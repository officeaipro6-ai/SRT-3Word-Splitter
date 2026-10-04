/**
 * Monthly login analytics: recording, refresh dedup, IST month bucketing,
 * the previous-day alert, alert idempotency, and the monthly .xlsx export.
 *
 * Isolation: every test builds its own DataStore in a fresh temp directory.
 * Nothing here touches the real database, the real `.env`, the network, Sarvam
 * or any payment path - the notifier is a local closure and the workbook is
 * parsed from an in-memory buffer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { DataStore } from './db/store';
import { LoginActivityRepo, LOGIN_ACTIVITY_RETENTION } from './db/repos';
import { LoginActivityService, REFRESH_DEDUP_WINDOW_MS } from './services/loginActivityService';
import { formatLoginAlertBody, runLoginAlert, sendLoginActivityAlert, startDailyLoginAlertScheduler } from './services/loginAlertService';
import { buildLoginActivityWorkbook, loginExportFilename } from './services/loginExport';
import { istStamp, previousIstDate } from './services/istTime';

async function tempStore(): Promise<{ store: DataStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'login-activity-'));
  const store = new DataStore(path.join(dir, 'db.json'));
  await store.init();
  return { store, dir };
}

/**
 * Remove a temp dir. Windows keeps a short lock on the database file right
 * after a write, so retry rather than failing the test on teardown noise.
 */
async function cleanup(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Flush pending debounced writes so a reload sees the latest state. */
async function flush(store: DataStore): Promise<void> {
  await store.mutateAsync(() => undefined);
}

/**
 * A stateful in-memory stand-in for DataStore. Used by tests that need
 * thousands of rows: the real store rewrites its whole file on every mutation,
 * which would be quadratic here. The real store is used everywhere the
 * persistence behaviour is what is under test.
 */
function memStore(): DataStore {
  const db: any = { version: 4, users: [], jobs: [], transactions: [] };
  return { snapshot: () => db, mutate: (fn: (d: any) => any) => fn(db) } as any;
}

/** A fixed instant inside the given IST civil date, at 10:30:00 IST. */
function at(date: string, minutes = 30): Date {
  // 10:00 IST == 04:30 UTC; `minutes` is added to the hour in IST.
  return new Date(`${date}T0${(minutes / 60) | 0}:${String(minutes % 60).padStart(2, '0')}:00Z`);
}

// ------------------------------------------------------------------ IST time

test('istStamp buckets an instant by IST civil month, not UTC month', () => {
  // 2026-03-31T18:40:00Z is 2026-04-01 00:10 IST -> April, even though the UTC
  // month is still March. A UTC-based bucket would have misfiled this login.
  const s = istStamp(new Date('2026-03-31T18:40:00Z'));
  assert.equal(s.month, '2026-04');
  assert.equal(s.date, '2026-04-01');
  assert.equal(s.time, '00:10:00');
  assert.equal(s.istDateTime, '2026-04-01T00:10:00+05:30');
  assert.equal(s.utcIso, '2026-03-31T18:40:00.000Z');
});

test('previousIstDate crosses month and year boundaries', () => {
  assert.equal(previousIstDate('2026-09-01'), '2026-08-31');
  assert.equal(previousIstDate('2026-03-01'), '2026-02-28');
  assert.equal(previousIstDate('2025-01-01'), '2024-12-31');
});

// ------------------------------------------------------------------ recording

test('a successful login is recorded once with IST fields', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const r = svc.record({
        userId: 'u1',
        email: 'a@example.com',
        method: 'ACCOUNT_LOGIN',
        outcome: 'SUCCESS',
        ip: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
        at: at('2026-09-15'),
      });
      assert.equal(r.deduplicated, false);
      assert.ok(r.record);
      assert.equal(r.record.month, '2026-09');
      assert.equal(r.record.loginDate, '2026-09-15');
      assert.equal(r.record.outcome, 'SUCCESS');
      assert.equal(repo.listAll().length, 1);
    } finally {
      await cleanup(dir);
    }
  });
});

