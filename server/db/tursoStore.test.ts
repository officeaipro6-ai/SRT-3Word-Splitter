/**
 * Turso/libSQL schema compatibility tests for server/db/tursoStore.ts.
 *
 * These run against a real SQLite engine through @libsql/client's local
 * `file::memory:` URL, so CREATE TABLE, PRIMARY KEY and NOT NULL semantics are
 * enforced exactly as they would be on Turso. They NEVER connect to Turso, never
 * read real credentials and never touch data/app.db.json or data/storage/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTITY_SPECS } from '../../scripts/migrate-to-production.ts';
import { CreditRepo, JobRepo } from './repos.ts';
import { DataStore } from './store.ts';
import { SCHEMA_VERSION, TursoStore } from './tursoStore.ts';

/** Repository root, for the source-level audits in the Step 5A tests. */
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const ALL_TABLES = [
  'users',
  'jobs',
  'transactions',
  'providerSafety',
  'moderationCases',
  'communityRestrictions',
  'communityMessages',
  'loginActivity',
  'loginAlerts',
] as const;

type Client = ReturnType<typeof createClient>;

/** Fresh in-memory database + an initialised store, with no network involved. */
async function openStore(): Promise<{ client: Client; store: TursoStore }> {
  const client = createClient({ url: 'file::memory:' });
  const store = new TursoStore(client);
  await store.init();
  return { client, store };
}

async function tableNames(client: Client): Promise<string[]> {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return result.rows.map((r) => String(r.name));
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}

/** Introspect the table as the database actually built it. */
async function columns(client: Client, table: string): Promise<ColumnInfo[]> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows as unknown as ColumnInfo[];
}

function columnNames(client: Client, table: string): Promise<string[]> {
  return columns(client, table).then((cols) => cols.map((c) => c.name));
}

/**
 * A user as the real write path stores it: `normalizeUser()` in store.ts fills
 * the optional credit counters before `createUser()` sees the record.
 */
function sampleUser(id: string): Record<string, unknown> {
  return {
    id,
    tokenHashes: [],
    credits: 100,
    role: 'USER',
    creditMode: 'NORMAL',
    createdAt: '2026-01-01T00:00:00.000Z',
    freeTrialsUsed: 0,
    purchasedCredits: 0,
    bonusCredits: 0,
  };
}

test('init() creates all 9 tables without a duplicate-column error', async () => {
  const { client } = await openStore();
  const names = await tableNames(client);
  for (const table of ALL_TABLES) {
    assert.ok(names.includes(table), `missing table: ${table}`);
  }
  // init() must also be re-runnable against an existing database.
  const store = new TursoStore(client);
  await store.init();
  assert.deepEqual(await tableNames(client), names);
});

test('loginAlerts declares generatedAt exactly once', async () => {
  const { client } = await openStore();
  const cols = await columns(client, 'loginAlerts');
  const generatedAt = cols.filter((c) => c.name === 'generatedAt');
  assert.equal(generatedAt.length, 1, 'generatedAt must be declared exactly once');
  assert.equal(generatedAt[0].type, 'TEXT');
  assert.equal(generatedAt[0].notnull, 1);
  // Column names must be unique across the whole table.
  const all = cols.map((c) => c.name);
  assert.equal(new Set(all).size, all.length);
});

test('transactions carries a nullable jobId and a nullable idempotencyKey', async () => {
  const { client } = await openStore();
  const cols = await columns(client, 'transactions');
  const jobId = cols.find((c) => c.name === 'jobId');
  assert.ok(jobId, 'transactions.jobId must exist (per-job idempotency depends on it)');
  assert.equal(jobId.type, 'TEXT');
  assert.equal(jobId.notnull, 0, 'jobId must be nullable');
  const key = cols.find((c) => c.name === 'idempotencyKey');
  assert.ok(key, 'transactions.idempotencyKey must exist');
  assert.equal(key.notnull, 0, 'idempotencyKey must be nullable; only ADMIN_* rows carry one');
  const all = cols.map((c) => c.name);
  assert.equal(new Set(all).size, all.length);
});

test('jobs carries creditTxnId and retryCount', async () => {
  const { client } = await openStore();
  const cols = await columns(client, 'jobs');
  const creditTxnId = cols.find((c) => c.name === 'creditTxnId');
  assert.ok(creditTxnId, 'jobs.creditTxnId must exist');
  assert.equal(creditTxnId.type, 'TEXT');
  assert.equal(creditTxnId.notnull, 0, 'creditTxnId must be nullable (not every job is charged)');
  const retryCount = cols.find((c) => c.name === 'retryCount');
  assert.ok(retryCount, 'jobs.retryCount must exist');
  assert.equal(retryCount.type, 'INTEGER');
  assert.equal(retryCount.notnull, 1);
  assert.equal(String(retryCount.dflt_value), '0');
});

test('communityRestrictions is keyed by (userId, startedAt) with no invented id', async () => {
  const { client } = await openStore();
  const cols = await columns(client, 'communityRestrictions');
  assert.ok(
    !cols.some((c) => c.name === 'id'),
    'no id column may exist: the source record has none and nothing generated one'
  );
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(pk, ['userId', 'startedAt'], 'primary key must be (userId, startedAt)');
  for (const name of ['userId', 'startedAt']) {
    assert.equal(cols.find((c) => c.name === name)!.notnull, 1);
  }
});

test('every ENTITY_SPEC column exists in the schema init() actually creates', async () => {
  const { client } = await openStore();
  for (const [entity, spec] of Object.entries(ENTITY_SPECS)) {
    const actual = await columnNames(client, spec.table);
    for (const col of spec.columns) {
      assert.ok(actual.includes(col.column), `${entity}: missing destination column ${col.column}`);
    }
    for (const key of spec.primaryKey) {
      assert.ok(actual.includes(key), `${entity}: primary key ${key} is not a column`);
    }
  }
});

test('a transaction without jobId or idempotencyKey inserts with NULLs, and jobId round-trips', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1'));

  // A plain usage ledger entry: neither field is present on the record.
  await store.addTransaction({
    id: 'tx-plain',
    userId: 'u1',
    type: 'USAGE',
    amount: 3,
    reason: 'charge',
    balanceAfter: 97,
    createdAt: '2026-01-01T00:00:01.000Z',
  });
  // A job-linked DEBIT: carries jobId but still no idempotency key.
  await store.addTransaction({
    id: 'tx-job',
    userId: 'u1',
    type: 'DEBIT',
    amount: 5,
    reason: 'charge_transcription',
    balanceAfter: 92,
    jobId: 'job-1',
    createdAt: '2026-01-01T00:00:02.000Z',
  });

  const rows = await store.getTransactions();
  assert.equal(rows.length, 2);
  const plain = rows.find((r: any) => r.id === 'tx-plain');
  const job = rows.find((r: any) => r.id === 'tx-job');
  assert.equal(plain.idempotencyKey, null, 'an absent key must stay NULL, never be invented');
  assert.equal(plain.jobId, null);
  assert.equal(job.jobId, 'job-1', 'jobId must round-trip for per-job idempotency lookups');
  assert.equal(job.idempotencyKey, null);

  // An admin row that does supply a key keeps it, and stays findable.
  await store.addTransaction({
    id: 'tx-admin',
    userId: 'u1',
    type: 'ADMIN_GRANT',
    amount: 7,
    reason: 'grant',
    balanceAfter: 99,
    idempotencyKey: 'idem-1',
    createdAt: '2026-01-01T00:00:03.000Z',
  });
  const found = await store.getTransactionByIdempotencyKey('idem-1', 'u1', 'ADMIN_GRANT');
  assert.equal(found.id, 'tx-admin');
});

test('jobs round-trip creditTxnId and retryCount', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1'));
  const input = { storageKey: 'uploads/j1.wav', originalName: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1, sha256: 'x', durationSeconds: 0 };
  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'QUEUED',
    provider: 'sarvam',
    input,
    createdAt: '2026-01-01T00:00:00.000Z',
    creditTxnId: 'tx-job',
    retryCount: 3,
  });
  const [job] = await store.getJobs();
  assert.equal(job.creditTxnId, 'tx-job');
  assert.equal(job.retryCount, 3);

  // A legacy-shaped job with neither field still inserts via the column defaults.
  await store.createJob({ id: 'j2', userId: 'u1', status: 'QUEUED', provider: 'sarvam', input, createdAt: '2026-01-01T00:00:01.000Z' });
  const legacy = (await store.getJobs()).find((r: any) => r.id === 'j2');
  assert.equal(legacy.creditTxnId, null);
  assert.equal(legacy.retryCount, 0);
});

test('restriction identity is deterministic: the same (userId, startedAt) cannot duplicate', async () => {
  const { store } = await openStore();
  const record = {
    userId: 'u1',
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
    violationCount: 1,
    automatic: true,
    extendedCount: 0,
  };
  await store.applyRestriction(record);
  assert.equal((await store.getCommunityRestrictions()).length, 1);

  // Re-applying the identical source record (a retried migration) must be
  // rejected by the primary key, never accepted as a second row.
  await assert.rejects(() => store.applyRestriction({ ...record }), /UNIQUE|constraint/i);

  const stored = (await store.getRestrictionsForUser('u1'))[0];
  assert.equal(stored.userId, 'u1');
  assert.equal(stored.startedAt, record.startedAt);
  assert.equal(stored.violationCount, 1);
  assert.equal(stored.automatic, 1);
  assert.equal(stored.releasedAt, null);
});

test('saveAlert writes exactly one generatedAt and stays keyed by id', async () => {
  const { store } = await openStore();
  const alert = {
    id: 'a1',
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 4,
    uniqueUsers: 2,
    newUsers: 1,
    activeUsers: 2,
    failedLogins: 1,
    topUsers: [{ userId: 'u1', count: 3 }],
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  };
  await store.saveAlert(alert);
  const [saved] = await store.listAlerts();
  assert.equal(saved.id, 'a1');
  assert.equal(saved.generatedAt, alert.generatedAt);
  assert.equal(saved.periodDate, '2026-01-01');
  assert.equal(saved.statusMessage, 'ok');
  assert.ok(await store.hasAlertFor('2026-01-01'));

  // Re-saving the same id updates in place (one row, not two).
  await store.saveAlert({ ...alert, generatedAt: '2026-01-02T04:00:00.000Z', totalLogins: 9 });
  const all = await store.listAlerts();
  assert.equal(all.length, 1);
  assert.equal(all[0].generatedAt, '2026-01-02T04:00:00.000Z');
  assert.equal(all[0].totalLogins, 9);
});

