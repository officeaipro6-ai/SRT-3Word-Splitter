/**
 * Transaction-scoped credit service for the Turso/libSQL provider.
 *
 * This is the async counterpart of `FileCreditService`. It exists because the JSON
 * service is only atomic by accident: `apply()` reads the balance, mutates it and
 * appends the ledger row in one synchronous tick, and its "never negative" rule is
 * a read-check-write that no other writer can interleave with. On libSQL each of
 * those steps is a separate await, so the same code becomes a lost-update race, a
 * TOCTOU overdraft, or a balance that moved without its ledger row.
 *
 * What makes this version safe:
 *   - Every mutating flow runs inside ONE `unitOfWork()`, so the balance change
 *     and its ledger row commit together or not at all.
 *   - The balance change is a single conditional `UPDATE ... RETURNING`
 *     (see `TursoScope.applyCreditDelta`). The non-negative rule is enforced by
 *     the database, and `balanceBefore`/`balanceAfter` are recovered from the same
 *     row, so the audit trail can only describe a transition that really happened.
 *   - Idempotency is a check performed INSIDE that same write transaction. libSQL
 *     serialises write transactions, so no second writer can slip a conflicting
 *     row in between the check and the insert.
 *   - The credit rules themselves are imported from `creditRules.ts`, the same
 *     module `FileCreditService` uses, so the two providers cannot disagree about
 *     what a DEBIT or a RELEASE means.
 *
 * WIRING STATUS: this service is fully implemented and tested, but deliberately
 * NOT yet injected in `server.ts`. See the Stage 5D report for the concrete
 * blocker (Express 4 does not catch rejected handler promises, so making the
 * synchronous `credits.*` calls async would turn today's clean CreditError
 * responses into unhandled rejections). No call site was converted.
 */
import type { TursoStore } from '../db/tursoStore';
import type { TursoScope } from '../db/tursoScope';
import type { CreditTransactionRecord, CreditTransactionType, UserRecord } from '../db/types';
import { getPlanById } from './creditPolicy';
import { istStamp } from './istTime';
import {
  CreditError,
  REDUCING_TYPES,
  INCREASING_TYPES,
  signedAmountFor,
  assertValidAmount,
} from './creditRules';
import type { ChargeInput, ChargeResult, AdminCreditInput } from './creditService';

export type { ChargeInput, ChargeResult, AdminCreditInput };

export class TursoCreditService {
  constructor(private readonly store: TursoStore) {}

  // ------------------------------------------------------------- plumbing ---

  /** Run `fn` in one write transaction: commit on resolve, rollback on throw. */
  private uow<T>(fn: (scope: TursoScope) => Promise<T>): Promise<T> {
    return this.store.unitOfWork(fn);
  }

  /**
   * The single point where money moves.
   *
   * Mirrors `FileCreditService.apply()` step for step, but the balance mutation
   * and its ledger row are one atomic unit and the non-negative guard is the
   * WHERE clause rather than a post-hoc compensation.
   */
  private async apply(
    scope: TursoScope,
    userId: string,
    type: CreditTransactionType,
    amount: number,
    reason: string,
    jobId: string | undefined,
    extra?: Partial<CreditTransactionRecord>
  ): Promise<{ transaction: CreditTransactionRecord; charged: boolean }> {
    assertValidAmount(type, amount);
    const signed = signedAmountFor(type, amount);

    // Reducing types may not push the balance below zero; the guard is part of
    // the UPDATE, so a concurrent writer cannot slip past it.
    const result = await scope.applyCreditDelta(userId, signed, {
      allowNegative: !REDUCING_TYPES.has(type),
    });

    if (result.status === 'no_user') {
      throw new CreditError('NO_USER', 'Unknown user.');
    }
    if (result.status === 'insufficient') {
      // Nothing was written: the WHERE clause matched no row, so there is nothing
      // to compensate. JSON needed a compensating write here; SQL does not.
      throw new CreditError('INSUFFICIENT_BALANCE', 'Insufficient credit balance.');
    }

    const transaction = await scope.addTransaction({
      userId,
      amount,
      type,
      reason,
      jobId,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      ...(extra || {}),
    } as Omit<CreditTransactionRecord, 'id' | 'createdAt'>);
    return { transaction, charged: true };
  }

  /**
   * Pre-flight balance check, kept so the caller-facing error message stays
   * identical to the JSON provider's. The SQL guard in `apply()` remains the
   * actual enforcement; this only preserves the diagnostic text.
   */
  private async assertCanPay(
    scope: TursoScope,
    userId: string,
    amount: number
  ): Promise<void> {
    const user = await scope.getUserById(userId);
    if (!user) throw new CreditError('NO_USER', 'Unknown user.');
    if (user.creditMode === 'UNLIMITED') return;
    if (user.credits < amount) {
      throw new CreditError(
        'INSUFFICIENT_BALANCE',
        `Insufficient credit balance (${user.credits}) for a ${amount}-credit charge.`
      );
    }
  }