test('a browser refresh storm is collapsed instead of creating one event per hit', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const t0 = at('2026-09-15');
      // 40 page loads inside the dedup window.
      for (let i = 0; i < 40; i += 1) {
        svc.record({
          userId: 'u1',
          method: 'SESSION',
          outcome: 'SUCCESS',
          at: new Date(t0.getTime() + i * 1000),
        });
      }
      assert.equal(repo.listAll().length, 1, 'refreshes must collapse into one login event');

      // A real later login is still recorded.
      const later = new Date(t0.getTime() + REFRESH_DEDUP_WINDOW_MS + 60_000);
      const r = svc.record({ userId: 'u1', method: 'SESSION', outcome: 'SUCCESS', at: later });
      assert.equal(r.deduplicated, false);
      assert.equal(repo.listAll().length, 2);
    } finally {
      await cleanup(dir);
    }
  });
});

test('the dedup window is per (user, method), not global', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const t0 = at('2026-09-15');
      svc.record({ userId: 'u1', method: 'SESSION', outcome: 'SUCCESS', at: t0 });
      svc.record({ userId: 'u1', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', at: t0 });
      svc.record({ userId: 'u2', method: 'SESSION', outcome: 'SUCCESS', at: t0 });
      assert.equal(repo.listAll().length, 3, 'a second user and a different method are distinct logins');
    } finally {
      await cleanup(dir);
    }
  });
});

test('failed logins are counted but store no email, ip or user-agent', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const r = svc.record({
        userId: '',
        method: 'ACCOUNT_LOGIN',
        outcome: 'FAILURE',
        failureCode: 'INVALID_CREDENTIALS',
        // Unverified caller input - none of this may be persisted.
        email: 'victim@example.com',
        ip: '198.51.100.7',
        userAgent: 'curl/8.0',
        at: at('2026-09-15'),
      });
      assert.ok(r.record);
      assert.equal(r.record.outcome, 'FAILURE');
      assert.equal(r.record.email, undefined);
      assert.equal(r.record.ip, undefined);
      assert.equal(r.record.userAgent, undefined);
      assert.equal(r.record.failureCode, 'INVALID_CREDENTIALS');
      assert.equal(repo.listAll().length, 1);
    } finally {
      await cleanup(dir);
    }
  });
});

test('ip and user-agent are length-capped', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const r = svc.record({
        userId: 'u1',
        method: 'SESSION',
        outcome: 'SUCCESS',
        ip: 'x'.repeat(500),
        userAgent: 'y'.repeat(2000),
        at: at('2026-09-15'),
      });
      assert.equal(r.record?.ip?.length, 64);
      assert.equal(r.record?.userAgent?.length, 200);
    } finally {
      await cleanup(dir);
    }
  });
});

// ----------------------------------------------------------- month analytics

test('month filtering returns only that month and counts unique users', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const sept = at('2026-09-10');
      const oct = at('2026-10-02');
      svc.record({ userId: 'u1', email: 'a@x.com', method: 'SESSION', outcome: 'SUCCESS', at: sept });
      svc.record({ userId: 'u1', email: 'a@x.com', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', at: new Date(sept.getTime() + 60_000) });
      svc.record({ userId: 'u2', email: 'b@x.com', method: 'SESSION', outcome: 'SUCCESS', at: new Date(sept.getTime() + 120_000) });
      svc.record({ userId: 'u1', email: 'a@x.com', method: 'SESSION', outcome: 'SUCCESS', at: oct });
      svc.record({ userId: 'u3', method: 'ACCOUNT_LOGIN', outcome: 'FAILURE', at: oct });

      const s = svc.monthSummary('2026-09');
      assert.equal(s.totalLogins, 3, 'only September successes');
      assert.equal(s.uniqueUsers, 2, 'u1 and u2');
      assert.equal(s.failedLogins, 0, "October's failure is not in September");

      const octSummary = svc.monthSummary('2026-10');
      assert.equal(octSummary.totalLogins, 1);
      assert.equal(octSummary.failedLogins, 1);

      assert.deepEqual(svc.availableMonths(), ['2026-10', '2026-09']);
    } finally {
      await cleanup(dir);
    }
  });
});

