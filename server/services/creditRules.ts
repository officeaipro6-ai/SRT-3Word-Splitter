/**
 * Credit invariants shared by EVERY credit backend (JSON and Turso).
 *
 * This module is deliberately PURE: no store, no repository, no clock, no I/O.
 * It exists so that the JSON service (`FileCreditService`) and the transaction-
 * scoped Turso service (`TursoCreditService`) cannot drift apart on the rules that
 * decide whether money moves. A rule that lived in only one of them would be a
 * rule that silently changed behaviour when the provider changed.
 *
 * Nothing here invents a pricing or credit policy: every value is copied from the
 * existing `FileCreditService` implementation, which remains the reference.
 */
import type { CreditTransactionType } from '../db/types';

/**
 * The credit failure taxonomy. Lives here (rather than in `creditService.ts`) so
 * that `creditRules.ts` can throw it without importing the service that imports
 * it. `creditService.ts` re-exports the class, so every existing
 * `import { CreditError } from './creditService'` keeps working unchanged.
 */
export class CreditError extends Error {
  readonly code:
    | 'INSUFFICIENT_BALANCE'
    | 'ALREADY_CHARGED'
    | 'ALREADY_REFUNDED'
    | 'NOT_CHARGED'
    | 'NO_USER'
    | 'INVALID_AMOUNT'
    | 'MISSING_REASON'
    | 'IDEMPOTENCY_CONFLICT'
    // Already thrown by the existing admin paths in both providers; the union
    // was simply missing them, which made those `throw` sites fail to typecheck.
    | 'MAX_EXCEEDED'
    | 'DAILY_LIMIT_EXCEEDED';
  constructor(
    code: CreditError['code'],
    message: string
  ) {
    super(message);
    this.name = 'CreditError';
    this.code = code;
  }
}

/** Transaction types that REDUCE the balance when applied. */
export const REDUCING_TYPES: ReadonlySet<CreditTransactionType> = new Set<CreditTransactionType>([
  'DEBIT',
  'ADMIN_DEBIT',
  'RESERVATION',
]);

/** Transaction types that INCREASE the balance when applied. */
export const INCREASING_TYPES: ReadonlySet<CreditTransactionType> = new Set<CreditTransactionType>([
  'CREDIT',
  'REFUND',
  'RELEASE',
  'PURCHASE',
  'ADMIN_GRANT',
  'ADMIN_ADJUSTMENT',
]);

/**
 * The signed delta a ledger row of `type` moves the balance by.
 *
 * `USAGE` and `FREE_TRIAL` are deliberately zero: a reservation already blocked
 * USAGE's funds (otherwise settling would both consume and charge), and a free
 * trial is worth 0 credits.
 */
export function signedAmountFor(type: CreditTransactionType, amount: number): number {
  if (REDUCING_TYPES.has(type)) return -amount;
  if (INCREASING_TYPES.has(type)) return amount;
  return 0;
}

/** True when applying `type` must never drive the balance below zero. */
export function isReducing(type: CreditTransactionType): boolean {
  return REDUCING_TYPES.has(type);
}

/**
 * Validate an amount for `type`, throwing the canonical `CreditError`.
 *
 * Only FREE_TRIAL may carry a zero amount: every other row represents real
 * money movement and a 0 would be an unauditable ledger entry.
 */
export function assertValidAmount(type: CreditTransactionType, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CreditError('INVALID_AMOUNT', 'Amount must be a non-negative whole number.');
  }
  if (amount === 0 && type !== 'FREE_TRIAL') {
    throw new CreditError('INVALID_AMOUNT', 'Only FREE_TRIAL ledger records may carry a zero amount.');
  }
}