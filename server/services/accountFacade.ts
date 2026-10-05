/**
 * Provider-agnostic ASYNC account/session facade.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production runs `DATABASE_PROVIDER=turso`, but the HTTP auth surface was
 * wired to the synchronous `UserRepo` (see `tursoAccountService.ts` for the
 * full failure). `creditFacade.ts` already solves exactly this shape of problem
 * for credits; this file does the same for users and sessions, so the handlers
 * never branch on which provider is mounted.
 *
 * The facade returns Promises from EVERY method, including the ones the JSON
 * provider answers synchronously. That is deliberate: a handler with one
 * `await` is then correct for both providers, and a synchronous throw from the
 * JSON side surfaces as a rejection at that same `await` — which is what makes
 * a single `try/catch` in the route correct rather than provider-dependent.
 *
 * `auth()` middleware MUST go through `resolveToken`/`touchUser`, because
 * Express 4 does not await middleware; see `server.ts`.
 */
import type { UserRecord, UserRole, CreditMode } from '../db/types';
import type { AccountResult } from './accountService';
import { signupAccount, loginAccount, type AccountBroker } from './accountService';
import { UserRepo, type CreditRepo } from '../db/repos';
import type { TursoAccountService } from './tursoAccountService';

export type { AccountResult };

export interface AsyncAccountService {
  // --- accounts ---
  signup(input: { email?: unknown; password?: unknown }, initialCredits?: number): Promise<AccountResult>;
  login(input: { email?: unknown; password?: unknown }): Promise<AccountResult>;
  getByEmail(email: string): Promise<UserRecord | null>;
  getById(userId: string): Promise<UserRecord | null>;

  // --- sessions ---
  /** Resolve a bearer-token hash to its owner, or null when unknown/revoked. */
  getByToken(tokenHash: string): Promise<UserRecord | null>;
  /** Idempotently attach a token hash; never grows tokenHashes on a refresh. */
  addToken(userId: string, tokenHash: string): Promise<boolean>;
  revokeToken(userId: string, tokenHash: string): Promise<boolean>;
  /** Create the anonymous session user behind `/api/session`. */
  createSessionUser(
    tokenHash: string,
    initialCredits: number,
    role?: UserRole,
    creditMode?: CreditMode
  ): Promise<UserRecord>;

  // --- activity + admin bootstrap ---
  touch(userId: string): Promise<void>;
  setRole(userId: string, role: UserRole): Promise<boolean>;
  setCreditMode(userId: string, creditMode: CreditMode): Promise<boolean>;
  setOwnerEmail(userId: string, ownerEmail: string): Promise<boolean>;
  listUsers(): Promise<UserRecord[]>;
  searchUsers(query: string, limit?: number): Promise<UserRecord[]>;
}

/**
 * Wrap the synchronous JSON provider.
 *
 * Each method is `async`, so a synchronous throw becomes a rejection at the
 * caller's `await`. The underlying call still runs on the same tick — the JSON
 * provider's execution and ordering are unchanged.
 */
export function createFileAccountFacade(users: UserRepo, credits?: CreditRepo): AsyncAccountService {
  // `credits` is only needed by signup's opening ledger row. When it is absent
  // the row is skipped rather than faked, so a caller that needs the ledger must
  // pass the repo (the server does).
  const broker: AccountBroker = credits
    ? ({ users, credits } as AccountBroker)
    : ({ users, credits: { add: () => undefined } as unknown as CreditRepo } as AccountBroker);

  return {
    signup: async (input, initialCredits = 0) =>
      signupAccount(broker, input, initialCredits),
    login: async (input) => loginAccount(broker, input),
    getByEmail: async (email) => users.getByEmail(email),
    getById: async (userId) => users.getById(userId),

    getByToken: async (tokenHash) => users.getByToken(tokenHash),
    addToken: async (userId, tokenHash) => users.addToken(userId, tokenHash),
    revokeToken: async (userId, tokenHash) => users.revokeToken(userId, tokenHash),
    createSessionUser: async (tokenHash, initialCredits, role, creditMode) => {
      const user = users.createUser(tokenHash, initialCredits, role, creditMode);
      if (initialCredits > 0 && credits) {
        credits.add({
          userId: user.id,
          amount: initialCredits,
          type: 'CREDIT',
          reason: 'initial_grant',
          jobId: undefined,
          balanceBefore: 0,
          balanceAfter: user.credits,
        });
      }
      return user;
    },

    touch: async (userId) => users.touch(userId),
    setRole: async (userId, role) => users.setRole(userId, role),
    setCreditMode: async (userId, creditMode) => users.setCreditMode(userId, creditMode),
    setOwnerEmail: async (userId, ownerEmail) => users.setOwnerEmail(userId, ownerEmail),
    listUsers: async () => users.listUsers(),
    searchUsers: async (query, limit = 50) => users.searchUsers(query, limit),
  };
}

/** Wrap the async libSQL service. Pure delegation: it already returns Promises. */
export function createTursoAccountFacade(svc: TursoAccountService): AsyncAccountService {
  return {
    signup: (input, initialCredits = 0) => svc.signup(input, initialCredits),
    login: (input) => svc.login(input),
    getByEmail: (email) => svc.getByEmail(email),
    getById: (userId) => svc.getById(userId),

    getByToken: (tokenHash) => svc.getByToken(tokenHash),
    addToken: (userId, tokenHash) => svc.addToken(userId, tokenHash),
    revokeToken: (userId, tokenHash) => svc.revokeToken(userId, tokenHash),
    createSessionUser: (tokenHash, initialCredits, role, creditMode) =>
      svc.createSessionUser(tokenHash, initialCredits, role, creditMode),

    touch: (userId) => svc.touch(userId),
    setRole: (userId, role) => svc.setRole(userId, role),
    setCreditMode: (userId, creditMode) => svc.setCreditMode(userId, creditMode),
    setOwnerEmail: (userId, ownerEmail) => svc.setOwnerEmail(userId, ownerEmail),
    listUsers: () => svc.listUsers(),
    searchUsers: (query, limit = 50) => svc.searchUsers(query, limit),
  };
}