  private async isUnlimitedIn(scope: TursoScope, userId: string): Promise<boolean> {
    return (await scope.getUserById(userId))?.creditMode === 'UNLIMITED';
  }

  /** Verified owner email of the acting admin, mirroring FileCreditService. */
  private async adminEmailFor(
    scope: TursoScope,
    adminUserId: string,
    claimed?: string
  ): Promise<string | undefined> {
    const stored = (await scope.getUserById(adminUserId))?.ownerEmail;
    if (stored) return stored;
    return claimed && claimed.trim() ? claimed.trim().toLowerCase() : undefined;
  }

  // ------------------------------------------------------------ read-only ---

  async isUnlimited(userId: string): Promise<boolean> {
    const user = await this.store.rootScope().getUserById(userId);
    return user?.creditMode === 'UNLIMITED';
  }

  async getBalance(userId: string): Promise<number> {
    const user = await this.store.rootScope().getUserById(userId);
    return user?.credits ?? 0;
  }

  /**
   * Reads run on the ROOT scope, never inside a write transaction, so they are
   * not queued behind the write mutex and cannot slow down or be slowed by
   * concurrent credits. Order is pinned (newest first, id as a stable
   * tiebreak) so repeated calls cannot disagree about "the latest 25".
   */
  async getTransactions(userId: string, limit = 25): Promise<CreditTransactionRecord[]> {
    return this.store.getTransactionsByUser(userId, limit) as Promise<CreditTransactionRecord[]>;
  }

  async getAllTransactions(limit = 200): Promise<CreditTransactionRecord[]> {
    return this.store.getAllTransactions(limit) as Promise<CreditTransactionRecord[]>;
  }

  async getAllTransactionsUnbounded(): Promise<CreditTransactionRecord[]> {
    return this.store.getAllTransactionsUnbounded() as Promise<CreditTransactionRecord[]>;
  }

  /**
   * Lifetime credits granted, matching FileCreditService.sumGrants: the increasing
   * types only. Aggregated by the SCOPE (which owns the SQL), so business logic
   * still never issues raw statements, and computed in SQL rather than by loading
   * the whole ledger because this feeds the admin user list for every row.
   */
  async sumGrants(userId: string): Promise<number> {
    return this.store.rootScope().sumAmountByTypes(userId, [...INCREASING_TYPES]);
  }

  /** Lifetime credits consumed, matching FileCreditService.sumUsed. */
  async sumUsed(userId: string): Promise<number> {
    return this.store.rootScope().sumAmountByTypes(userId, [...REDUCING_TYPES]);
  }

  // ---------------------------------------------- flow C: job charge ------

  /**
   * Charge a job exactly once.
   *
   * Boundary: the idempotency read (`debitForJob`) and the balance + ledger
   * writes share one transaction, so a retried request cannot produce a second
   * DEBIT and two concurrent requests cannot both pass the check.
   */
  async chargeJob(input: ChargeInput): Promise<ChargeResult> {
    return this.uow(async (scope) => {
      if (await this.isUnlimitedIn(scope, input.userId)) {
        return { transaction: null, charged: false, unlimited: true };
      }
      const existing = await scope.getTransactionByJobAndType(input.userId, input.jobId, 'DEBIT');
      if (existing) {
        return { transaction: existing, charged: false };
      }
      await this.assertCanPay(scope, input.userId, input.amount);
      return this.apply(scope, input.userId, 'DEBIT', input.amount, input.reason, input.jobId);
    });
  }

  // ------------------------------------------- flow D: reservation ----------

  /** Reserve credits for a queued job; idempotent per jobId. */
  async reserveJob(input: ChargeInput): Promise<ChargeResult> {
    return this.uow(async (scope) => {
      if (await this.isUnlimitedIn(scope, input.userId)) {
        return { transaction: null, charged: false, unlimited: true };
      }
      const existing = await scope.getTransactionByJobAndType(
        input.userId,
        input.jobId,
        'RESERVATION'
      );
      if (existing) {
        return { transaction: existing, charged: false };
      }
      await this.assertCanPay(scope, input.userId, input.amount);
      return this.apply(scope, input.userId, 'RESERVATION', input.amount, input.reason, input.jobId);
    });
  }

  // ------------------------------------- flow E: settle / usage -------------

