/**
 * IST (Asia/Kolkata, UTC+05:30) civil-time helpers.
 *
 * India has no daylight saving, so a fixed +05:30 offset is exact and needs no
 * IANA timezone database. Every login-activity record is bucketed by IST civil
 * time, because the product's "day" and "month" boundaries are Indian ones.
 */

/** IST is UTC+05:30 with no DST. */
export const IST_OFFSET_MINUTES = 330;
const IST_SUFFIX = '+05:30';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface IstStamp {
  /** Civil date in IST, e.g. `2026-09-30`. */
  date: string;
  /** Civil time in IST, e.g. `08:15:42`. */
  time: string;
  /** Month bucket in IST, e.g. `2026-09`. */
  month: string;
  /** Full IST civil timestamp, e.g. `2026-09-30T08:15:42+05:30`. */
  istDateTime: string;
  /** The same instant in UTC ISO-8601 (the canonical stored timestamp). */
  utcIso: string;
}

/** Break an instant into IST civil parts. */
export function istStamp(at: Date = new Date()): IstStamp {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
  return {
    date: `${y}-${mo}-${d}`,
    time,
    month: `${y}-${mo}`,
    istDateTime: `${y}-${mo}-${d}T${time}${IST_SUFFIX}`,
    utcIso: at.toISOString(),
  };
}

/** The IST civil date immediately before the given one. */
export function previousIstDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d);
  const back = new Date(asUtc - 24 * 60 * 60 * 1000);
  return `${back.getUTCFullYear()}-${pad2(back.getUTCMonth() + 1)}-${pad2(back.getUTCDate())}`;
}

/** True for a well-formed `YYYY-MM` month bucket. */
export function isMonth(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** True for a well-formed `YYYY-MM-DD` IST civil date. */
export function isIstDate(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);
}

/** The `YYYY-MM` bucket a `YYYY-MM-DD` IST civil date belongs to. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** All month buckets from `from` to `to` inclusive (used to fill gaps). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad2(m)}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
