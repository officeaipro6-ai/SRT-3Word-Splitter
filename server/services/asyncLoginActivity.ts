/**
 * Async, provider-neutral login-activity recording and daily reporting.
 *
 * WHY THIS MODULE EXISTS
 * The original path (`LoginActivityService` + `LoginActivityRepo`) is fully
 * SYNCHRONOUS and reads/writes through `store.snapshot()` / `store.mutate()`.
 * On the production libSQL/Turso provider:
 *   - `snapshot()` returns a Promise, so `snapshot().loginAlerts` and
 *     `snapshot().loginActivity` are `undefined`, `?? []` silently became an
 *     empty list, and every read reported ZERO logins; and
 *   - `mutate()` throws by design, so every write was lost.
 * The visible symptoms were (a) the daily Telegram report showing zeros and
 * (b) the SAME report being re-sent repeatedly, because the "already sent" guard
 * could never observe a persisted row.
 *
 * This module keeps every rule and every message from `loginActivityService.ts`
 * / `loginAlertService.ts` EXACTLY as they were (same IST maths, same refresh
 * de-dup window, same privacy contract, same summary text) and only replaces the
 * data access with `await`ed, per-entity operations. Two implementations exist:
 * a file-provider one wrapping the synchronous repo, and a Turso one calling the
 * store's per-entity async methods.
 *
 * The one behavioural change is the daily report's idempotency, which is
 * required for correctness: the send is now gated by a PERSISTED, ATOMIC claim
 * (`claimDailyLoginAlert`) rather than a read-then-write check.
 */
import { LoginActivityRepo, newId } from '../db/repos';
import type { LoginActivityRecord, LoginAlertRecord } from '../db/types';
import type { TursoStore } from '../db/tursoStore';
import { istStamp, previousIstDate, isIstDate, isMonth, monthOf } from './istTime';
import {
  REFRESH_DEDUP_WINDOW_MS,
  type DaySummary,
  type MonthSummary,
  type MonthQuery,
  type MonthQueryResult,
  type RecordLoginInput,
  type RecordLoginResult,
} from './loginActivityService';
import {
  ALERT_RUN_AFTER_MIDNIGHT_MINUTES,
  formatLoginAlertBody,
  type LoginAlertTransport,
  type SendLoginActivityResult,
} from './loginAlertService';

const MAX_IP = 64;
const MAX_UA = 200;

/**
 * The data-access surface both providers implement.
 *
 * These are the SAME operations the synchronous `LoginActivityRepo` exposes,
 * only awaited. Keeping the shape identical is what lets one recording/summary
 * implementation serve both providers unchanged.
 */
