/**
 * CreditService — ALL money/credit logic is server-side and idempotent.
 *
 * Rules enforced here:
 *   - Balance is always the server value (user-repo), never client-supplied.
 *   - A job can be DEBITED at most once (idempotency key = jobId).
 *   - A job can be REFUNDED at most once, and only if it was charged.
 *   - Never negative: charge fails with INSUFFICIENT_BALANCE if balance < amount.
 *   - Every mutation appends a ledger entry with balanceBefore + balanceAfter
 *     (audit trail).
 *   - Admin grants/debits record adminUserId + idempotencyKey and never
 *     double-apply on duplicate keys.
 *   - Manual admin credit changes go through `adminAdjustCredits` and ALWAYS
 *     write type ADMIN_ADJUSTMENT (never a fake PURCHASE), carrying the
 *     server-verified admin email, amount added, balance before/after and the
 *     mandatory reason.
 *   - An account with creditMode UNLIMITED (server-assigned, authorised ADMIN
 *     only) bypasses charges entirely: chargeJob produces NO DEBIT transaction
 *     and writes NO fake sentinel balance value.
 */
import { UserRepo, CreditRepo } from '../db/repos';
import { type CreditTransactionRecord, type CreditTransactionType } from '../db/types';
import { getPlanById } from './creditPolicy';
import { istStamp } from './istTime';
import {
  CreditError,
  REDUCING_TYPES,
  signedAmountFor,
  assertValidAmount,
} from './creditRules';

/**
 * Re-exported so every existing `import { CreditError } from './creditService'`
 * keeps resolving. The class itself now lives in `creditRules.ts` so the JSON and
 * Turso credit backends share ONE definition of the failure taxonomy.
 */
export { CreditError };

export interface ChargeInput {
  userId: string;
  jobId: string;
  amount: number;
  reason: string;
}

/**
 * A VERIFIED payment, as handed to the credit layer by the payment gateway
 * path. Prices are never taken from here: `planId` is resolved against the
 * locked server catalog, so a tampered `amountInr` cannot buy extra credits.
 */
export interface PurchaseInput {
  userId: string;
  planId: string;
  paymentId: string;
  orderId: string;
  amountInr: number;
  currency: string;
  planName: string;
  email?: string;
}

/** Result of an admin credit mutation. `applied:false` means idempotent replay. */
export interface AdminResult {
  transaction: CreditTransactionRecord;
  applied: boolean;
}

export interface ChargeResult {
  transaction: CreditTransactionRecord | null;
  charged: boolean;
  /** True when the account is server-assigned UNLIMITED and charging was skipped. */
  unlimited?: boolean;
}

export interface AdminCreditInput {
  adminUserId: string;
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey?: string;
  /**
   * Server-verified owner email of the acting admin. Resolved from the admin's
   * own stored account, never from the request body.
   */
  adminEmail?: string;
}