test('the migration never emits a destructive or overwriting statement', async () => {
  const { client } = await openStore();
  for (const table of ALL_TABLES) {
    const triggers = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${table}'`
    );
    assert.equal(triggers.rows.length, 0, `${table} must have no triggers`);
    const views = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='view' AND tbl_name='${table}'`
    );
    assert.equal(views.rows.length, 0, `${table} must have no views`);
  }
  // No schema may reference ON DELETE CASCADE / SET NULL, which would let a
  // single insert or delete cascade into unrelated rows.
  for (const table of ALL_TABLES) {
    const sql = await client.execute(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`
    );
    const text = String(sql.rows[0]?.sql ?? '');
    assert.ok(!/ON\s+DELETE/i.test(text), `${table} declares ON DELETE ...`);
    assert.ok(!/ON\s+UPDATE/i.test(text), `${table} declares ON UPDATE ...`);
  }
});

// ---------------------------------------------------------------------------
// 1. loginAlerts.periodDate uniqueness
// ---------------------------------------------------------------------------

test('loginAlerts declares UNIQUE(periodDate) so the database enforces it', async () => {
  const { client } = await openStore();
  const indexes = await client.execute('PRAGMA index_list(loginAlerts)');
  const uniqueCols: string[] = [];
  for (const idx of indexes.rows as unknown as { unique: number; name: string }[]) {
    if (!idx.unique) continue;
    const info = await client.execute(`PRAGMA index_info(${idx.name})`);
    uniqueCols.push(...info.rows.map((r) => String(r.name)));
  }
  assert.ok(uniqueCols.includes('periodDate'), 'periodDate must carry a UNIQUE index');
});

test('two different alert ids for the same periodDate cannot create two records', async () => {
  const { store } = await openStore();
  const base = {
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 4,
    uniqueUsers: 2,
    newUsers: 1,
    activeUsers: 2,
    failedLogins: 1,
    topUsers: [{ userId: 'u1', count: 3 }],
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  };

  await store.saveAlert({ ...base, id: 'alert-a' });
  assert.equal((await store.listAlerts()).length, 1);

  // A second run for the same period with a different id must replace the
  // existing business record, not append a duplicate.
  await store.saveAlert({ ...base, id: 'alert-b', totalLogins: 9, generatedAt: '2026-01-02T05:00:00.000Z' });
  const all = await store.listAlerts();
  assert.equal(all.length, 1, 'exactly one business record per periodDate');
  assert.equal(all[0].totalLogins, 9, 'the re-issued summary wins');
  assert.equal(all[0].generatedAt, '2026-01-02T05:00:00.000Z');

  // The stored id is carried over, never invented: the original id survives
  // because periodDate is the conflict target.
  assert.equal(all[0].id, 'alert-a');
  assert.ok(await store.hasAlertFor('2026-01-01'));
  assert.equal((await store.findAlertFor('2026-01-01'))!.periodDate, '2026-01-01');
});

test('repeated application of the same alert is idempotent', async () => {
  const { store } = await openStore();
  const alert = {
    id: 'alert-a',
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 4,
    uniqueUsers: 2,
    newUsers: 1,
    activeUsers: 2,
    failedLogins: 1,
    topUsers: [],
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  };

  for (let i = 0; i < 5; i += 1) await store.saveAlert({ ...alert });

  const all = await store.listAlerts();
  assert.equal(all.length, 1);
  // Every field, including the topUsers JSON blob, must survive five identical
  // applications byte-identically: it is decoded on the way out, so it can be
  // compared directly instead of being excluded from the assertion.
  assert.deepEqual({ ...all[0], id: 'ignored-id' }, { ...alert, id: 'ignored-id' });
});

test('distinct periods are kept as separate alerts', async () => {
  const { store } = await openStore();
  const base = {
    alertDate: '2026-01-02',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 1,
    uniqueUsers: 1,
    newUsers: 0,
    activeUsers: 1,
    failedLogins: 0,
    topUsers: [],
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  };
  await store.saveAlert({ ...base, id: 'a1', periodDate: '2026-01-01' });
  await store.saveAlert({ ...base, id: 'a2', periodDate: '2026-01-02' });
  await store.saveAlert({ ...base, id: 'a3', periodDate: '2026-01-03' });

  assert.equal((await store.listAlerts()).length, 3);
  assert.equal(new Set((await store.listAlerts()).map((a: any) => a.id)).size, 3);
});

// ---------------------------------------------------------------------------
// 2. transaction paymentId
// ---------------------------------------------------------------------------

test('transactions carries a dedicated paymentId column', async () => {
  const { client } = await openStore();
  const col = (await columns(client, 'transactions')).find((c) => c.name === 'paymentId');
  assert.ok(col, 'transactions.paymentId must exist as its own column');
  assert.equal(col.type, 'TEXT');
  assert.equal(col.notnull, 0, 'paymentId must be nullable');
});

test('a transaction with paymentId round-trips through the payment-ID lookup', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1'));

  await store.addTransaction({
    id: 'tx-pay',
    userId: 'u1',
    type: 'PACKAGE',
    amount: 500,
    reason: 'razorpay_capture',
    balanceAfter: 600,
    paymentId: 'pay_RANDOM123',
    createdAt: '2026-01-02T03:04:05.000Z',
  });

  const found = await store.getTransactionByPaymentId('pay_RANDOM123');
  assert.ok(found, 'the payment-ID lookup must find the transaction');
  assert.equal(found.id, 'tx-pay');
  assert.equal(found.paymentId, 'pay_RANDOM123');
  assert.equal(found.type, 'PACKAGE');
  // Ids and timestamps are untouched by the payment mapping.
  assert.equal(found.createdAt, '2026-01-02T03:04:05.000Z');

  // An unknown payment id must not match, and must not match a NULL row either.
  assert.equal(await store.getTransactionByPaymentId('pay_OTHER'), null);
});

test('a transaction without paymentId keeps it null and stays out of the lookup', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1'));

  await store.addTransaction({
    id: 'tx-nopay',
    userId: 'u1',
    type: 'USAGE',
    amount: 3,
    reason: 'charge',
    balanceAfter: 97,
    createdAt: '2026-01-02T03:04:06.000Z',
  });
  await store.addTransaction({
    id: 'tx-nopay-2',
    userId: 'u1',
    type: 'USAGE',
    amount: 3,
    reason: 'charge',
    balanceAfter: 94,
    createdAt: '2026-01-02T03:04:07.000Z',
  });

  const [row] = (await store.getTransactions()).filter((r: any) => r.id === 'tx-nopay');
  assert.equal(row.paymentId, null, 'an absent paymentId must stay NULL, never be invented');
  assert.equal(row.extra, null, 'paymentId must not be stuffed into extra');
  assert.equal(await store.getTransactionByPaymentId(''), null);
  assert.equal((await store.getTransactions()).length, 2, 'two payment-less rows may coexist');
});

// ---------------------------------------------------------------------------
// 3. createUser optional credit fields
// ---------------------------------------------------------------------------

test('createUser applies the same defaults as normalizeUser for a partial record', async () => {
  const { store } = await openStore();
  // Deliberately partial: only the fields a brand-new record must carry.
  await store.createUser({ id: 'partial', createdAt: '2026-01-01T00:00:00.000Z' } as any);

  const user = await store.getUserById('partial');
  assert.ok(user);
  assert.equal(user.freeTrialsUsed, 0);
  assert.equal(user.purchasedCredits, 0);
  assert.equal(user.bonusCredits, 0);
  assert.equal(user.credits, 0);
  // Read back as the decoded array the DataStore interface promises, not as the
  // raw '[]' text that is physically stored in the column.
  assert.deepEqual(user.tokenHashes, []);
  assert.equal(user.role, 'USER');
  assert.equal(user.creditMode, 'NORMAL');
});

test('createUser does not change the meaning of supplied values', async () => {
  const { store } = await openStore();
  await store.createUser({
    id: 'explicit',
    tokenHashes: ['h1'],
    credits: 42,
    role: 'ADMIN',
    creditMode: 'UNLIMITED',
    createdAt: '2026-01-01T00:00:00.000Z',
    freeTrialsUsed: 3,
    purchasedCredits: 10,
    bonusCredits: 7,
  } as any);

  const user = await store.getUserById('explicit');
  assert.equal(user!.credits, 42);
  assert.equal(user!.role, 'ADMIN');
  assert.equal(user!.creditMode, 'UNLIMITED');
  assert.equal(user!.freeTrialsUsed, 3);
  assert.equal(user!.purchasedCredits, 10);
  assert.equal(user!.bonusCredits, 7);
  assert.deepEqual(user!.tokenHashes, ['h1']);
});

// ---------------------------------------------------------------------------
// 4. PRAGMA journal_mode=WAL is local-driver only
// ---------------------------------------------------------------------------

test('journal_mode is configured for a local file driver', async () => {
  const client = createClient({ url: 'file::memory:' });
  const before = await client.execute('PRAGMA journal_mode');
  await new TursoStore(client).init();
  const after = await client.execute('PRAGMA journal_mode');
  // A local driver accepts the pragma and reports a mode back.
  assert.ok(typeof after.rows[0].journal_mode === 'string', 'local driver reports a journal mode');
  assert.ok(before.rows.length > 0);
});

test('a real file-backed database initialises without a WAL conflict', async () => {
  // Regression: the embedded-driver probe used to be `EXPLAIN PRAGMA
  // journal_mode`, which leaves a read transaction open and made the following
  // `PRAGMA journal_mode=WAL` fail with "cannot change into wal mode from within
  // a transaction". `file::memory:` hides this because an in-memory database
  // ignores the mode switch, so only a real file URL exposes it.
  const dir = mkdtempSync(join(tmpdir(), 'libsql-file-'));
  const client = createClient({ url: `file:${join(dir, 'app.db')}` });
  const store = new TursoStore(client);
  await store.init();

  const mode = await client.execute('PRAGMA journal_mode');
  assert.equal(String(mode.rows[0].journal_mode).toLowerCase(), 'wal', 'WAL must actually be applied');
  assert.deepEqual(await store.validateSchema(), []);
  assert.equal(store.foreignKeysActive, true, 'foreign keys work on a file-backed database too');
});

