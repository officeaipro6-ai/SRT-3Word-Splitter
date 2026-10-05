/**
 * Free-trial usage policy for the free user upload path (legacy
 * /api/process-audio). Pure, dependency-free functions so the policy is
 * unit-testable without a database or server.
 *
 * Semantics:
 *  - A NORMAL user may successfully process exactly `limit` audio jobs for
 *    free. The FROZEN limit is 1: one free trial per user, ever. The counter
 *    increments server-side ONLY after a successful pipeline run, so failed
 *    uploads / API errors never consume a trial and a browser refresh cannot
 *    reset it (the session token is stable in localStorage).
 *  - Each individual free trial may cover at most
 *    `FREE_TRIAL_MAX_DURATION_SECONDS` (2 minutes) of SERVER-MEASURED audio. A
 *    longer file can never be served by a free trial: it is refused with a
 *    clear message and must be paid for with credits. There is no splitting of
 *    a long file across several trials and no rounding down, so 2:00 is the
 *    last accepted second and 2:01 is refused.
 *  - Accounts in UNLIMITED credit mode (operator/ADMIN accounts, assigned
 *    exclusively through the ADMIN_BOOTSTRAP_TOKEN secret) and anonymous
 *    legacy callers (no session token) are never counted or capped, preserving
 *    the pre-existing legacy /api/process-audio behaviour.
 */
import type { UserRecord } from '../db/types';
import { config } from '../config';

/** Server-side cap on successful free trials (0 disables the cap entirely). */
export const FREE_TRIAL_LIMIT = config.freeTrialLimit;

/**
 * Maximum SERVER-MEASURED duration, in seconds, that the ONE free trial may
 * process: 2 minutes. With the frozen limit of 1 trial this caps total free
 * usage at 2 minutes per new user.
 */
export const FREE_TRIAL_MAX_DURATION_SECONDS = 120;

export const FREE_TRIAL_EXHAUSTED_CODE = 'FREE_TRIAL_EXHAUSTED';

export const FREE_TRIAL_DURATION_LIMIT_CODE = 'FREE_TRIAL_DURATION_LIMIT';

/** The exact user-facing message for a file too long for a free trial. */
export const FREE_TRIAL_DURATION_LIMIT_MESSAGE =
  'Free trial is limited to 2 minutes. Please use credits for longer files.';

/** Total free audio seconds a new user may ever consume (1 trial x 2 min). */
export function freeTrialTotalMaxDurationSeconds(limit: number): number {
  return limit > 0 ? limit * FREE_TRIAL_MAX_DURATION_SECONDS : 0;
}

/**
 * True when the measured duration may NOT be served by a free trial.
 *
 * Fails closed: an unmeasurable/unknown duration is treated as too long, so a
 * long or corrupt file can never sneak through a free trial. `limit <= 0` keeps
 * the documented legacy "cap disabled" behaviour (unlimited free, any length).
 */
export function exceedsFreeTrialDuration(seconds: number, limit: number): boolean {
  if (limit <= 0) return false;
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return true;
  return s > FREE_TRIAL_MAX_DURATION_SECONDS;
}

/** The exact user-facing block message (limit-aware when configured). */
export function freeTrialBlockMessage(limit: number): string {
  return `You have used your ${limit} free audio trials. Please choose a plan to continue.`;
}

/** True when this account is exempt from free-trial accounting (UNLIMITED operator) or anonymous. */
export function isFreeTrialExempt(user: Pick<UserRecord, 'creditMode'> | null): boolean {
  return !user || user.creditMode === 'UNLIMITED';
}

/** Consumed successful free trials for a user (0 when exempt/anonymous). */
export function freeTrialsUsedFor(user: Pick<UserRecord, 'creditMode' | 'freeTrialsUsed'> | null): number {
  return isFreeTrialExempt(user) ? 0 : (user?.freeTrialsUsed ?? 0);
}

/** True when the user must be blocked from further free processing. */
export function isFreeTrialExhausted(used: number, limit: number): boolean {
  return limit > 0 && used >= limit;
}

/** Trials left before the cap (limit <= 0 means "cap disabled" -> -1 sentinel). */
export function freeTrialsRemaining(used: number, limit: number): number {
  if (limit <= 0) return -1;
  return Math.max(0, limit - used);
}