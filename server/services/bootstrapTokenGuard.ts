/**
 * ADMIN_BOOTSTRAP_TOKEN integrity guard (server-side only).
 *
 * Purpose: detect an UNEXPECTED change to the admin bootstrap secret and raise a
 * security alert, without ever handling the secret unsafely.
 *
 * Hard rules enforced here:
 *   - The token is READ ONLY from the server-side environment (.env), and is
 *     never written, generated, rotated, recovered or replaced by this module.
 *     A missing or changed token is reported and requires MANUAL correction.
 *   - The token VALUE is never returned, logged, stored or serialised. Only a
 *     keyed fingerprint (HMAC-SHA256 over a locally generated pepper) is kept.
 *   - Comparison is timing-safe (timingSafeEqual).
 *   - The alert message never contains the token, and every rendered line is
 *     passed through `redactSecrets` before it can reach a log or a transport.
 *   - Delivery is transport-neutral. No messaging provider is configured in this
 *     project, so the alert is recorded locally and the notification channel is
 *     reported as PENDING rather than faked.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { redactSecrets } from './notifications.ts';

/** Outcomes of one startup verification. */
export type BootstrapTokenStatus =
  | 'UNCHANGED'
  | 'BASELINE_RECORDED'
  | 'CHANGED'
  | 'MISSING';

export interface GuardState {
  version: 1;
  /** Locally generated pepper; the fingerprint is useless without it. */
  pepper: string;
  /** Hex HMAC-SHA256(pepper, token). Never the token itself. */
  fingerprint: string;
  /** ISO time the fingerprint was first recorded. */
  recordedAt: string;
  /** ISO time of the most recent successful match. */
  lastVerifiedAt: string;
}

export interface GuardAlert {
  /** Stable, non-secret alert code for logs/UI. */
  code: 'BOOTSTRAP_TOKEN_CHANGED' | 'BOOTSTRAP_TOKEN_MISSING';
  title: string;
  body: string;
  createdAt: string;
  /** True only when a configured transport accepted the alert. */
  delivered: boolean;
  deliveries: string[];
  /** Present when nothing was sent (channel not configured). */
  note: string | null;
}

export interface GuardResult {
  status: BootstrapTokenStatus;
  /** True only for a genuine, unexpected change of a previously recorded token. */
  alert: GuardAlert | null;
  /** Never the token: a short, non-reversible fingerprint for operator logs. */
  fingerprintPrefix: string | null;
  /** Human summary safe to print. */
  summary: string;
  /** True when a notification channel must still be configured. */
  notificationPending: boolean;
}

export interface GuardLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type GuardTransport = (alert: GuardAlert) => boolean | Promise<boolean>;

/** The exact operator-facing wording required for a token-change alert. */
export function bootstrapTokenChangedMessage(projectDir: string): string {
  return `SECURITY ALERT: ADMIN_BOOTSTRAP_TOKEN has changed in ${projectDir}. Please verify the server configuration.`;
}

/** The exact operator-facing wording for a missing token. */
export function bootstrapTokenMissingMessage(projectDir: string): string {
  return `SECURITY ALERT: ADMIN_BOOTSTRAP_TOKEN is missing in ${projectDir}. Please verify the server configuration.`;
}

/**
 * Keyed fingerprint of the token. The pepper lives beside the state file, so a
 * leaked state file alone cannot be used to confirm a guessed token.
 */
export function fingerprintToken(token: string, pepper: string): string {
  return createHmac('sha256', Buffer.from(pepper, 'hex')).update(token, 'utf8').digest('hex');
}

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readState(file: string): Promise<GuardState | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as GuardState;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.pepper === 'string' &&
      typeof parsed.fingerprint === 'string' &&
      parsed.pepper.length > 0 &&
      parsed.fingerprint.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null; // Absent or unreadable -> treated as "no baseline yet".
  }
}

async function writeState(file: string, state: GuardState): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Verify the configured bootstrap token against the recorded fingerprint.
 *
 * Never throws, never mutates the token, and never returns the token. On a
 * missing token it fails safely: the caller is told manual correction is needed.
 */
