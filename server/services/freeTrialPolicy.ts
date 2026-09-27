/**
 * Free-trial usage policy for the free user upload path (legacy
 * /api/process-audio). Pure, dependency-free functions so the policy is
 * unit-testable without a database or server.
 *
 * Semantics:
 *  - A NORMAL user may successfully process exactly `limit` audio jobs for
 *    free. The counter increments server-side ONLY after a successful pipeline
 *    run, so failed uploads / API errors never consume a trial and a browser
 *    refresh cannot reset it (the session token is stable in localStorage).
 *  - Accounts in UNLIMITED credit mode (operator/ADMIN accounts, assigned
 *    exclusively through the ADMIN_BOOTSTRAP_TOKEN secret) and anonymous
 *    legacy callers (no session token) are never counted or capped, preserving
 *    the pre-existing legacy /api/process-audio behaviour.
 */
import type { UserRecord } from '../db/types';
import { config } from '../config';

/** Server-side cap on successful free trials (0 disables the cap entirely). */
export const FREE_TRIAL_LIMIT = config.freeTrialLimit;

export const FREE_TRIAL_EXHAUSTED_CODE = 'FREE_TRIAL_EXHAUSTED';

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