test('no WAL pragma is sent to a remote driver', async () => {
  const issued: string[] = [];
  // Stand-in for a remote libsql/Turso client: PRAGMAs are unsupported.
  const remote = {
    async execute(opts: { sql: string; args?: unknown[] } | string) {
      const sql = typeof opts === 'string' ? opts : opts.sql;
      issued.push(sql);
      if (/PRAGMA/i.test(sql)) throw new Error('remote driver rejected: PRAGMA');
      return { rows: [] };
    },
    async transaction() {
      throw new Error('not used');
    },
    async close() {},
  };

  // The stand-in cannot really create tables, so init() fails validation; what
  // matters is that WAL was never attempted against such a driver.
  await new TursoStore(remote as any).init().catch(() => undefined);

  assert.equal(
    issued.some((sql) => /^PRAGMA\s+(journal_mode\s*=|synchronous)/i.test(sql)),
    false,
    'journal_mode/synchronous must not be SET on a remote driver'
  );
  assert.ok(
    issued.some((sql) => /^PRAGMA journal_mode$/i.test(sql)),
    'the driver is probed with a plain pragma read first'
  );
  assert.ok(
    issued.every((sql) => !/EXPLAIN/i.test(sql)),
    'the probe must not use EXPLAIN: it leaves a read transaction open'
  );
  assert.ok(issued.some((sql) => /CREATE TABLE IF NOT EXISTS loginAlerts/.test(sql)));
});

// ---------------------------------------------------------------------------
// 5. Schema validation, reported not repaired
// ---------------------------------------------------------------------------

test('a fresh database records the schema version and validates clean', async () => {
  const { client, store } = await openStore();
  assert.deepEqual(await store.validateSchema(), []);
  const marker = await client.execute('SELECT version FROM schema_migrations');
  assert.deepEqual(marker.rows.map((r) => Number(r.version)), [SCHEMA_VERSION]);
});

