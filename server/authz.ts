/**
 * Owner/admin authorisation rules (server-side only).
 *
 * There is NO password/OAuth/email-verification system in this project, so
 * "verified account" is implemented honestly and minimally:
 *
 *   1. The ADMIN role is ONLY ever assigned server-side, and only when the
 *      caller proves possession of the server-held bootstrap secret
 *      (`ADMIN_BOOTSTRAP_TOKEN`) — see `server.ts` /api/session.
 *   2. The claim must also name an email that is on the server-side allowlist
 *      (`OWNER_EMAILS`, defaults to the two product-owner addresses). The claim
 *      is not trusted by itself: it is checked against the server's list, and
 *      the email actually stored on the admin record is the allowlisted one
 *      (normalised), not whatever casing/whitespace the client sent.
 *   3. Every admin request re-verifies the allowlist, so demoting the allowlist
 *      in the environment revokes access immediately.
 *
 * A browser can therefore never grant itself admin rights: a forged email in a
 * JSON body is rejected, and role/creditMode from the client are never read.
 */
import { timingSafeEqual } from 'crypto';
import { config } from './config';

/** Addresses that may back an ADMIN account when OWNER_EMAILS is not set. */
export const DEFAULT_OWNER_EMAILS: readonly string[] = [
  'officeaipro6@gmail.com',
  'sumitchinara@gmail.com',
];

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** The server-side owner allowlist (never a client-supplied list). */
export function ownerAllowlist(): string[] {
  const fromEnv = (process.env.OWNER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_OWNER_EMAILS];
}

export function isAllowlistedOwnerEmail(value: unknown): boolean {
  const email = normalizeEmail(value);
  if (!email) return false;
  return ownerAllowlist().includes(email);
}

/** Timing-safe comparison of a submitted bootstrap secret with the server's. */
export function isValidAdminBootstrapToken(submitted: unknown): boolean {
  const expected = config.adminBootstrapToken;
  if (!expected) return false;
  if (typeof submitted !== 'string') return false;
  const got = submitted.trim();
  if (!got || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
}

/**
 * The single decision point for granting ADMIN. Returns the CANONICAL
 * allowlisted email to persist, or null to refuse. Both the secret and the
 * allowlist must match; a matching email with no/wrong secret is refused.
 */
export function authorizeOwnerSession(input: {
  bootstrapToken?: unknown;
  claimedEmail?: unknown;
}): { ok: true; ownerEmail: string } | { ok: false; code: 'NO_ADMIN_SECRET' | 'BAD_TOKEN' | 'EMAIL_NOT_ALLOWED' } {
  if (!config.adminBootstrapToken) return { ok: false, code: 'NO_ADMIN_SECRET' };
  if (!isValidAdminBootstrapToken(input.bootstrapToken)) return { ok: false, code: 'BAD_TOKEN' };
  const email = normalizeEmail(input.claimedEmail);
  if (!email) return { ok: false, code: 'EMAIL_NOT_ALLOWED' };
  if (!ownerAllowlist().includes(email)) return { ok: false, code: 'EMAIL_NOT_ALLOWED' };
  return { ok: true, ownerEmail: email };
}

export type OwnerRejection = 'NO_ADMIN_SECRET' | 'BAD_TOKEN' | 'EMAIL_NOT_ALLOWED';

/** Server-side check applied to every admin request, in addition to the token auth. */
export function isVerifiedOwner(user: { role?: string; ownerEmail?: string } | null | undefined): boolean {
  if (!user || user.role !== 'ADMIN') return false;
  return isAllowlistedOwnerEmail(user.ownerEmail);
}

/**
 * Owner notification recipients. Derived from the SAME server-side allowlist —
 * a client cannot add recipients, so notification targets are never attacker
 * controlled.
 */
export function ownerNotificationRecipients(): string[] {
  return ownerAllowlist();
}

/** Operator-facing reason for a refused owner attempt (no secrets echoed). */
export function ownerRejectionMessage(code: OwnerRejection): string {
  switch (code) {
    case 'NO_ADMIN_SECRET':
      return 'Admin access is not configured on this server.';
    case 'BAD_TOKEN':
      return 'Admin access requires a valid admin bootstrap token.';
    case 'EMAIL_NOT_ALLOWED':
      return 'This email is not an allowed owner account for admin access.';
  }
}
