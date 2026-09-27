/**
 * Owner-notification abstraction (provider-neutral, isolated).
 *
 * There is NO WhatsApp/Twilio/WATI/Interakt integration in this project (the
 * repository was searched; nothing was found) and none was added. This module is
 * therefore only the PREPARED abstraction:
 *
 *   - `notifyOwner(event)` is the one entry point callers use.
 *   - Events are enumerated and typed: PROVIDER_WARNING, PROVIDER_BLOCKED,
 *     LOW_BALANCE, QUOTA_EXHAUSTED.
 *   - Messages are rendered from templates, so a future transport (WhatsApp
 *     Business API, email, SMS, webhook) only needs a transport function — it
 *     does NOT need to touch provider safety, credits or the API routes.
 *   - The default delivery is a local, durable-free in-memory ring buffer plus a
 *     structured server log line. Nothing is sent anywhere, nothing claims to
 *     have been delivered, and `delivered` stays false while no transport is
 *     configured.
 *
 * Safety: rendering/recording never includes provider API keys, session tokens
 * or any other secret; `redactSecrets` scrubs anything that looks like one.
 */

/** The four prepared owner-alert events. */
export type OwnerNotificationEvent =
  | 'PROVIDER_WARNING'
  | 'PROVIDER_BLOCKED'
  | 'LOW_BALANCE'
  | 'QUOTA_EXHAUSTED';

export const OWNER_NOTIFICATION_EVENTS: readonly OwnerNotificationEvent[] = [
  'PROVIDER_WARNING',
  'PROVIDER_BLOCKED',
  'LOW_BALANCE',
  'QUOTA_EXHAUSTED',
];

/**
 * Percentage thresholds for a REAL, reliable provider balance/quota reading
 * (percent of remaining balance). They are applied ONLY when such a reading
 * exists. The project has no verified Sarvam balance/quota endpoint, so
 * `balanceSource` is null in production and percentage alerts stay disabled —
 * we never invent a balance to make a percentage alert fire.
 */
export const PROVIDER_BALANCE_THRESHOLDS = {
  warning: 25,
  low: 10,
  critical: 5,
  blocked: 0,
} as const;

export interface OwnerNotificationPayload {
  event: OwnerNotificationEvent;
  provider: string;
  /** Human-readable, already-redacted reason. */
  reason?: string;
  /** Raw provider error text, truncated and redacted before storing. */
  lastError?: string;
  lastHttpStatus?: number | null;
  /**
   * Remaining balance PERCENT from a real provider balance/quota source.
   * null = unknown (no verified source) — never a guess.
   */
  balancePercent?: number | null;
  balanceSource?: string | null;
  at?: string;
}

export interface OwnerNotification {
  id: string;
  event: OwnerNotificationEvent;
  provider: string;
  title: string;
  body: string;
  reason: string | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  balancePercent: number | null;
  balanceSource: string | null;
  /** ISO timestamp of the event. */
  at: string;
  /** ISO timestamp when a transport reported acceptance. */
  deliveredAt: string | null;
  /** True only when a configured transport actually accepted the message. */
  delivered: boolean;
  /** Names of transports that accepted it (e.g. ['whatsapp'] once wired). */
  deliveries: string[];
  /** Human note about why nothing was sent, when no transport is configured. */
  note: string | null;
}

const SECRET_PATTERNS: RegExp[] = [
  // Bearer headers FIRST: otherwise the "name: value" rule below would consume
  // the word "Bearer" and leave the token itself behind.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // Env-var / header style credentials, e.g. SARVAM_API_KEY=..., token: ...,
  // "api-subscription-key: ...". Deliberately over-eager: over-redacting a
  // harmless word is always safer than logging a credential.
  /[A-Za-z0-9_-]*(?:KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?|AUTH)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;"'`]+/gi,
];

/** Best-effort scrub of anything that looks like a credential. */
export function redactSecrets(input: unknown, maxLength = 400): string {
  let text = typeof input === 'string' ? input : input == null ? '' : String(input);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
}

const TITLES: Record<OwnerNotificationEvent, string> = {
  PROVIDER_WARNING: '⚠️ Provider Warning',
  PROVIDER_BLOCKED: '⛔ Provider Blocked',
  LOW_BALANCE: '🔻 Low Balance',
  QUOTA_EXHAUSTED: '⛔ Quota Exhausted',
};

/** Render the operator-facing message for an event (no secrets, no invented data). */
export function renderOwnerNotification(payload: OwnerNotificationPayload): { title: string; body: string } {
  const provider = payload.provider;
  const reason = payload.reason ? redactSecrets(payload.reason, 200) : '';
  const lastError = payload.lastError ? redactSecrets(payload.lastError, 200) : '';
  const status = payload.lastHttpStatus != null ? `HTTP ${payload.lastHttpStatus}` : '';
  const balanceLine =
    payload.balancePercent != null && payload.balanceSource
      ? `Balance: ${payload.balancePercent}% remaining (source: ${payload.balanceSource}).`
      : 'Balance: unknown — this provider has no verified balance/quota API, so no percentage is shown.';
  const lines: string[] = [];

  switch (payload.event) {
    case 'PROVIDER_BLOCKED':
      lines.push(`Transcription provider ${provider} is BLOCKED. No further ASR calls will be made.`);
      lines.push('Reason: provider reported that its credits/quota are exhausted (HTTP 402).');
      break;
    case 'QUOTA_EXHAUSTED':
      lines.push(`Provider ${provider} reported exhausted quota (HTTP 402).`);
      break;
    case 'PROVIDER_WARNING':
      lines.push(`Transcription provider ${provider} reported repeated failures.`);
      break;
    case 'LOW_BALANCE':
      lines.push(`Provider ${provider} balance is low.`);
      break;
  }
  if (reason) lines.push(reason);
  if (lastError) lines.push(`Last provider error: ${lastError}`);
  if (status) lines.push(`Last response: ${status}`);
  lines.push(balanceLine);
  lines.push(
    payload.event === 'PROVIDER_BLOCKED' || payload.event === 'QUOTA_EXHAUSTED'
      ? 'Action required: add credits to the provider account, then reset the provider state to AVAILABLE from the admin panel. Automatic recharge is disabled and will not be attempted.'
      : 'Action required: inspect the provider account. Automatic recharge is disabled and will not be attempted.'
  );
  return { title: TITLES[payload.event], body: lines.join('\n') };
}

