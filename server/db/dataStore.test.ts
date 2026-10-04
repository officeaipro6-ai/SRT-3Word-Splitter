/**
 * Contract tests for the type-only provider / unit-of-work contract in
 * `server/db/dataStore.ts`.
 *
 * The suite has three parts:
 *
 *  1. COMPILE-TIME assertions. `Assert<T extends true>` fails to compile when
 *     its argument is `false`, so the KNOWN provider incompatibilities are
 *     pinned in place: if someone quietly widens a type and closes one of these
 *     gaps, `tsc --noEmit` (npm run lint) fails here first.
 *
 *  2. RUNTIME proof of the same shape, against real provider instances built on
 *     a local temp file. A JSON store and a libSQL store never leave the
 *     machine; no Turso or R2 endpoint is contacted.
 *
 *  3. RUNTIME proof of the `UnitOfWork` semantics, using a small isolated
 *     implementation defined in this file. It never touches a production
 *     provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';

import type { SyncDataStore, UnitOfWork } from './dataStore';
import { DataStore } from './store';
import { TursoStore } from './tursoStore';

// ---------------------------------------------------------------------------
// 1. Compile-time contract assertions
// ---------------------------------------------------------------------------

/** Compile-time assertion: the argument must resolve to `true`. */
type Assert<T extends true> = T;

/**
 * The recorded provider facts. This tuple is intentionally exported so the
 * assertions are live code rather than dead type aliases.
 *
 * - The JSON provider IS the synchronous surface the repositories are typed
 *   against, and must stay exactly that.
 * - `TursoStore` is NOT that surface: `snapshot()` is async and
 *   `mutate()`/`mutateAsync()` throw. This is the repository incompatibility,
 *   recorded rather than hidden.
 * - `TursoStore` does NOT satisfy `UnitOfWork`, because its `transaction()`
 *   hands out the raw `@libsql/client` handle instead of a scoped store.
 * - The JSON provider has no transaction concept yet.
 */
export type ProviderContractAssertions = [
  Assert<DataStore extends SyncDataStore ? true : false>,
  Assert<TursoStore extends SyncDataStore ? false : true>,
  Assert<DataStore extends TursoStore ? false : true>,
  Assert<TursoStore extends UnitOfWork<TursoStore> ? false : true>,
  Assert<DataStore extends UnitOfWork<DataStore> ? false : true>,
];

// ---------------------------------------------------------------------------
// 2. Runtime proof of the provider shapes
// ---------------------------------------------------------------------------

test('the JSON provider satisfies the synchronous surface at runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uow-json-'));
  try {
    const store = new DataStore(join(dir, 'app.db.json'));
    await store.init();

    // Synchronous by contract: a DbShape object, not a thenable.
    const snap = store.snapshot();
    assert.equal(snap instanceof Promise, false, 'JSON snapshot() must not return a Promise');
    assert.ok(Array.isArray(snap.users));
    assert.ok(Array.isArray(snap.transactions));

    // Synchronous mutation returning the callback value inline.
    const created = store.mutate((db) => {
      db.users.push({ id: 'u1', tokenHashes: [], credits: 5 } as never);
      return 'mutated';
    });
    assert.equal(created, 'mutated');
    assert.equal(store.snapshot().users.length, 1);

    // The surface the repositories rely on is present and callable.
    const surface: SyncDataStore = store;
    assert.equal(typeof surface.mutate, 'function');
    assert.equal(typeof surface.mutateAsync, 'function');
    assert.equal(typeof surface.snapshot, 'function');
    assert.equal(typeof surface.init, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('TursoStore does not satisfy the synchronous surface at runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uow-turso-'));
  const client = createClient({ url: `file:${join(dir, 'app.db')}` });
  try {
    const store = new TursoStore(client);
    await store.init();

    // Async where the synchronous contract requires a plain object.
    const pending = store.snapshot();
    assert.ok(pending instanceof Promise, 'Turso snapshot() is async, so it cannot be a SyncDataStore');
    const snap = await pending;
    assert.ok(Array.isArray(snap.users));

    // Whole-database writes are refused rather than silently accepted.
    assert.throws(() => store.mutate(() => 1), /not supported/i);
    await assert.rejects(() => store.mutateAsync(() => 1), /not supported/i);
  } finally {
    await client.close();
    // The temp dir is intentionally left behind: the libSQL native binding keeps
    // the SQLite file locked for the lifetime of the process on Windows, so
    // removing it here fails with EPERM. This matches the existing file-backed
    // tests in server/db/tursoStore.test.ts, which clean up the same way.
  }
});

