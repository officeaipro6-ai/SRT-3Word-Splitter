/**
 * Provider safety state machine (locally stored, audit-friendly).
 *
 * The provider gate is checked IMMEDIATELY BEFORE the ASR call (see
 * `server.ts` /api/process-audio and `queue.ts` processOne) so the app can never
 * start a billable call while the gate is closed.
 *
 * States:
 *   AVAILABLE -> provider may be called.
 *   WARNING   -> repeated provider failures were observed; calls still allowed.
 *   BLOCKED   -> the provider reported an exhausted balance/quota (HTTP 402) or
 *                the operator kill-switch is on. NO ASR call is made, no retry,
 *                no automatic recharge, no paid fallback provider. The state is
 *                persisted, so a restart cannot silently re-enable billing. Only
 *                an explicit admin reset returns it to AVAILABLE.
 *
 * Honesty rules encoded here:
 *   - Balance is `known: false` unless a verified provider balance/quota source
 *     exists. Sarvam exposes no such endpoint in this integration, so no balance
 *     number is displayed and no percentage-based alert is fabricated.
 *   - Only RELIABLE signals change state: a real 402/quota error blocks. Ambiguous
 *     failures never block — they only move AVAILABLE -> WARNING, because a wrong
 *     BLOCKED state would needlessly stop all transcription.
 *   - Nothing here ever charges, recharges or buys anything.
 */
import { config } from '../config';
import { PROVIDER_UNAVAILABLE_MESSAGE } from './creditPolicy';
import { redactSecrets } from './notifications';
import type { ProviderSafetyRecord, ProviderSafetyStatus } from '../db/types';

/** Marker error: a job must not run because provider safety is closed. */
export class ProviderSpendingError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor() {
    super(PROVIDER_UNAVAILABLE_MESSAGE);
    this.name = 'ProviderSpendingError';
  }
}

/** How a provider failure was classified. */
export type ProviderFailureKind =
  | 'QUOTA_EXHAUSTED'
  | 'PAYMENT_REQUIRED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  httpStatus?: number;
  providerCode?: string;
  message: string;
  /** True only for failures that may transition AVAILABLE -> WARNING. */
  transient: boolean;
}

const QUOTA_CODES = new Set([
  'insufficient_quota',
  // The code Sarvam actually returns for an exhausted balance.
  'insufficient_quota_error',
  'insufficient_quota_err',
  'quota_exceeded',
  'exceeded_quota',
  'no_credits',
  'no_credits_available',
  'insufficient_balance',
  'credits_exhausted',
  'payment_required',
]);

/**
 * Classify a provider error from its HTTP status + free-text/code detail.
 * Pure and total: unknown text yields UNKNOWN (never a block).
 *
 * Ordering matters: a 429/rate-limit response is always treated as a TRANSIENT
 * rate limit (even when its text mentions "quota"), because only a reliable
 * 402 / explicit exhausted-quota code may close the gate.
 */
