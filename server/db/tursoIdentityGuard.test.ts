/**
 * Stage 6B — money-identity indexes are part of the schema v3 contract.
 *
 * THE DEFECT THIS LOCKS DOWN
 * -------------------------
 * `init()` had an empty `TURSO_SKIP_IDENTITY_MIGRATION === '1'` branch. The schema
 * marker was written unconditionally afterwards, and `validateSchema()` never
 * looked at the identity indexes. The two together meant the bypass flag produced
 * a database stamped **v3** — the version that asserts "this database cannot
 * express a double credit" — while having **none** of the three indexes. It
 * reported success for an unprotected ledger, which is the one failure mode a
 * money-safety migration must never have.
 *
 * The contract now:
 *   - v3 is only ever recorded once all three identity indexes exist;
 *   - the skip flag is an inspection aid that CANNOT certify protection;
 *   - validateSchema() treats a missing identity index as an incompatibility, but
 *     only from the schema version that first promised them;
 *   - the pre-existing conflict hard-stop, additivity and idempotence are
 *     unchanged, and no test here deletes or rewrites a financial row.
 *
 * Everything runs against throwaway `file::memory:` and temp-file databases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TursoStore, SCHEMA_VERSION } from './tursoStore.ts';
import { CREDIT_IDENTITY_INDEXES, applyCreditIdentityMigration } from './creditIdentityIndexes.ts';

const SKIP_FLAG = 'TURSO_SKIP_IDENTITY_MIGRATION';

const ALL_INDEX_NAMES = CREDIT_IDENTITY_INDEXES.map((i) => i.name);

function freshDb(): { client: Client; store: TursoStore } {
  const client = createClient({ url: 'file::memory:' });
  return { client, store: new TursoStore(client) };
}

/** Runs `fn` with the skip flag forced on, restoring whatever was there before. */
async function withSkipFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[SKIP_FLAG];
  if (value === undefined) delete process.env[SKIP_FLAG];
  else process.env[SKIP_FLAG] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[SKIP_FLAG];
    else process.env[SKIP_FLAG] = previous;
  }
}

/** Index names that actually exist in the live database. */
async function indexNames(client: Client): Promise<string[]> {
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
  return res.rows.map((r) => String(r.name)).filter((n) => n.startsWith('ux_transactions_'));
}

/** Version markers recorded so far. */
async function stampedVersions(client: Client): Promise<number[]> {
  const res = await client.execute('SELECT version FROM schema_migrations');
  return res.rows.map((r) => Number(r.version));
}

/**
 * Order-independent comparison of index names.
 *
 * sqlite_master returns indexes in creation order, so the live list has to be
 * sorted before it can be compared with a sorted expectation.
 */
function assertIndexes(actual: readonly string[], message?: string): void {
  assert.deepEqual([...actual].sort(), [...ALL_INDEX_NAMES].sort(), message);
}

// ---------------------------------------------------------------------------
// A. skip flag + missing indexes => failure, and NO v3 stamp
// ---------------------------------------------------------------------------

test('6B-A. skip flag with missing identity indexes fails loudly and stamps nothing', async () => {
  // A stale pre-Stage-5D database: current tables, no identity indexes.
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());
  await client.execute('DROP INDEX ux_transactions_payment_id');
  await client.execute('DROP INDEX ux_transactions_idempotency');
  await client.execute('DROP INDEX ux_transactions_job_type');
  await client.execute('DELETE FROM schema_migrations');
  assert.deepEqual(await indexNames(client), [], 'precondition: no identity indexes');

  await withSkipFlag('1', () => assert.rejects(() => store.init()));

  await withSkipFlag('1', async () => {
    await assert.rejects(
      () => store.init(),
      (err: Error) => {
        // Actionable: names the flag, the consequence, and the remedy.
        assert.match(err.message, /TURSO_SKIP_IDENTITY_MIGRATION/);
        assert.match(err.message, /was NOT recorded/);
        assert.match(err.message, /Unset TURSO_SKIP_IDENTITY_MIGRATION/);
        assert.match(err.message, /No data was changed/);
        // Every missing index is named so the operator knows the full extent.
        for (const name of ALL_INDEX_NAMES) {
          assert.ok(err.message.includes(name), `error must name ${name}`);
        }
        return true;
      }
    );
  });

  // The critical assertion: the version marker must NOT claim protection.
  assert.deepEqual(await stampedVersions(client), [], 'schema v3 must not be recorded');
  assert.deepEqual(await indexNames(client), [], 'the bypass must not create indexes');
});

