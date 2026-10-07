/**
 * EMAIL OWNERSHIP VERIFICATION — delivery transport.
 *
 * Two modes, chosen once from the environment:
 *
 *   - Resend (production): enabled when `RESEND_API_KEY` AND `EMAIL_FROM` are
 *     set. Sends real mail through the Resend HTTPS API (`POST
 *     https://api.resend.com/emails`) over port 443 using Node's global
 *     `fetch`. The API key comes from the environment only and is never
 *     logged, echoed, stored or sent anywhere but the Authorization header.
 *
 *   - Log (development / no Resend configured): prints the verification LINK
 *     to stdout so local work and Render Preview apps can exercise the full
 *     flow without a mail account. Clearly labelled as such; the Resend path
 *     never prints anything about the message body.
 *
 * Neither mode ever returns the raw verification token to a client. The token
 * travels only inside the emailed link.
 */
import { normalizeAccountEmail } from './accountService';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  delivered: boolean;
  transport: 'resend' | 'log';
  /** Short, redacted reason when delivery failed (never a credential). */
  error?: string;
}

/** The injectable send surface routes depend on; tests capture this. */
export type EmailSender = (msg: EmailMessage) => Promise<EmailDelivery>;

export interface EmailTransportConfig {
  emailFrom: string;
  /** Resend API key (RESEND_API_KEY). Present only in the environment. */
  apiKey: string;
}

/** Read transport config straight from the environment. */
export function emailTransportConfig(env: NodeJS.ProcessEnv = process.env): EmailTransportConfig {
  return {
    emailFrom: (env.EMAIL_FROM ?? '').trim(),
    apiKey: (env.RESEND_API_KEY ?? '').trim(),
  };
}