  /**
   * Convert a reservation into consumed credits.
   *
   * A USAGE row moves the balance by zero (the reservation already blocked the
   * funds), so the only writes here are the ledger row and its zero-delta balance
   * stamp. Still one transaction, because "settle twice" must be impossible.
   */
  async settleJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): Promise<{ transaction: CreditTransactionRecord } | null> {
    return this.uow(async (scope) => {
      const reservation = await scope.getTransactionByJobAndType(userId, jobId, 'RESERVATION');
      if (!reservation) return null;
      const usage = await scope.getTransactionByJobAndType(userId, jobId, 'USAGE');
      if (usage) return { transaction: usage };
      const { transaction } = await this.apply(scope, userId, 'USAGE', reservation.amount, reason, jobId);
      return { transaction };
    });
  }

  // ------------------------------------------ flow F: release ---------------

  /** Release an unconsumed reservation, returning the blocked credits. */
  async releaseJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): Promise<{ transaction: CreditTransactionRecord } | null> {
    return this.uow(async (scope) => {
      const reservation = await scope.getTransactionByJobAndType(userId, jobId, 'RESERVATION');
      if (!reservation) return null;
      if (await scope.getTransactionByJobAndType(userId, jobId, 'USAGE')) return null;
      const released = await scope.getTransactionByJobAndType(userId, jobId, 'RELEASE');
      if (released) return null;
      const { transaction } = await this.apply(
        scope,
        userId,
        'RELEASE',
        reservation.amount,
        reason,
        jobId
      );
      return { transaction };
    });
  }

  // ------------------------------------------- flow G: refund ---------------

  /**
   * Refund a finished job exactly once, and only if it was charged.
   *
   * The debit lookup, the "already refunded?" check, the credit-back and the
   * REFUND row are one transaction: a double webhook cannot refund twice.
   */
  async refundFinishedJob(
    userId: string,
    jobId: string,
    reason: string
  ): Promise<{ transaction: CreditTransactionRecord; charged: boolean } | null> {
    return this.uow(async (scope) => {
      const debit = await scope.getTransactionByJobAndType(userId, jobId, 'DEBIT');
      if (!debit) return null;
      const refunded = await scope.getTransactionByJobAndType(userId, jobId, 'REFUND');
      if (refunded) return null;
      return this.apply(scope, userId, 'REFUND', debit.amount, reason, jobId);
    });
  }

  // ------------------------------------- flow A: verified purchase -----------

  /**
   * Credit a verified purchase, idempotent by gateway paymentId.
   *
   * The `paymentId` check and the grant share one write transaction, which is
   * what makes "never apply the same payment twice" true even when a gateway
   * delivers two webhooks for one payment at the same moment. This is the
   * canonical use of the `paymentId` idempotency key.
   */
  async recordPurchase(input: {
    userId: string;
    planId: string;
    paymentId: string;
    orderId: string;
    amountInr: number;
    currency: string;
    planName: string;
    email?: string;
  }): Promise<{ transaction: CreditTransactionRecord; credits: number; alreadyProcessed: boolean }> {
    const plan = getPlanById(input.planId);
    if (!plan) {
      throw new CreditError('INVALID_AMOUNT', 'Invalid plan ID.');
    }

    return this.uow(async (scope) => {
      const existing = await scope.getTransactionByPaymentId(input.paymentId);
      if (existing) {
        const userRecord = await scope.getUserById(input.userId);
        return { transaction: existing, credits: userRecord?.credits ?? 0, alreadyProcessed: true };
      }
      const { transaction } = await this.apply(
        scope,
        input.userId,
        'PURCHASE',
        plan.credits,
        'purchase',
        undefined,
        {
          paymentId: input.paymentId,
          paymentStatus: 'captured',
          packageId: input.planId,
        }
      );
      const userRecord = await scope.getUserById(input.userId);
      return { transaction, credits: userRecord?.credits ?? 0, alreadyProcessed: false };
    });
  }

  // ---------------------------------- flows B / H / I: admin + signup -------

  /**
   * Manual admin credit change (also the giveaway path). Always writes
   * ADMIN_ADJUSTMENT, never a fake PURCHASE.
   *
   * Boundary: the idempotencyKey check, the per-day giveaway cap, the balance
   * change and the ledger row are one transaction, so two simultaneous giveaway
   * requests cannot both pass the daily cap.
   */
  async adminAdjustCredits(input: AdminCreditInput): Promise<{
    transaction: CreditTransactionRecord;
    applied: boolean;
  }> {
    return this.uow(async (scope) => {
      const key = (input.idempotencyKey || '').trim();
      if (key) {
        const prior = await scope.getTransactionByIdempotencyKey(key, input.userId);
        if (prior) return { transaction: prior, applied: false };
      }
      if (!(await scope.getUserById(input.userId))) {
        throw new CreditError('NO_USER', 'Unknown target user.');
      }
      const amount = Math.floor(Number(input.amount));
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new CreditError('INVALID_AMOUNT', 'Amount must be a positive whole number.');
      }
      if (amount > 2000) {
        throw new CreditError('MAX_EXCEEDED', 'Maximum 2,000 credits per admin action');
      }
      const todayIst = istStamp().date;
      if (await scope.hasAdminGiveawayToday(input.userId, todayIst)) {
        throw new CreditError('DAILY_LIMIT_EXCEEDED', 'User has already received a giveaway today');
      }
      return this.applyAdmin(scope, input, 'ADMIN_ADJUSTMENT');
    });
  }

  /** Legacy alias kept so older admin clients keep working. */
  async adminGrantCredits(input: AdminCreditInput): Promise<{
    transaction: CreditTransactionRecord;
    applied: boolean;
  }> {
    return this.adminAdjustCredits(input);
  }

  /** Admin debit; may not drive the balance negative. */
  async adminDebitCredits(input: AdminCreditInput): Promise<{
    transaction: CreditTransactionRecord;
    applied: boolean;
  }> {
    return this.uow(async (scope) => {
      const existing = await this.checkIdempotency(scope, input, 'ADMIN_DEBIT');
      if (existing) return { transaction: existing, applied: false };
      if (!(await scope.getUserById(input.userId))) {
        throw new CreditError('NO_USER', 'Unknown target user.');
      }
      const balanceNow = (await scope.getUserById(input.userId))?.credits ?? 0;
      if (balanceNow < input.amount) {
        throw new CreditError(
          'INSUFFICIENT_BALANCE',
          `Cannot debit ${input.amount} credits: target balance is only ${balanceNow}.`
        );
      }
      return this.applyAdmin(scope, input, 'ADMIN_DEBIT');
    });
  }

  private async checkIdempotency(
    scope: TursoScope,
    input: AdminCreditInput,
    type: CreditTransactionType
  ): Promise<CreditTransactionRecord | null> {
    const key = (input.idempotencyKey || '').trim();
    if (!key) return null;
    return scope.getTransactionByIdempotencyKey(key, input.userId, type);
  }

  private async applyAdmin(
    scope: TursoScope,
    input: AdminCreditInput,
    type: 'ADMIN_ADJUSTMENT' | 'ADMIN_DEBIT'
  ): Promise<{ transaction: CreditTransactionRecord; applied: boolean }> {
    const amount = Math.floor(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new CreditError('INVALID_AMOUNT', 'Amount must be a positive whole number.');
    }
    const reason = (input.reason || '').trim();
    if (reason.length < 1) {
      throw new CreditError('MISSING_REASON', 'An audit reason is required for admin credit operations.');
    }
    const key = (input.idempotencyKey || '').trim().slice(0, 200) || undefined;
    if (key) {
      const prior = await scope.getTransactionByIdempotencyKey(key, input.userId, type);
      if (prior) return { transaction: prior, applied: false };
    }
    const { transaction } = await this.apply(
      scope,
      input.userId,
      type,
      amount,
      reason,
      undefined,
      {
        adminUserId: input.adminUserId,
        adminEmail: await this.adminEmailFor(scope, input.adminUserId, input.adminEmail),
        idempotencyKey: key,
      }
    );
    return { transaction, applied: true };
  }

  /**
   * Flow H: create an account and its opening credit ledger row atomically.
   *
   * `transactions.userId` has a FOREIGN KEY to `users(id)`, so the user row must
   * be inserted first; doing both inside one transaction means a signup can never
   * leave an orphan ledger entry behind.
   */
  async registerUserWithCredits(
    user: UserRecord,
    initial: Omit<CreditTransactionRecord, 'id' | 'createdAt' | 'userId' | 'balanceBefore' | 'balanceAfter'> & {
      balanceBefore: number;
      balanceAfter: number;
    }
  ): Promise<CreditTransactionRecord> {
    return this.uow(async (scope) => {
      await scope.createUser(user);
      return scope.addTransaction({
        ...initial,
        userId: user.id,
        balanceBefore: initial.balanceBefore,
        balanceAfter: initial.balanceAfter,
      } as Omit<CreditTransactionRecord, 'id' | 'createdAt'>);
    });
  }

  /**
   * Flow I: count one more successful free trial.
   *
   * Atomic increment, so two concurrent free-trial requests cannot both read the
   * same counter and under-count, which would hand out extra free allowances.
   */
  async incrementFreeTrialsUsed(userId: string): Promise<number | null> {
    return this.uow(async (scope) => scope.incrementFreeTrialsUsed(userId));
  }
}