export type OwnerNotificationTransport = (
  notification: OwnerNotification
) => boolean | Promise<boolean>;

const isThenable = (value: unknown): value is Promise<boolean> =>
  typeof (value as Promise<boolean>)?.then === 'function';

export interface NotifierLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OwnerNotifier {
  notifyOwner(payload: OwnerNotificationPayload): OwnerNotification;
  recent(limit?: number): OwnerNotification[];
  transportNames(): string[];
  reset(): void;
}

const MAX_BUFFER = 50;

/**
 * Create the owner notifier. `transports` is intentionally empty by default:
 * a future WhatsApp/email transport plugs in here without any other change.
 */
export function createOwnerNotifier(opts: {
  log: NotifierLog;
  transports?: Record<string, OwnerNotificationTransport>;
  idFactory?: () => string;
  now?: () => string;
}): OwnerNotifier {
  const transports = opts.transports ?? {};
  const now = opts.now ?? (() => new Date().toISOString());
  let counter = 0;
  const idFactory = opts.idFactory ?? (() => `ntf_${(++counter).toString(36)}_${now().replace(/\D/g, '')}`);
  const buffer: OwnerNotification[] = [];

  const transportNames = () => Object.keys(transports);

  return {
    transportNames,

    notifyOwner(payload: OwnerNotificationPayload) {
      const { title, body } = renderOwnerNotification(payload);
      const notification: OwnerNotification = {
        id: idFactory(),
        event: payload.event,
        provider: payload.provider,
        title,
        body,
        reason: payload.reason ? redactSecrets(payload.reason, 200) : null,
        lastError: payload.lastError ? redactSecrets(payload.lastError, 400) : null,
        lastHttpStatus: payload.lastHttpStatus ?? null,
        balancePercent: payload.balancePercent ?? null,
        balanceSource: payload.balanceSource ?? null,
        at: payload.at ?? now(),
        deliveredAt: null,
        delivered: false,
        deliveries: [],
        note:
          transportNames().length === 0
            ? 'No delivery channel is configured: recorded locally and logged only. WhatsApp is NOT connected.'
            : null,
      };

      for (const [name, transport] of Object.entries(transports)) {
        const logFailure = (err: unknown) => {
          // A broken transport must never break provider-safety handling.
          opts.log.warn('owner notification transport failed', {
            event: notification.event,
            transport: name,
            error: redactSecrets((err as Error)?.message),
          });
        };
        const markDelivered = () => {
          if (!notification.delivered) notification.deliveredAt = now();
          notification.delivered = true;
          if (!notification.deliveries.includes(name)) notification.deliveries.push(name);
        };
        try {
          const result = transport(notification);
          if (result === true) {
            markDelivered();
          } else if (isThenable(result)) {
            // Async transports are supported: the delivery flag is updated once
            // the promise settles (visible in `recent()`), and a rejection is
            // logged instead of becoming an unhandled rejection.
            result.then((ok) => {
              if (ok) markDelivered();
            }, logFailure);
          }
        } catch (err) {
          logFailure(err);
        }
      }

      buffer.unshift(notification);
      if (buffer.length > MAX_BUFFER) buffer.length = MAX_BUFFER;
      opts.log.warn('owner notification: ' + notification.title, {
        event: notification.event,
        provider: notification.provider,
        delivered: notification.delivered,
        transports: notification.deliveries,
        at: notification.at,
      });
      return structuredClone(notification);
    },

    recent(limit = 20) {
      return buffer.slice(0, Math.max(1, Math.min(limit, MAX_BUFFER))).map((n) => structuredClone(n));
    },

    reset() {
      buffer.length = 0;
    },
  };
}

/**
 * Percentage → event, using the prepared thresholds. Returns null when the
 * reading is unknown/absent so we never fabricate a balance-based alert.
 */
export function balanceEventFor(percent: number | null | undefined): OwnerNotificationEvent | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  if (percent <= PROVIDER_BALANCE_THRESHOLDS.blocked) return 'QUOTA_EXHAUSTED';
  if (percent <= PROVIDER_BALANCE_THRESHOLDS.critical) return 'LOW_BALANCE';
  if (percent <= PROVIDER_BALANCE_THRESHOLDS.low) return 'LOW_BALANCE';
  if (percent <= PROVIDER_BALANCE_THRESHOLDS.warning) return 'PROVIDER_WARNING';
  return null;
}