/** A verification link resolves against the app, not a bare token endpoint. */
export function verificationLink(rawToken: string, appBaseUrl: string): string {
  const base = (appBaseUrl || '').replace(/\/+$/, '');
  return `${base}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
}

export function buildVerificationEmail(to: string, link: string, from: string): EmailMessage {
  const subject = 'Verify your Odia SRT email address';
  const text =
    'Click this link to verify your email address and start transcribing:\n\n' +
    `${link}\n\n` +
    'The link is valid for one hour and can be used once. If you did not create an ' +
    'Odia SRT account, you can ignore this email.';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px">' +
    '<h2 style="margin:0 0 8px;color:#111827">Verify your Odia SRT email</h2>' +
    '<p style="color:#374151;line-height:1.5">Click the button below to verify your email and start transcribing.</p>' +
    `<p style="margin:24px 0"><a href="${escapeHtml(link)}" ` +
    'style="background:#4f46e5;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">' +
    'Verify my email</a></p>' +
    '<p style="color:#6b7280;font-size:13px;line-height:1.5">The link is valid for one hour and can be used once. ' +
    'If you did not create an Odia SRT account, you can ignore this email.</p>' +
    '</div>';
  return {
    to: normalizeAccountEmail(to),
    subject,
    text,
    html,
  };
}

/**
 * Build the message + resolve the app base URL.
 *
 * The base URL preference is: explicit `APP_BASE_URL`/`APP_URL` override, then
 * the request origin the browser actually used, then a localhost fallback. The
 * request origin is the correct choice for both the deployed app (the email
 * links back to exactly the host the user is on) and local dev.
 */
export function verificationEmailFor(
  to: string,
  rawToken: string,
  opts: { appBaseUrl?: string; requestBaseUrl?: string } = {}
): { message: EmailMessage; baseUrl: string } {
  const baseUrl = (opts.appBaseUrl || opts.requestBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  const link = verificationLink(rawToken, baseUrl);
  return { message: buildVerificationEmail(to, link, emailTransportConfig().emailFrom || 'noreply@localhost'), baseUrl };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resend sender construction options. The API key is never logged or stored. */
export interface ResendSenderConfig {
  /** Resend API key, sent only in the Authorization header. */
  apiKey: string;
  /** Verified sender address shown in the From header. */
  emailFrom: string;
  /** API endpoint override for tests; defaults to the production Resend API. */
  apiUrl?: string;
}

/**
 * The production logger used by the Resend path. Deliberately narrow: message
 * recipients and transport only; never body content (the body carries the
 * token inside its link).
 */
function logDelivery(to: string): void {
  // A plain console line (matches the surrounding server's style); no secrets.
  console.log(`[email:resend] verification email → ${to}`);
}

/**
 * Reduce a value that could contain address/credential-shaped fragments to a
 * safe snippet. Emails become `[email]`, `Bearer`/`token=`/`pass=`/auth
 * fragments become `name=***` and whitespace collapses. Used on both error
 * paths and the log classifier so nothing sensitive survives.
 */
export function scrubSensitiveText(value: string): string {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer=***')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b(token|pass(?:word)?|auth(?:orization)?|bearer)\b(\s*[=:]\s*[^\s,;]+)?/gi, (_m, name: string) => `${name}=***`)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Safe, short description of a non-2xx Resend response. Status + scrubbed body. */
function resendErrorText(status: number, bodyText: string): string {
  const raw = String(bodyText ?? '').slice(0, 400);
  let message = '';
  try {
    const parsed = raw ? (JSON.parse(raw) as { message?: unknown }) : null;
    if (parsed && typeof parsed.message === 'string') message = parsed.message;
  } catch {
    /* non-JSON body; fall back to the raw text */
  }
  const fragment = scrubSensitiveText(message || raw || `HTTP ${status}`);
  return `resend_http_${status}: ${fragment}`;
}

/**
 * `nodemailer`-free Resend HTTPS sender built from a config object. Never
 * throws at creation and never rejects: every failure is returned as an
 * {@link EmailDelivery} with `delivered:false`.
 */
export function createResendSender(config: ResendSenderConfig): EmailSender {
  const apiUrl = (config.apiUrl || 'https://api.resend.com/emails').replace(/\/+$/, '');

  return async (msg: EmailMessage): Promise<EmailDelivery> => {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { delivered: false, transport: 'resend', error: resendErrorText(res.status, body) };
      }
      logDelivery(msg.to);
      return { delivered: true, transport: 'resend' };
    } catch (err) {
      // Only machine-safe bits survive here: any Node error code (ENOTFOUND /
      // ETIMEDOUT / EAI_AGAIN / ...) plus a trimmed message, redacted of
      // anything credential-shaped. Never the raw error object, request or key.
      const anyErr = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
      const code = typeof anyErr?.code === 'string'
        ? anyErr.code
        : typeof anyErr?.cause?.code === 'string'
          ? anyErr.cause.code
          : '';
      const causeMessage = typeof anyErr?.cause?.message === 'string' ? anyErr.cause.message : '';
      const message = String(anyErr?.message ?? err);
      const combined = causeMessage && !message.includes(causeMessage) ? `${message} (${causeMessage})` : message;
      const sanitized = combined.replace(/pass\b[^,;]+/gi, 'pass=***').slice(0, 400);
      const error = (code ? `${code}: ` : '') + sanitized;
      return { delivered: false, transport: 'resend', error };
    }
  };
}

/**
 * The well-known failure classes this server can actually act on. Anything else
 * is reduced to a short, scrubbed message by {@link classifyDeliveryError}.
 */
const DELIVERY_ERROR_CODES = [
  'EAUTH',
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ESOCKET',
  'EPIPE',
  'EACCES',
  'ETLSRCH',
  'EADDRINUSE',
] as const;

/**
 * Reduce a transport's sanitized error to a safe, short value safe for
 * production logs.
 *
 * - A known delivery failure class (e.g. `ENOTFOUND`, `ETIMEDOUT`, `EAUTH`)
 *   is returned verbatim so ops can sort on it.
 * - Anything else falls back to the first non-empty line, scrubbed of email
 *   addresses and any `token=`/`pass=`/`Authorization` fragments, then capped
 *   at 120 chars (`unknown` when nothing remains).
 *
 * Accepts ONLY the already-redacted string from an {@link EmailDelivery} — never
 * credentials, request objects or response instances.
 */
export function classifyDeliveryError(error: string | undefined | null): string {
  const sanitized = String(error ?? '').trim();
  if (!sanitized) return 'unknown';
  const known = DELIVERY_ERROR_CODES.find((code) => sanitized.includes(code));
  if (known) return known;
  const firstLine = sanitized.split(/\r?\n/)[0].trim();
  const scrubbed = scrubSensitiveText(firstLine);
  return scrubbed.slice(0, 120) || 'unknown';
}

/**
 * Local-only fallback: prints the verification LINK (no mail API needed).
 *
 * The link embeds the single-use token; printing it is what lets a developer
 * or a Preview app complete the flow. This mode is only active when Resend is
 * NOT configured, and the printed line is unmistakably labelled as a
 * development fallback so it can never be mistaken for real mail delivery.
 */
export function createLogSender(): EmailSender {
  return async (msg: EmailMessage): Promise<EmailDelivery> => {
    const link = extractLinkFromText(msg.text);
    console.log(
      `[email:log] NO RESEND CONFIGURED — dev fallback only. ` +
        `to=${msg.to} subject=${JSON.stringify(msg.subject)}`
    );
    console.log(`[email:log] verification link (dev only): ${link}`);
    return { delivered: true, transport: 'log' };
  };
}

function extractLinkFromText(text: string): string {
  const match = /https?:\/\/[^\s]+/.exec(text || '');
  return match ? match[0] : '';
}

/** Pick the Resend HTTPS sender when configured, otherwise the dev log fallback. */
export function createEmailSender(env: NodeJS.ProcessEnv = process.env): { sender: EmailSender; mode: 'resend' | 'log' } {
  const config = emailTransportConfig(env);
  if (config.apiKey && config.emailFrom) {
    return { sender: createResendSender({ apiKey: config.apiKey, emailFrom: config.emailFrom }), mode: 'resend' };
  }
  return { sender: createLogSender(), mode: 'log' };
}