test('TursoStore.transaction() yields a raw client handle, not a scoped store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uow-turso-tx-'));
  const client = createClient({ url: `file:${join(dir, 'app.db')}` });
  try {
    const store = new TursoStore(client);
    await store.init();

    let observed: unknown;
    await store.transaction(async (tx) => {
      observed = tx;
      // The handle is commit/rollback + execute only: no schema-aware,
      // JSON-decoding per-entity surface. Repositories must never see this.
      assert.equal(typeof tx.execute, 'function');
      assert.equal(typeof tx.commit, 'function');
      assert.equal(typeof tx.rollback, 'function');
      assert.equal(typeof (tx as Record<string, unknown>).getUserById, 'undefined');
      assert.equal(typeof (tx as Record<string, unknown>).saveAlert, 'undefined');
      return null;
    });

    assert.ok(observed, 'transaction() must invoke the callback');
    assert.notEqual(observed instanceof TursoStore, true, 'the handle must not be the store itself');
  } finally {
    await client.close();
    // Temp dir left behind on purpose; see the note in the previous test.
  }
});

// ---------------------------------------------------------------------------
// 3. Runtime proof of the UnitOfWork semantics
// ---------------------------------------------------------------------------

/**
 * Isolated test double standing in for a future transaction-scoped store. It
 * exposes only the scoped surface, never a client handle, so it cannot model the
 * "raw Transaction reaches the repository" shape the contract forbids.
 */
class FakeScopedStore {
  readonly writes: string[] = [];

  write(entry: string): void {
    this.writes.push(entry);
  }

  read(): string[] {
    return [...this.writes];
  }
}

/** Reference `UnitOfWork`: commit on resolve, roll back and rethrow on reject. */
class FakeUnitOfWork implements UnitOfWork<FakeScopedStore> {
  commits = 0;
  rollbacks = 0;
  /** Durably written state; only updated on commit. */
  persisted: string[] = [];

  async transaction<T>(fn: (scoped: FakeScopedStore) => Promise<T>): Promise<T> {
    const scoped = new FakeScopedStore();
    try {
      const result = await fn(scoped);
      this.commits += 1;
      this.persisted = scoped.read();
      return result;
    } catch (err) {
      this.rollbacks += 1;
      throw err;
    }
  }
}

test('UnitOfWork returns the callback result and commits', async () => {
  const uow = new FakeUnitOfWork();

  const result = await uow.transaction(async (scoped) => {
    scoped.write('a');
    scoped.write('b');
    return 'value-from-callback';
  });

  assert.equal(result, 'value-from-callback');
  assert.equal(uow.commits, 1);
  assert.equal(uow.rollbacks, 0);
  assert.deepEqual(uow.persisted, ['a', 'b']);
});

test('UnitOfWork rolls back and rethrows the original error', async () => {
  const uow = new FakeUnitOfWork();
  const failure = new Error('credit balance would go negative');

  await assert.rejects(
    () =>
      uow.transaction(async (scoped) => {
        scoped.write('debit-1');
        scoped.write('debit-2');
        throw failure;
      }),
    (err: unknown) => err === failure,
  );

  assert.equal(uow.commits, 0);
  assert.equal(uow.rollbacks, 1);
  // Nothing from the failed scope may reach durable state.
  assert.deepEqual(uow.persisted, []);
});

test('a rolled-back transaction does not block the next one', async () => {
  const uow = new FakeUnitOfWork();

  await assert.rejects(() =>
    uow.transaction(async (scoped) => {
      scoped.write('doomed');
      throw new Error('first fails');
    }),
  );

  const after = await uow.transaction(async (scoped) => {
    scoped.write('kept');
    return 7;
  });

  assert.equal(after, 7);
  assert.equal(uow.commits, 1);
  assert.equal(uow.rollbacks, 1);
  assert.deepEqual(uow.persisted, ['kept']);
});