// ---------------------------------------------------------------------------
// B. skip flag + all indexes present => valid
// ---------------------------------------------------------------------------

test('6B-B. skip flag with all identity indexes already present is valid and records v3', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());
  await client.execute('DELETE FROM schema_migrations');

  // Indexes exist from the first init(); the bypass changes nothing about them.
  await withSkipFlag('1', () => store.init());

  assertIndexes(await indexNames(client));
  assert.deepEqual(
    await stampedVersions(client),
    [SCHEMA_VERSION],
    'an already-protected database may still be stamped v3'
  );
});

// ---------------------------------------------------------------------------
// C. schema v3 + missing identity index => validation failure
// D. schema v3 + all identity indexes => validation success
// ---------------------------------------------------------------------------

test('6B-C. validateSchema reports a missing identity index when v3 is expected', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());
  assert.deepEqual(await store.validateSchema(SCHEMA_VERSION), [], 'precondition: fully protected');

  await client.execute('DROP INDEX ux_transactions_job_type');

  const problems = await store.validateSchema(SCHEMA_VERSION);
  assert.ok(
    problems.some((p) => p.includes('ux_transactions_job_type')),
    `expected the missing index to be reported, got: ${JSON.stringify(problems)}`
  );
  // Exactly the one that is gone.
  assert.equal(problems.filter((p) => p.includes('money-identity index')).length, 1);

  // Descriptive only — the existing suite pins that problems never repair.
  assert.ok(problems.every((p) => !/DROP|DELETE|ALTER|TRUNCATE/i.test(p)));

  // The normal path is self-healing: init() recreates the dropped index instead
  // of reporting it, which is exactly what the migration is for.
  await withSkipFlag(undefined, () => store.init());
  assertIndexes(await indexNames(client), 'the normal path restores the missing index');

  // Under the bypass it must refuse instead of creating anything, and must not
  // leave a version marker behind.
  await client.execute('DELETE FROM schema_migrations');
  await client.execute('DROP INDEX ux_transactions_job_type');
  await withSkipFlag('1', () => assert.rejects(() => store.init(), /was NOT recorded/));
  assert.deepEqual(await stampedVersions(client), [], 'nothing is recorded under the bypass');
});

test('6B-D. validateSchema passes when all identity indexes are present', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());

  assertIndexes(await indexNames(client));
  assert.deepEqual(await store.validateSchema(SCHEMA_VERSION), []);
  assert.deepEqual(await store.validateSchema(), [], 'the default expects SCHEMA_VERSION too');
});

// ---------------------------------------------------------------------------
// Requirement 9: an older contract must not demand indexes it never promised
// ---------------------------------------------------------------------------

test('6B. an older schema version is not required to have identity indexes', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());
  await client.execute('DROP INDEX ux_transactions_payment_id');
  await client.execute('DROP INDEX ux_transactions_idempotency');
  await client.execute('DROP INDEX ux_transactions_job_type');

  // Pre-Stage-5D contract: the indexes are not applicable, so nothing is reported.
  assert.deepEqual(await store.validateSchema(2), []);

  // The same database under the current contract is reported, not repaired.
  assert.equal((await store.validateSchema(3)).length, 3);
  assert.equal((await store.validateSchema()).length, 3);
});

// ---------------------------------------------------------------------------
// E. normal migration creates indexes, THEN stamps v3 (ordering)
// ---------------------------------------------------------------------------

test('6B-E. the normal path creates and verifies the indexes before recording v3', async () => {
  const { client, store } = freshDb();

  const stampOrder: string[] = [];
  const realExecute = client.execute.bind(client);
  // Observe the write ordering without changing behaviour.
  (client as { execute: unknown }).execute = (opts: unknown, ...rest: unknown[]) => {
    const sql = typeof opts === 'string' ? opts : String((opts as { sql?: string })?.sql ?? '');
    if (/CREATE UNIQUE INDEX/.test(sql)) stampOrder.push('index');
    if (/INSERT OR IGNORE INTO schema_migrations/.test(sql)) stampOrder.push('stamp');
    return (realExecute as (...a: unknown[]) => unknown)(opts, ...rest);
  };

  try {
    await withSkipFlag(undefined, () => store.init());
  } finally {
    (client as { execute: unknown }).execute = realExecute;
  }

  assert.deepEqual(stampOrder, ['index', 'index', 'index', 'stamp'], 'all three indexes, then the marker');
  assert.deepEqual(await stampedVersions(client), [SCHEMA_VERSION]);
  assertIndexes(await indexNames(client));
});

