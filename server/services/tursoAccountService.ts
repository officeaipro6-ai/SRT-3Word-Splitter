/**
 * Async email/password ACCOUNT service for the Turso/libSQL provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * `accountService.ts` (JSON provider) is synchronous and works through
 * `UserRepo`, which is built on two whole-database primitives: `snapshot()`
 * and `mutate()`. `TursoStore` provides NEITHER in that shape:
 *
 *   - `snapshot()` returns `Promise<DbShape>`, so `snapshot().users` is
 *     `undefined` and `snapshot().users.find(...)` throws
 *     `TypeError: Cannot read properties of undefined (reading 'find')`.
 *   - `mutate()` throws by design ("cannot persist a whole-database snapshot").
 *
 * Wiring `new UserRepo(tursoStore)` therefore produced a hard 500 on BOTH
 * `/api/account/signup` and `/api/account/login` in production (and on the
 * `auth()` middleware's `users.getByToken`). This service is the Turso half of
 * the split that `creditFacade.ts` already performs for credits: the same
 * domain rules, expressed against per-entity async store calls.
 *
 * WHAT IS DELIBERATELY SHARED
 * ---------------------------
 * Password hashing, credential validation, email normalization and the
 * `EMAIL_TAKEN` / `INVALID_CREDENTIALS` / `VALIDATION` result contract all come
 * from `accountService.ts` and `password.ts`. This file adds persistence only,
 * so the two providers cannot drift on validation or on which failure a user
 * sees. Role assignment is still impossible here: `createAccount` hardcodes
 * `role: 'USER'`, exactly like the JSON path.
 *
 * ATOMICITY
 * ---------
 * Signup writes the user row and its `initial_grant` ledger entry inside ONE
 * `unitOfWork`, so a failure can never leave an account with no opening balance
 * (or a balance with no account). Login's `lastLoginAt` write is a single
 * UPDATE. Token add/revoke are read-modify-write on the `tokenHashes` JSON
 * array, matching the JSON provider's per-user semantics.
 */
import type { TursoStore } from '../db/tursoStore';
import type { TursoScope } from '../db/tursoScope';
import type { UserRecord, CreditTransactionRecord } from '../db/types';
import {
  signupAccount,
  loginAccount,
  type AccountBroker,
  type AccountResult,
} from './accountService';
import type { UserRepo } from '../db/repos';
import type { CreditRepo } from '../db/repos';
import { normalizeAccountEmail } from './accountService';
import { issueVerificationToken, hashVerificationToken } from './emailVerification';

/**
 * The persistence surface this service needs. Declared structurally (not as
 * `TursoStore`) so the account rules can be exercised against a real libSQL
 * engine without the rest of the store, and so nothing here can reach a method
 * this service has no reason to call.
 */
export interface TursoAccountStore {
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserByToken(tokenHash: string): Promise<UserRecord | null>;
  getUserByEmailVerifyTokenHash(tokenHash: string): Promise<UserRecord | null>;
  createUser(user: UserRecord): Promise<void>;
  updateUser(id: string, patch: Partial<UserRecord>): Promise<void>;
  getUsers(): Promise<UserRecord[]>;
  unitOfWork<T>(fn: (scope: TursoScope) => Promise<T>): Promise<T>;
}

function newAccountId(): string {
  // Same shape `repos.newId()` produces for the JSON provider (uuid v4), so an
  // id is provider-independent for anything that stores or logs it.
  return globalThis.crypto.randomUUID();
}

/** The user record both providers persist for a fresh signup. */
function buildAccountUser(email: string, passwordHash: string, initialCredits: number, now: string): UserRecord {
  return {
    id: newAccountId(),
    tokenHashes: [],
    credits: initialCredits,
    role: 'USER',
    creditMode: 'NORMAL',
    email,
    passwordHash,
    createdAt: now,
    lastSeenAt: now,
    lastLoginAt: now,
    freeTrialsUsed: 0,
    emailVerified: false,
  };
}

export class TursoAccountService {
  constructor(private readonly store: TursoAccountStore) {}