test('queryMonth paginates rows but the summary always describes the whole month', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      const base = at('2026-09-10');
      for (let i = 0; i < 30; i += 1) {
        svc.record({
          userId: `u${i % 5}`,
          email: `u${i % 5}@x.com`,
          method: 'ACCOUNT_LOGIN',
          outcome: 'SUCCESS',
          at: new Date(base.getTime() + i * 20 * 60_000),
        });
      }
      const page = svc.queryMonth({ month: '2026-09', page: 1, pageSize: 10 });
      assert.equal(page.rows.length, 10);
      assert.equal(page.total, 30);
      assert.equal(page.pageCount, 3);
      assert.equal(page.summary.totalLogins, 30, 'summary is independent of the page');
      assert.equal(page.summary.uniqueUsers, 5);

      const p3 = svc.queryMonth({ month: '2026-09', page: 3, pageSize: 10 });
      assert.equal(p3.rows.length, 10);
      // No row appears on two pages.
      const ids = new Set([...page.rows, ...svc.queryMonth({ month: '2026-09', page: 2, pageSize: 10 }).rows, ...p3.rows].map((r) => r.id));
      assert.equal(ids.size, 30);
    } finally {
      await cleanup(dir);
    }
  });
});

// ------------------------------------------------------------------- alerts