export interface LoginActivityStore {
  record(rec: LoginActivityRecord): Promise<void>;
  lastForUserMethod(userId: string, method: string): Promise<LoginActivityRecord | null>;
  listForDate(date: string): Promise<LoginActivityRecord[]>;
  listForMonth(month: string): Promise<LoginActivityRecord[]>;
  firstLoginFor(userId: string): Promise<LoginActivityRecord | null>;
  availableMonths(): Promise<string[]>;
  /** Persisted, atomic claim. True ONLY for the caller that may send. */
  claimDailyAlert(claim: {
    id: string;
    alertDate: string;
    periodDate: string;
    month: string;
    generatedAt: string;
  }): Promise<boolean>;
  completeDailyAlert(alert: LoginAlertRecord): Promise<void>;
  releaseDailyAlert(periodDate: string): Promise<void>;
  findAlertFor(periodDate: string): Promise<LoginAlertRecord | undefined>;
  hasAlertFor(periodDate: string): Promise<boolean>;
  listAlerts(limit?: number): Promise<LoginAlertRecord[]>;
  countEvents(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

/** JSON/`DataStore` provider: the existing synchronous repo, awaited. */
export function createFileLoginActivityStore(repo: LoginActivityRepo): LoginActivityStore {
  return {
    async record(rec) {
      repo.record(rec);
    },
    async lastForUserMethod(userId, method) {
      return repo.lastForUserMethod(userId, method) ?? null;
    },
    async listForDate(date) {
      return repo.listForDate(date);
    },
    async listForMonth(month) {
      return repo.listForMonth(month);
    },
    async firstLoginFor(userId) {
      return repo.firstLoginFor(userId) ?? null;
    },
    async availableMonths() {
      return repo.availableMonthsFilled();
    },
    // A single process owns a JSON file, so the claim cannot race against
    // another instance the way the UNIQUE-constrained SQL upsert can. It is
    // still PERSISTED (it must survive a restart), and it still refuses to
    // re-send a date that is already settled. Mirrors claimDailyLoginAlert:
    // claim only when absent, or when a previous attempt FAILED.
    async claimDailyAlert(claim) {
      const held = repo.findAlertFor(claim.periodDate);
      if (held && !isSettledAlert(held) && held.deliveryStatus !== 'FAILED') return false;
      repo.saveAlert({
        id: claim.id,
        alertDate: claim.alertDate,
        periodDate: claim.periodDate,
        month: claim.month,
        generatedAt: claim.generatedAt,
        totalLogins: 0,
        uniqueUsers: 0,
        newUsers: 0,
        activeUsers: 0,
        failedLogins: 0,
        topUsers: [],
        deliveryStatus: 'PENDING',
        statusMessage: 'Claimed for delivery; no message sent yet.',
      } as unknown as LoginAlertRecord);
      return true;
    },
    async completeDailyAlert(alert) {
      repo.saveAlert(alert);
    },
    async releaseDailyAlert(periodDate) {
      const held = repo.findAlertFor(periodDate);
      if (held?.statusMessage?.startsWith('Claimed for delivery')) repo.deleteAlertFor(periodDate);
    },
    async findAlertFor(periodDate) {
      return repo.findAlertFor(periodDate);
    },
    async hasAlertFor(periodDate) {
      return repo.hasAlertFor(periodDate);
    },
    async listAlerts(limit) {
      return repo.listAlerts(limit);
    },
    async countEvents() {
      return repo.countEvents();
    },
  };
}

/** libSQL/Turso provider: per-entity async methods only. */
export function createTursoLoginActivityStore(store: TursoStore): LoginActivityStore {
  return {
    async record(rec) {
      await store.recordLoginActivity(rec);
    },
    async lastForUserMethod(userId, method) {
      return await store.lastForUserMethod(userId, method);
    },
    async listForDate(date) {
      return (await store.listLoginActivityForDate(date)) as LoginActivityRecord[];
    },
    async listForMonth(month) {
      return (await store.listLoginActivityForMonth(month)) as LoginActivityRecord[];
    },
    async firstLoginFor(userId) {
      return ((await store.firstLoginFor(userId)) as LoginActivityRecord) ?? null;
    },
    async availableMonths() {
      return (await store.availableMonths()) as string[];
    },
    async claimDailyAlert(claim) {
      return store.claimDailyLoginAlert(claim);
    },
    async completeDailyAlert(alert) {
      await store.completeDailyLoginAlert(alert);
    },
    async releaseDailyAlert(periodDate) {
      await store.releaseDailyLoginAlert(periodDate);
    },
    async findAlertFor(periodDate) {
      return ((await store.findAlertFor(periodDate)) as LoginAlertRecord) ?? undefined;
    },
    async hasAlertFor(periodDate) {
      return store.hasAlertFor(periodDate);
    },
    async listAlerts(limit = 60) {
      return (await store.listAlerts(limit)) as LoginAlertRecord[];
    },
    async countEvents() {
      return store.countLoginEvents();
    },
  };
}

// ---------------------------------------------------------------------------
// Recording + analytics (same rules as loginActivityService.ts, now awaited)
// ---------------------------------------------------------------------------

export class AsyncLoginActivityService {
  constructor(private readonly store: LoginActivityStore) {}

  /**
   * Record one login/session event.
   *
   * Identical rules to the synchronous service: a repeated SUCCESS for the same
   * (user, method) inside `REFRESH_DEDUP_WINDOW_MS` is a page refresh and is
   * collapsed; a FAILURE stores NO email and NO ip/user-agent, because the
   * submitted address is unverified input.
   */
  async record(input: RecordLoginInput): Promise<RecordLoginResult> {
    const at = input.at ?? new Date();
    const stamp = istStamp(at);
    const success = input.outcome === 'SUCCESS';

    if (success && input.userId) {
      const prev = await this.store.lastForUserMethod(input.userId, input.method);
      if (prev) {
        const age = at.getTime() - new Date(prev.occurredAt).getTime();
        if (age >= 0 && age < REFRESH_DEDUP_WINDOW_MS) return { deduplicated: true };
      }
    }

    const record: LoginActivityRecord = {
      id: newId(),
      userId: success ? input.userId : '',
      email: success && input.email ? input.email : undefined,
      loginDate: stamp.date,
      loginTime: stamp.time,
      istDateTime: stamp.istDateTime,
      month: stamp.month,
      occurredAt: stamp.utcIso,
      method: input.method,
      outcome: input.outcome,
      failureCode: !success && input.failureCode ? input.failureCode.slice(0, 64) : undefined,
      ip: success && input.ip ? input.ip.slice(0, MAX_IP) : undefined,
      userAgent: success && input.userAgent ? input.userAgent.slice(0, MAX_UA) : undefined,
    };

    await this.store.record(record);
    return { record, deduplicated: false };
  }

  availableMonths(): Promise<string[]> {
    return this.store.availableMonths();
  }

  async monthSummary(month: string): Promise<MonthSummary> {
    return this.summarise(month, await this.store.listForMonth(month));
  }

  /** Paginated, searchable month view for the admin table. */
  async queryMonth(input: MonthQuery): Promise<MonthQueryResult> {
    const pageSize = Math.min(Math.max(1, input.pageSize), 500);
    const page = Math.max(1, input.page);
    const rows = await this.store.listForMonth(input.month);
    const needle = input.q?.trim().toLowerCase() ?? '';

    const filtered = needle
      ? rows.filter(
          (r) =>
            r.email?.toLowerCase().includes(needle) ||
            r.userId.toLowerCase().includes(needle) ||
            r.loginDate.includes(needle)
        )
      : rows;

    const start = (page - 1) * pageSize;
    const full = await this.summarise(input.month, rows);
    return {
      month: input.month,
      summary: {
        month: full.month,
        totalLogins: full.totalLogins,
        uniqueUsers: full.uniqueUsers,
        activeUsers: full.activeUsers,
        failedLogins: full.failedLogins,
      },
      rows: filtered.slice(start, start + pageSize).map((r) => structuredClone(r)),
      total: filtered.length,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  /**
   * Yesterday's activity in IST: the period is the previous IST calendar date
   * of `at`. Unchanged maths, now reading real rows on every provider.
   */
  async previousDaySummary(at: Date = new Date()): Promise<DaySummary> {
    const today = istStamp(at).date;
    return this.daySummary(previousIstDate(today), today);
  }

  /** One IST civil day's activity. `alertDate` is when the report is produced. */
  async daySummary(date: string, alertDate: string): Promise<DaySummary> {
    const rows = await this.store.listForDate(date);
    const successes = rows.filter((r) => r.outcome === 'SUCCESS');

    const perUser = new Map<string, { count: number; email?: string }>();
    for (const r of successes) {
      if (!r.userId) continue;
      const cur = perUser.get(r.userId) ?? { count: 0, email: r.email };
      cur.count += 1;
      if (!cur.email && r.email) cur.email = r.email;
      perUser.set(r.userId, cur);
    }

    // "New" = the user's FIRST ever successful login happened on this day.
    let newUsers = 0;
    for (const userId of perUser.keys()) {
      const first = await this.store.firstLoginFor(userId);
      if (first && first.loginDate === date) newUsers += 1;
    }

    return {
      date,
      month: monthOf(date),
      totalLogins: successes.length,
      uniqueUsers: perUser.size,
      newUsers,
      activeUsers: new Set(rows.filter((r) => r.userId).map((r) => r.userId)).size,
      failedLogins: rows.filter((r) => r.outcome === 'FAILURE').length,
      topUsers: [...perUser.entries()]
        .map(([userId, v]) => ({ userId, email: v.email, count: v.count }))
        .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId))
        .slice(0, 5),
    };
  }

  private async summarise(month: string, rows: LoginActivityRecord[]): Promise<MonthSummary> {
    const successes = rows.filter((r) => r.outcome === 'SUCCESS');

    const perUser = new Map<string, { count: number; email?: string; first: string; last: string }>();
    const byDate = new Map<string, number>();

    for (const r of successes) {
      if (r.userId) {
        const cur = perUser.get(r.userId) ?? {
          count: 0,
          email: r.email,
          first: r.istDateTime,
          last: r.istDateTime,
        };
        cur.count += 1;
        if (!cur.email && r.email) cur.email = r.email;
        if (r.istDateTime < cur.first) cur.first = r.istDateTime;
        if (r.istDateTime > cur.last) cur.last = r.istDateTime;
        perUser.set(r.userId, cur);
      }
      byDate.set(r.loginDate, (byDate.get(r.loginDate) ?? 0) + 1);
    }

    return {
      month,
      totalLogins: successes.length,
      uniqueUsers: perUser.size,
      activeUsers: new Set(rows.filter((r) => r.userId).map((r) => r.userId)).size,
      failedLogins: rows.filter((r) => r.outcome === 'FAILURE').length,
      perUser: [...perUser.entries()]
        .map(([userId, v]) => ({
          userId,
          email: v.email,
          count: v.count,
          firstLogin: v.first,
          lastLogin: v.last,
        }))
        .sort((a, b) => b.count - a.count || a.userId.localeCompare(b.userId)),
      byDate: [...byDate.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}

// ---------------------------------------------------------------------------
// Daily report: same message, now gated by a persisted atomic claim
// ---------------------------------------------------------------------------

/** Provider-neutral dispatch. Text and status values are unchanged. */
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
    return { status: 'DELIVERED', message: `Delivered via ${ok.join(', ')}.`, delivered: true };
  }
  return {
    status: 'FAILED',
    message: `All configured transports failed (${results.map((r) => r.name).join(', ')}).`,
    delivered: false,
  };
}

export interface RunLoginAlertResult {
  alert: LoginAlertRecord;
  /** True when the report for this IST date was already sent; nothing was sent. */
  duplicate: boolean;
}

/**
 * Produce (or decline to re-produce) the report for the previous IST day.
 *
 * This is the SINGLE entry point used by the scheduler, the manual admin
 * trigger and the tests, so all three obey one rule:
 *
 *   1. Atomically claim the IST date in the database. Losers stop here - they
 *      never build a summary and never contact a transport.
 *   2. Only the winner builds the summary and dispatches it.
 *   3. The winner records the real summary + delivery result.
 *   4. If dispatch throws, the claim is released so a later tick can retry.
 *
 * Because step 1 is a single UNIQUE-constrained INSERT, "already sent" is a
 * fact in the database rather than a value read earlier in memory. That holds
 * across process restarts, redeploys and multiple concurrent instances.
 */
export async function runDailyLoginAlert(
  activity: AsyncLoginActivityService,
  store: LoginActivityStore,
  opts: { at?: Date; transports?: Record<string, LoginAlertTransport> } = {}
): Promise<RunLoginAlertResult> {
  const at = opts.at ?? new Date();
  const stamp = istStamp(at);
  const periodDate = previousIstDate(stamp.date);

  // Fast path: a SETTLED report (delivered, or deliberately not configured) is
  // already recorded for this date, so there is nothing left to do.
  const existing = await store.findAlertFor(periodDate);
  if (existing && isSettledAlert(existing)) return { alert: existing, duplicate: true };

  const claim = {
    id: newId(),
    alertDate: stamp.date,
    periodDate,
    month: monthOf(periodDate),
    generatedAt: stamp.utcIso,
  };
  const won = await store.claimDailyAlert(claim);
  if (!won) {
    // Another tick/instance owns this date, or it is already settled. Either way
    // this caller must NOT contact a transport.
    const settled = (await store.findAlertFor(periodDate)) ?? ({ ...claim, topUsers: [] } as LoginAlertRecord);
    return { alert: settled, duplicate: true };
  }

  try {
    const summary = await activity.daySummary(periodDate, stamp.date);
    const sent = await sendLoginActivityAlert(summary, opts.transports ?? {});

    const alert: LoginAlertRecord = {
      ...claim,
      month: summary.month,
      totalLogins: summary.totalLogins,
      uniqueUsers: summary.uniqueUsers,
      newUsers: summary.newUsers,
      activeUsers: summary.activeUsers,
      failedLogins: summary.failedLogins,
      topUsers: summary.topUsers,
      deliveryStatus: sent.status,
      statusMessage: sent.message,
    } as LoginAlertRecord;

    await store.completeDailyAlert(alert);
    return { alert, duplicate: false };
  } catch (e) {
    // Never leave a PENDING claim behind: it would block that IST date until a
    // release. A FAILED row stays (it is retryable by design); a PENDING row is
    // given back immediately so the next tick can try.
    await store.releaseDailyAlert(periodDate).catch(() => undefined);
    throw e;
  }
}

/**
 * True when this IST date's report is finished and must never be sent again.
 *
 * DELIVERED and NOT_CONFIGURED are terminal. NOT_CONFIGURED means the report was
 * produced and deliberately not sent (no transport), which is the same as the
 * previous behaviour and keeps the alert log from churning.
 *
 * PENDING (a send is in flight right now) and FAILED (the message never
 * arrived) are deliberately NOT settled: PENDING must not be stolen from the
 * caller that owns it, and FAILED must be retried.
 */
export function isSettledAlert(alert: Pick<LoginAlertRecord, 'deliveryStatus'>): boolean {
  return alert.deliveryStatus === 'DELIVERED' || alert.deliveryStatus === 'NOT_CONFIGURED';
}

/**
 * The EXISTING in-process daily scheduler. Not a second scheduler: the same
 * 60s tick, the same ALERT_RUN_AFTER_MIDNIGHT_MINUTES gate, the same
 * `runDailyLoginAlert` call. The only change is that the "should I run?" test
 * is now a real database read and the send is a real atomic claim.
 *
 * Render Free spins the service down when idle, so this tick only exists while
 * a process is awake. A wake-up after the window simply runs the report then,
 * still keyed to the correct previous IST day - and still only once.
 */
export function startDailyLoginAlertSchedulerAsync(
  activity: AsyncLoginActivityService,
  store: LoginActivityStore,
  opts: {
    transports?: Record<string, LoginAlertTransport>;
    intervalMs?: number;
    onError?: (e: unknown) => void;
  } = {}
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const stamp = istStamp(new Date());
      const periodDate = previousIstDate(stamp.date);
      const [h, m] = stamp.time.split(':').map(Number);
      if (h * 60 + m < ALERT_RUN_AFTER_MIDNIGHT_MINUTES) return;
      const held = await store.findAlertFor(periodDate);
      if (held && isSettledAlert(held)) return;
      await runDailyLoginAlert(activity, store, { transports: opts.transports });
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
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

/** Validate a month bucket, falling back to the current IST month. */
export function resolveMonth(value: unknown, now = new Date()): string {
  const v = typeof value === 'string' ? value.trim() : '';
  return isMonth(v) ? v : istStamp(now).month;
}

/** Validate an IST civil date, falling back to today. */
export function resolveIstDate(value: unknown, now = new Date()): string {
  const v = typeof value === 'string' ? value.trim() : '';
  return isIstDate(v) ? v : istStamp(now).date;
}