  // ------------------------------------------------------------- reads ---

  getByEmail(email: string): Promise<UserRecord | null> {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return Promise.resolve(null);
    return this.store.getUserByEmail(normalized);
  }

  getById(userId: string): Promise<UserRecord | null> {
    return this.store.getUserById(userId);
  }

  getByToken(tokenHash: string): Promise<UserRecord | null> {
    return this.store.getUserByToken(tokenHash);
  }

  // ------------------------------------------------------------ signup ---

  /**
   * Create a plain USER account plus its opening `initial_grant` ledger row in
   * one transaction.
   *
   * Reuses `signupAccount`'s validation and `EMAIL_TAKEN` / `VALIDATION`
   * contract by running it against an in-memory broker (see
   * `validateWithLocalBroker` below) and then persisting the resulting record.
   */
  async signup(input: { email?: unknown; password?: unknown }, initialCredits = 0): Promise<AccountResult> {
    const email = normalizeAccountEmail(input.email);
    const existing = email ? await this.store.getUserByEmail(email) : null;

    // Validate + hash exactly once, through the shared pure rules.
    const validated = signupAccount(this.localBroker(existing), input, initialCredits);
    if (!validated.ok || !validated.user) return validated;

    // `validated.user` is the record the shared rule would have persisted; the
    // only field this service re-derives is the id/timestamps, which are set
    // here so both providers produce the same shape.
    const record: UserRecord = {
      ...validated.user,
      id: validated.user.id || newAccountId(),
      tokenHashes: [],
      lastLoginAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      role: 'USER',
      creditMode: 'NORMAL',
    };
    await this.store.unitOfWork(async (scope) => {
      await scope.createUser(record);
      if (initialCredits > 0) {
        const txn: Omit<CreditTransactionRecord, 'id' | 'createdAt' | 'userId'> = {
          type: 'CREDIT',
          amount: initialCredits,
          reason: 'initial_grant',
          balanceBefore: 0,
          balanceAfter: initialCredits,
        };
        await scope.addTransaction({ ...txn, userId: record.id } as never);
      }
    });
    return { ok: true, user: record };
  }

  /**
   * A broker whose reads are answered by whatever this service already loaded,
   * so the shared pure rules can be reused without a second round trip and
   * without the synchronous `UserRepo` the Turso provider cannot support.
   *
   * `signupAccount` only reads `getByEmail` and writes through
   * `createAccount` + `credits.add`; both writes are discarded here because the
   * real persist happens in `signup`'s unit of work. What is kept is the
   * validation result, the `EMAIL_TAKEN` check and the scrypt hash.
   */
  private localBroker(existing: UserRecord | null): AccountBroker {
    const users = {
      getByEmail: () => existing,
      createAccount: (opts: {
        email: string;
        passwordHash: string;
        initialCredits?: number;
        emailVerified?: boolean;
      }) =>
        buildAccountUser(opts.email, opts.passwordHash, opts.initialCredits ?? 0, new Date().toISOString()),
      // `loginAccount` calls this after a successful verifyPassword. The real
      // `lastLoginAt` write is `login()`'s own UPDATE against the store, so this
      // stand-in only has to exist and report that it ran.
      recordLogin: () => true,
    } as unknown as UserRepo;
    const credits = { add: () => undefined } as unknown as CreditRepo;
    return { users, credits };
  }

  // ------------------------------------------------------------- login ---

  /**
   * Verify an email/password pair and stamp `lastLoginAt` on success.
   *
   * A missing account and a wrong password are indistinguishable to the caller
   * (`INVALID_CREDENTIALS`), which `loginAccount` already guarantees; the
   * scrypt comparison runs against the stored hash exactly as on the JSON
   * provider.
   */
  async login(input: { email?: unknown; password?: unknown }): Promise<AccountResult> {
    const email = normalizeAccountEmail(input.email);
    const user = email ? await this.store.getUserByEmail(email) : null;
    if (!user) {
      // Still run the shared validator so a malformed request gets VALIDATION
      // rather than being reported as bad credentials.
      return loginAccount(this.localBroker(null), input);
    }
    const result = loginAccount(this.localBroker(user), input);
    if (!result.ok || !result.user) return result;
    const now = new Date().toISOString();
    await this.store.updateUser(user.id, { lastLoginAt: now, lastSeenAt: now });
    return { ok: true, user: { ...user, lastLoginAt: now, lastSeenAt: now } };
  }