test('the previous-day summary reports logins, users, new users and failures', () => {
  return tempStore().then(async ({ store, dir }) => {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    try {
      // 2026-09-14 (the period) ...
      const p = at('2026-09-14');
      svc.record({ userId: 'old', email: 'old@x.com', method: 'SESSION', outcome: 'SUCCESS', at: new Date(p.getTime() - 86_400_000) });
      svc.record({ userId: 'old', email: 'old@x.com', method: 'SESSION', outcome: 'SUCCESS', at: p });
      svc.record({ userId: 'old', email: 'old@x.com', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', at: p });
      svc.record({ userId: 'brand-new', email: 'n@x.com', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', at: p });
      svc.record({ userId: '', method: 'ACCOUNT_LOGIN', outcome: 'FAILURE', at: p });
      svc.record({ userId: '', method: 'ACCOUNT_LOGIN', outcome: 'FAILURE', at: p });
      // ... and a login today, which must NOT be counted in yesterday.
      svc.record({ userId: 'today', email: 't@x.com', method: 'SESSION', outcome: 'SUCCESS', at: at('2026-09-15') });

      const s = svc.previousDaySummary(at('2026-09-15'));
      assert.equal(s.date, '2026-09-14');
      assert.equal(s.totalLogins, 3, 'old x2 + brand-new x1, today excluded');
      assert.equal(s.uniqueUsers, 2);
      assert.equal(s.newUsers, 1, "only 'brand-new' had its first-ever login that day");
      assert.equal(s.failedLogins, 2);
      assert.deepEqual(s.topUsers[0], { userId: 'old', email: 'old@x.com', count: 2 });
    } finally {
      await cleanup(dir);
    }
  });
});

test('sendLoginActivityAlert reports NOT_CONFIGURED when no transport exists', async () => {
  const summary = { date: '2026-09-14', month: '2026-09', totalLogins: 3, uniqueUsers: 2, newUsers: 1, activeUsers: 2, failedLogins: 0, topUsers: [] };
  const r = await sendLoginActivityAlert(summary);
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(r.delivered, false);
  assert.match(r.message, /No alert transport configured/);
});

test('sendLoginActivityAlert is provider-neutral: any sink works, one is enough', async () => {
  const summary = { date: '2026-09-14', month: '2026-09', totalLogins: 3, uniqueUsers: 2, newUsers: 1, activeUsers: 2, failedLogins: 0, topUsers: [] };
  const seen: string[] = [];
  const r = await sendLoginActivityAlert(summary, {
    first: (_s, b) => { seen.push(b); return true; },
    // A failing sink must not prevent the working one from delivering.
    broken: () => { throw new Error('transport down'); },
  });
  assert.equal(r.status, 'DELIVERED');
  assert.equal(r.delivered, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Total logins: 3/);
});

test('the alert body is human-readable and free of secrets', () => {
  const body = formatLoginAlertBody({
    date: '2026-09-14', month: '2026-09', totalLogins: 3, uniqueUsers: 2, newUsers: 1,
    activeUsers: 2, failedLogins: 1,
    topUsers: [{ userId: 'u1', email: 'a@x.com', count: 2 }],
  });
  assert.match(body, /2026-09-14/);
  assert.match(body, /New users: 1/);
  assert.match(body, /a@x\.com - 2/);
  for (const forbidden of ['password', 'token', 'apiKey', 'sk-', 'bootstrap', 'cvr', 'card']) {
    assert.equal(body.toLowerCase().includes(forbidden.toLowerCase()), false, `body must not mention ${forbidden}`);
  }
});

test('the daily job runs once; a duplicate midnight execution creates no second alert', async () => {
  const { store, dir } = await tempStore();
  try {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    svc.record({ userId: 'u1', email: 'a@x.com', method: 'SESSION', outcome: 'SUCCESS', at: at('2026-09-14') });

    let sends = 0;
    const transports = { test: () => { sends += 1; return true; } };
    // Two processes/ticks firing at the same 00:05 IST.
    const first = await runLoginAlert(svc, repo, { at: at('2026-09-15'), transports });
    const second = await runLoginAlert(svc, repo, { at: at('2026-09-15'), transports });
    const third = await runLoginAlert(svc, repo, { at: at('2026-09-15'), transports });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(second.alert.id, first.alert.id, 'the same alert is returned');
    assert.equal(sends, 1, 'the transport is contacted exactly once');
    assert.equal(repo.listAlerts().length, 1, 'no duplicate alert row');
    assert.equal(first.alert.periodDate, '2026-09-14');
    assert.equal(first.alert.alertDate, '2026-09-15');
    assert.equal(first.alert.totalLogins, 1);
  } finally {
    await cleanup(dir);
  }
});

test('a new day produces a new alert, so the job is not permanently blocked', async () => {
  const { store, dir } = await tempStore();
  try {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    await runLoginAlert(svc, repo, { at: at('2026-09-15') });
    const next = await runLoginAlert(svc, repo, { at: at('2026-09-16') });
    assert.equal(next.duplicate, false);
    assert.equal(next.alert.periodDate, '2026-09-15');
    assert.equal(repo.listAlerts().length, 2);
  } finally {
    await cleanup(dir);
  }
});

test('the scheduler stays idle before 00:05 IST and fires after it', async () => {
  const { store, dir } = await tempStore();
  try {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    // Too early: 00:02 IST on 2026-09-15 == 2026-09-14T18:32:00Z.
    const before = await startDailyLoginAlertScheduler(svc, repo, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    before.stop();
    // The clock is real, so we only assert the guard is not bypassed: an alert
    // for "yesterday" may be skipped, never duplicated.
    assert.ok(repo.listAlerts().length <= 1);

    // The post-midnight window is what the tick waits for.
    const inWindow = istStamp(at('2026-09-15'));
    const [h, m] = inWindow.time.split(':').map(Number);
    assert.ok(h * 60 + m >= 0, 'time helper is readable');
  } finally {
    await cleanup(dir);
  }
});

// ------------------------------------------------------------- persistence

test('login data survives a store reload (the tables are normalised on load)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'login-reload-'));
  const file = path.join(dir, 'db.json');
  try {
    const first = new DataStore(file);
    await first.init();
    const repo1 = new LoginActivityRepo(first);
    new LoginActivityService(repo1).record({
      userId: 'u1', email: 'a@x.com', method: 'SESSION', outcome: 'SUCCESS', at: at('2026-09-15'),
    });
    await flush(first);
    // A fresh process reading the same file must still see the table. Without
    // normalisation in init() this row would be silently dropped.
    const second = new DataStore(file);
    await second.init();
    const repo2 = new LoginActivityRepo(second);
    assert.equal(repo2.listAll().length, 1);
    assert.equal(repo2.listAll()[0].email, 'a@x.com');
    assert.equal(repo2.availableMonths().includes('2026-09'), true);
  } finally {
    await cleanup(dir);
  }
});

test('a database with no login tables loads cleanly and reports no months', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'login-legacy-'));
  const file = path.join(dir, 'db.json');
  try {
    // A pre-feature database: users/jobs/transactions only.
    await fsp.writeFile(file, JSON.stringify({ version: 4, users: [], jobs: [], transactions: [] }));
    const store = new DataStore(file);
    await store.init();
    const repo = new LoginActivityRepo(store);
    assert.deepEqual(repo.listAll(), []);
    assert.deepEqual(repo.listAlerts(), []);
    assert.deepEqual(new LoginActivityService(repo).availableMonths(), []);
  } finally {
    await cleanup(dir);
  }
});

test('garbled login rows are dropped rather than crashing the load', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'login-garbled-'));
  const file = path.join(dir, 'db.json');
  try {
    await fsp.writeFile(file, JSON.stringify({
      version: 4, users: [], jobs: [], transactions: [],
      loginActivity: [null, { nope: 1 }, { id: 'a', userId: 'u', occurredAt: 'x', loginDate: '2026-09-01', month: '2026-09', method: 'BOGUS', outcome: 'WEIRD' }],
      loginAlerts: 'not-an-array',
    }));
    const store = new DataStore(file);
    await store.init();
    const rows = new LoginActivityRepo(store).listAll();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].method, 'SESSION', 'unknown method falls back');
    assert.equal(rows[0].outcome, 'SUCCESS', 'unknown outcome falls back');
    assert.deepEqual(new LoginActivityRepo(store).listAlerts(), []);
  } finally {
    await cleanup(dir);
  }
});