// ---------------------------------------------------------------------------
// F. rerunning the migration remains idempotent
// ---------------------------------------------------------------------------

test('6B-F. re-running init and the migration stays idempotent', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());
  await withSkipFlag(undefined, () => store.init());

  assert.deepEqual(await stampedVersions(client), [SCHEMA_VERSION], 'INSERT OR IGNORE, not a duplicate');
  assertIndexes(await indexNames(client), 'no duplicate indexes');

  const again = await applyCreditIdentityMigration(client);
  assert.deepEqual([...again.created], [], 'a second run creates nothing');
  assert.deepEqual([...again.missing], []);
  assertIndexes(again.present);
  assert.deepEqual(await stampedVersions(client), [SCHEMA_VERSION]);
});

// ---------------------------------------------------------------------------
// G. the conflict pre-flight still hard-stops, changing nothing
// ---------------------------------------------------------------------------

test('6B-G. duplicate financial rows still hard-stop the migration without writing', async () => {
  const { client } = freshDb();

  // Two ledger rows for one payment: the exact defect the indexes exist to stop.
  await client.execute(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL,
    paymentId TEXT, idempotencyKey TEXT, jobId TEXT, note TEXT, createdAt TEXT NOT NULL,
    reason TEXT)`);

  const insert = (id: string) =>
    client.execute({
      sql: `INSERT INTO transactions (id, userId, type, amount, paymentId, note, createdAt)
            VALUES (?, 'u1', 'PURCHASE', 100, 'pay_dupe', 'x', '2026-01-01T00:00:00.000Z')`,
      args: [id],
    });
  await insert('t1');
  await insert('t2');

  await assert.rejects(() => applyCreditIdentityMigration(client), /ABORTED/i);

  assert.deepEqual(await indexNames(client), [], 'not even the non-conflicting index is created');
  const rows = await client.execute('SELECT COUNT(*) AS n FROM transactions');
  assert.equal(Number(rows.rows[0].n), 2, 'no financial row is deleted, merged or rewritten');

  // A full init() under the same conditions must refuse, not "repair" the data.
  const store = new TursoStore(client);
  await assert.rejects(() => store.init());
  const stamped = await client.execute('SELECT version FROM schema_migrations');
  assert.equal(stamped.rows.length, 0, 'nothing is recorded when the ledger is unprotected');
});

// ---------------------------------------------------------------------------
// The guard is reached through init(), not only through validateSchema()
// ---------------------------------------------------------------------------

test('6B. the skip guard and validateSchema agree on one definition of protected', async () => {
  const { client, store } = freshDb();
  await withSkipFlag(undefined, () => store.init());

  // Both the private detector and the public validator must see the same truth.
  const viaPrivate = await (store as unknown as { missingIdentityIndexes(): Promise<string[]> })
    .missingIdentityIndexes();
  assert.deepEqual(viaPrivate, []);

  await client.execute('DROP INDEX ux_transactions_payment_id');
  const viaPrivateAfter = await (
    store as unknown as { missingIdentityIndexes(): Promise<string[]> }
  ).missingIdentityIndexes();
  assert.deepEqual(viaPrivateAfter, ['transactions: ux_transactions_payment_id']);
  assert.equal((await store.validateSchema(SCHEMA_VERSION)).length, 1);
});

// ---------------------------------------------------------------------------
// The guard must hold on a real file-backed database too, not just in memory
// ---------------------------------------------------------------------------

test('6B. the skip guard holds on a real file-backed database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'libsql-6b-'));
  const client = createClient({ url: `file:${join(dir, 'app.db')}` });
  const store = new TursoStore(client);

  await withSkipFlag(undefined, () => store.init());
  await client.execute('DROP INDEX ux_transactions_job_type');

  await withSkipFlag('1', async () => {
    await assert.rejects(() => store.init(), /was NOT recorded/);
  });
  assert.deepEqual(await stampedVersions(client), [SCHEMA_VERSION], 'the earlier stamp is left alone');
  assert.ok(
    !(await indexNames(client)).includes('ux_transactions_job_type'),
    'the bypass still does not create the index'
  );
});