  // ------------------------------------------------------------ tokens ---

  /**
   * Attach a bearer-token hash to a user, idempotently, and refresh lastSeenAt.
   *
   * Matches `UserRepo.addToken`: a hash that is already present is not appended
   * a second time, so a browser refresh cannot grow `tokenHashes` without bound.
   */
  async addToken(userId: string, tokenHash: string): Promise<boolean> {
    const user = await this.store.getUserById(userId);
    if (!user) return false;
    const hashes = Array.isArray(user.tokenHashes) ? [...user.tokenHashes] : [];
    if (!hashes.includes(tokenHash)) hashes.push(tokenHash);
    const lastSeenAt = new Date().toISOString();
    await this.store.updateUser(userId, { tokenHashes: hashes, lastSeenAt });
    return true;
  }

  /** Revoke one token so it can never authenticate again. */
  async revokeToken(userId: string, tokenHash: string): Promise<boolean> {
    const user = await this.store.getUserById(userId);
    if (!user) return false;
    const hashes = Array.isArray(user.tokenHashes) ? [...user.tokenHashes] : [];
    const idx = hashes.indexOf(tokenHash);
    if (idx === -1) return false;
    hashes.splice(idx, 1);
    await this.store.updateUser(userId, { tokenHashes: hashes });
    return true;
  }

  /** Record activity. Best-effort: never fails an otherwise-valid request. */
  async touch(userId: string): Promise<void> {
    await this.store.updateUser(userId, { lastSeenAt: new Date().toISOString() });
  }

  // ------------------------------------------------ email ownership verification

  /**
   * Issue a fresh single-use verification token for an account and persist only
   * its sha256 hash + expiry + send time. Returns the RAW token (for the
   * transport to email) or null when the user does not exist.
   */
  async issueVerification(userId: string): Promise<string | null> {
    const user = await this.store.getUserById(userId);
    if (!user) return null;
    const token = issueVerificationToken();
    await this.store.updateUser(userId, {
      emailVerifyTokenHash: token.hash,
      emailVerifyExpiresAt: token.expiresAt,
      emailVerifyLastSentAt: new Date().toISOString(),
    });
    return token.raw;
  }

  /** Find the account holding an outstanding verification-token hash, or null. */
  getByEmailVerificationTokenHash(tokenHash: string): Promise<UserRecord | null> {
    if (!tokenHash) return Promise.resolve(null);
    return this.store.getUserByEmailVerifyTokenHash(tokenHash);
  }

  /**
   * Mark a USER account verified AND consume the token in the same write, so an
   * already-spent link can never verify anything again (single use).
   */
  async markEmailVerified(userId: string): Promise<boolean> {
    const user = await this.store.getUserById(userId);
    if (!user) return false;
    await this.store.updateUser(userId, {
      emailVerified: true,
      emailVerifyTokenHash: undefined,
      emailVerifyExpiresAt: undefined,
    });
    return true;
  }

  /**
   * Invalidate the outstanding token (a consumed/discarded link) while keeping
   * the last-sent timestamp so the resend cooldown still applies.
   */
  async clearVerificationToken(userId: string): Promise<boolean> {
    const user = await this.store.getUserById(userId);
    if (!user) return false;
    await this.store.updateUser(userId, {
      emailVerifyTokenHash: undefined,
      emailVerifyExpiresAt: undefined,
    });
    return true;
  }

  // -------------------------------------------- admin bootstrap fields ---

  /** Promote/demote a role. Server-side only; never from client input. */
  async setRole(userId: string, role: UserRecord['role']): Promise<boolean> {
    if (!(await this.store.getUserById(userId))) return false;
    await this.store.updateUser(userId, { role });
    return true;
  }