test('an older loginAlerts table is detected and reported, not altered', async () => {
  const client = createClient({ url: 'file::memory:' });
  // A pre-UNIQUE table, exactly as an older build would have left it.
  await client.execute(`CREATE TABLE loginAlerts (
    id TEXT PRIMARY KEY, alertDate TEXT NOT NULL, periodDate TEXT NOT NULL,
    month TEXT NOT NULL, generatedAt TEXT NOT NULL, totalLogins INTEGER NOT NULL DEFAULT 0,
    uniqueUsers INTEGER NOT NULL DEFAULT 0, newUsers INTEGER NOT NULL DEFAULT 0,
    activeUsers INTEGER NOT NULL DEFAULT 0, failedLogins INTEGER NOT NULL DEFAULT 0,
    topUsers TEXT, deliveryStatus TEXT NOT NULL DEFAULT 'NOT_CONFIGURED', statusMessage TEXT)`);
  await client.execute(`INSERT INTO loginAlerts (id, alertDate, periodDate, month, generatedAt, statusMessage) VALUES ('old', '2026-01-02', '2026-01-01', '2026-01', '2026-01-02T00:00:00.000Z', 'ok')`);

  const store = new TursoStore(client);
  const problems = await store.validateSchema();
  assert.ok(
    problems.some((p) => p.includes('loginAlerts.periodDate') && p.includes('UNIQUE')),
    `expected a UNIQUE problem, got: ${JSON.stringify(problems)}`
  );

  await assert.rejects(() => store.init(), /incompatible/i);

  // Reported only: the existing table and its row are untouched.
  const ddl = await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='loginAlerts'");
  // NB: match the constraint keyword, not the `uniqueUsers` column.
  assert.ok(!/\bUNIQUE\s*\(/i.test(String(ddl.rows[0].sql)), 'init() must not ALTER the table');
  const rows = await client.execute('SELECT COUNT(*) AS n FROM loginAlerts');
  assert.equal(Number(rows.rows[0].n), 1, 'no data may be lost');
});

test('a table missing a mapped column is detected and reported', async () => {
  const client = createClient({ url: 'file::memory:' });
  // A jobs table from before creditTxnId/retryCount existed.
  await client.execute(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL,
    provider TEXT NOT NULL, input TEXT NOT NULL)`);

  const problems = await new TursoStore(client).validateSchema();
  assert.ok(problems.some((p) => p.includes('jobs is missing column creditTxnId')));
  assert.ok(problems.some((p) => p.includes('jobs is missing column retryCount')));
  assert.ok(problems.every((p) => !/DROP|DELETE|ALTER/i.test(p)), 'problems are descriptive only');
});

// ---------------------------------------------------------------------------
// STEP 5A — final Turso runtime compatibility
// ---------------------------------------------------------------------------

// --- 1. canonical paymentId: JSON and Turso stores must agree ---

test('JSON and Turso stores resolve the same paymentId identically', async () => {
  // The same fixture set, loaded into both backends. `paymentId` is the canonical
  // field: it is what every purchase write path sets and what the export reads.
  const withPayment = {
    id: 't_paid',
    userId: 'u1',
    type: 'PURCHASE',
    amount: 500,
    reason: 'purchase',
    balanceAfter: 500,
    createdAt: '2026-01-02T00:00:00.000Z',
    paymentId: 'pay_CANONICAL',
  };
  const withoutPayment = {
    id: 't_free',
    userId: 'u1',
    type: 'CREDIT',
    amount: 5,
    reason: 'initial_grant',
    balanceAfter: 505,
    createdAt: '2026-01-03T00:00:00.000Z',
    paymentId: null,
  };

  // --- JSON store, through the real CreditRepo.findByPaymentId ---
  const file = join(mkdtempSync(join(tmpdir(), 'jsonstore-')), 'app.db.json');
  const jsonStore = new DataStore(file);
  await jsonStore.init();
  jsonStore.mutate((db) => {
    db.users.push({ ...sampleUser('u1') } as any);
    db.transactions.push({ ...withPayment } as any, { ...withoutPayment } as any);
  });
  const jsonRepo = new CreditRepo(jsonStore);

  // --- Turso store, through TursoStore.getTransactionByPaymentId ---
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  await store.addTransaction(withPayment);
  await store.addTransaction(withoutPayment);

  // Hit: both find the same record.
  const fromJson = jsonRepo.findByPaymentId('pay_CANONICAL');
  const fromTurso = await store.getTransactionByPaymentId('pay_CANONICAL');
  assert.equal(fromJson?.id, 't_paid', 'the JSON store must find a purchase by paymentId');
  assert.equal(fromTurso?.id, 't_paid', 'the Turso store must find the same purchase');
  assert.equal(fromJson?.paymentId, fromTurso?.paymentId);

  // Miss: an unknown id matches nothing on either side.
  assert.equal(jsonRepo.findByPaymentId('pay_UNKNOWN'), null);
  assert.equal(await store.getTransactionByPaymentId('pay_UNKNOWN'), null);

  // An empty string is not a payment id; neither store may match it.
  assert.equal(jsonRepo.findByPaymentId(''), null);
  assert.equal(await store.getTransactionByPaymentId(''), null);

  // A record with no paymentId is never returned by a lookup.
  assert.equal(jsonRepo.findByPaymentId('t_free'), null);
  assert.equal(await store.getTransactionByPaymentId('t_free'), null);

  // The legacy bag is not consulted by either store, and nothing is invented.
  assert.equal((fromJson as any).extra, undefined, 'paymentId must not be read from extra');
  assert.equal((fromTurso as any).extra, null, 'extra stays NULL when it was never written');
});

test('findByPaymentId no longer depends on the never-written extra.gatewayPaymentId', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jsonstore-')), 'app.db.json');
  const store = new DataStore(file);
  await store.init();
  store.mutate((db) => {
    db.users.push({ ...sampleUser('u1') } as any);
    db.transactions.push({
      id: 't_extra',
      userId: 'u1',
      type: 'PURCHASE',
      amount: 10,
      reason: 'purchase',
      balanceAfter: 10,
      createdAt: '2026-01-02T00:00:00.000Z',
      paymentId: 'pay_REAL',
      extra: { gatewayPaymentId: 'pay_LEGACY' },
    } as any);
  });
  const repo = new CreditRepo(store);

  // The canonical field wins.
  assert.equal(repo.findByPaymentId('pay_REAL')?.id, 't_extra');
  // The phantom field is not a lookup key on either store.
  assert.equal(repo.findByPaymentId('pay_LEGACY'), null, 'extra.gatewayPaymentId is not canonical');

  const { store: turso } = await openStore();
  await turso.createUser(sampleUser('u1') as any);
  await turso.addTransaction({
    id: 't_extra',
    userId: 'u1',
    type: 'PURCHASE',
    amount: 10,
    reason: 'purchase',
    balanceAfter: 10,
    createdAt: '2026-01-02T00:00:00.000Z',
    paymentId: 'pay_REAL',
    extra: { gatewayPaymentId: 'pay_LEGACY' },
  });
  assert.equal((await turso.getTransactionByPaymentId('pay_REAL'))?.id, 't_extra');
  assert.equal(await turso.getTransactionByPaymentId('pay_LEGACY'), null);
  // The blob itself is preserved verbatim rather than dropped.
  assert.deepEqual((await turso.getTransactionByPaymentId('pay_REAL'))?.extra, {
    gatewayPaymentId: 'pay_LEGACY',
  });
});

// --- 2. JSON blob decoding on every read path ---

test('every JSON blob column round-trips through write -> read unchanged', async () => {
  const { store } = await openStore();

  const tokenHashes = ['h1', 'h2'];
  const input = { audioUrl: 'https://example.test/a.mp3', fileName: 'a.mp3', nested: { deep: [1, 2, 3] } };
  const output = { srt: '1\n00:00:00,000 --> ...', segments: 12, ok: true, ratio: 0.75, missing: null };
  const extra = { gatewayPaymentId: 'pay_X', attempts: 2, flags: ['a', 'b'], meta: { note: 'hi' } };
  const topUsers = [
    { userId: 'u1', count: 3 },
    { userId: 'u2', count: 1 },
  ];

  await store.createUser({ ...sampleUser('u1'), tokenHashes, email: 'u1@test' } as any);
  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'QUEUED',
    provider: 'sarvam',
    input,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);
  await store.updateJob('j1', { status: 'COMPLETED', output });
  await store.addTransaction({
    id: 't1',
    userId: 'u1',
    type: 'PURCHASE',
    amount: 10,
    reason: 'purchase',
    balanceAfter: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    paymentId: 'pay_X',
    extra,
  } as any);
  await store.saveAlert({
    id: 'a1',
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 4,
    uniqueUsers: 2,
    newUsers: 1,
    activeUsers: 2,
    failedLogins: 1,
    topUsers,
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  } as any);

  // users.tokenHashes
  assert.deepEqual((await store.getUserById('u1'))!.tokenHashes, tokenHashes);
  assert.deepEqual((await store.getUserByToken('h2'))!.tokenHashes, tokenHashes);
  assert.deepEqual((await store.getUserByEmail('u1@test'))!.tokenHashes, tokenHashes);
  assert.deepEqual((await store.getUsers())[0].tokenHashes, tokenHashes);

  // jobs.input / jobs.output
  const job = await store.getJobById('j1');
  assert.deepEqual(job.input, input);
  assert.deepEqual(job.output, output);
  assert.ok(Array.isArray(job.input.nested.deep), 'nested arrays stay arrays');
  assert.deepEqual((await store.getJobs())[0].input, input);
  assert.deepEqual((await store.getJobsByUser('u1'))[0].output, output);
  assert.deepEqual((await store.getAllJobs())[0].input, input);
  assert.deepEqual((await store.getQueuedJobs()).length, 0, 'status changed to COMPLETED');
  assert.deepEqual((await store.getProcessingJobs()).length, 0);
  assert.deepEqual((await store.getEligibleQueued('2026-01-01T00:00:00.000Z')).length, 0);

  // transactions.extra
  assert.deepEqual((await store.getTransactions())[0].extra, extra);
  assert.deepEqual((await store.getTransactionsByUser('u1'))[0].extra, extra);
  assert.deepEqual((await store.getAllTransactions())[0].extra, extra);
  assert.deepEqual((await store.getAllTransactionsUnbounded())[0].extra, extra);

  // loginAlerts.topUsers
  assert.deepEqual((await store.findAlertFor('2026-01-01'))!.topUsers, topUsers);
  assert.deepEqual((await store.listAlerts())[0].topUsers, topUsers);
});

test('JSON blob types are preserved, not stringified or flattened', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  await store.addTransaction({
    id: 't1',
    userId: 'u1',
    type: 'PURCHASE',
    amount: 1,
    reason: 'purchase',
    balanceAfter: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    extra: { int: 7, float: 1.5, yes: true, no: false, nothing: null, arr: [1, 'two'], obj: { k: 'v' } },
  } as any);

  const extra = (await store.getTransactions())[0].extra;
  assert.equal(typeof extra.int, 'number');
  assert.equal(typeof extra.float, 'number');
  assert.equal(typeof extra.yes, 'boolean');
  assert.equal(typeof extra.no, 'boolean');
  assert.equal(extra.nothing, null);
  assert.ok(Array.isArray(extra.arr));
  assert.equal(typeof extra.obj, 'object');
  assert.deepEqual(extra, { int: 7, float: 1.5, yes: true, no: false, nothing: null, arr: [1, 'two'], obj: { k: 'v' } });
});

test('a JSON string value is parsed exactly once, not twice', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  // A string that itself contains JSON must come back as that string, not be
  // re-parsed into the object it describes.
  const asText = '{"looks":"like json"}';
  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'QUEUED',
    provider: 'sarvam',
    input: asText,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);

  const job = await store.getJobById('j1');
  assert.equal(job.input, asText);
  assert.equal(typeof job.input, 'string');
});

test('an absent or null JSON blob stays null and does not throw', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'QUEUED',
    provider: 'sarvam',
    input: { a: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);
  await store.addTransaction({
    id: 't1',
    userId: 'u1',
    type: 'CREDIT',
    amount: 1,
    reason: 'initial_grant',
    balanceAfter: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);

  const job = await store.getJobById('j1');
  assert.equal(job.output, null, 'a never-written blob reads back as null');

  const txn = (await store.getTransactions())[0];
  assert.equal(txn.extra, null, 'transactions.extra was never written');

  await store.saveAlert({
    id: 'a1',
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 0,
    uniqueUsers: 0,
    newUsers: 0,
    activeUsers: 0,
    failedLogins: 0,
    topUsers: [],
    deliveryStatus: 'NOT_CONFIGURED',
  } as any);
  assert.deepEqual((await store.findAlertFor('2026-01-01'))!.topUsers, []);
});

test('malformed JSON in a blob column fails loudly instead of vanishing', async () => {
  const { client, store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  // Corrupt one blob behind the store's back, as a bad migration or a manual
  // edit could.
  await client.execute({ sql: "UPDATE users SET tokenHashes = ? WHERE id = ?", args: ['{not json', 'u1'] });

  await assert.rejects(
    () => store.getUserById('u1'),
    (err: Error) => {
      assert.match(err.message, /users\.tokenHashes/, 'the error must name the column');
      assert.match(err.message, /does not hold valid JSON/i);
      return true;
    }
  );
});

test('plain TEXT columns are not decoded, even when they look like JSON', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  const body = '{"kind":"looks like json but is a message"}';
  await store.addMessage({
    id: 'm1',
    userId: 'u1',
    kind: 'POST',
    body,
    accepted: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);

  const msg = await store.getMessageByAttachmentKey('u1', 'missing');
  assert.equal(msg, null, 'a miss is still null');
  const list = await store.listMessages();
  assert.equal(list[0].body, body, 'communityMessages.body must stay the exact string');
  assert.equal(typeof list[0].body, 'string');

  // moderationCases.excerpt is plain text too.
  await store.addModerationCase({
    id: 'c1',
    userId: 'u1',
    category: 'abuse',
    action: 'HIDE',
    confidence: 0.9,
    automatic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    excerpt: '["not","json"]',
  } as any);
  assert.equal((await store.getCasesForUser('u1'))[0].excerpt, '["not","json"]');
});

test('snapshot() preserves every JSON blob field', async () => {
  const { store } = await openStore();
  const input = { audioUrl: 'https://example.test/a.mp3', tags: ['x', 'y'] };
  const output = { srt: 'text', segments: 3 };
  const extra = { note: 'kept' };
  const topUsers = [{ userId: 'u1', count: 2 }];

  await store.createUser({ ...sampleUser('u1'), tokenHashes: ['h1'] } as any);
  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'COMPLETED',
    provider: 'sarvam',
    input,
    output,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);
  await store.addTransaction({
    id: 't1',
    userId: 'u1',
    type: 'PURCHASE',
    amount: 5,
    reason: 'purchase',
    balanceAfter: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    paymentId: 'pay_S',
    extra,
  } as any);
  await store.saveAlert({
    id: 'a1',
    alertDate: '2026-01-02',
    periodDate: '2026-01-01',
    month: '2026-01',
    generatedAt: '2026-01-02T03:00:00.000Z',
    totalLogins: 2,
    uniqueUsers: 1,
    newUsers: 1,
    activeUsers: 1,
    failedLogins: 0,
    topUsers,
    deliveryStatus: 'DELIVERED',
    statusMessage: 'ok',
  } as any);

  const snap = await store.snapshot();
  assert.deepEqual(snap.users[0].tokenHashes, ['h1'], 'snapshot must not lose users.tokenHashes');
  assert.deepEqual(snap.jobs[0].input, input, 'snapshot must not lose jobs.input');
  assert.deepEqual(snap.jobs[0].output, output, 'snapshot must not lose jobs.output');
  assert.deepEqual((snap.transactions[0] as any).extra, extra, 'snapshot must not lose transactions.extra');
  assert.equal(snap.transactions[0].paymentId, 'pay_S', 'and keeps the paymentId');

  // loginAlerts.topUsers survives as an array of the saved entries.
  // normalizeLoginAlerts() additionally decorates each entry with `email`, which
  // is the same enrichment the JSON store applies, so compare the saved fields.
  assert.ok(Array.isArray(snap.loginAlerts[0].topUsers), 'topUsers must still be an array');
  assert.equal(snap.loginAlerts[0].topUsers.length, 1);
  assert.equal(snap.loginAlerts[0].topUsers[0].userId, 'u1');
  assert.equal(snap.loginAlerts[0].topUsers[0].count, 2);
});

test('the JSON columns decoded on read are exactly the ones written as JSON', async () => {
  // ENTITY_SPECS is the migration's own list of JSON blob columns. If a column is
  // flagged json there, the store must decode it on the way out, or the migrated
  // data would read back as text.
  const declared = new Set<string>();
  for (const spec of Object.values(ENTITY_SPECS)) {
    for (const col of spec.columns) {
      if (col.json) declared.add(`${spec.table}.${col.column}`);
    }
  }
  assert.deepEqual(
    [...declared].sort(),
    [
      'jobs.input',
      'jobs.output',
      'loginAlerts.topUsers',
      'transactions.extra',
      'users.tokenHashes',
    ],
    'the JSON blob column set changed; update JSON_COLUMNS in tursoStore.ts and these tests'
  );
  // A raw SELECT proves these are physically TEXT, so decoding is required
  // rather than cosmetic.
  const { client, store } = await openStore();
  await client.execute({
    sql: "INSERT INTO users (id, tokenHashes, credits, role, creditMode, createdAt) VALUES ('u_raw', ?, 0, 'USER', 'NORMAL', '2026-01-01')",
    args: [JSON.stringify(['h1'])],
  });
  const raw = await client.execute({ sql: 'SELECT tokenHashes FROM users WHERE id = ?', args: ['u_raw'] });
  assert.equal(typeof raw.rows[0].tokenHashes, 'string', 'the column really holds JSON text');
  assert.equal(raw.rows[0].tokenHashes, '["h1"]');
  assert.deepEqual((await store.getUserById('u_raw'))!.tokenHashes, ['h1'], 'and the read path decodes it');
});

// --- 3. foreign key enforcement ---

test('init() turns foreign-key enforcement on and confirms it', async () => {
  const { store } = await openStore();
  assert.equal(store.foreignKeysActive, true, 'foreign keys must be verified active, not assumed');
});

test('an invalid userId reference is rejected', async () => {
  const { store } = await openStore();

  await assert.rejects(
    () =>
      store.createJob({
        id: 'j_orphan',
        userId: 'ghost',
        status: 'QUEUED',
        provider: 'sarvam',
        input: { a: 1 },
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any),
    /FOREIGN KEY/i,
    'a job for a user that does not exist must be refused'
  );

  await assert.rejects(
    () =>
      store.addTransaction({
        id: 't_orphan',
        userId: 'ghost',
        type: 'PURCHASE',
        amount: 1,
        reason: 'purchase',
        balanceAfter: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      } as any),
    /FOREIGN KEY/i,
    'a transaction for a user that does not exist must be refused'
  );

  // The rejected rows left nothing behind.
  assert.equal((await store.getJobs()).length, 0);
  assert.equal((await store.getTransactions()).length, 0);
});

test('valid records and the users-first write order keep working', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  await store.createUser(sampleUser('u2') as any);

  await store.createJob({
    id: 'j1',
    userId: 'u1',
    status: 'QUEUED',
    provider: 'sarvam',
    input: { a: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);
  await store.addTransaction({
    id: 't1',
    userId: 'u2',
    type: 'PURCHASE',
    amount: 10,
    reason: 'purchase',
    balanceAfter: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);

  assert.equal((await store.getJobById('j1'))!.userId, 'u1');
  assert.equal((await store.getTransactions())[0].userId, 'u2');
});

test('the status-filtered queue reads work against a real engine', async () => {
  // Regression: these queries used `status = "QUEUED"`. SQLite resolves a
  // double-quoted token as an identifier, so every one of them failed with
  // "no such column: QUEUED" — including the queue worker's own reads.
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  const mk = (id: string, status: string, nextRetryAt: string | null = null) =>
    store.createJob({
      id,
      userId: 'u1',
      status,
      provider: 'sarvam',
      input: { a: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
      nextRetryAt,
    } as any);

  await mk('j_queued', 'QUEUED');
  await mk('j_processing', 'PROCESSING');
  await mk('j_done', 'COMPLETED');
  await mk('j_retry', 'QUEUED', '2026-06-01T00:00:00.000Z');

  assert.deepEqual((await store.getQueuedJobs()).map((j: any) => j.id).sort(), ['j_queued', 'j_retry']);
  assert.deepEqual((await store.getProcessingJobs()).map((j: any) => j.id), ['j_processing']);
  assert.deepEqual(
    (await store.getEligibleQueued('2026-01-02T00:00:00.000Z')).map((j: any) => j.id).sort(),
    ['j_queued'],
    'a retry dated in the future is not yet eligible'
  );
  assert.deepEqual((await store.getQueuedJobs())[0].input, { a: 1 }, 'and these reads decode input too');
});

test('firstLoginFor resolves a SUCCESS outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'libsql-la-'));
  const client = createClient({ url: `file:${join(dir, 'first.db')}` });
  const store = new TursoStore(client);
  await store.init();
  const base = {
    userId: 'u1',
    email: 'u1@test',
    loginDate: '2026-01-01',
    loginTime: '10:00',
    istDateTime: '2026-01-01 10:00',
    month: '2026-01',
    method: 'PASSWORD',
  };
  await store.recordLoginActivity({
    ...base,
    id: 'la_fail',
    occurredAt: '2026-01-01T09:00:00.000Z',
    outcome: 'FAILURE',
  } as any);
  await store.recordLoginActivity({
    ...base,
    id: 'la_ok',
    occurredAt: '2026-01-01T11:00:00.000Z',
    outcome: 'SUCCESS',
  } as any);

  const first = await store.firstLoginFor('u1');
  assert.equal(first.id, 'la_ok', 'only the SUCCESS row counts');
});

test('loginActivity accepts a user that never signed up', async () => {
  // Tables with no declared foreign key must stay unaffected: loginActivity
  // records failed logins for users who never created an account, so its userId
  // is deliberately free-form. File-backed because recordLoginActivity runs in a
  // transaction and @libsql/client hands the client a fresh connection after one
  // starts, which would leave a `file::memory:` database empty.
  const dir = mkdtempSync(join(tmpdir(), 'libsql-la-'));
  const client = createClient({ url: `file:${join(dir, 'la.db')}` });
  const store = new TursoStore(client);
  await store.init();

  await store.recordLoginActivity({
    id: 'la1',
    userId: 'never-signed-up',
    email: 'x@test',
    loginDate: '2026-01-01',
    loginTime: '10:00',
    istDateTime: '2026-01-01 10:00',
    month: '2026-01',
    occurredAt: '2026-01-01T10:00:00.000Z',
    method: 'PASSWORD',
    outcome: 'FAILURE',
  } as any);

  assert.equal((await store.listAllLoginActivity())[0].userId, 'never-signed-up');
});

// --- 4. transaction() and the unsupported snapshot writers ---

test('transaction() commits on success and rolls back on failure', async () => {
  // A file-backed database, because @libsql/client hands the client a fresh
  // connection after a transaction starts and `file::memory:` is per-connection.
  const dir = mkdtempSync(join(tmpdir(), 'libsql-tx-'));
  const client = createClient({ url: `file:${join(dir, 'tx.db')}` });
  const store = new TursoStore(client);
  await store.init();
  await store.createUser(sampleUser('u1') as any);

  const committed = await store.transaction(async (tx) => {
    await tx.execute({
      sql: 'INSERT INTO jobs (id,userId,status,createdAt,provider,input) VALUES (?,?,?,?,?,?)',
      args: ['j_ok', 'u1', 'QUEUED', '2026-01-01T00:00:00.000Z', 'sarvam', JSON.stringify({ a: 1 })],
    });
    return 'done';
  });
  assert.equal(committed, 'done');
  assert.equal((await store.getJobs()).length, 1, 'a committed insert must be visible');

  await assert.rejects(() =>
    store.transaction(async (tx) => {
      await tx.execute({
        sql: 'INSERT INTO jobs (id,userId,status,createdAt,provider,input) VALUES (?,?,?,?,?,?)',
        args: ['j_rollback', 'u1', 'QUEUED', '2026-01-01T00:00:00.000Z', 'sarvam', JSON.stringify({ a: 2 })],
      });
      throw new Error('boom');
    })
  );
  assert.equal((await store.getJobs()).length, 1, 'the failed insert must have been rolled back');
  assert.equal(await store.getJobById('j_rollback'), null);
});

test('recordLoginActivity inserts inside a working transaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'libsql-tx-'));
  const client = createClient({ url: `file:${join(dir, 'tx.db')}` });
  const store = new TursoStore(client);
  await store.init();

  const rec = {
    id: 'la1',
    userId: '',
    email: 'x@test',
    loginDate: '2026-01-01',
    loginTime: '10:00',
    istDateTime: '2026-01-01 10:00',
    month: '2026-01',
    occurredAt: '2026-01-01T10:00:00.000Z',
    method: 'PASSWORD',
    outcome: 'FAILURE',
  };
  // This path goes through transaction(); it threw "Unknown transaction mode"
  // before the wrapper was fixed.
  await store.recordLoginActivity(rec as any);
  const rows = await store.listAllLoginActivity();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'la1');
});

test('mutate() and mutateAsync() fail fast and never look like a silent write', async () => {
  const { store } = await openStore();

  let mutateRan = false;
  assert.throws(
    () =>
      store.mutate(() => {
        mutateRan = true;
      }),
    /snapshot|mutateAsync|per-entity/i,
    'mutate() must explain that whole-database writes are unsupported'
  );
  assert.equal(mutateRan, false, 'the callback must not run and have its work discarded');

  let asyncRan = false;
  await assert.rejects(
    () =>
      store.mutateAsync(() => {
        asyncRan = true;
      }),
    /snapshot|per-entity/i
  );
  assert.equal(asyncRan, false, 'mutateAsync must reject before invoking the callback');

  // Nothing was written by either call.
  assert.deepEqual(await store.snapshot().then((s) => s.users), []);
});

test('no production code path calls mutateAsync(), and save() is gone', async () => {
  // The audit behind the guard: a real call always has a receiver, so the
  // `async mutateAsync(...)` declaration in store.ts is not a match.
  const sources = ['server.ts', 'server/db/repos.ts', 'server/db/store.ts', 'server/services/creditService.ts'];
  for (const rel of sources) {
    const text = readFileSync(resolve(PROJECT_ROOT, rel), 'utf8');
    assert.ok(!/\.mutateAsync\(/.test(text), `${rel} must not call mutateAsync() in production`);
  }
  // save() was private and is no longer part of the class surface.
  const storeText = readFileSync(resolve(PROJECT_ROOT, 'server/db/tursoStore.ts'), 'utf8');
  assert.ok(!/private async save\(/.test(storeText), 'the dead save() must be removed, not left as a trap');
});

test('mutate() is genuinely production-reachable, which is why it is documented', async () => {
  // repos.ts is synchronous and is wired to the active store in server.ts, so
  // this gap is real. If a future step ports the repositories, this test should
  // be revisited rather than left passing by accident.
  const repoText = readFileSync(resolve(PROJECT_ROOT, 'server/db/repos.ts'), 'utf8');
  assert.ok(/store\.mutate\(/.test(repoText), 'repos.ts still calls the synchronous mutate()');
  const serverText = readFileSync(resolve(PROJECT_ROOT, 'server.ts'), 'utf8');
  assert.ok(
    /new UserRepo\(store\)/.test(serverText) && /new CreditRepo\(store\)/.test(serverText),
    'the repositories are constructed with the active store'
  );
  const storeText = readFileSync(resolve(PROJECT_ROOT, 'server/db/tursoStore.ts'), 'utf8');
  assert.match(
    storeText,
    /IS reachable in production/,
    'the store must keep documenting that mutate() is production-reachable'
  );
});

// --- 5. schema validation is still strict ---

test('schema validation was not loosened in Step 5A', async () => {
  // Pinned deliberately. Stage 5D raised this from 2 to 3 for the credit
  // identity indexes; any other value means someone changed the schema contract
  // without updating this guard.
  assert.equal(SCHEMA_VERSION, 3, 'the schema contract version must not drift');

  const { client } = await openStore();
  const problems = await new TursoStore(client).validateSchema();
  assert.deepEqual(problems, [], 'a freshly created database validates clean');

  // Missing column, missing UNIQUE and a missing table are all still reported.
  const stale = createClient({ url: 'file::memory:' });
  await stale.execute(`CREATE TABLE loginAlerts (
    id TEXT PRIMARY KEY, alertDate TEXT NOT NULL, periodDate TEXT NOT NULL,
    month TEXT NOT NULL, generatedAt TEXT NOT NULL, totalLogins INTEGER NOT NULL DEFAULT 0,
    uniqueUsers INTEGER NOT NULL DEFAULT 0, newUsers INTEGER NOT NULL DEFAULT 0,
    activeUsers INTEGER NOT NULL DEFAULT 0, failedLogins INTEGER NOT NULL DEFAULT 0,
    topUsers TEXT, deliveryStatus TEXT NOT NULL DEFAULT 'NOT_CONFIGURED', statusMessage TEXT)`);
  const found = await new TursoStore(stale).validateSchema();
  assert.ok(found.some((p) => p.includes('loginAlerts.periodDate') && p.includes('UNIQUE')));
  assert.ok(found.some((p) => p.includes('missing table users')));
  assert.ok(found.some((p) => p.includes('missing table jobs')));
  assert.ok(found.every((p) => !/DROP|DELETE|ALTER|TRUNCATE/i.test(p)), 'no destructive repair');
  await assert.rejects(() => new TursoStore(stale).init(), /incompatible/i);
});

test('all 9 tables still initialise together, twice', async () => {
  const { client, store } = await openStore();
  assert.deepEqual(await tableNames(client).then((n) => n.filter((x) => ALL_TABLES.includes(x as any)).sort()), [...ALL_TABLES].sort());
  await new TursoStore(client).init();
  assert.deepEqual(await tableNames(client).then((n) => n.filter((x) => ALL_TABLES.includes(x as any)).sort()), [...ALL_TABLES].sort());
  assert.deepEqual(await store.validateSchema(), []);
});

// ---------------------------------------------------------------------------
// Stage 5C-3: updateUser() must select its row by the `id` ARGUMENT.
//
// The bug: the WHERE argument was built from `patch.id ?? ''` instead of `id`.
// Consequences were (a) a normal `updateUser('u1', {...})` matched no row at all
// and silently did nothing, and (b) a patch carrying someone else's id wrote to
// THAT user instead. Both are regressions locked down below.
// ---------------------------------------------------------------------------

/** Two users with distinct field values, so a mis-targeted write is visible. */
async function seedTwoUsers() {
  const { client, store } = await openStore();
  await store.createUser({ ...sampleUser('u1'), tokenHashes: ['h1'], credits: 10, email: 'one@test' } as any);
  await store.createUser({ ...sampleUser('u2'), tokenHashes: ['h2'], credits: 20, email: 'two@test' } as any);
  return { client, store };
}

test('5C3-A. updateUser() updates the exact user named by its id argument', async () => {
  const { store } = await seedTwoUsers();

  await store.updateUser('u1', { credits: 111 });

  const u1 = await store.getUserById('u1');
  assert.equal(u1!.credits, 111, 'the named user must be updated');
  const u2 = await store.getUserById('u2');
  assert.equal(u2!.credits, 20, 'the other user must be untouched');
});

test('5C3-B. a conflicting patch.id cannot redirect the update to another user', async () => {
  const { store } = await seedTwoUsers();

  // The patch names u2 while the argument names u1.
  await store.updateUser('u1', { id: 'u2', credits: 999 } as any);

  const u1 = await store.getUserById('u1');
  assert.equal(u1!.credits, 999, 'the ARGUMENT decides the row');
  const u2 = await store.getUserById('u2');
  assert.equal(u2!.credits, 20, 'patch.id must not redirect the write to u2');
});

test('5C3-B2. a patch.id alone neither moves nor rewrites the primary key', async () => {
  const { store } = await seedTwoUsers();

  // Only `id` in the patch: there is nothing to set, so no UPDATE may run and
  // no row may be rewritten to the patch's id.
  await store.updateUser('u1', { id: 'u2' } as any);

  const u1 = await store.getUserById('u1');
  assert.ok(u1, 'u1 must still exist under its own id');
  assert.equal(u1!.credits, 10, 'u1 must be unchanged');
  const u2 = await store.getUserById('u2');
  assert.ok(u2, 'u2 must still exist');
  assert.equal(u2!.credits, 20, 'u2 must be unchanged');
  assert.equal((await store.getUsers()).length, 2, 'no row may be created or duplicated');
});

test('5C3-C. fields absent from the patch are preserved', async () => {
  const { store } = await seedTwoUsers();
  const before = await store.getUserById('u1');

  await store.updateUser('u1', { credits: 55 });

  const after = await store.getUserById('u1');
  assert.equal(after!.credits, 55, 'the patched field changed');
  assert.equal(after!.email, before!.email, 'email untouched');
  assert.deepEqual(after!.tokenHashes, before!.tokenHashes, 'tokenHashes untouched');
  assert.equal(after!.role, before!.role, 'role untouched');
  assert.equal(after!.creditMode, before!.creditMode, 'creditMode untouched');
  assert.equal(after!.createdAt, before!.createdAt, 'createdAt untouched');
  assert.equal(after!.freeTrialsUsed, before!.freeTrialsUsed, 'freeTrialsUsed untouched');
  assert.equal(after!.purchasedCredits, before!.purchasedCredits, 'purchasedCredits untouched');
  assert.equal(after!.bonusCredits, before!.bonusCredits, 'bonusCredits untouched');
});

test('5C3-D. the read-back user carries the updated values', async () => {
  const { store } = await seedTwoUsers();

  await store.updateUser('u1', { credits: 7, role: 'ADMIN', email: 'changed@test' });

  // Every read path must observe the write.
  assert.equal((await store.getUserById('u1'))!.credits, 7);
  assert.equal((await store.getUserById('u1'))!.role, 'ADMIN');
  assert.equal((await store.getUserById('u1'))!.email, 'changed@test');
  assert.equal((await store.getUserByEmail('changed@test'))!.id, 'u1', 'getUserByEmail sees it');
  assert.equal((await store.getUsers()).find((u) => u.id === 'u1')!.credits, 7, 'getUsers sees it');
  const snap = await store.snapshot();
  assert.equal(snap.users.find((u) => u.id === 'u1')!.credits, 7, 'snapshot sees it');
});

test('5C3-E. an unknown user id modifies no record at all', async () => {
  const { store } = await seedTwoUsers();
  const before = await store.getUsers();

  await store.updateUser('does-not-exist', { credits: 4242 });

  const after = await store.getUsers();
  assert.equal(after.length, before.length, 'no row added');
  for (const u of after) {
    const old = before.find((b) => b.id === u.id)!;
    assert.equal(u.credits, old.credits, `${u.id} credits must be unchanged`);
    assert.equal(u.email, old.email, `${u.id} email must be unchanged`);
  }
  assert.equal(await store.getUserById('does-not-exist'), null);
});

test('5C3-F. tokenHashes remain writable and stay correctly JSON-encoded', async () => {
  const { client, store } = await seedTwoUsers();

  await store.updateUser('u1', { tokenHashes: ['a', 'b', 'c'] });

  // The column is JSON text on disk and decodes on every read path.
  const raw = await client.execute({ sql: 'SELECT tokenHashes FROM users WHERE id = ?', args: ['u1'] });
  assert.equal(typeof raw.rows[0].tokenHashes, 'string', 'the column holds JSON text');
  assert.deepEqual(JSON.parse(String(raw.rows[0].tokenHashes)), ['a', 'b', 'c']);

  assert.deepEqual((await store.getUserById('u1'))!.tokenHashes, ['a', 'b', 'c']);
  assert.deepEqual((await store.getUsers()).find((u) => u.id === 'u1')!.tokenHashes, ['a', 'b', 'c']);
  // Token lookup still works for each stored hash.
  assert.equal((await store.getUserByToken('b'))!.id, 'u1');
  // And the other user keeps its own token set.
  assert.deepEqual((await store.getUserById('u2'))!.tokenHashes, ['h2']);

  // Re-appending the same set is idempotent at the storage layer too.
  await store.updateUser('u1', { tokenHashes: ['a', 'b', 'c'] });
  assert.deepEqual((await store.getUserById('u1'))!.tokenHashes, ['a', 'b', 'c']);
});

test('5C3-G. null-able fields still normalise to SQL NULL', async () => {
  const { client, store } = await seedTwoUsers();
  await store.updateUser('u1', { email: 'set@test', lastLoginAt: '2026-01-02T03:04:05.000Z' });

  await store.updateUser('u1', { email: null, lastLoginAt: null } as any);

  const raw = await client.execute({ sql: 'SELECT email, lastLoginAt FROM users WHERE id = ?', args: ['u1'] });
  assert.equal(raw.rows[0].email, null, 'email becomes NULL, not the string "null"');
  assert.equal(raw.rows[0].lastLoginAt, null, 'lastLoginAt becomes NULL');
  assert.equal((await store.getUserById('u1'))!.email, null);
});

test('5C3-H. updateUser selects by the id argument, exactly like updateJob', async () => {
  // Guards the convention itself so the two update methods cannot drift apart.
  // Comments are stripped first so this guard inspects CODE, not prose (the
  // methods carry comments that legitimately name the old buggy expression).
  const src = readFileSync(new URL('./tursoStore.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const method of ['updateUser', 'updateJob']) {
    const from = code.indexOf(`async ${method}(`);
    assert.ok(from > -1, `${method} must exist`);
    const body = code.slice(from, code.indexOf('await this.exec(', from));
    assert.match(body, /args\.push\(id\)/, `${method} must select its row with the id argument`);
    assert.doesNotMatch(body, /patch\.id/, `${method} must never select or set a row from patch.id`);
  }
});

// ---------------------------------------------------------------------------
// Stage 5C-4: updateJob() must not let a patch rewrite the job primary key.
//
// Caller analysis (see the report): updateJob has ZERO production callers, and
// all five production JobRepo.update() call sites (queue.ts x4, server.ts x1)
// pass the id as the FIRST ARGUMENT and never inside the patch. A job id is
// minted once via randomUUID() at enqueue and is load-bearing outside the row:
// srtKey()/uploadKey() derive storage object paths from it, and creditTxnId /
// refundFinishedJob() key on it. No FK references jobs(id), so a rewrite would
// silently desynchronise the row from storage and the credit ledger.
// ---------------------------------------------------------------------------

/** One user plus two jobs with distinct values, so a mis-targeted write shows. */
async function seedTwoJobs() {
  const { client, store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  const input = {
    storageKey: 'uploads/in.wav',
    originalName: 'a.mp3',
    mimeType: 'audio/mpeg',
    sizeBytes: 1,
    sha256: 'x',
    durationSeconds: 0,
  };
  await store.createJob({
    id: 'job-1', userId: 'u1', status: 'QUEUED', provider: 'sarvam', input,
    createdAt: '2026-01-01T00:00:00.000Z', retryCount: 0,
  } as any);
  await store.createJob({
    id: 'job-2', userId: 'u1', status: 'PROCESSING', provider: 'sarvam',
    input: { ...input, storageKey: 'uploads/other.wav' },
    createdAt: '2026-01-02T00:00:00.000Z', retryCount: 2, creditsCharged: 7,
  } as any);
  return { client, store };
}

test('5C4-A. updateJob() updates the exact job named by its id argument', async () => {
  const { store } = await seedTwoJobs();

  await store.updateJob('job-1', { status: 'COMPLETED', completedAt: '2026-01-03T00:00:00.000Z' });

  const j1 = await store.getJobById('job-1');
  assert.equal(j1!.status, 'COMPLETED');
  assert.equal(j1!.completedAt, '2026-01-03T00:00:00.000Z');
  assert.equal((await store.getJobById('job-2'))!.status, 'PROCESSING', 'C: the other job is untouched');
});

test('5C4-B. a conflicting patch.id cannot rewrite the job primary key', async () => {
  const { client, store } = await seedTwoJobs();

  // The patch names job-2 while the argument names job-1.
  await store.updateJob('job-1', { id: 'job-2', status: 'FAILED' } as any);

  const j1 = await store.getJobById('job-1');
  assert.ok(j1, 'job-1 must still exist under its own id');
  assert.equal(j1!.status, 'FAILED', 'the ARGUMENT decides the row');
  const j2 = await store.getJobById('job-2');
  assert.ok(j2, 'job-2 must still exist');
  assert.equal(j2!.status, 'PROCESSING', 'job-2 must be untouched');
  assert.equal(j2!.id, 'job-2', 'job-2 keeps its own id');

  // The id column on disk was never rewritten.
  const raw = await client.execute({ sql: 'SELECT id FROM jobs ORDER BY id', args: [] });
  assert.deepEqual(raw.rows.map((r) => String(r.id)), ['job-1', 'job-2'], 'both ids intact, no PK rewrite');
});

test('5C4-B2. an id-only patch is a no-op and changes nothing', async () => {
  const { client, store } = await seedTwoJobs();
  const before = await client.execute({ sql: 'SELECT * FROM jobs ORDER BY id', args: [] });

  await store.updateJob('job-1', { id: 'job-2' } as any);

  const after = await client.execute({ sql: 'SELECT * FROM jobs ORDER BY id', args: [] });
  assert.deepEqual(after.rows, before.rows, 'an id-only patch must not modify any row');
  assert.equal((await store.getJobById('job-1'))!.status, 'QUEUED');
});

test('5C4-D. fields absent from the patch are preserved', async () => {
  const { store } = await seedTwoJobs();
  const before = await store.getJobById('job-1');

  await store.updateJob('job-1', { status: 'PROCESSING' });

  const after = await store.getJobById('job-1');
  assert.equal(after!.status, 'PROCESSING', 'the patched field changed');
  assert.equal(after!.userId, before!.userId, 'userId untouched');
  assert.equal(after!.provider, before!.provider, 'provider untouched');
  assert.equal(after!.createdAt, before!.createdAt, 'createdAt untouched');
  assert.equal(after!.retryCount, before!.retryCount, 'retryCount untouched');
  assert.deepEqual(after!.input, before!.input, 'input untouched');
  assert.equal(after!.output, before!.output, 'output untouched');
});

test('5C4-D2. input/output still round-trip as JSON blobs', async () => {
  const { client, store } = await seedTwoJobs();
  const output = { srtKey: 'srt/job-1.srt', rawSrt: '1\n00:00:00,000 --> 00:00:01,000\nhello\n', segmentCount: 1, wordCount: 1, provider: 'sarvam' };

  await store.updateJob('job-1', { output, input: { ...(await store.getJobById('job-1'))!.input, sizeBytes: 42 } });

  const raw = await client.execute({ sql: 'SELECT input, output FROM jobs WHERE id = ?', args: ['job-1'] });
  assert.equal(typeof raw.rows[0].output, 'string', 'output is stored as JSON text');
  assert.deepEqual(JSON.parse(String(raw.rows[0].output)), output);
  assert.equal(JSON.parse(String(raw.rows[0].input)).sizeBytes, 42);
  assert.deepEqual((await store.getJobById('job-1'))!.output, output);
});

test('5C4-E. an unknown job id modifies nothing', async () => {
  const { client, store } = await seedTwoJobs();
  const before = await client.execute({ sql: 'SELECT * FROM jobs ORDER BY id', args: [] });

  await store.updateJob('no-such-job', { status: 'COMPLETED', creditsCharged: 999 });

  const after = await client.execute({ sql: 'SELECT * FROM jobs ORDER BY id', args: [] });
  assert.deepEqual(after.rows, before.rows, 'no row may be added or modified');
  assert.equal(await store.getJobById('no-such-job'), null);
  assert.equal((await store.getJobs()).length, 2);
});

test('5C4-F. the JSON JobRepo now matches Turso: patch.id cannot rewrite the key', async () => {
  // Originally pinned the Stage 5C-4 divergence between the two backends.
  const file = join(mkdtempSync(join(tmpdir(), 'jsonstore-')), 'app.db.json');
  const jsonStore = new DataStore(file);
  await jsonStore.init();
  const repo = new JobRepo(jsonStore);
  const input = { storageKey: 'uploads/a.wav', originalName: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1, sha256: 'x', durationSeconds: 0 };
  await repo.create({ id: 'job-1', userId: 'u1', status: 'QUEUED', provider: 'sarvam', input, createdAt: '2026-01-01T00:00:00.000Z', retryCount: 0 } as any);
  await repo.create({ id: 'job-2', userId: 'u1', status: 'PROCESSING', provider: 'sarvam', input, createdAt: '2026-01-01T00:00:00.000Z', retryCount: 2 } as any);

  const updated = await repo.update('job-1', { status: 'COMPLETED', completedAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(updated!.status, 'COMPLETED');
  assert.equal(updated!.id, 'job-1', 'id preserved on a normal patch');
  assert.equal((await repo.get('job-2'))!.status, 'PROCESSING', 'the other job is untouched');
  assert.equal((await repo.get('job-1'))!.retryCount, 0, 'unpatched fields preserved');

  // Stage 5C-5 Part A closed the divergence this test used to document: JSON's
  // Object.assign copied patch.id and persisted two rows sharing one id, while
  // Turso refused it. Both backends now refuse it, so assert the aligned contract.
  await repo.update('job-1', { id: 'job-2' } as any);
  assert.equal((await repo.get('job-1'))!.id, 'job-1', 'the job keeps its own id');
  assert.equal((await repo.get('job-2'))!.status, 'PROCESSING', 'job-2 is not written through');
  assert.equal((await repo.listAll()).length, 2, 'no duplicate id is produced');

  // And it is persisted: two DISTINCT primary keys on disk. mutate() only queues
  // its write, so flush via the public async variant before reading, otherwise
  // this would race the pending save.
  await jsonStore.mutateAsync(() => {});
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { jobs: Array<{ id: string }> };
  assert.equal(persisted.jobs.length, 2, 'both jobs are still on disk');
  assert.deepEqual(
    persisted.jobs.map((j) => j.id).sort(),
    ['job-1', 'job-2'],
    'two distinct primary keys, matching TursoStore.updateJob'
  );
});

test('5C4-G. both update methods refuse to treat id as a patchable column', async () => {
  const src = readFileSync(new URL('./tursoStore.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const method of ['updateUser', 'updateJob']) {
    const from = code.indexOf(`async ${method}(`);
    const body = code.slice(from, code.indexOf('await this.exec(', from));
    assert.match(body, /if \(key === 'id'\) continue;/, `${method} must skip the id key when building SET fields`);
  }
});

// ---------------------------------------------------------------------------
// Stage 5C-5 Part B: getTransactionByJobAndType() is the Turso half of
// CreditRepo.forJobAndType(). Without it the per-job credit guarantees
// (debitForJob/refundForJob and reservationForJob/usageForJob/releaseForJob)
// have no query to stand on, because only ADMIN_* writes carry an
// idempotencyKey -- job transactions store NULL there.
// ---------------------------------------------------------------------------

/** A transaction with the fields the per-job lookups filter on. */
function txnAt(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: 'u1',
    type: 'DEBIT',
    amount: -5,
    reason: 'charge',
    balanceBefore: 100,
    balanceAfter: 95,
    jobId: 'job-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('5C5-B1. getTransactionByJobAndType finds the row JSON forJobAndType finds', async () => {
  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  await store.createUser(sampleUser('u2') as any);
  await store.addTransaction(txnAt('t-debit'));
  await store.addTransaction(txnAt('t-usage', { type: 'USAGE', amount: -5 }));
  await store.addTransaction(txnAt('t-other-user', { userId: 'u2' }));
  await store.addTransaction(txnAt('t-other-job', { jobId: 'job-2' }));

  const hit = await store.getTransactionByJobAndType('u1', 'job-1', 'DEBIT');
  assert.ok(hit, 'the DEBIT for job-1 must be found');
  assert.equal(hit.id, 't-debit');
  assert.equal(hit.jobId, 'job-1');

  // Each filter dimension must actually exclude the others.
  assert.equal(await store.getTransactionByJobAndType('u1', 'job-1', 'REFUND'), null, 'wrong type');
  assert.equal(await store.getTransactionByJobAndType('u1', 'no-such-job', 'DEBIT'), null, 'unknown job');
  assert.equal(await store.getTransactionByJobAndType('nobody', 'job-1', 'DEBIT'), null, 'unknown user');
  // Positive controls: job-2 and u2 really do own DEBIT rows, so they must be found.
  assert.equal((await store.getTransactionByJobAndType('u1', 'job-2', 'DEBIT'))!.id, 't-other-job');
  assert.equal((await store.getTransactionByJobAndType('u2', 'job-1', 'DEBIT'))!.id, 't-other-user');
});

test('5C5-B2. a double charge is now IMPOSSIBLE, not merely resolved to the first row', async () => {
    const { store } = await openStore();
    await store.createUser(sampleUser('u1') as any);

    // This test previously seeded three DEBIT rows for one (userId, jobId, type)
    // and asserted the lookup returned the earliest, matching JSON find() order.
    // That state was a tolerated double-charge bug: the tie-break hid the second
    // charge instead of preventing it.
    //
    // Stage 5D closes it at the source. `ux_transactions_job_type` makes a second
    // row of the same type for the same job unrepresentable, so the lookup can
    // only ever see one. The ORDER BY createdAt tie-break remains in the query as
    // a safety net for a legacy database that has not been migrated yet.
    await store.addTransaction(txnAt('t-first', { createdAt: '2026-01-01T00:00:00.000Z', amount: -1 }));
    await assert.rejects(
      store.addTransaction(txnAt('t-second', { createdAt: '2026-01-02T00:00:00.000Z', amount: -2 })),
      /UNIQUE|constraint/i,
      'a second DEBIT for one job must be rejected by the database, not silently kept',
    );

    const hit = await store.getTransactionByJobAndType('u1', 'job-1', 'DEBIT');
    assert.equal(hit!.id, 't-first', 'the single surviving debit is returned');
  });

test('5C5-B3. it matches JSON forJobAndType on the same seeded ledger', async () => {
  // True cross-backend parity: the same rows into both stores, compared result
  // for result through the real JSON repository method.
  const file = join(mkdtempSync(join(tmpdir(), 'jsonstore-')), 'app.db.json');
  const jsonStore = new DataStore(file);
  await jsonStore.init();
  const jsonCredits = new CreditRepo(jsonStore);

  const rows = [
    txnAt('t-debit', { createdAt: '2026-01-01T00:00:00.000Z' }),
    txnAt('t-usage', { type: 'USAGE', createdAt: '2026-01-02T00:00:00.000Z' }),
    txnAt('t-res', { type: 'RESERVATION', createdAt: '2026-01-03T00:00:00.000Z' }),
    txnAt('t-unrelated', { jobId: 'job-9', createdAt: '2026-01-04T00:00:00.000Z' }),
    txnAt('t-admin', { jobId: undefined, type: 'ADMIN_CREDIT', idempotencyKey: 'adm-1', createdAt: '2026-01-05T00:00:00.000Z' }),
  ];
  jsonStore.mutate((db) => {
    for (const r of rows) db.transactions.push(structuredClone(r) as any);
  });

  const { store } = await openStore();
  await store.createUser(sampleUser('u1') as any);
  for (const r of rows) await store.addTransaction(r as any);

  for (const type of ['DEBIT', 'USAGE', 'RESERVATION', 'RELEASE', 'REFUND', 'ADMIN_CREDIT']) {
    const fromJson = jsonCredits.forJobAndType('u1', 'job-1', type as any);
    const fromTurso = await store.getTransactionByJobAndType('u1', 'job-1', type);
    assert.equal(fromTurso?.id ?? null, fromJson?.id ?? null, `type ${type} must resolve identically on both backends`);
  }

  // A job-scoped lookup must never see the NULL-jobId admin row.
  assert.equal(await store.getTransactionByJobAndType('u1', 'job-1', 'ADMIN_CREDIT'), null);
  // ...but the idempotency path still finds it, which is why both are needed.
  assert.equal((await store.getTransactionByIdempotencyKey('adm-1', 'u1'))!.id, 't-admin');
});

// ---------------------------------------------------------------------------
// Production crash regression: JobRepo over the libSQL provider.
//
// `TypeError: Cannot read properties of undefined (reading 'filter')` at
// JobRepo.listProcessing() crashed the Render boot inside
// JobQueue.rehydrate() on the Turso deployment. Cause: every JobRepo read was
// `this.store.snapshot().jobs`, and TursoStore.snapshot() is ASYNC, so `.jobs`
// was undefined on a synchronous access. JobRepo now dispatches to the
// per-entity async methods; these tests pin that dispatch, because the old
// synchronous reads silently degraded to "no jobs" anywhere they were merely
// undefined rather than throwing (the tick loop swallowed them via
// runDetached), so the queue would have silently stopped processing jobs.
// ---------------------------------------------------------------------------

/** A realistic job row; only the fields these tests assert on matter. */
function tursoJob(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    userId: 'u1',
    status,
    provider: 'sarvam',
    input: { storageKey: `uploads/${id}.mp3`, originalName: `${id}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 1, sha256: 'x', durationSeconds: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    retryCount: 0,
    ...extra,
  } as any;
}

/** Seed the user a job's FK points at, so createJob() satisfies the constraint. */
async function seedJobUser(store: TursoStore, userId: string): Promise<void> {
  if (!(await store.getUserById(userId))) {
    await store.createUser({ id: userId, email: `${userId}@example.test`, role: 'USER', credits: 0, tokenHashes: [], createdAt: '2026-01-01T00:00:00.000Z' } as any);
  }
}

test('6B-J1. listProcessing() returns PROCESSING jobs over libSQL (the boot-crash regression)', async () => {
  const { store } = await openStore();
  const repo = new JobRepo(store as unknown as DataStore);
  await seedJobUser(store, 'u1');
  await repo.create(tursoJob('j-q', 'QUEUED'));
  await repo.create(tursoJob('j-p1', 'PROCESSING'));
  await repo.create(tursoJob('j-d', 'COMPLETED'));
  await repo.create(tursoJob('j-p2', 'PROCESSING'));

  const processing = await repo.listProcessing();
  assert.deepEqual(processing.map((j) => j.id).sort(), ['j-p1', 'j-p2']);
  // The fields rehydrate() reads to refund + mark FAILED must survive intact.
  assert.equal(processing[0].userId, 'u1');
  assert.equal(typeof processing[0].input.storageKey, 'string');
});

test('6B-J2. listProcessing() on an empty table resolves to [] rather than throwing', async () => {
  const { store } = await openStore();
  const repo = new JobRepo(store as unknown as DataStore);
  // This exact shape is what production hit: an empty jobs table made
  // snapshot().jobs undefined, and `.filter` on it was the crash.
  assert.deepEqual(await repo.listProcessing(), []);
});

test('6B-J3. every JobRepo read dispatches to libSQL per-entity methods', async () => {
  const { store } = await openStore();
  const repo = new JobRepo(store as unknown as DataStore);
  await seedJobUser(store, 'u1');
  await seedJobUser(store, 'u2');
  await repo.create(tursoJob('j-q', 'QUEUED'));
  await repo.create(tursoJob('j-p', 'PROCESSING', { userId: 'u2' }));

  assert.equal((await repo.get('j-q'))!.status, 'QUEUED');
  assert.equal(await repo.get('no-such-job'), null);
  assert.equal((await repo.getForUser('j-p', 'u2'))!.id, 'j-p');
  assert.equal(await repo.getForUser('j-p', 'u1'), null, 'ownership is still enforced on libSQL');
  assert.equal((await repo.listForUser('u1')).length, 1);
  assert.equal((await repo.listForUser('u1', 'QUEUED')).length, 1);
  assert.equal(await repo.countActiveForUser('u1'), 1);
  assert.deepEqual((await repo.listQueued()).map((j) => j.id), ['j-q']);
  assert.equal((await repo.listAll()).length, 2);

  // Backoff gating is the queue's eligibility rule, so it must match too.
  await repo.create(tursoJob('j-later', 'QUEUED', { nextRetryAt: '2999-01-01T00:00:00.000Z' }));
  const eligible = (await repo.listEligibleQueued('2026-01-02T00:00:00.000Z')).map((j) => j.id);
  assert.ok(eligible.includes('j-q'));
  assert.ok(!eligible.includes('j-later'), 'a future nextRetryAt is not eligible');
});

test('6B-J4. update() persists over libSQL and still returns null for an unknown id', async () => {
  const { store } = await openStore();
  const repo = new JobRepo(store as unknown as DataStore);
  await seedJobUser(store, 'u1');
  await repo.create(tursoJob('j-1', 'PROCESSING'));

  const updated = await repo.update('j-1', {
    status: 'FAILED',
    errorCode: 'INTERRUPTED',
    completedAt: '2026-01-03T00:00:00.000Z',
  });
  assert.equal(updated!.status, 'FAILED', 'the persisted row is read back');
  assert.equal(updated!.errorCode, 'INTERRUPTED');
  assert.equal((await store.getJobById('j-1'))!.status, 'FAILED', 'the write really landed');
  assert.equal(await repo.update('no-such-job', { status: 'COMPLETED' }), null);
});

test('6B-J5. JobRepo over libSQL matches the JSON provider on the same job set', async () => {
  // The two providers must not diverge on anything rehydrate()/tick() reads.
  const file = join(mkdtempSync(join(tmpdir(), 'jobrepo-parity-')), 'app.db.json');
  const jsonStore = new DataStore(file);
  await jsonStore.init();
  const json = new JobRepo(jsonStore);
  const { store } = await openStore();
  const turso = new JobRepo(store as unknown as DataStore);
  await seedJobUser(store, 'u1');

  for (const repo of [json, turso]) {
    await repo.create(tursoJob('j-q', 'QUEUED'));
    await repo.create(tursoJob('j-p', 'PROCESSING'));
    await repo.create(tursoJob('j-d', 'COMPLETED'));
  }

  assert.deepEqual(
    (await turso.listProcessing()).map((j) => j.id),
    (await json.listProcessing()).map((j) => j.id),
  );
  assert.deepEqual((await turso.listQueued()).map((j) => j.id), (await json.listQueued()).map((j) => j.id));
  assert.equal(await turso.countActiveForUser('u1'), await json.countActiveForUser('u1'));
  assert.deepEqual(
    (await turso.listAll()).map((j) => j.id).sort(),
    (await json.listAll()).map((j) => j.id).sort(),
  );
});