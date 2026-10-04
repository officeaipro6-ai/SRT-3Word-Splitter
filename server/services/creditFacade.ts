/**
 * Provider-agnostic ASYNC credit facade.
 *
 * WHY THIS EXISTS
 * ---------------
 * `FileCreditService` (JSON) is synchronous and must stay that way: it is used
 * inside synchronous view builders and synchronous recovery loops, and changing
 * it would ripple through every call site. `TursoCreditService` is necessarily
 * async because it awaits libSQL over the network.
 *
 * Express 4 does NOT catch a rejected promise from a route handler. If handlers
 * were pointed straight at the async service, every `CreditError` — which today
 * produces a clean 402/400/404 — would become an UNHANDLED PROMISE REJECTION:
 * no response, no status mapping, and potentially a process-level crash. That is
 * the specific hazard this facade plus `asyncRoute()` exist to remove.
 *
 * WHAT THIS GUARANTEES
 * --------------------
 *   - ONE interface for both providers, so call sites never branch on provider.
 *   - The JSON path stays byte-for-byte behaviourally identical. Each wrapper is
 *     an `async` function, so a synchronous `CreditError` thrown by the JSON
 *     provider surfaces as a rejection at the same `await` point a Turso error
 *     would — which is what makes a single handler try/catch correct for both.
 *   - Nothing is swallowed: every method rejects, and `asyncRoute()` guarantees
 *     the rejection reaches Express error middleware.
 *   - Errors keep their identity. `CreditError` is a shared class re-exported
 *     from `creditRules`, so `instanceof CreditError` works across both
 *     providers and the existing per-handler status mapping keeps working.
 */
import type { CreditTransactionRecord, UserRecord } from '../db/types';
import type {
  ChargeInput,
  ChargeResult,
  AdminCreditInput,
  PurchaseInput,
  AdminResult,
} from './creditService';
import { FileCreditService, CreditError } from './creditService';
import { TursoCreditService } from './tursoCreditService';

export { CreditError };

/**
 * Outcome of recording a verified purchase.
 *
 * Deliberately NOT an `AdminResult`: a purchase has no `applied` flag because
 * its idempotency marker is `alreadyProcessed` (the gateway replay case).
 */
export interface PurchaseResult {
  transaction: CreditTransactionRecord;
  credits: number;
  alreadyProcessed: boolean;
}

export interface RegisterUserInput {
  userId: string;
  initialCredits: number;
  role?: string;
  creditMode?: string;
  freeTrialsUsed?: number;
}

/** The opening ledger row written alongside a newly registered user. */
export type RegistrationLedgerInput = Omit<
  CreditTransactionRecord,
  'id' | 'createdAt' | 'userId' | 'balanceBefore' | 'balanceAfter'
> & { balanceBefore: number; balanceAfter: number };

/**
 * Raised when a credit operation that only the Turso provider implements is
 * invoked on the JSON provider.
 *
 * It is a named class so a call site can catch it deliberately, and it is thrown
 * (not faked) so that an incomplete wiring surfaces immediately instead of
 * quietly producing a user with no ledger row or an untracked free trial.
 */
export class CreditJsonProviderUnsupportedError extends Error {
  readonly code = 'JSON_PROVIDER_UNSUPPORTED';
  constructor(operation: string) {
    super(
      `credits.${operation}() is not available on the JSON provider in this stage. ` +
        `JSON registration still runs through accountService.signupAccount, and the ` +
        `free-trial counter through users.incrementFreeTrialsUsed. Implement the JSON ` +
        `side before routing this call through the facade.`,
    );
    this.name = 'CreditJsonProviderUnsupportedError';
  }
}

/**
 * The single credit surface the HTTP layer is allowed to use.
 *
 * Every method returns a Promise. Money-MOVING methods are the reason this
 * exists and are documented as such; the read methods are here so a call site
 * never has to know which provider is mounted.
 */
export interface AsyncCreditService {
  // --- reads (never queued behind the write mutex) ---
  isUnlimited(userId: string): Promise<boolean>;
  getBalance(userId: string): Promise<number>;
  getTransactions(userId: string, limit?: number): Promise<CreditTransactionRecord[]>;
  getAllTransactions(limit?: number): Promise<CreditTransactionRecord[]>;
  getAllTransactionsUnbounded(): Promise<CreditTransactionRecord[]>;
  sumGrants(userId: string): Promise<number>;
  sumUsed(userId: string): Promise<number>;

  // --- money movement: each of these is one transaction or one atomic statement ---
  assertCanPay(userId: string, amount: number): Promise<void>;
  chargeJob(input: ChargeInput): Promise<ChargeResult>;
  reserveJob(input: ChargeInput): Promise<ChargeResult>;
  settleJobReservation(
    userId: string,
    jobId: string,
    reason: string,
  ): Promise<{ transaction: CreditTransactionRecord } | null>;
  releaseJobReservation(
    userId: string,
    jobId: string,
    reason: string,
  ): Promise<{ transaction: CreditTransactionRecord } | null>;
  refundFinishedJob(
    userId: string,
    jobId: string,
    reason: string,
  ): Promise<{ transaction: CreditTransactionRecord | null; charged: boolean } | null>;
  recordPurchase(input: PurchaseInput): Promise<PurchaseResult>;
  adminAdjustCredits(input: AdminCreditInput): Promise<AdminResult>;
  adminGrantCredits(input: AdminCreditInput): Promise<AdminResult>;
  adminDebitCredits(input: AdminCreditInput): Promise<AdminResult>;
  registerUserWithCredits(
    user: UserRecord,
    initial: RegistrationLedgerInput,
  ): Promise<CreditTransactionRecord>;
  incrementFreeTrialsUsed(userId: string): Promise<number | null>;
}

