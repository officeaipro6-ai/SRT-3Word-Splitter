/**
 * Login-activity recording and month-wise analytics.
 *
 * PRIVACY CONTRACT (enforced here, not left to callers):
 *  - never store a password, a bearer token, an API key, the admin bootstrap
 *    token, or any payment secret;
 *  - store only the account email already held on the user record;
 *  - a FAILED login stores NO email and NO ip/user-agent, because the caller is
 *    not authenticated and the submitted address cannot be trusted;
 *  - ip / user-agent are length-capped.
 */
import { LoginActivityRepo, newId } from '../db/repos';
import type { LoginActivityRecord, LoginMethod, LoginOutcome } from '../db/types';
import { isIstDate, isMonth, istStamp, monthOf, previousIstDate } from './istTime';

/**
 * A repeat of the same (user, method) inside this window is a page refresh,
 * not a new login, and is collapsed into the existing event.
 */
export const REFRESH_DEDUP_WINDOW_MS = 5 * 60 * 1000;

const MAX_IP = 64;
const MAX_UA = 200;

export interface RecordLoginInput {
  userId: string;
  email?: string;
  method: LoginMethod;
  outcome: LoginOutcome;
  /** Non-identifying classification for a failure. */
  failureCode?: string;
  ip?: string;
  userAgent?: string;
  at?: Date;
}

export interface RecordLoginResult {
  record?: LoginActivityRecord;
  /** True when the event was collapsed into a recent one (page refresh). */
  deduplicated: boolean;
}

export interface MonthSummary {
  month: string;
  totalLogins: number;
  /** Distinct users with at least one SUCCESS event. */
  uniqueUsers: number;
  /** Distinct users with a login in this month (SUCCESS or FAILURE). */
  activeUsers: number;
  failedLogins: number;
  /** Per-user SUCCESS counts, most active first. */
  perUser: Array<{
    userId: string;
    email?: string;
    count: number;
    firstLogin: string;
    lastLogin: string;
  }>;
  /** SUCCESS counts keyed by IST civil date, oldest first. */
  byDate: Array<{ date: string; count: number }>;
}

export interface DaySummary {
  date: string;
  month: string;
  totalLogins: number;
  uniqueUsers: number;
  newUsers: number;
  activeUsers: number;
  failedLogins: number;
  topUsers: Array<{ userId: string; email?: string; count: number }>;
}

export interface MonthQuery {
  month: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface MonthQueryResult {
  month: string;
  summary: Omit<MonthSummary, 'perUser' | 'byDate'>;
  rows: LoginActivityRecord[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export class LoginActivityService {
  constructor(private readonly repo: LoginActivityRepo) {}

  /**
   * Record one login/session event.
   *
   * A repeated SUCCESS for the same (user, method) within
   * `REFRESH_DEDUP_WINDOW_MS` is a browser refresh and is NOT stored again.
   */
  record(input: RecordLoginInput): RecordLoginResult {
    const at = input.at ?? new Date();
    const stamp = istStamp(at);
    const success = input.outcome === 'SUCCESS';

    if (success && input.userId) {
      const prev = this.repo.lastForUserMethod(input.userId, input.method);
      if (prev) {
        const age = at.getTime() - new Date(prev.occurredAt).getTime();
        // Also collapse a clock skew / duplicate instant.
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
      // Only a SUCCESS carries request metadata; a failure is unverified input.
      ip: success && input.ip ? input.ip.slice(0, MAX_IP) : undefined,
      userAgent: success && input.userAgent ? input.userAgent.slice(0, MAX_UA) : undefined,
    };

    this.repo.record(record);
    return { record, deduplicated: false };
  }

  availableMonths(): string[] {
    return this.repo.availableMonthsFilled();
  }

  /** Aggregate one month. */
  monthSummary(month: string): MonthSummary {
    const rows = this.repo.listForMonth(month);
    return this.summarise(month, rows);
  }

  /** Paginated, searchable month view for the admin table. */
  queryMonth(input: MonthQuery): MonthQueryResult {
    const pageSize = Math.min(Math.max(1, input.pageSize), 500);
    const page = Math.max(1, input.page);
    const rows = this.repo.listForMonth(input.month);
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
    const full = this.summarise(input.month, rows);
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
   * Yesterday's activity in IST, as reported by the daily post-midnight alert.
   * `at` is the moment the alert runs; the period is the previous IST day.
   */
  previousDaySummary(at: Date = new Date()): DaySummary {
    const today = istStamp(at).date;
    return this.daySummary(previousIstDate(today), today);
  }

  /** One IST civil day's activity. `alertDate` is when the report is produced. */
  daySummary(date: string, alertDate: string): DaySummary {
    const rows = this.repo.listForDate(date);
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
      const first = this.repo.firstLoginFor(userId);
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

  private summarise(month: string, rows: LoginActivityRecord[]): MonthSummary {
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
