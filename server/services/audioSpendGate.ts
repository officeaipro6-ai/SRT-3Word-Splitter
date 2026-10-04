/**
 * Pre-job credit gate for the legacy /api/process-audio pipeline.
 *
 * Decides, BEFORE any provider call, whether a request may spend the operator's
 * ASR quota, and — when payment is required — reserves the exact number of
 * credits (1 credit = 1 rounded-up minute) from the user's SERVER-side wallet.
 *
 * Order of checks (mirrors the product spec):
 *   1. provider safety gate (hard layer — no caller is exempt)
 *   2. identity / free-trial eligibility (exactly 2 successful free trials,
 *      each covering at most 2 minutes of measured audio)
 *   3. required credits from the SERVER-MEASURED duration
 *   4. available balance (server value only — client-supplied values never used)
 *
 * If the decision is not OK the PROVIDER IS NEVER CALLED and NO credits move.
 * Reservation happens at the very end, only when the decision is PAID, so a
 * rejected request cannot touch the wallet.
 */
import {
  exceedsFreeTrialDuration,
  FREE_TRIAL_DURATION_LIMIT_CODE,
  FREE_TRIAL_DURATION_LIMIT_MESSAGE,
  isFreeTrialExempt,
  freeTrialsUsedFor,
} from './freeTrialPolicy';
import {
  CANNOT_MEASURE_DURATION_MESSAGE,
  creditsForDuration,
  NOT_ENOUGH_CREDITS_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
} from './creditPolicy';
import type { UserRecord } from '../db/types';

export type SpendKind =
  | 'PROVIDER_UNAVAILABLE'
  | 'NEED_CREDITS'
  | 'NO_DURATION'
  | 'FREE_TRIAL'
  | 'FREE_TRIAL_DURATION_LIMIT'
  | 'PAID'
  | 'UNLIMITED'
  | 'ANONYMOUS';

export interface AudioSpendContext {
  /** The server-resolved user, or null for anonymous (token-less) callers. */
  user: Pick<UserRecord, 'id' | 'creditMode' | 'freeTrialsUsed' | 'credits'> | null;
  /** SERVER-measured decoded wall-clock duration (seconds) of the upload. */
  measuredDurationSeconds: number;
  freeTrialLimit: number;
  /**
   * TRUE when the locally stored provider safety state is BLOCKED (402 /
   * insufficient quota / operator kill-switch). Supplied by the caller from the
   * persisted state, which keeps this decision function pure and testable.
   */
  providerBlocked?: boolean;
}

export interface SpendDecision {
  ok: boolean;
  kind: SpendKind;
  status?: number;
  code?: string;
  message?: string;
  requiredCredits?: number;
  measuredDurationSeconds?: number;
  freeTrialsUsed?: number;
  freeTrialLimit?: number;
  freeTrialsRemaining?: number;
  /** Server-maintained balance at decision time (PAID/NEED_CREDITS only). */
  balance?: number;
}

function baseUsage(used: number, limit: number) {
  return {
    freeTrialsUsed: used,
    freeTrialLimit: limit,
    freeTrialsRemaining: limit > 0 ? Math.max(0, limit - used) : 0,
  };
}

/** Pure decision — no wallet mutation. Never calls the provider. */
export function decideAudioSpend(ctx: AudioSpendContext): SpendDecision {
  // Provider safety gate first: no caller is exempt, and no credit is touched.
  if (ctx.providerBlocked === true) {
    return {
      ok: false,
      kind: 'PROVIDER_UNAVAILABLE',
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
      message: PROVIDER_UNAVAILABLE_MESSAGE,
    };
  }

  // Anonymous legacy callers keep the pre-existing unrestricted behaviour
  // (documented known limitation). The provider safety gate above still applies
  // to them, so a blocked provider stops ALL spending.
  if (!ctx.user) return { ok: true, kind: 'ANONYMOUS' };

  const used = freeTrialsUsedFor(ctx.user);
  // Operator/UNLIMITED accounts are exempt from trial + credit accounting but
  // never bypass the provider safety gate checked above.
  if (ctx.user.creditMode === 'UNLIMITED') {
    return { ok: true, kind: 'UNLIMITED', ...baseUsage(used, ctx.freeTrialLimit) };
  }

  // A free trial may cover at most 2 minutes of SERVER-MEASURED audio. This is
  // checked BEFORE any provider call, from the measured duration only (a
  // client-supplied duration is never trusted), and it never rounds down:
  // 2:00 is the last accepted second, 2:01 is refused. A long file is never
  // split across several trials.
  const trialAvailable = ctx.freeTrialLimit === 0 || used < ctx.freeTrialLimit;
  const tooLongForTrial = exceedsFreeTrialDuration(ctx.measuredDurationSeconds, ctx.freeTrialLimit);

  // cap disabled (FREE_TRIAL_LIMIT=0) = unlimited free, matching the legacy
  // "0 disables the cap" semantics (exceedsFreeTrialDuration returns false for
  // limit <= 0, so the duration cap is not applied in that mode).
  if (trialAvailable && !tooLongForTrial) {
    return {
      ok: true,
      kind: 'FREE_TRIAL',
      ...baseUsage(used, ctx.freeTrialLimit),
    };
  }

  // A free trial is unavailable (exhausted, or the file is too long for one) ->
  // the user must pay with credits. The duration used for pricing is ALWAYS the
  // server-measured one; a client-supplied duration is never accepted.
  if (!(ctx.measuredDurationSeconds > 0)) {
    return {
      ok: false,
      kind: 'NO_DURATION',
      status: 422,
      code: 'NO_DURATION',
      message: CANNOT_MEASURE_DURATION_MESSAGE,
      ...baseUsage(used, ctx.freeTrialLimit),
    };
  }
  const required = creditsForDuration(ctx.measuredDurationSeconds);
  const balance = ctx.user.credits ?? 0;
  if (balance < required) {
    // When a trial is still available but the file is longer than 2:00, say so
    // explicitly and point the user at credits, instead of the generic
    // "out of trials" message. Trials are NOT consumed by this refusal.
    const blockedByTrialDuration = trialAvailable && tooLongForTrial;
    return {
      ok: false,
      kind: blockedByTrialDuration ? 'FREE_TRIAL_DURATION_LIMIT' : 'NEED_CREDITS',
      status: 402,
      code: blockedByTrialDuration ? FREE_TRIAL_DURATION_LIMIT_CODE : 'NOT_ENOUGH_CREDITS',
      message: blockedByTrialDuration ? FREE_TRIAL_DURATION_LIMIT_MESSAGE : NOT_ENOUGH_CREDITS_MESSAGE,
      requiredCredits: required,
      measuredDurationSeconds: ctx.measuredDurationSeconds,
      balance,
      ...baseUsage(used, ctx.freeTrialLimit),
    };
  }
  return {
    ok: true,
    kind: 'PAID',
    requiredCredits: required,
    measuredDurationSeconds: ctx.measuredDurationSeconds,
    balance,
    ...baseUsage(used, ctx.freeTrialLimit),
  };
}