/**
 * Wrap the synchronous JSON service.
 *
 * Every method is `async`, so a synchronous throw becomes a rejection. The
 * underlying call still happens synchronously on the same tick — nothing about
 * the JSON provider's execution or ordering changes.
 */
export function createFileCreditFacade(svc: FileCreditService): AsyncCreditService {
  return {
    isUnlimited: async (userId) => svc.isUnlimited(userId),
    getBalance: async (userId) => svc.getBalance(userId),
    getTransactions: async (userId, limit) => svc.getTransactions(userId, limit),
    getAllTransactions: async (limit) => svc.getAllTransactions(limit),
    getAllTransactionsUnbounded: async () => svc.getAllTransactionsUnbounded(),
    sumGrants: async (userId) => svc.sumGrants(userId),
    sumUsed: async (userId) => svc.sumUsed(userId),

    assertCanPay: async (userId, amount) => svc.assertCanPay(userId, amount),
    chargeJob: async (input) => svc.chargeJob(input),
    reserveJob: async (input) => svc.reserveJob(input),
    settleJobReservation: async (userId, jobId, reason) =>
      svc.settleJobReservation(userId, jobId, reason),
    releaseJobReservation: async (userId, jobId, reason) =>
      svc.releaseJobReservation(userId, jobId, reason),
    refundFinishedJob: async (userId, jobId, reason) =>
      svc.refundFinishedJob(userId, jobId, reason),
    recordPurchase: async (input) => svc.recordPurchase(input),
    adminAdjustCredits: async (input) => svc.adminAdjustCredits(input),
    adminGrantCredits: async (input) => svc.adminGrantCredits(input),
    adminDebitCredits: async (input) => svc.adminDebitCredits(input),

// Registration and free-trial counting are NOT routed through the credit
    // facade for the JSON provider: signup still goes through
    // accountService.signupAccount -> UserRepo.createUser/createAccount, and the
    // free-trial counter through users.incrementFreeTrialsUsed. That path is
    // deliberately left untouched.
    //
    // Throwing a named error (rather than returning a plausible-looking value)
    // is intentional: if someone later routes signup through this facade without
    // implementing the JSON side, they get an immediate, unambiguous failure
    // instead of silently creating an account with no ledger row. Turso already
    // does both atomically inside one unit of work.
    registerUserWithCredits: async () => {
      throw new CreditJsonProviderUnsupportedError('registerUserWithCredits');
    },
    // `number | null` is part of the interface contract, so null is a legitimate
    // "not tracked by this provider" answer. Returning it keeps this a harmless
    // no-op; the real counter is users.incrementFreeTrialsUsed.
    incrementFreeTrialsUsed: async () => null,
  };
}

/** Wrap the async libSQL service. Pure delegation: it already returns Promises. */
export function createTursoCreditFacade(svc: TursoCreditService): AsyncCreditService {
  return {
    isUnlimited: (userId) => svc.isUnlimited(userId),
    getBalance: (userId) => svc.getBalance(userId),
    getTransactions: (userId, limit) => svc.getTransactions(userId, limit ?? 25),
    getAllTransactions: (limit) => svc.getAllTransactions(limit ?? 200),
    getAllTransactionsUnbounded: () => svc.getAllTransactionsUnbounded(),
    sumGrants: (userId) => svc.sumGrants(userId),
    sumUsed: (userId) => svc.sumUsed(userId),

assertCanPay: async (userId, amount) => {
      // UNLIMITED parity: the JSON service returns early for creditMode
      // 'UNLIMITED' (FileCreditService.assertCanPay). Without this check an
      // UNLIMITED Turso user would be rejected for insufficient balance while the
      // identical JSON account sails through — provider divergence that only
      // appears once the database is swapped.
      if (await svc.isUnlimited(userId)) return;
      const balance = await svc.getBalance(userId);
      if (balance < amount) {
        throw new CreditError(
          'INSUFFICIENT_BALANCE',
          `Insufficient credit balance (${balance}) for a ${amount}-credit charge.`,
        );
      }
    },
    chargeJob: (input) => svc.chargeJob(input),
    reserveJob: (input) => svc.reserveJob(input),
    settleJobReservation: (userId, jobId, reason) =>
      svc.settleJobReservation(userId, jobId, reason),
    releaseJobReservation: (userId, jobId, reason) =>
      svc.releaseJobReservation(userId, jobId, reason),
    refundFinishedJob: (userId, jobId, reason) => svc.refundFinishedJob(userId, jobId, reason),
    recordPurchase: (input) => svc.recordPurchase(input),
    adminAdjustCredits: (input) => svc.adminAdjustCredits(input),
    adminGrantCredits: (input) => svc.adminGrantCredits(input),
    adminDebitCredits: (input) => svc.adminDebitCredits(input),
    registerUserWithCredits: (user, initial) => svc.registerUserWithCredits(user, initial),
    incrementFreeTrialsUsed: (userId) => svc.incrementFreeTrialsUsed(userId),
  };
}