export interface CreditService {
  /** Throw CreditError('INSUFFICIENT_BALANCE') unless the user can pay `amount`. */
  assertCanPay(userId: string, amount: number): void;
  /** Charge once per job; idempotent (returns the existing DEBIT if present). */
  chargeJob(input: ChargeInput): ChargeResult;
  /** Refund once per job; no-op if already refunded or never charged. */
  refundFinishedJob(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord; charged: boolean } | null;
  /**
   * Reserve credits for a job WITHOUT spending them yet. The reserved amount is
   * blocked from availability (so concurrent jobs cannot double-spend) and is
   * recorded as a RESERVATION ledger entry. Idempotent per jobId.
   */
  reserveJob(input: ChargeInput): ChargeResult;
  /**
   * Convert a reservation into final consumption (USAGE). Balance is already
   * blocked by the reservation; this only marks it spent. Idempotent; returns
   * null when there is no reservation (UNLIMITED/anonymous/free path).
   */
  settleJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord } | null;
  /**
   * Return an unsettled reservation to the available balance (RELEASE). Never
   * releases a reservation that was converted to USAGE. Idempotent.
   */
  releaseJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord } | null;
  getBalance(userId: string): number;
  isUnlimited(userId: string): boolean;
  getTransactions(userId: string, limit?: number): CreditTransactionRecord[];
  /**
   * THE canonical manual-credit path (admin UI "add credits"). Always writes a
   * single ADMIN_ADJUSTMENT ledger entry recording: amount added, balance before,
   * balance after, the acting admin (id + verified email), a mandatory reason
   * and the timestamp. Never a PURCHASE. Idempotent by idempotencyKey.
   */
  adminAdjustCredits(
    input: AdminCreditInput
  ): { transaction: CreditTransactionRecord; applied: boolean };
  /** Legacy admin grant; now recorded as ADMIN_ADJUSTMENT. */
  adminGrantCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean };
  /** Admin debit; idempotent by idempotencyKey; never negative. */
  adminDebitCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean };
  getAllTransactions(limit?: number): CreditTransactionRecord[];
  /** Unpaginated, unsliced ledger across all users (admin Excel export). */
  getAllTransactionsUnbounded(): CreditTransactionRecord[];
  sumGrants(userId: string): number;
  sumUsed(userId: string): number;
  /**
   * Record a verified purchase. Adds credits to the user and writes a PURCHASE
   * ledger entry with full payment metadata. Idempotent by paymentId.
   */
  recordPurchase(input: {
    userId: string;
    planId: string;
    paymentId: string;
    orderId: string;
    amountInr: number;
    currency: string;
    planName: string;
    email?: string;
  }): { transaction: CreditTransactionRecord; credits: number; alreadyProcessed: boolean };
}

export class FileCreditService implements CreditService {
  constructor(
    private readonly users: UserRepo,
    private readonly credits: CreditRepo
  ) {}

  isUnlimited(userId: string): boolean {
    return this.users.getById(userId)?.creditMode === 'UNLIMITED';
  }

  assertCanPay(userId: string, amount: number): void {
    const user = this.users.getById(userId);
    if (!user) throw new CreditError('NO_USER', 'Unknown user.');
    // Server-assigned UNLIMITED accounts are never blocked by balance.
    if (user.creditMode === 'UNLIMITED') return;
    if (user.credits < amount) {
      throw new CreditError(
        'INSUFFICIENT_BALANCE',
        `Insufficient credit balance (${user.credits}) for a ${amount}-credit charge.`
      );
    }
  }

  chargeJob(input: ChargeInput): ChargeResult {
    if (this.isUnlimited(input.userId)) {
      // Bypass entirely: no DEBIT, balance untouched, no sentinel value.
      return { transaction: null, charged: false, unlimited: true };
    }
    const existing = this.credits.debitForJob(input.userId, input.jobId);
    if (existing) {
      // Idempotent: never double-charge a retried job.
      return { transaction: existing, charged: false };
    }
    this.assertCanPay(input.userId, input.amount);
    return this.apply(input.userId, 'DEBIT', input.amount, input.reason, input.jobId);
  }

  refundFinishedJob(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord; charged: boolean } | null {
    const debit = this.credits.debitForJob(userId, jobId);
    if (!debit) return null; // Never charged -> nothing to refund.
    const refunded = this.credits.refundForJob(userId, jobId);
    if (refunded) return null; // Already refunded -> idempotent no-op.
    return this.apply(userId, 'REFUND', debit.amount, reason, jobId);
  }

  reserveJob(input: ChargeInput): ChargeResult {
    if (this.isUnlimited(input.userId)) {
      return { transaction: null, charged: false, unlimited: true };
    }
    const existing = this.credits.reservationForJob(input.userId, input.jobId);
    if (existing) {
      // Idempotent: never double-reserve a retried request.
      return { transaction: existing, charged: false };
    }
    this.assertCanPay(input.userId, input.amount);
    return this.apply(input.userId, 'RESERVATION', input.amount, input.reason, input.jobId);
  }

  settleJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord } | null {
    const reservation = this.credits.reservationForJob(userId, jobId);
    if (!reservation) return null; // Nothing reserved (UNLIMITED/anonymous/free path).
    const usage = this.credits.usageForJob(userId, jobId);
    if (usage) return { transaction: usage }; // Already settled -> idempotent.
    return { transaction: this.apply(userId, 'USAGE', reservation.amount, reason, jobId).transaction };
  }

  releaseJobReservation(
    userId: string,
    jobId: string,
    reason: string
  ): { transaction: CreditTransactionRecord } | null {
    const reservation = this.credits.reservationForJob(userId, jobId);
    if (!reservation) return null; // Nothing reserved.
    if (this.credits.usageForJob(userId, jobId)) return null; // Consumed — never release.
    const released = this.credits.releaseForJob(userId, jobId);
    if (released) return null; // Already released -> idempotent.
    return { transaction: this.apply(userId, 'RELEASE', reservation.amount, reason, jobId).transaction };
  }

  getBalance(userId: string): number {
    return this.users.getById(userId)?.credits ?? 0;
  }

  getTransactions(userId: string, limit?: number): CreditTransactionRecord[] {
    return this.credits.listForUser(userId, limit);
  }

  getAllTransactions(limit?: number): CreditTransactionRecord[] {
    return this.credits.listAll(limit);
  }

  /**
   * EVERY transaction for EVERY user, unpaginated and unsliced. The admin
   * Excel export uses this so the file is never truncated to the number of
   * rows the dashboard happens to display.
   */
  getAllTransactionsUnbounded(): CreditTransactionRecord[] {
    return this.credits.listAllUnbounded();
  }

  sumGrants(userId: string): number {
    return this.credits.sumGrants(userId);
  }

  sumUsed(userId: string): number {
    return this.credits.sumUsed(userId);
  }

  /**
   * Manual credit adjustment. `amount` is the number of credits ADDED (a
   * deduction is an explicit, separate adminDebitCredits call, so an adjustment
   * can never be mistaken for a purchase or a refund).
   */
  adminAdjustCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean } {
    const key = (input.idempotencyKey || '').trim();
    if (key) {
      const prior = this.credits.findByIdempotencyKey(key, input.userId);
      if (prior) return { transaction: prior, applied: false };
    }
    if (!this.users.getById(input.userId)) {
      throw new CreditError('NO_USER', 'Unknown target user.');
    }
    // Enforce max 2000 credits per admin action (giveaway/adjustment).
    const amount = Math.floor(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new CreditError('INVALID_AMOUNT', 'Amount must be a positive whole number.');
    }
    if (amount > 2000) {
      throw new CreditError('MAX_EXCEEDED', 'Maximum 2,000 credits per admin action');
    }

    // Enforce max 2000 giveaway credits per USER per DAY (IST).
    // Check if this user has already received an admin giveaway today (IST).
    const todayIst = istStamp().date;
    if (this.credits.hasAdminGiveawayToday(input.userId, todayIst)) {
      throw new CreditError('DAILY_LIMIT_EXCEEDED', 'User has already received a giveaway today');
    }

    return this.applyAdmin(input, 'ADMIN_ADJUSTMENT');
  }

  /** Legacy alias kept so older admin clients keep working; records ADMIN_ADJUSTMENT. */
  adminGrantCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean } {
    return this.adminAdjustCredits(input);
  }

  adminDebitCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean } {
    const existing = this.checkIdempotency(input, 'ADMIN_DEBIT');
    if (existing) return { transaction: existing, applied: false };
    if (!this.users.getById(input.userId)) {
      throw new CreditError('NO_USER', 'Unknown target user.');
    }
    const balanceNow = this.getBalance(input.userId);
    if (balanceNow < input.amount) {
      throw new CreditError(
        'INSUFFICIENT_BALANCE',
        `Cannot debit ${input.amount} credits: target balance is only ${balanceNow}.`
      );
    }
    return this.applyAdmin(input, 'ADMIN_DEBIT');
  }

  private checkIdempotency(
    input: AdminCreditInput,
    type: CreditTransactionType
  ): CreditTransactionRecord | null {
    const key = (input.idempotencyKey || '').trim();
    if (!key) return null;
    return this.credits.findByIdempotencyKey(key, input.userId, type);
  }

  private applyAdmin(
    input: AdminCreditInput,
    type: 'ADMIN_ADJUSTMENT' | 'ADMIN_DEBIT'
  ): { transaction: CreditTransactionRecord; applied: boolean } {
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
      const prior = this.credits.findByIdempotencyKey(key, input.userId, type);
      if (prior) return { transaction: prior, applied: false };
    }
    // The acting admin's id and server-verified owner email are recorded for
    // audit. The email is taken from the admin's own account, not the request.
    const txn = this.apply(
      input.userId,
      type,
      amount,
      reason,
      undefined,
      {
        adminUserId: input.adminUserId,
        adminEmail: this.adminEmailFor(input.adminUserId, input.adminEmail),
        idempotencyKey: key,
      }
    );
    return { transaction: txn.transaction, applied: true };
  }

  /** Verified owner email of an admin account (falls back to the stored value). */
  private adminEmailFor(adminUserId: string, claimed?: string): string | undefined {
    const stored = this.users.getById(adminUserId)?.ownerEmail;
    if (stored) return stored;
    return claimed && claimed.trim() ? claimed.trim().toLowerCase() : undefined;
  }

  private apply(
    userId: string,
    type: CreditTransactionType,
    amount: number,
    reason: string,
    jobId: string | undefined,
    extra?: Partial<CreditTransactionRecord>
  ): { transaction: CreditTransactionRecord; charged: boolean } {
    // Amount rules live in creditRules so this provider and the Turso provider
    // cannot drift; call order is preserved (amount checks, then sign, then
    // balance).
    assertValidAmount(type, amount);
    // Sign by type: reducing types block funds, increasing types add funds,
    // zero types (USAGE / FREE_TRIAL) never move the balance (the reservation
    // already blocked USAGE's funds; a free trial is worth 0 credits).
    const signed = signedAmountFor(type, amount);
    const balanceBefore = this.users.getById(userId)?.credits ?? 0;
    const balanceAfter = this.users.bumpCredits(userId, signed);
    if (balanceAfter === null) {
      throw new CreditError('NO_USER', 'Unknown user.');
    }
    if (REDUCING_TYPES.has(type) && balanceAfter < 0) {
      // Roll back the negative mutation so the ledger never goes negative.
      this.users.bumpCredits(userId, -signed);
      throw new CreditError('INSUFFICIENT_BALANCE', 'Insufficient credit balance.');
    }
    const txn = this.credits.add({
      userId,
      amount,
      type,
      reason,
      jobId,
      balanceBefore,
      balanceAfter,
      ...(extra || {}),
    });
    return { transaction: txn, charged: true };
  }

  /**
   * Record a verified purchase. Adds credits to the user and writes a PURCHASE
   * ledger entry with full payment metadata. Idempotent by paymentId.
   */
  recordPurchase(input: {
    userId: string;
    planId: string;
    paymentId: string;
    orderId: string;
    amountInr: number;
    currency: string;
    planName: string;
    email?: string;
  }): { transaction: CreditTransactionRecord; credits: number; alreadyProcessed: boolean } {
    const plan = getPlanById(input.planId);
    if (!plan) {
      throw new CreditError('INVALID_AMOUNT', 'Invalid plan ID.');
    }

    // Idempotency: check if already processed by paymentId
    const existing = this.credits.findByPaymentId(input.paymentId);
    if (existing) {
      const userRecord = this.users.getById(input.userId);
      return { transaction: existing, credits: userRecord?.credits ?? 0, alreadyProcessed: true };
    }

    // Use the apply method to create the PURCHASE transaction
    const { transaction } = this.apply(
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

    const userRecord = this.users.getById(input.userId);
    return { transaction, credits: userRecord?.credits ?? 0, alreadyProcessed: false };
  }
}