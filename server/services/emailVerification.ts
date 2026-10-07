/**
 * EMAIL OWNERSHIP VERIFICATION — pure, unit-testable rules.
 *
 * Nothing in this file touches the store, a transport, or an HTTP request. It
 * only decides the domain questions:
 *
 *   - whether an account currently requires verification
 *   - whether a presented token is the live, unexpired, single-use token
 *   - whether a resend is allowed or still inside the cooldown window
 *
 * Persistence lives in the account facades (JSON `UserRepo` / Turso
 * `TursoAccountService`); delivery lives in `emailTransport.ts`. The token is
 * 256 bits of CSPRNG entropy; only its sha256 hash is ever persisted, matching
 * the bearer-token convention in `server/services/auth.ts`.
 */
import { createHash, randomBytes } from 'crypto';
import type { UserRecord } from '../db/types';

/**
 * Read a millisecond setting, defaulting when the variable is unset OR blank
 * (blank is how tests/e2e force the fallback — `Number('')` would otherwise
 * silently zero the window).
 */
function readMs(envKey: string, fallbackMs: number): number {
  const raw = (process.env[envKey] ?? '').trim();
  const parsed = Number(raw);
  return raw === '' ? fallbackMs : Number.isFinite(parsed) ? parsed : fallbackMs;
}

/** Links stay valid for up to 1 hour (requirement: "30 min or 1 h"). */
export const EMAIL_VERIFY_TTL_MS = readMs('EMAIL_VERIFY_EXPIRES_MS', 60 * 60 * 1000);

/** One resend per account per minute by default; a link is re-issued on resend. */
export const EMAIL_VERIFY_RESEND_COOLDOWN_MS = readMs('EMAIL_VERIFY_RESEND_COOLDOWN_MS', 60 * 1000);

export interface VerificationToken {
  /** Value placed in the emailed link. Returned to callers, never persisted. */
  raw: string;
  /** sha256(raw), the ONLY form ever stored or looked up. */
  hash: string;
  /** ISO expiry (now + EMAIL_VERIFY_TTL_MS). */
  expiresAt: string;
}

/** 256-bit token + its stored hash + expiry. */
export function issueVerificationToken(now = Date.now()): VerificationToken {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,
    hash: createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(now + EMAIL_VERIFY_TTL_MS).toISOString(),
  };
}

export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Grandfather / default policy.
 *
 * - No email (anonymous session user / admin bootstrap) -> not an account that
 *   participates in email verification.
 * - Field absent (account created before this feature) -> treated as verified,
 *   so existing customers are never locked out by activation.
 * - Field is a stored boolean -> its value IS the answer.
 */
export function isEmailVerified(user: Pick<UserRecord, 'email' | 'emailVerified'> | null | undefined): boolean {
  if (!user) return true;
  if (!user.email) return true;
  if (user.emailVerified === false) return false;
  return true;
}

/** True when a stored token is present, matches, and has not expired. */
export function isVerificationTokenValid(
  user: Pick<UserRecord, 'emailVerifyTokenHash' | 'emailVerifyExpiresAt' | 'emailVerified'> | null | undefined,
  tokenHash: string,
  nowIso = new Date().toISOString()
): boolean {
  if (!user) return false;
  if (!user.emailVerifyTokenHash) return false;
  if (user.emailVerifyTokenHash !== tokenHash) return false;
  if (typeof user.emailVerifyExpiresAt !== 'string') return false;
  return user.emailVerifyExpiresAt > nowIso;
}

/** Remaining cooldown after the last sent link, or 0 when resend is allowed. */
export function resendCooldownRemainingMs(user: Pick<UserRecord, 'emailVerifyLastSentAt'> | null | undefined, now = Date.now()): number {
  if (!user || typeof user.emailVerifyLastSentAt !== 'string') return 0;
  const sentAt = Date.parse(user.emailVerifyLastSentAt);
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, sentAt + EMAIL_VERIFY_RESEND_COOLDOWN_MS - now);
}