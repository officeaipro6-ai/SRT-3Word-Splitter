/**
 * HARD provider-spending protection layer.
 *
 * Purpose: prevent UNCONTROLLED spending from the operator's Sarvam/provider
 * account while the app is not yet generating revenue. This is NOT a promise
 * that external API usage is free — it is a hard software kill-switch plus a
 * quota-quarantine so no job is ever started when the server already knows the
 * provider cannot bill/process it.
 *
 * Two independent gates:
 *  1. KILL SWITCH   — operator sets PROVIDER_SPENDING_PROTECTION=1 in .env. When
 *                     on, NO provider job is ever started for ANY caller
 *                     (including ADMIN/UNLIMITED accounts). There is no bypass.
 *  2. QUOTA QUARANTINE — when a provider call reports that its balance/quota is
 *                     exhausted (HTTP 402 insufficient_quota / "no credits
 *                     available"), the server quarantines the provider for a
 *                     short cooldown. During the cooldown NO new API job starts;
 *                     the user sees "Processing temporarily unavailable. Please
 *                     try again later."
 *
 * Guarantees:
 *   - No automatic recharge is ever initiated.
 *   - No card/bank/account is ever charged automatically.
 *   - No provider-credit purchase is ever triggered automatically.
 *   - A user request can NEVER force an API call while a gate is active.
 *   - No hidden fallback provider that could create another bill: the check is
 *     applied in front of the ACTIVE provider call, before any provider is
 *     contacted, and there is no retry loop for quota failures.
 */
import { config } from '../config';
import { PROVIDER_UNAVAILABLE_MESSAGE } from './creditPolicy';

/** Marker error: a job must not run because spending protection is active. */
export class ProviderSpendingError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor() {
    super(PROVIDER_UNAVAILABLE_MESSAGE);
    this.name = 'ProviderSpendingError';
  }
}

interface SpendingState {
  blocked: boolean;
  reason: 'kill_switch' | 'quota_cooldown' | null;
  quotaUntilIso: string | null;
}

let quotaUntilIso: string | null = null;

/** Live protection state (both gates considered). */
export function providerSpendingState(): SpendingState {
  const kill = config.providerSpendingProtection;
  const quarantine = quotaUntilIso !== null && quotaUntilIso > new Date().toISOString();
  if (kill) return { blocked: true, reason: 'kill_switch', quotaUntilIso };
  if (quarantine) return { blocked: true, reason: 'quota_cooldown', quotaUntilIso };
  return { blocked: false, reason: null, quotaUntilIso };
}

/** Throws ProviderSpendingError when the active provider must not be called. */
export function assertProviderSpendingAllowed(): void {
  if (providerSpendingState().blocked) throw new ProviderSpendingError();
}

/**
 * Record that the provider reported exhausted quota. No retry loop is created:
 * the quarantine simply makes subsequent requests fail fast (no API call).
 */
export function reportProviderQuotaExhausted(nowIso: string = new Date().toISOString()): string {
  const until = new Date(Date.parse(nowIso) + config.providerQuotaCooldownMs).toISOString();
  quotaUntilIso = until;
  return until;
}

/** Test hook: clear the quarantine so tests start clean. */
export function resetProviderSafetyForTests(): void {
  quotaUntilIso = null;
}