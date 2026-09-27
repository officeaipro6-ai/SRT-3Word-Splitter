/**
 * CreditService — ALL money/credit logic is server-side and idempotent.
 *
 * Rules enforced here:
 *   - Balance is always the server value (user-repo), never client-supplied.
 *   - A job can be DEBITED at most once (idempotency key = jobId).
 *   - A job can be REFUNDED at most once, and only if it was charged.
 *   - Never negative: charge fails with INSUFFICIENT_BALANCE if balance < amount.
 *   - Every mutation appends a ledger entry with balanceAfter (audit trail).
 *   - Admin grants/debits record adminUserId + idempotencyKey and never
 *     double-apply on duplicate keys.
 *   - An account with creditMode UNLIMITED (server-assigned, authorised ADMIN
 *     only) bypasses charges entirely: chargeJob produces NO DEBIT transaction
 *     and writes NO fake sentinel balance value.
 */
import { UserRepo, CreditRepo } from '../db/repos';
import { type CreditTransactionRecord, type CreditTransactionType } from '../db/types';

export class CreditError extends Error {
  readonly code:
    | 'INSUFFICIENT_BALANCE'
    | 'ALREADY_CHARGED'
    | 'ALREADY_REFUNDED'
    | 'NOT_CHARGED'
    | 'NO_USER'
    | 'INVALID_AMOUNT'
    | 'MISSING_REASON'
    | 'IDEMPOTENCY_CONFLICT';
  constructor(
    code: CreditError['code'],
    message: string
  ) {
    super(message);
    this.name = 'CreditError';
    this.code = code;
  }
}

export interface ChargeInput {
  userId: string;
  jobId: string;
  amount: number;
  reason: string;
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
  getBalance(userId: string): number;
  isUnlimited(userId: string): boolean;
  getTransactions(userId: string, limit?: number): CreditTransactionRecord[];
  /** Admin grant; idempotent by idempotencyKey. */
  adminGrantCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean };
  /** Admin debit; idempotent by idempotencyKey; never negative. */
  adminDebitCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean };
  getAllTransactions(limit?: number): CreditTransactionRecord[];
  sumGrants(userId: string): number;
  sumUsed(userId: string): number;
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

  getBalance(userId: string): number {
    return this.users.getById(userId)?.credits ?? 0;
  }

  getTransactions(userId: string, limit?: number): CreditTransactionRecord[] {
    return this.credits.listForUser(userId, limit);
  }

  getAllTransactions(limit?: number): CreditTransactionRecord[] {
    return this.credits.listAll(limit);
  }

  sumGrants(userId: string): number {
    return this.credits.sumGrants(userId);
  }

  sumUsed(userId: string): number {
    return this.credits.sumUsed(userId);
  }

  adminGrantCredits(input: AdminCreditInput): { transaction: CreditTransactionRecord; applied: boolean } {
    const existing = this.checkIdempotency(input, 'ADMIN_GRANT');
    if (existing) return { transaction: existing, applied: false };
    return this.applyAdmin(input, 'ADMIN_GRANT');
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
    return this.credits.findByIdempotencyKey(key, input.userId);
  }

  private applyAdmin(
    input: AdminCreditInput,
    type: 'ADMIN_GRANT' | 'ADMIN_DEBIT'
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
      const prior = this.credits.findByIdempotencyKey(key, input.userId);
      if (prior) return { transaction: prior, applied: false };
    }
    // Token hash of the operator's own session (never a secret to them; this is
    // persisted for audit only). Store the admin's user id, not their token.
    const txn = this.apply(
      input.userId,
      type,
      amount,
      reason,
      undefined,
      {
        adminUserId: input.adminUserId,
        idempotencyKey: key,
      }
    );
    return { transaction: txn.transaction, applied: true };
  }

  private apply(
    userId: string,
    type: CreditTransactionType,
    amount: number,
    reason: string,
    jobId: string | undefined,
    extra?: Partial<CreditTransactionRecord>
  ): { transaction: CreditTransactionRecord; charged: boolean } {
    const signed = type === 'DEBIT' || type === 'ADMIN_DEBIT' ? -amount : amount;
    const balanceAfter = this.users.bumpCredits(userId, signed);
    if (balanceAfter === null) {
      throw new CreditError('NO_USER', 'Unknown user.');
    }
    if ((type === 'DEBIT' || type === 'ADMIN_DEBIT') && balanceAfter < 0) {
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
      balanceAfter,
      ...(extra || {}),
    });
    return { transaction: txn, charged: true };
  }
}