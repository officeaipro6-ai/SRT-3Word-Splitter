/**
 * Stage 5D — credit identity uniqueness (schema v3).
 *
 * These tests are the safety argument for adding UNIQUE indexes to a table that
 * holds financial history. They run only against throwaway `file::memory:` and
 * temp-file databases; nothing here touches real user data.
 *
 * The cases that matter most are the ones where the migration must REFUSE to
 * act. A migration that quietly resolves a duplicate by deleting or rewriting a
 * row is far more dangerous than one that stops and asks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type Client, type InValue } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TursoStore, SCHEMA_VERSION } from './tursoStore.ts';
import {
  applyCreditIdentityMigration,
  planCreditIdentityMigration,
  formatConflicts,
  CREDIT_IDENTITY_INDEXES,
} from './creditIdentityIndexes.ts';
import type { UserRecord } from './types.ts';

function user(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u1',
    tokenHashes: [],
    credits: 100,
    role: 'USER',
    creditMode: 'NORMAL',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    freeTrialsUsed: 0,
    ...over,
  } as UserRecord;
}

/**
 * The test owns the libsql client and hands the same instance to the store.
 *
 * TursoStore deliberately keeps its client private (TursoScope hides
 * commit/rollback/raw clients), so the migration helpers — which take a raw
 * Client, being a database-level concern — are driven from the test's own
 * reference rather than by widening the production API for test convenience.
 */
function freshDb(): { client: Client; store: TursoStore } {
  const client = createClient({ url: 'file::memory:' });
  return { client, store: new TursoStore(client) };
}

async function indexNames(client: Client): Promise<Set<string>> {
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
  return new Set(res.rows.map((r) => String(r.name)));
}

async function countRows(client: Client, where = ''): Promise<number> {
  const res = await client.execute(`SELECT COUNT(*) AS n FROM transactions ${where}`);
  return Number(res.rows[0].n);
}

/**
 * Insert a ledger row directly, bypassing the service, to plant test data.
 *
 * `transactions.userId` carries a real FOREIGN KEY to `users(id)` (foreign keys
 * are enforced — TursoStore verifies `PRAGMA foreign_keys` on every connection),
 * so the referenced user has to exist first. Seeding it here keeps each test
 * focused on the identity index rather than on fixture plumbing.
 */