export function classifyProviderFailure(input: {
  status?: number | null;
  code?: string | null;
  message?: string | null;
}): ProviderFailure {
  const status = Number.isFinite(input.status as number) ? Number(input.status) : undefined;
  const code = (input.code || '').trim();
  const message = (input.message || '').trim();
  const lower = `${code} ${message}`.toLowerCase();
  const has402 = status === 402 || /(?:^|\D)402(?:\D|$)/.test(lower);
  const quotaWord =
    /insufficient_quota|no credits available|no_credits|insufficient balance|credits exhausted|quota exhausted/.test(
      lower
    );

  if (status === 401 || status === 403 || /unauthor|forbidden|invalid api.?key/.test(lower)) {
    return {
      kind: 'AUTH',
      httpStatus: status,
      providerCode: code || undefined,
      message: redactSecrets(message || 'Provider rejected the API credentials.'),
      transient: false,
    };
  }
  // Rate limits stay transient: a throttled request must never block the app.
  if (status === 429 || /rate limit|too many requests|rate_limit/.test(lower)) {
    return {
      kind: 'RATE_LIMIT',
      httpStatus: status ?? 429,
      providerCode: code || undefined,
      message: redactSecrets(message || 'Provider rate limit reached.'),
      transient: true,
    };
  }
  if (has402 && quotaWord) {
    return {
      kind: 'QUOTA_EXHAUSTED',
      httpStatus: status ?? 402,
      providerCode: code || undefined,
      message: redactSecrets(message || 'Provider reported insufficient quota / no credits available.'),
      transient: false,
    };
  }
  if (has402) {
    return {
      kind: 'PAYMENT_REQUIRED',
      httpStatus: status ?? 402,
      providerCode: code || undefined,
      message: redactSecrets(message || 'Provider returned HTTP 402 (payment required).'),
      transient: false,
    };
  }
  if (QUOTA_CODES.has(code.toLowerCase())) {
    return {
      kind: 'QUOTA_EXHAUSTED',
      httpStatus: status,
      providerCode: code,
      message: redactSecrets(message || 'Provider reported an exhausted quota code.'),
      transient: false,
    };
  }
  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    /unavailable|overloaded|etimedout|timed out|timeout|econnreset|econnrefused|socket hang up|fetch failed|network/.test(
      lower
    )
  ) {
    return {
      kind: 'UNAVAILABLE',
      httpStatus: status,
      providerCode: code || undefined,
      message: redactSecrets(message || 'Provider temporarily unavailable.'),
      transient: true,
    };
  }
  return {
    kind: 'UNKNOWN',
    httpStatus: status,
    providerCode: code || undefined,
    message: redactSecrets(message || 'Unclassified provider error.'),
    transient: false,
  };
}

/** Pure transition table. Keeping it pure is what makes the gate testable. */
export function nextProviderState(input: {
  current: ProviderSafetyStatus;
  failure: ProviderFailure;
  killSwitch: boolean;
  failuresBefore: number;
  warningAfterFailures: number;
}): ProviderSafetyStatus {
  if (input.killSwitch) return 'BLOCKED';
  if (input.failure.kind === 'QUOTA_EXHAUSTED' || input.failure.kind === 'PAYMENT_REQUIRED') {
    return 'BLOCKED';
  }
  if (input.current === 'BLOCKED') return 'BLOCKED';
  if (input.failure.transient && input.failuresBefore + 1 >= input.warningAfterFailures) {
    return 'WARNING';
  }
  return input.current === 'WARNING' && !input.failure.transient ? 'AVAILABLE' : input.current;
}

/** Public projection of provider safety for the API/UI (no secrets). */
export interface ProviderSafetyView {
  provider: string;
  status: ProviderSafetyStatus;
  reason: 'KILL_SWITCH' | 'QUOTA_EXHAUSTED' | null;
  blocked: boolean;
  reasonText: string;
  lastError: string | null;
  lastHttpStatus: number | null;
  lastErrorAt: string | null;
  blockedAt: string | null;
  updatedAt: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastResetAt: string | null;
  lastResetBy: string | null;
  balance: {
    known: boolean;
    percent: number | null;
    source: string | null;
    unit: string | null;
    updatedAt: string | null;
  };
  message: string;
  /** Audit trail of state changes, newest first. */
  history: ProviderSafetyEvent[];
  /** TRUE when no verified provider balance/quota API is configured. */
  balanceSourceAvailable: boolean;
}

export interface ProviderSafetyEvent {
  at: string;
  from: ProviderSafetyStatus;
  to: ProviderSafetyStatus;
  reason: string;
  kind: string;
  httpStatus?: number;
  notified: boolean;
}

const MAX_HISTORY = 20;

export class ProviderSafetyService {
  private events: ProviderSafetyEvent[] = [];