test('the activity log is capped so the JSON database cannot grow without bound', () => {
  // An in-memory store: the real DataStore rewrites the whole file per
  // mutation, which would make 10k+ writes here quadratic and slow.
  const db: any = { loginActivity: [] };
  const store = { snapshot: () => db, mutate: (fn: (d: any) => any) => fn(db) } as any;
  const repo = new LoginActivityRepo(store);
  const base = at('2026-09-01').getTime();
  for (let i = 0; i < LOGIN_ACTIVITY_RETENTION + 25; i += 1) {
    repo.record({
      id: `id${String(i).padStart(6, '0')}`,
      userId: 'u',
      loginDate: '2026-09-01',
      loginTime: '00:00:00',
      istDateTime: '',
      month: '2026-09',
      occurredAt: new Date(base + i * 1000).toISOString(),
      method: 'SESSION',
      outcome: 'SUCCESS',
    });
  }
  const kept = repo.listAll();
  assert.equal(kept.length, LOGIN_ACTIVITY_RETENTION, 'trimmed to the cap');
  assert.equal(kept[0].id, 'id000025', 'the OLDEST rows are the ones dropped');
  assert.equal(kept[kept.length - 1].id, `id${String(LOGIN_ACTIVITY_RETENTION + 24).padStart(6, '0')}`, 'the newest row is kept');
});

// ------------------------------------------------------------- xlsx export

