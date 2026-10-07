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
import { isEmailVerified } from './services/emailVerification';
import type { UserRecord } from './db/types';

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

export type TranscriberRejection = 'NO_SESSION' | 'ADMIN_FORBIDDEN' | 'EMAIL_NOT_VERIFIED';

export type TranscriberGrant =
  | { ok: true }
  | { ok: false; status: 403; code: TranscriberRejection; error: string }
  | { ok: false; status: 401; code: 'NO_SESSION'; error: string };

/**
 * The server-side authorization decision for EVERY transcription entry point
 * (POST /api/process-audio, POST /api/detect-language).
 *
 * Matrix (this is the ONLY boundary that deliberately admits BOTH identities):
 *
 *   - valid ADMIN/owner session (token resolved + role ADMIN + the STORED
 *     ownerEmail is still on the live OWNER_EMAILS allowlist)  -> allowed,
 *     and NO customer email-ownership step is required of an owner.
 *   - USER (customer) session whose inbox was proven with the emailed
 *     single-use link (isEmailVerified)                        -> allowed.
 *   - USER session with an unverified inbox                    -> blocked.
 *   - ADMIN row whose ownerEmail is no longer allowlisted, or an ADMIN row
 *     without a stored owner email (revoked/denied)            -> blocked, so an
 *     arbitrary or demoted user can never transcribe under admin identity.
 *   - unknown/expired/bogus token never reaches here: the caller's auth
 *     middleware rejects the session (401) before this runs.
 */
export function authorizeTranscriber(
  user: Pick<UserRecord, 'role' | 'ownerEmail' | 'email' | 'emailVerified'> | null | undefined,
): TranscriberGrant {
  // Never reached through the HTTP middleware (an unknown/expired token is
  // rejected with 401 before the handler resolves a user) — a defensive guard
  // so a missing user can never be interpreted as a verified customer.
  if (!user) {
    return {
      ok: false,
      status: 401,
      code: 'NO_SESSION',
      error: 'Authentication required.',
    };
  }
  if (user.role === 'ADMIN') {
    // Same live-allowlist re-check as every /api/admin request: editing
    // OWNER_EMAILS revokes transcription access at the same moment.
    if (!isVerifiedOwner(user)) {
      return {
        ok: false,
        status: 403,
        code: 'ADMIN_FORBIDDEN',
        error: 'Forbidden: this administrator session is not a verified owner account.',
      };
    }
    return { ok: true };
  }
  if (!isEmailVerified(user)) {
    return {
      ok: false,
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
      error: 'Please verify your email before continuing.',
    };
  }
  return { ok: true };
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