export async function verifyBootstrapTokenIntegrity(opts: {
  /** Raw token as read from the server-side environment; empty when unset. */
  token: string | null | undefined;
  stateFile: string;
  projectDir: string;
  log: GuardLog;
  transports?: Record<string, GuardTransport>;
  now?: () => Date;
}): Promise<GuardResult> {
  const now = opts.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const transports = opts.transports ?? {};
  const token = (opts.token ?? '').trim();
  const state = await readState(opts.stateFile);
  const transportNames = Object.keys(transports);

  const deliver = async (alert: GuardAlert): Promise<void> => {
    for (const [name, transport] of Object.entries(transports)) {
      try {
        const outcome = transport(alert);
        const accepted =
          typeof outcome === 'boolean' ? outcome : await Promise.resolve(outcome).catch(() => false);
        if (accepted) {
          alert.delivered = true;
          if (!alert.deliveries.includes(name)) alert.deliveries.push(name);
        }
      } catch {
        // A broken transport must never break startup safety.
      }
    }
    if (transportNames.length === 0) {
      alert.note =
        'No notification channel is configured: the alert is recorded locally and logged only. ' +
        'WhatsApp is NOT connected - notification setup is PENDING and no credentials were invented.';
    }
  };

  // ---- Missing token: fail safely, change nothing, require manual correction.
  if (!token) {
    const alert: GuardAlert = {
      code: 'BOOTSTRAP_TOKEN_MISSING',
      title: 'SECURITY ALERT: admin bootstrap token missing',
      body: `${bootstrapTokenMissingMessage(opts.projectDir)} No token was generated, recovered or replaced; set it manually in the server-side .env.`,
      createdAt: timestamp,
      delivered: false,
      deliveries: [],
      note: null,
    };
    await deliver(alert);
    opts.log.warn('bootstrap token integrity: MISSING (manual correction required)', {
      code: alert.code,
      stateRecorded: Boolean(state),
      note: alert.note,
    });
    return {
      status: 'MISSING',
      alert,
      fingerprintPrefix: null,
      summary:
        'ADMIN_BOOTSTRAP_TOKEN is not configured. Nothing was generated or changed; set it manually in the server-side .env.',
      notificationPending: transportNames.length === 0,
    };
  }

  const pepper = state?.pepper ?? randomBytes(32).toString('hex');
  const fingerprint = fingerprintToken(token, pepper);

  // ---- No baseline yet: record one. This is the only write we ever perform.
  if (!state) {
    await writeState(opts.stateFile, {
      version: 1,
      pepper,
      fingerprint,
      recordedAt: timestamp,
      lastVerifiedAt: timestamp,
    });
    opts.log.info('bootstrap token integrity: baseline fingerprint recorded', {
      fingerprintPrefix: fingerprint.slice(0, 12),
      stateFile: path.basename(opts.stateFile),
    });
    return {
      status: 'BASELINE_RECORDED',
      alert: null,
      fingerprintPrefix: fingerprint.slice(0, 12),
      summary: 'Recorded a baseline fingerprint for ADMIN_BOOTSTRAP_TOKEN. The token itself was not stored.',
      notificationPending: transportNames.length === 0,
    };
  }

  // ---- Same token as recorded: nothing to do. Refresh the verification time.
  if (safeEquals(fingerprint, state.fingerprint)) {
    await writeState(opts.stateFile, { ...state, lastVerifiedAt: timestamp });
    opts.log.info('bootstrap token integrity: unchanged', {
      fingerprintPrefix: state.fingerprint.slice(0, 12),
    });
    return {
      status: 'UNCHANGED',
      alert: null,
      fingerprintPrefix: state.fingerprint.slice(0, 12),
      summary: 'ADMIN_BOOTSTRAP_TOKEN matches the recorded fingerprint. No change detected.',
      notificationPending: transportNames.length === 0,
    };
  }

  // ---- Changed (or the recorded fingerprint was tampered with): alert, and
  // deliberately do NOT overwrite the recorded fingerprint, so the change stays
  // visible until an operator acts.
  const alert: GuardAlert = {
    code: 'BOOTSTRAP_TOKEN_CHANGED',
    title: 'SECURITY ALERT: admin bootstrap token changed',
    body: `${bootstrapTokenChangedMessage(opts.projectDir)} The token value is never included in this alert. No token was generated or replaced; restore the previous value manually.`,
    createdAt: timestamp,
    delivered: false,
    deliveries: [],
    note: null,
  };
  await deliver(alert);
  opts.log.warn('bootstrap token integrity: CHANGED (security alert raised)', {
    code: alert.code,
    delivered: alert.delivered,
    transports: alert.deliveries,
    recordedFingerprintPrefix: state.fingerprint.slice(0, 12),
    presentedFingerprintPrefix: fingerprint.slice(0, 12),
    message: redactSecrets(alert.body, 300),
  });
  return {
    status: 'CHANGED',
    alert,
    fingerprintPrefix: fingerprint.slice(0, 12),
    summary:
      'ADMIN_BOOTSTRAP_TOKEN does not match the recorded fingerprint. A security alert was raised. The token was not changed automatically.',
    notificationPending: transportNames.length === 0,
  };
}
