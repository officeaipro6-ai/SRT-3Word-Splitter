/**
 * Normal email/password USER account layer — fully separate from admin auth.
 *
 * Scope is deliberately minimal:
 *  - signup creates a plain USER account (role USER, creditMode NORMAL) with the
 *    same accounting the existing session bootstrap uses (initial credits + an
 *    'initial_grant' ledger entry, freeTrialsUsed = 0). Granting ADMIN is never
 *    part of this path and never derived from a client claim.
 *  - login verifies the scrypt password hash and records lastLoginAt.
 *  - Nothing here reads or requires ADMIN_BOOTSTRAP_TOKEN.
 *
 * Pure (unit-testable) on purpose, in the same style as server/services/freeTrialPolicy.ts.
 */
import { isPasswordLengthValid, verifyPassword, hashPassword } from './password.ts';
import type { UserRepo, CreditRepo } from '../db/repos.ts';
import type { UserRecord } from '../db/types.ts';
import { isEmailVerified } from './emailVerification.ts';

export type AccountErrorCode =
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'VALIDATION';

export interface AccountResult {
  ok: boolean;
  code?: AccountErrorCode;
  error?: string;
  user?: UserRecord;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

/** Normalize to the canonical stored form (trim + lower-case). */
export function normalizeAccountEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidAccountEmail(value: unknown): boolean {
  const email = normalizeAccountEmail(value);
  return Boolean(email && email.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(email));
}

function failure(code: AccountErrorCode, error: string): AccountResult {
  return { ok: false, code, error };
}

function success(user: UserRecord): AccountResult {
  return { ok: true, user };
}

export interface AccountBroker {
  users: UserRepo;
  credits: CreditRepo;
}

/**
 * Validate + normalize credentials. Returns a shared VALIDATION failure for
 * empty/malformed emails and out-of-policy passwords, before touching the store.
 */
function parseCredentials(
  input: { email?: unknown; password?: unknown }
): { email: string; password: string } | AccountResult {
  const email = normalizeAccountEmail(input.email);
  if (!isValidAccountEmail(email)) {
    return failure('VALIDATION', 'A valid email address is required.');
  }
  if (!isPasswordLengthValid(input.password)) {
    return failure('VALIDATION', 'Password must be between 8 and 256 characters.');
  }
  return { email, password: input.password as string };
}

/** Create a new account + seed ledger. Never throws on domain failures. */
export function signupAccount(
  broker: AccountBroker,
  input: { email?: unknown; password?: unknown },
  initialCredits = 0
): AccountResult {
  const creds = parseCredentials(input);
  if ('ok' in creds) return creds;
  const { email, password } = creds;

  if (broker.users.getByEmail(email)) {
    return failure('EMAIL_TAKEN', 'An account with this email already exists. Please sign in.');
  }

  const user = broker.users.createAccount({
    email,
    passwordHash: hashPassword(password),
    initialCredits,
    // New accounts must prove email ownership before they may consume credits or
    // trigger provider processing. Pre-existing accounts (created before this
    // field existed) normalise to `emailVerified: true` in both stores.
    emailVerified: false,
  });
  if (initialCredits > 0) {
    broker.credits.add({
      userId: user.id,
      amount: initialCredits,
      type: 'CREDIT',
      reason: 'initial_grant',
      jobId: undefined,
      balanceBefore: 0,
      balanceAfter: user.credits,
    });
  }
  return success(user);
}

/**
 * Email + password login — returns INVALID_CREDENTIALS for unknown email AND wrong password alike.
 *
 * A correct credential pair on an UNVERIFIED account returns EMAIL_NOT_VERIFIED
 * instead of a session: the password is real but ownership of the email is not
 * yet proven, so no token is issued and `lastLoginAt` is NOT stamped. The
 * account is not revealed as wrong — it is simply not yet usable.
 */
export function loginAccount(broker: AccountBroker, input: { email?: unknown; password?: unknown }): AccountResult {
  const creds = parseCredentials(input);
  if ('ok' in creds) return creds;
  const { email, password } = creds;

  const user = broker.users.getByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return failure('INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  if (!isEmailVerified(user)) {
    return {
      ok: false,
      code: 'EMAIL_NOT_VERIFIED',
      error: 'Please verify your email before continuing.',
      user,
    };
  }
  broker.users.recordLogin(user.id);
  return success(user);
}