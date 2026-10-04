/**
 * Daily login-activity alert: "yesterday's logins" summary.
 *
 * IDEMPOTENCY
 * The alert is keyed by the IST day it REPORTS ON (`periodDate`), and that key
 * is persisted before any transport is contacted. A duplicate run - a restart,
 * a second process, a tick that fires twice - sees the stored row and returns
 * it without re-sending. `periodDate` is unique in the store: re-issuing
 * replaces rather than appends.
 *
 * PROVIDER NEUTRALITY
 * `sendLoginActivityAlert` takes an optional `transports` map. With no
 * transport registered it reports `NOT_CONFIGURED` and the summary is still
 * persisted and visible in the admin alert log. There is no default transport,
 * no network call, and no hard dependency on any messaging provider here.
 */
import { LoginActivityRepo, newId } from '../db/repos';
import type { LoginAlertRecord } from '../db/types';
import { istStamp, previousIstDate } from './istTime';
import type { DaySummary, LoginActivityService } from './loginActivityService';

/**
 * A notification sink. Kept to a boolean so this module never learns anything
 * about a provider's SDK, credentials or message format.
 */
export type LoginAlertTransport = (subject: string, body: string) => Promise<boolean> | boolean;

/** The daily run fires this many minutes after IST midnight. */
export const ALERT_RUN_AFTER_MIDNIGHT_MINUTES = 5;

export interface SendLoginActivityResult {
  status: LoginAlertRecord['deliveryStatus'];
  message: string;
  delivered: boolean;
}

/** Human-readable, secret-free body for the reported day. */
export function formatLoginAlertBody(summary: DaySummary): string {
  const top =
    summary.topUsers.length > 0
      ? summary.topUsers
          .map((u, i) => {
            // Prefer email for display; fall back to truncated UUID if email unavailable
            const display = u.email ?? `${u.userId.slice(0, 8)}…`;
            return `${i + 1}. ${display} - ${u.count}`;
          })
          .join('\n')
      : '-';
  return [
    `Login activity for ${summary.date} (IST)`,
    `Total logins: ${summary.totalLogins}`,
    `Unique users: ${summary.uniqueUsers}`,
    `New users: ${summary.newUsers}`,
    `Active users: ${summary.activeUsers}`,
    `Failed logins: ${summary.failedLogins}`,
    'Top login-count users:',
    top,
  ].join('\n');
}

/**
 * Provider-neutral dispatch.
 *
 * Success requires at least one transport to return true. When no transport is
 * registered the result is `NOT_CONFIGURED` - a clear "not delivered" signal,
 * not a silent success.
 */
export async function sendLoginActivityAlert(
  summary: DaySummary,
  transports: Record<string, LoginAlertTransport> = {}
): Promise<SendLoginActivityResult> {
  const subject = `Daily login activity - ${summary.date}`;
  const body = formatLoginAlertBody(summary);
  const names = Object.keys(transports);

  if (names.length === 0) {
    return {
      status: 'NOT_CONFIGURED',
      message: 'No alert transport configured; summary saved to the admin alert log.',
      delivered: false,
    };
  }

  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, ok: await transports[name](subject, body) };
      } catch {
        return { name, ok: false };
      }
    })
  );

  const ok = results.filter((r) => r.ok).map((r) => r.name);
  if (ok.length > 0) {
    return {
      status: 'DELIVERED',
      message: `Delivered via ${ok.join(', ')}.`,
      delivered: true,
    };
  }
  return {
    status: 'FAILED',
    message: `All configured transports failed (${results.map((r) => r.name).join(', ')}).`,
    delivered: false,
  };
}

export interface RunLoginAlertResult {
  alert: LoginAlertRecord;
  /** True when an alert for this period already existed and nothing was sent. */
  duplicate: boolean;
}

/**
 * Produce (or return the already-produced) alert for the previous IST day.
 *
 * This is the single entry point used by the scheduler, the manual admin
 * trigger, and the tests, so all three share one idempotency rule.
 */
export async function runLoginAlert(
  activity: LoginActivityService,
  repo: LoginActivityRepo,
  opts: {
    at?: Date;
    transports?: Record<string, LoginAlertTransport>;
  } = {}
): Promise<RunLoginAlertResult> {
  const at = opts.at ?? new Date();
  const stamp = istStamp(at);
  const periodDate = previousIstDate(stamp.date);

  // The persisted key is the guard: check it before doing any work.
  const existing = repo.findAlertFor(periodDate);
  if (existing) return { alert: existing, duplicate: true };

  const summary = activity.daySummary(periodDate, stamp.date);
  const sent = await sendLoginActivityAlert(summary, opts.transports ?? {});

  const alert: LoginAlertRecord = {
    id: newId(),
    alertDate: stamp.date,
    periodDate,
    month: summary.month,
    generatedAt: stamp.utcIso,
    totalLogins: summary.totalLogins,
    uniqueUsers: summary.uniqueUsers,
    newUsers: summary.newUsers,
    activeUsers: summary.activeUsers,
    failedLogins: summary.failedLogins,
    topUsers: summary.topUsers,
    deliveryStatus: sent.status,
    statusMessage: sent.message,
  };

  return { alert: repo.saveAlert(alert), duplicate: false };
}

/**
 * In-process daily scheduler.
 *
 * A single 60s tick asks "is it past 00:05 IST on a day whose previous day has
 * no alert yet?". The persisted `periodDate` guard makes the tick itself
 * restart-safe and duplicate-safe, so this cannot emit twice for one day even
 * if several processes or ticks run.
 *
 * Limitation, stated plainly: this is per-process, so it needs a long-running
 * server, and a machine that is asleep at 00:05 IST will run the alert late on
 * its next tick (still keyed to the correct previous day). Deployments that
 * need guaranteed 00:05 should call `runLoginAlert` from an external cron
 * instead - the exported function is the supported entry point for that.
 */
export function startDailyLoginAlertScheduler(
  activity: LoginActivityService,
  repo: LoginActivityRepo,
  opts: { transports?: Record<string, LoginAlertTransport>; intervalMs?: number; onError?: (e: unknown) => void } = {}
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const stamp = istStamp(new Date());
      const periodDate = previousIstDate(stamp.date);
      if (repo.hasAlertFor(periodDate)) return;
      const [h, m] = stamp.time.split(':').map(Number);
      if (h * 60 + m < ALERT_RUN_AFTER_MIDNIGHT_MINUTES) return;
      await runLoginAlert(activity, repo, { transports: opts.transports });
    } catch (e) {
      opts.onError?.(e);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never hold the event loop open in tests or short-lived scripts.
  timer.unref?.();
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