  constructor(private readonly deps: {
    get: () => ProviderSafetyRecord;
    patch: (patch: Partial<ProviderSafetyRecord>) => ProviderSafetyRecord;
    setStatus: (
      provider: string,
      status: ProviderSafetyStatus,
      reason: ProviderSafetyRecord['reason'],
      patch?: Partial<ProviderSafetyRecord>
    ) => ProviderSafetyRecord;
    notifyOwner: (payload: {
      event: 'PROVIDER_WARNING' | 'PROVIDER_BLOCKED' | 'QUOTA_EXHAUSTED' | 'LOW_BALANCE';
      provider: string;
      reason: string;
      lastError?: string;
      lastHttpStatus?: number | null;
      balancePercent?: number | null;
      balanceSource?: string | null;
    }) => { delivered: boolean } | void;
    log?: {
      info(message: string, fields?: Record<string, unknown>): void;
      warn(message: string, fields?: Record<string, unknown>): void;
      error(message: string, fields?: Record<string, unknown>): void;
    };
    provider: string;
    now?: () => string;
  }) {}

  private get now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /** Effective status, including the env kill-switch (which forces BLOCKED). */
  effectiveStatus(record = this.deps.get()): ProviderSafetyStatus {
    if (config.providerSpendingProtection) return 'BLOCKED';
    return record.status;
  }

  /** The raw persisted record (not the kill-switch-adjusted status). */
  snapshot(): ProviderSafetyRecord {
    return this.deps.get();
  }

  isBlocked(): boolean {
    return this.effectiveStatus() === 'BLOCKED';
  }

  /** Throws ProviderSpendingError when the active provider must not be called. */
  assertProviderSpendingAllowed(): void {
    if (this.isBlocked()) throw new ProviderSpendingError();
  }

  /** Record a provider failure and apply the state machine. */
  reportFailure(failure: ProviderFailure): ProviderSafetyView {
    const current = this.deps.get();
    const failuresBefore = current.consecutiveFailures ?? 0;
    const killSwitch = config.providerSpendingProtection;
    const next = nextProviderState({
      current: current.status,
      failure,
      killSwitch,
      failuresBefore,
      warningAfterFailures: config.providerWarningAfterFailures,
    });
    const reason: ProviderSafetyRecord['reason'] = killSwitch
      ? 'KILL_SWITCH'
      : next === 'BLOCKED'
        ? 'QUOTA_EXHAUSTED'
        : null;
    const at = this.now;
    const record = this.deps.setStatus(current.provider || this.deps.provider, next, reason, {
      lastError: failure.message.slice(0, 400),
      lastHttpStatus: failure.httpStatus,
      lastErrorAt: at,
      updatedAt: at,
      blockedAt: next === 'BLOCKED' ? current.blockedAt ?? at : current.blockedAt,
      consecutiveFailures: failuresBefore + 1,
    });
    const notified = this.notify(next, failure, record);
    this.pushEvent({
      at,
      from: current.status,
      to: next,
      reason: reason ?? failure.kind,
      kind: failure.kind,
      httpStatus: failure.httpStatus,
      notified,
    });
    this.deps.log?.warn('provider safety: failure reported', {
      provider: record.provider,
      status: next,
      kind: failure.kind,
      httpStatus: failure.httpStatus,
    });
    return this.view(record);
  }

  /** Record a successful provider call (clears the transient failure counter). */
  /**
   * A successful call proves the provider is working again, so a WARNING is
   * cleared. BLOCKED is sticky: only the audited manual reset leaves it.
   */
  reportSuccess(): ProviderSafetyView {
    const current = this.deps.get();
    const at = this.now;
    const patch: Partial<ProviderSafetyRecord> = {
      consecutiveFailures: 0,
      lastSuccessAt: at,
      updatedAt: at,
    };
    if (current.status === 'WARNING') {
      patch.status = 'AVAILABLE';
      patch.reason = null;
      patch.blockedAt = undefined;
      patch.lastHttpStatus = undefined;
    }
    const record = this.deps.patch(patch);
    if (current.status === 'WARNING') {
      this.pushEvent({
        at,
        from: current.status,
        to: 'AVAILABLE',
        reason: 'provider_recovered',
        kind: 'SUCCESS',
        notified: false,
      });
    }
    return this.view(record);
  }

