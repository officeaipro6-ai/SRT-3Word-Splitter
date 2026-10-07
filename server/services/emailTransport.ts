/**
 * EMAIL OWNERSHIP VERIFICATION — delivery transport.
 *
 * Two modes, chosen once from the environment:
 *
 *   - SMTP (production): enabled when `SMTP_HOST` AND `EMAIL_FROM` are set.
 *     Sends real mail through `nodemailer` using `SMTP_HOST` / `SMTP_PORT` /
 *     `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE`. Secrets come from the
 *     environment only and are never logged, echoed or stored.
 *
 *   - Log (development / no SMTP configured): prints the verification LINK to
 *     stdout so local work and Render Preview apps can exercise the full flow
 *     without a mail account. Clearly labelled as such; the SMTP path never
 *     prints anything about the message body.
 *
 * Neither mode ever returns the raw verification token to a client. The token
 * travels only inside the emailed link.
 */
import nodemailer from 'nodemailer';
import { normalizeAccountEmail } from './accountService';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  delivered: boolean;
  transport: 'smtp' | 'log';
  /** Short, redacted reason when delivery failed (never a credential). */
  error?: string;
}

/** The injectable send surface routes depend on; tests capture this. */
export type EmailSender = (msg: EmailMessage) => Promise<EmailDelivery>;

export interface EmailTransportConfig {
  emailFrom: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPassword?: string;
  smtpSecure?: string;
}

/** Read transport config straight from the environment. */
export function emailTransportConfig(env: NodeJS.ProcessEnv = process.env): EmailTransportConfig {
  return {
    emailFrom: (env.EMAIL_FROM ?? '').trim(),
    smtpHost: (env.SMTP_HOST ?? '').trim(),
    smtpPort: (env.SMTP_PORT ?? '').trim(),
    smtpUser: (env.SMTP_USER ?? '').trim(),
    smtpPassword: (env.SMTP_PASSWORD ?? '').trim(),
    smtpSecure: (env.SMTP_SECURE ?? '').trim(),
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

/**
 * The production logger used by the SMTP path. Deliberately narrow: message
 * recipients and transport only; never body content (the body carries the
 * token inside its link).
 */
function logDelivery(to: string): void {
  // A plain console line (matches the surrounding server's style); no secrets.
  console.log(`[email:smtp] verification email → ${to}`);
}

/** `nodemailer` SMTP sender built from the environment. Never throws at creation. */
export function createSmtpSender(config: EmailTransportConfig): EmailSender {
  const port = Number(config.smtpPort || 587);
  const secure = String(config.smtpSecure).toLowerCase() === 'true';
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port,
    secure,
    auth:
      config.smtpUser && config.smtpPassword
        ? { user: config.smtpUser, pass: config.smtpPassword }
        : undefined,
  });

  return async (msg: EmailMessage): Promise<EmailDelivery> => {
    try {
      await transporter.sendMail({
        from: config.emailFrom,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      logDelivery(msg.to);
      return { delivered: true, transport: 'smtp' };
    } catch (err) {
      // Only machine-safe bits survive here: the nodemailer error `code`
      // (EAUTH/ETIMEDOUT/...) plus a trimmed message, redacted of anything
      // credential-shaped. Never the raw error object.
      const code = typeof (err as { code?: unknown } | null)?.code === 'string'
        ? String((err as { code: string }).code)
        : '';
      const message = String((err as Error | undefined)?.message ?? err);
      const sanitized = message.replace(/pass\b[^,;]+/gi, 'pass=***').slice(0, 400);
      const error = (code ? `${code}: ` : '') + sanitized;
      return { delivered: false, transport: 'smtp', error };
    }
  };
}

/**
 * The well-known failure classes this server can actually act on. Anything else
 * is reduced to a short, scrubbed message by {@link classifyDeliveryError}.
 */
const SMTP_ERROR_CODES = [
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
 * - A known SMTP failure class (e.g. `EAUTH`, `ECONNECTION`, `ETIMEDOUT`) is
 *   returned verbatim so ops can sort on it.
 * - Anything else falls back to the first non-empty line, scrubbed of email
 *   addresses and any `token=`/`pass=`/`Authorization` fragments, then capped
 *   at 120 chars (`unknown` when nothing remains).
 *
 * Accepts ONLY the already-redacted string from an {@link EmailDelivery} — never
 * credentials, request objects or nodemailer instances.
 */
export function classifyDeliveryError(error: string | undefined | null): string {
  const sanitized = String(error ?? '').trim();
  if (!sanitized) return 'unknown';
  const known = SMTP_ERROR_CODES.find((code) => sanitized.includes(code));
  if (known) return known;
  const firstLine = sanitized.split(/\r?\n/)[0].trim();
  const scrubbed = firstLine
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer=***')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b(token|pass(?:word)?|auth(?:orization)?|bearer)\b(\s*[=:]\s*[^\s,;]+)?/gi, (_m, name: string) => `${name}=***`)
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed.slice(0, 120) || 'unknown';
}

/**
 * Local-only fallback: prints the verification LINK (no SMTP server needed).
 *
 * The link embeds the single-use token; printing it is what lets a developer
 * or a Preview app complete the flow. This mode is only active when SMTP is NOT
 * configured, and the printed line is unmistakably labelled as a development
 * fallback so it can never be mistaken for real mail delivery.
 */
export function createLogSender(): EmailSender {
  return async (msg: EmailMessage): Promise<EmailDelivery> => {
    const link = extractLinkFromText(msg.text);
    console.log(
      `[email:log] NO SMTP CONFIGURED — dev fallback only. ` +
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

/** Pick the SMTP sender when configured, otherwise the dev log fallback. */
export function createEmailSender(env: NodeJS.ProcessEnv = process.env): { sender: EmailSender; mode: 'smtp' | 'log' } {
  const config = emailTransportConfig(env);
  if (config.smtpHost && config.emailFrom) {
    return { sender: createSmtpSender(config), mode: 'smtp' };
  }
  return { sender: createLogSender(), mode: 'log' };
}