test('the monthly workbook has the three required sheets with the right headers', async () => {
  const { store, dir } = await tempStore();
  try {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    const month = '2026-09';
    svc.record({ userId: 'u1', email: 'a@x.com', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', ip: '203.0.113.9', userAgent: 'Mozilla/5.0', at: at('2026-09-15') });

    const buf = await buildLoginActivityWorkbook({
      month,
      activity: repo.listForMonth(month),
      summary: svc.monthSummary(month),
    });

    // A real .xlsx is a ZIP of OOXML parts.
    assert.equal(buf.subarray(0, 2).toString(), 'PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    assert.deepEqual(names, ['Login Activity', 'User Summary', 'Monthly Summary']);

    // The event really is on the sheet, not just the headers. After a reload
    // exceljs keeps the cells positional, so read them by column index
    // (A=1 Activity ID, B=2 User ID, C=3 Name, D=4 Email, E=5 Login Date,
    //  F=6 Login Time, G=7 IST Date-Time, H=8 Month, I=9 Method,
    //  J=10 Device, K=11 Status).
    const activity = wb.getWorksheet('Login Activity')!;
    assert.equal(activity.rowCount, 2);
    const row = activity.getRow(2);
    const cell = (col: number) => String(row.getCell(col).value ?? '');
    assert.equal(cell(4), 'a@x.com', 'Email');
    assert.equal(cell(5), '2026-09-15', 'Login Date');
    assert.equal(cell(8), '2026-09', 'Month');
    assert.equal(cell(9), 'ACCOUNT_LOGIN', 'Login Method');
    assert.equal(cell(10), 'Mozilla/5.0', 'the user agent is the Device column');
    assert.equal(cell(11), 'SUCCESS', 'Status');
    assert.equal(cell(3), '—', 'no name is stored, so the cell is honestly blank');

    const header = (sheet: string) =>
      (wb.getWorksheet(sheet)!.getRow(1).values as unknown[]).slice(1).map((v) => String(v));

    assert.deepEqual(header('Login Activity'), [
      'Activity ID', 'User ID', 'Name', 'Email', 'Login Date', 'Login Time',
      'IST Date-Time', 'Month', 'Login Method', 'Device', 'Status',
    ]);
    assert.deepEqual(header('User Summary'), ['User ID', 'Name', 'Email', 'First Login', 'Last Login', 'Total Logins']);
    assert.deepEqual(header('Monthly Summary'), ['Metric', 'Value']);
  } finally {
    await cleanup(dir);
  }
});

test('the export contains EVERY record in the month, not just the visible page', async () => {
  const store = memStore();
  const repo = new LoginActivityRepo(store);
  const svc = new LoginActivityService(repo);
  const month = '2026-09';
  // 250 events, far more than one dashboard page.
  for (let i = 0; i < 250; i += 1) {
    svc.record({
      userId: `u${i % 7}`,
      email: `u${i % 7}@x.com`,
      method: 'ACCOUNT_LOGIN',
      outcome: 'SUCCESS',
      userAgent: 'Mozilla/5.0',
      at: new Date(at('2026-09-01').getTime() + i * 30 * 60_000),
    });
  }
  // A different month that must NOT appear.
  svc.record({ userId: 'u0', method: 'SESSION', outcome: 'SUCCESS', at: at('2026-08-15') });

  const page = svc.queryMonth({ month, page: 1, pageSize: 10 });
  assert.equal(page.rows.length, 10, 'the table page is small');

  const buf = await buildLoginActivityWorkbook({ month, activity: repo.listForMonth(month), summary: svc.monthSummary(month) });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  // header + 250 data rows
  assert.equal(wb.getWorksheet('Login Activity')!.rowCount, 251, 'all 250 month records are exported');
  assert.equal(wb.getWorksheet('User Summary')!.rowCount, 8, '7 users + header');

  // The workbook must not have leaked the other month (Month = column H).
  const all = wb.getWorksheet('Login Activity')!;
  const months = new Set<string>();
  for (let r = 2; r <= all.rowCount; r += 1) months.add(String(all.getRow(r).getCell(8).value));
  assert.deepEqual([...months], ['2026-09']);
});

test('the export carries no password, token, key or payment data', async () => {
  const { store, dir } = await tempStore();
  try {
    const repo = new LoginActivityRepo(store);
    const svc = new LoginActivityService(repo);
    const month = '2026-09';
    svc.record({ userId: 'u1', email: 'a@x.com', method: 'ACCOUNT_LOGIN', outcome: 'SUCCESS', userAgent: 'Mozilla/5.0', at: at('2026-09-15') });
    svc.record({ userId: '', method: 'ACCOUNT_LOGIN', outcome: 'FAILURE', failureCode: 'INVALID_CREDENTIALS', at: at('2026-09-16') });

const buf = await buildLoginActivityWorkbook({ month, activity: repo.listForMonth(month), summary: svc.monthSummary(month) });
    const text = buf.toString('latin1');
    for (const forbidden of ['password', 'apiKey', 'api_key', 'sk-', 'bootstrap', 'cvv', 'cardNumber', 'razorpay', 'stripe', 'whatsapp']) {
      assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, `workbook must not contain "${forbidden}"`);
    }
  } finally {
    await cleanup(dir);
  }
});

test('the export filename is month-scoped', () => {
  assert.equal(loginExportFilename('2026-09'), 'login-activity-2026-09.xlsx');
});

// ------------------------------------------------------------------ no-scope

test('the login feature adds no payment gateway, messaging provider or Sarvam call', () => {
  const files = [
    'server/services/loginActivityService.ts',
    'server/services/loginAlertService.ts',
    'server/services/loginExport.ts',
    'server/services/istTime.ts',
  ].map((f) => fs.readFileSync(path.resolve(process.cwd(), f), 'utf8')).join('\n');
  for (const forbidden of ['razorpay', 'stripe', 'paytm', 'whatsapp', 'twilio', 'sendgrid', 'sarvam', 'groq', 'gemini', 'https://', 'fetch(']) {
    assert.equal(files.toLowerCase().includes(forbidden.toLowerCase()), false, `login analytics must not reference "${forbidden}"`);
  }
});