  /**
   * Manual admin reset. This is the ONLY way out of BLOCKED: the operator has
   * added credits to the provider account and confirms it. It never changes
   * credit balances, never calls the provider, and is fully audited.
   */
  resetToAvailable(adminEmail: string): ProviderSafetyView {
    const current = this.deps.get();
    const at = this.now;
    const record = this.deps.setStatus(current.provider || this.deps.provider, 'AVAILABLE', null, {
      consecutiveFailures: 0,
      blockedAt: undefined,
      lastResetAt: at,
      lastResetBy: adminEmail,
      updatedAt: at,
    });
    this.pushEvent({
      at,
      from: current.status,
      to: 'AVAILABLE',
      reason: 'admin_reset',
      kind: 'ADMIN_RESET',
      notified: false,
    });
    this.deps.log?.info('provider safety: admin reset to AVAILABLE', {
      provider: record.provider,
      by: adminEmail,
    });
    return this.view(record);
  }

  /** Full, safe-to-serve view (no credentials, no balance invention). */
  view(record = this.deps.get()): ProviderSafetyView {
    const status = this.effectiveStatus(record);
    const blocked = status === 'BLOCKED';
    const reason = config.providerSpendingProtection
      ? 'KILL_SWITCH'
      : blocked
        ? (record.reason ?? 'QUOTA_EXHAUSTED')
        : null;
    const reasonText = blocked
      ? config.providerSpendingProtection
        ? 'Operator kill-switch is on (PROVIDER_SPENDING_PROTECTION).'
        : 'Provider reported exhausted credits/quota (HTTP 402). Transcription is stopped until an admin resets the provider.'
      : status === 'WARNING'
        ? 'Repeated provider failures were observed. Calls still allowed.'
        : 'No known provider problem.';
    return {
      provider: record.provider,
      status,
      reason,
      blocked,
      reasonText,
      lastError: record.lastError ?? null,
      lastHttpStatus: record.lastHttpStatus ?? null,
      lastErrorAt: record.lastErrorAt ?? null,
      blockedAt: record.blockedAt ?? null,
      updatedAt: record.updatedAt,
      consecutiveFailures: record.consecutiveFailures ?? 0,
      lastSuccessAt: record.lastSuccessAt ?? null,
      lastResetAt: record.lastResetAt ?? null,
      lastResetBy: record.lastResetBy ?? null,
      balance: {
        known: record.balance?.known === true,
        percent: record.balance?.known === true ? (record.balance.percent ?? null) : null,
        source: record.balance?.known === true ? (record.balance.source ?? null) : null,
        unit: record.balance?.known === true ? (record.balance.unit ?? null) : null,
        updatedAt: record.balance?.known === true ? (record.balance.updatedAt ?? null) : null,
      },
      message: blocked ? PROVIDER_UNAVAILABLE_MESSAGE : 'ok',
      history: this.events.map((e) => ({ ...e })),
      balanceSourceAvailable: record.balance?.known === true,
    };
  }

  private notify(
    next: ProviderSafetyStatus,
    failure: ProviderFailure,
    record: ProviderSafetyRecord
  ): boolean {
    const event =
      failure.kind === 'QUOTA_EXHAUSTED'
        ? 'QUOTA_EXHAUSTED'
        : next === 'BLOCKED'
          ? 'PROVIDER_BLOCKED'
          : next === 'WARNING'
            ? 'PROVIDER_WARNING'
            : null;
    if (!event) return false;
    try {
      const res = this.deps.notifyOwner({
        event,
        provider: record.provider,
        reason:
          next === 'BLOCKED'
            ? 'Provider is BLOCKED: no ASR calls, no retry, no automatic recharge.'
            : `Provider entered ${next} after ${failure.kind}.`,
        lastError: failure.message,
        lastHttpStatus: failure.httpStatus ?? null,
        balancePercent: record.balance?.known === true ? (record.balance.percent ?? null) : null,
        balanceSource: record.balance?.known === true ? (record.balance.source ?? null) : null,
      });
      return Boolean(res && res.delivered === true);
    } catch (err) {
      this.deps.log?.error('provider safety: notifyOwner failed', {
        error: redactSecrets((err as Error)?.message),
      });
      return false;
    }
  }

  private pushEvent(event: ProviderSafetyEvent) {
    this.events.unshift(event);
    if (this.events.length > MAX_HISTORY) this.events.length = MAX_HISTORY;
  }
}