  async setCreditMode(userId: string, creditMode: UserRecord['creditMode']): Promise<boolean> {
    if (!(await this.store.getUserById(userId))) return false;
    await this.store.updateUser(userId, { creditMode });
    return true;
  }

  /** Persist the server-verified owner email for a bootstrapped admin. */
  async setOwnerEmail(userId: string, ownerEmail: string): Promise<boolean> {
    const email = ownerEmail.trim().toLowerCase();
    if (!email) return false;
    if (!(await this.store.getUserById(userId))) return false;
    await this.store.updateUser(userId, { ownerEmail: email });
    return true;
  }

  /**
   * Create an anonymous session user (the `/api/session` bootstrap path), with
   * its opening ledger row, in one transaction.
   */
  async createSessionUser(
    tokenHash: string,
    initialCredits: number,
    role: UserRecord['role'] = 'USER',
    creditMode: UserRecord['creditMode'] = 'NORMAL'
  ): Promise<UserRecord> {
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: newAccountId(),
      tokenHashes: [tokenHash],
      credits: initialCredits,
      role,
      creditMode,
      createdAt: now,
      lastSeenAt: now,
      freeTrialsUsed: 0,
    };
    await this.store.unitOfWork(async (scope) => {
      await scope.createUser(user);
      if (initialCredits > 0) {
        await scope.addTransaction({
          userId: user.id,
          type: 'CREDIT',
          amount: initialCredits,
          reason: 'initial_grant',
          balanceBefore: 0,
          balanceAfter: initialCredits,
        } as never);
      }
    });
    return user;
  }

  /**
   * Consume exactly one free trial and return the new count.
   *
   * POLICY IS UNCHANGED: this only persists the increment. Whether a trial is
   * allowed at all is still decided by `freeTrialPolicy.ts` and
   * `config.freeTrialLimit` before this is ever called. Implemented as one
   * conditional SQL UPDATE (`COALESCE(freeTrialsUsed,0) + 1 ... RETURNING`), so
   * concurrent requests cannot lose an increment the way a read-modify-write
   * would.
   *
   * Returns null when the user does not exist, matching
   * `UserRepo.incrementFreeTrialsUsed`.
   */
  async incrementFreeTrialsUsed(userId: string): Promise<number | null> {
    return this.store.unitOfWork((scope) => scope.incrementFreeTrialsUsed(userId));
  }

  /**
   * Append the zero-amount FREE_TRIAL ledger row.
   *
   * Audit only: `amount` is 0 and no balance changes. Recorded so the admin
   * transaction log explains a trial-count change. Written through the same
   * transaction helper as signup's opening grant so it cannot half-apply.
   */
  async recordFreeTrialUsage(userId: string, balanceAfter: number): Promise<void> {
    await this.store.unitOfWork(async (scope) => {
      await scope.addTransaction({
        userId,
        type: 'FREE_TRIAL',
        amount: 0,
        reason: 'free_trial_transcription',
        balanceBefore: balanceAfter,
        balanceAfter,
      } as never);
    });
  }

  /** Admin listing: most recently active first. */
  async listUsers(): Promise<UserRecord[]> {
    const all = await this.store.getUsers();
    return all
      .slice()
      .sort((a, b) => (b.lastSeenAt || b.createdAt).localeCompare(a.lastSeenAt || a.createdAt));
  }

  /** Admin search over id / account email / verified owner email. */
  async searchUsers(query: string, limit = 50): Promise<UserRecord[]> {
    const q = (query || '').trim().toLowerCase();
    const all = await this.listUsers();
    if (!q) return all.slice(0, limit);
    return all
      .filter(
        (u) =>
          u.id.toLowerCase().includes(q) ||
          (typeof u.email === 'string' && u.email.toLowerCase().includes(q)) ||
          (typeof u.ownerEmail === 'string' && u.ownerEmail.toLowerCase().includes(q))
      )
      .slice(0, limit);
  }
}