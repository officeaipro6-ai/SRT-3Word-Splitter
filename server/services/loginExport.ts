/**
 * ADMIN Excel export of monthly login activity.
 *
 * Pure builder: it takes already-loaded rows and returns an .xlsx buffer, so it
 * is unit-testable without a database, a server or the filesystem.
 *
 * SCOPE: EVERY record in the selected month is written, not only the rows the
 * admin table happens to be showing. The export never depends on the current
 * page, page size or search filter.
 *
 * SECURITY: rows are assembled from an EXPLICIT whitelist of fields. Passwords,
 * bearer tokens, API keys, the admin bootstrap token, payment data and internal
 * secrets are never read, so they cannot reach the workbook.
 */
import ExcelJS from 'exceljs';
import type { LoginActivityRecord } from '../db/types';
import type { MonthSummary } from './loginActivityService';

export interface WorkbookInput {
  /** EVERY record in the month, any order (the builder sorts). */
  activity: LoginActivityRecord[];
  summary: MonthSummary;
  month: string;
  generatedAt?: Date;
}

const BLANK = '—';

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Array<Partial<ExcelJS.Column>>,
  lastColumn: string
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns as ExcelJS.Column[];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  ws.autoFilter = `A1:${lastColumn}1`;
  return ws;
}

function fmt(row: ExcelJS.Row, key: string, format: string) {
  row.getCell(key).numFmt = format;
}

/** Build the workbook for one IST month (`YYYY-MM`). */
export async function buildLoginActivityWorkbook(input: WorkbookInput): Promise<Buffer> {
  const generatedAt = input.generatedAt ?? new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OdiaSRT Admin';
  wb.created = generatedAt;

  const rows = input.activity
    .slice()
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)
    );

  // 1) Login Activity - newest first, one row per recorded event.
  const activity = addSheet(
    wb,
    'Login Activity',
    [
      { header: 'Activity ID', key: 'activityId', width: 40 },
      { header: 'User ID', key: 'userId', width: 40 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Login Date', key: 'loginDate', width: 14 },
      { header: 'Login Time', key: 'loginTime', width: 12 },
      { header: 'IST Date-Time', key: 'istDateTime', width: 26 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Login Method', key: 'method', width: 18 },
      { header: 'Device', key: 'device', width: 40 },
      { header: 'Status', key: 'status', width: 12 },
    ],
    'K'
  );

  for (const r of rows) {
    const row = activity.addRow({
      activityId: r.id,
      userId: r.userId || BLANK,
      // No name is stored, so the cell is honestly blank rather than invented.
      name: BLANK,
      email: r.email || BLANK,
      loginDate: r.loginDate,
      loginTime: r.loginTime,
      istDateTime: r.istDateTime,
      month: r.month,
      method: r.method,
      device: r.userAgent || BLANK,
      status: r.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    });
    row.alignment = { vertical: 'middle' };
  }

  // 2) User Summary - per-user aggregates for the month.
  const users = addSheet(
    wb,
    'User Summary',
    [
      { header: 'User ID', key: 'userId', width: 40 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'First Login', key: 'firstLogin', width: 26 },
      { header: 'Last Login', key: 'lastLogin', width: 26 },
      { header: 'Total Logins', key: 'totalLogins', width: 14 },
    ],
    'F'
  );

  for (const u of input.summary.perUser) {
    const row = users.addRow({
      userId: u.userId,
      name: BLANK,
      email: u.email || BLANK,
      firstLogin: u.firstLogin || BLANK,
      lastLogin: u.lastLogin || BLANK,
      totalLogins: u.count,
    });
    row.alignment = { vertical: 'middle' };
    fmt(row, 'totalLogins', '#,##0');
  }

  // 3) Monthly Summary - headline metrics for the month.
  const summary = addSheet(
    wb,
    'Monthly Summary',
    [
      { header: 'Metric', key: 'metric', width: 28 },
      { header: 'Value', key: 'value', width: 18 },
    ],
    'B'
  );

  const metrics: Array<[string, string | number]> = [
    ['Month', input.month],
    ['Total Login Events', input.summary.totalLogins],
    ['Unique Users', input.summary.uniqueUsers],
    ['Active Users', input.summary.activeUsers],
    ['Failed Logins', input.summary.failedLogins],
    ['Generated At (UTC)', generatedAt.toISOString()],
  ];
  for (const [metric, value] of metrics) {
    const row = summary.addRow({ metric, value });
    row.alignment = { vertical: 'middle' };
    if (typeof value === 'number') fmt(row, 'value', '#,##0');
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Download filename for a month export. */
export function loginExportFilename(month: string): string {
  return `login-activity-${month}.xlsx`;
}