async function insertTxn(client: Client, row: Record<string, unknown>): Promise<void> {
  // Object form, matching tursoScope.execute(). This build of @libsql/client
  // only types the single-argument overload, so `execute(sql, args)` is a type
  // error even though it works at runtime.
  await client.execute({
    sql: `INSERT OR IGNORE INTO users (id, tokenHashes, credits, role, creditMode, createdAt, lastSeenAt, freeTrialsUsed)
          VALUES (?, '[]', 0, 'USER', 'NORMAL', ?, ?, 0)`,
    args: [String(row.userId), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  });
  await client.execute({
    sql: `INSERT INTO transactions
            (id, userId, type, amount, reason, balanceBefore, balanceAfter, idempotencyKey, createdAt, adminUserId, adminEmail, jobId, paymentId, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      String(row.id),
      String(row.userId),
      String(row.type),
      Number(row.amount ?? 10),
      String(row.reason ?? 'test'),
      Number(row.balanceBefore ?? 100),
      Number(row.balanceAfter ?? 90),
      (row.idempotencyKey ?? null) as string | null,
      String(row.createdAt ?? '2026-01-01T00:00:00.000Z'),
      (row.adminUserId ?? null) as string | null,
      (row.adminEmail ?? null) as string | null,
      (row.jobId ?? null) as string | null,
      (row.paymentId ?? null) as string | null,
      (row.extra ?? null) as string | null,
    ] as InValue[],
  });
}

/**
 * Build a database shaped like a pre-Stage-5D deployment: correct tables, real
 * rows, and NO identity indexes.
 */
async function legacyDb(rows: Array<Record<string, unknown>>): Promise<{ client: Client; store: TursoStore }> {
  const { client, store } = freshDb();
  await store.init(); // creates tables AND the indexes
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    await client.execute(`DROP INDEX IF EXISTS ${idx.name}`);
  }
  for (const row of rows) await insertTxn(client, row);
  return { client, store };
}

// ------------------------------------------------------------ happy path ----

test('5D-D1. a fresh database gets all three identity indexes', async () => {
  const { client, store } = freshDb();
  await store.init();
  const names = await indexNames(client);
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    assert.ok(names.has(idx.name), `${idx.name} must exist on a fresh database`);
  }
});

test('5D-D2. the schema version is bumped to 3 and stamped', async () => {
  const { client, store } = freshDb();
  await store.init();
  const marked = await client.execute('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  assert.equal(Number(marked.rows[0].version), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 3, 'Stage 5D identity work is schema v3');
});

test('5D-D3. re-running the migration is a no-op (idempotent)', async () => {
  const { client, store } = freshDb();
  await store.init();
  const before = await indexNames(client);

  const again = await applyCreditIdentityMigration(client);
  assert.deepEqual(again.created, [], 'a second run must create nothing');
  assert.equal(again.missing.length, 0);
  assert.equal(again.conflicts.length, 0);
  assert.deepEqual([...(await indexNames(client))].sort(), [...before].sort());
});

// -------------------------------------------------- the database now bites ---

test('5D-D4. the database itself rejects a duplicate paymentId', async () => {
  const { client, store } = freshDb();
  await store.init();
  await insertTxn(client, { id: 't1', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_abc' });

  await assert.rejects(
    insertTxn(client, { id: 't2', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_abc' }),
    /UNIQUE|constraint/i,
    'a second row for one payment must be rejected by the database',
  );
  assert.equal(await countRows(client, 'WHERE paymentId = ?'.replace('?', "'pay_abc'")), 1);
});

test('5D-D5. a repeated (userId, jobId, type) is rejected but DEBIT+REFUND coexist', async () => {
  const { client, store } = freshDb();
  await store.init();

  await insertTxn(client, { id: 't1', userId: 'u1', type: 'DEBIT', jobId: 'job-1' });
  await insertTxn(client, { id: 't2', userId: 'u1', type: 'REFUND', jobId: 'job-1' });

  await assert.rejects(
    insertTxn(client, { id: 't3', userId: 'u1', type: 'DEBIT', jobId: 'job-1' }),
    /UNIQUE|constraint/i,
    'a second DEBIT for one job must be rejected',
  );
  // A different type on the same job is legitimate and must remain allowed.
  assert.equal(await countRows(client, "WHERE jobId = 'job-1'"), 2);
});

test('5D-D6. many rows with NULL identity columns are allowed (partial index)', async () => {
  const { client, store } = freshDb();
  await store.init();

  // Admin rows legitimately have no jobId and no paymentId. A naive UNIQUE index
  // or a NOT NULL sentinel would break exactly this common case.
  for (let i = 0; i < 25; i += 1) {
    await insertTxn(client, {
      id: `admin-${i}`,
      userId: `u${i}`,
      type: 'ADMIN_CREDIT',
      idempotencyKey: null,
      jobId: null,
      paymentId: null,
    });
  }
  assert.equal(await countRows(client), 25, 'all NULL-identity rows survive');
});

test('5D-D7. an admin idempotencyKey is unique per (user, key, type)', async () => {
  const { client, store } = freshDb();
  await store.init();

  await insertTxn(client, { id: 'a1', userId: 'u1', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' });
  await assert.rejects(
    insertTxn(client, { id: 'a2', userId: 'u1', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' }),
    /UNIQUE|constraint/i,
  );
  // Same key, different user: a different admin intent, must be allowed.
  await insertTxn(client, { id: 'a3', userId: 'u2', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' });
  // Same key, different type: also a different operation.
  await insertTxn(client, { id: 'a4', userId: 'u1', type: 'ADMIN_DEBIT', idempotencyKey: 'k1' });
  assert.equal(await countRows(client, "WHERE idempotencyKey = 'k1'"), 3);
});

// ------------------------------------------- pre-existing databases (v2) ----

test('5D-D8. a legacy database with NO duplicates migrates and keeps every row', async () => {
  const rows = [
    { id: 'r1', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_1' },
    { id: 'r2', userId: 'u1', type: 'DEBIT', jobId: 'job-1' },
    { id: 'r3', userId: 'u1', type: 'REFUND', jobId: 'job-1' },
    { id: 'r4', userId: 'u2', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' },
    { id: 'r5', userId: 'u3', type: 'ADMIN_CREDIT' },
  ];
  const { client } = await legacyDb(rows);

  const result = await applyCreditIdentityMigration(client);
  assert.equal(result.created.length, 3, 'all three indexes are created');
  assert.equal(result.conflicts.length, 0);

  // Row-for-row preservation: nothing was rewritten, dropped, or renumbered.
  const after = await client.execute('SELECT id FROM transactions ORDER BY id');
  assert.deepEqual(
    after.rows.map((r) => String(r.id)),
    ['r1', 'r2', 'r3', 'r4', 'r5'],
    'every pre-existing row must survive the migration, in order',
  );
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    assert.ok((await indexNames(client)).has(idx.name));
  }
});

test('5D-D9. a legacy database WITH duplicates is refused, and nothing is changed', async () => {
  const { client } = await legacyDb([
    { id: 'd1', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_dup' },
    { id: 'd2', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_dup' },
  ]);

  await assert.rejects(applyCreditIdentityMigration(client), (err: unknown) => {
    const message = (err as Error).message;
    assert.match(message, /ABORTED/, 'the refusal must be unmistakable');
    assert.match(message, /pay_dup/, 'the conflicting identity must be named');
    assert.match(message, /no data was changed/i, 'the message must promise nothing was touched');
    return true;
  });

  // Critical: the abort must be all-or-nothing. The job and idempotency indexes
  // had no conflicts, so a naive implementation would have created them before
  // failing and left the database half-migrated.
  const names = await indexNames(client);
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    assert.ok(!names.has(idx.name), `${idx.name} must NOT be created when the migration aborts`);
  }
  assert.equal(await countRows(client), 2, 'both conflicting rows are preserved');
});

test('5D-D10. conflict detection works for all three identities', async () => {
  const { client } = await legacyDb([
    { id: 'x1', userId: 'u1', type: 'PURCHASE', paymentId: 'p1' },
    { id: 'x2', userId: 'u1', type: 'PURCHASE', paymentId: 'p1' },
    { id: 'x3', userId: 'u1', type: 'DEBIT', jobId: 'j1' },
    { id: 'x4', userId: 'u1', type: 'DEBIT', jobId: 'j1' },
    { id: 'x5', userId: 'u1', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' },
    { id: 'x6', userId: 'u1', type: 'ADMIN_CREDIT', idempotencyKey: 'k1' },
  ]);

  const plan = await planCreditIdentityMigration(client);
  assert.equal(plan.missing.length, 3, 'all three are missing');
  assert.deepEqual(
    plan.conflicts.map((c) => c.index).sort(),
    ['ux_transactions_idempotency', 'ux_transactions_job_type', 'ux_transactions_payment_id'],
    'every identity conflict must be detected',
  );
  for (const c of plan.conflicts) assert.equal(c.count, 2);
  assert.match(formatConflicts(plan.conflicts), /appears 2x/);
});

test('5D-D11. a dry run changes nothing and agrees with the real run', async () => {
  // Dirty database: the dry run must refuse, exactly like a real run.
  const dirty = await legacyDb([
    { id: 'g1', userId: 'u1', type: 'PURCHASE', paymentId: 'p1' },
    { id: 'g2', userId: 'u1', type: 'PURCHASE', paymentId: 'p1' },
  ]);
  await assert.rejects(applyCreditIdentityMigration(dirty.client, { dryRun: true }), /ABORTED/);
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    assert.ok(!(await indexNames(dirty.client)).has(idx.name));
  }

  // Clean database: the dry run succeeds and reports what execute would do.
  const { client, store } = freshDb();
  await store.init();
  const dry = await applyCreditIdentityMigration(client, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.created, [], 'a dry run creates nothing');
});

test('5D-D12. init() refuses to start against a conflicting legacy database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-v3-conflict-'));
  const client = createClient({ url: `file:${join(dir, 'app.db')}` });
  const store = new TursoStore(client);

  await store.init(); // provision the pre-v3 shape
  await store.createUser(user({ id: 'u1' }));
  for (const idx of CREDIT_IDENTITY_INDEXES) {
    await client.execute(`DROP INDEX IF EXISTS ${idx.name}`);
  }
  await insertTxn(client, { id: 'z1', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_x' });
  await insertTxn(client, { id: 'z2', userId: 'u1', type: 'PURCHASE', paymentId: 'pay_x' });

  // init() must refuse rather than start serving money operations on a database
  // that cannot guarantee single-crediting.
  await assert.rejects(store.init(), /ABORTED/);

  for (const idx of CREDIT_IDENTITY_INDEXES) {
    assert.ok(!(await indexNames(client)).has(idx.name), 'nothing was created by the refused init');
  }
  assert.equal(await countRows(client), 2, 'data untouched');
});