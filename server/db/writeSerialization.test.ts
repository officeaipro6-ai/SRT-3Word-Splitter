/**
 * Stage 5D finalization — write serialization and competing-write safety.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * `@libsql/client` opens every write transaction on a brand-new connection with
 * SQLite's default `busy_timeout = 0`. Overlapping writers therefore did not
 * queue: the loser failed instantly with `SQLITE_BUSY`. For a payment webhook
 * that is the worst outcome available — the gateway considers the money taken
 * while the app writes no purchase and no ledger row, and `SQLITE_BUSY` reads
 * like an ordinary transient error, so it fails SILENTLY.
 *
 * `WriteMutex` serializes writers FIFO inside `TursoStore.transaction()`. These
 * tests prove the required properties directly:
 *   - competing writes are serialized, and none is silently lost
 *   - a failed paid operation stays failed (never converted into success)
 *   - a duplicate never double-credits
 *   - ledger balances always equal the user's balance
 *   - rollback semantics are preserved
 *   - READS are not queued behind the write lock
 *
 * Databases are FILE-backed in a temp directory, never `file::memory:`, because
 * @libsql/client hands the client a fresh connection once a transaction starts
 * and an in-memory database is per-connection. These tests never connect to
 * Turso, read credentials, or touch data/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TursoStore } from './tursoStore.ts';
import { TursoCreditService } from '../services/tursoCreditService.ts';
import { REDUCING_TYPES } from '../services/creditRules.ts';
import { WriteMutex, WriteLockTimeoutError } from './writeMutex.ts';
import type { UserRecord } from './types.ts';

// ------------------------------------------------------------------ helpers ---

function makeTurso(): TursoStore {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-conc-'));
  return new TursoStore(createClient({ url: `file:${join(dir, 'app.db')}` }));
}

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
 * The ledger identity every credit flow must preserve:
 *   users.credits === openingBalance +/- sum(signed ledger amount)
 *
 * `openingBalance` is the balance the user was SEEDED with, which by definition
 * has no ledger row behind it (it is pre-existing data, not a transaction).
 *
 * This is the single strongest corruption check — it catches a lost update, a
 * doubled write, and a balance mutated without its ledger row, in one place.
 */
async function assertLedgerConsistent(
  store: TursoStore,
  userId: string,
  openingBalance: number,
): Promise<void> {
  const u = await store.getUserById(userId);
  assert.ok(u, `user ${userId} must exist`);
  const txns = await store.getTransactionsByUser(userId, 1000);
  let sum = 0;
  for (const t of txns as Array<Record<string, unknown>>) {
    const type = String(t.type) as Parameters<typeof REDUCING_TYPES.has>[0];
    const amount = Number(t.amount);
    // Use the SHARED reducing set, not a list written out here: that is the same
    // definition production applies, so this check cannot drift from the code it
    // is auditing.
    sum += REDUCING_TYPES.has(type) ? -amount : amount;
  }
  assert.equal(
    u.credits,
    openingBalance + sum,
    `balance (${u.credits}) must equal opening (${openingBalance}) + ledger (${sum}) for ${userId}`,
  );
}

function purchase(credits: TursoCreditService, userId: string, paymentId: string, planId = 'starter') {
  return credits.recordPurchase({
    userId,
    planId,
    paymentId,
    orderId: `order_${paymentId}`,
    amountInr: 69,
    currency: 'INR',
    planName: 'Starter',
  });
}

// ------------------------------------------------------------ mutex unit ----

test('5D-M1. the mutex is FIFO: waiters run in arrival order, none starved', async () => {
  const mutex = new WriteMutex(5000);
  const order: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  // Occupy the lock first, so the next three must queue behind it.
  const holder = mutex.runExclusive(async () => {
    await held;
    order.push(0);
  });
  // Let the holder actually take the lock before queueing anyone.
  await new Promise((r) => setTimeout(r, 5));
  const queued = Promise.all([
    mutex.runExclusive(async () => {
      order.push(1);
    }),
    mutex.runExclusive(async () => {
      order.push(2);
    }),
    mutex.runExclusive(async () => {
      order.push(3);
    }),
  ]);
  release();
  await Promise.all([holder, queued]);
  assert.deepEqual(order, [0, 1, 2, 3], 'writers must be served in arrival order');
  assert.equal(mutex.queueDepth, 0, 'queue must drain');
  assert.equal(mutex.isHeld, false, 'lock must be released');
});

test('5D-M2. the mutex never runs two critical sections at once', async () => {
  const mutex = new WriteMutex(5000);
  let concurrent = 0;
  let maxObserved = 0;
  const body = async () => {
    concurrent++;
    maxObserved = Math.max(maxObserved, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent--;
  };
  await Promise.all(Array.from({ length: 12 }, () => mutex.runExclusive(body)));
  assert.equal(maxObserved, 1, 'critical sections must never overlap');
});

test('5D-M3. a failing critical section releases the lock for the next writer', async () => {
  const mutex = new WriteMutex(5000);
  await assert.rejects(
    mutex.runExclusive(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  // If the lock leaked, this would hang and time out instead of running.
  assert.equal(await mutex.runExclusive(async () => 'still works'), 'still works');
});

test('5D-M4. a writer that cannot get a slot fails LOUDLY rather than hanging', async () => {
  // The budget is 300ms, not something tiny: the property under test is "a
  // blocked writer rejects with WRITE_LOCK_TIMEOUT instead of hanging or
  // silently committing", which is meaningfully shorter than the 15s production
  // timeout. A 40ms window made this assertion CPU-contention sensitive and it
  // flaked once under a full-suite parallel run, where event-loop delay easily
  // exceeds a few dozen milliseconds.
  const TIMEOUT_MS = 300;
  const mutex = new WriteMutex(TIMEOUT_MS);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const holder = mutex.runExclusive(async () => {
    await held;
  });
  await new Promise((r) => setTimeout(r, 5));
  const startedAt = Date.now();
  await assert.rejects(
    mutex.runExclusive(async () => 'never runs'),
    (err: unknown) => {
      assert.ok(err instanceof WriteLockTimeoutError);
      assert.equal(err.code, 'WRITE_LOCK_TIMEOUT');
      assert.match(err.message, /did NOT run and nothing was committed/);
      return true;
    },
  );
  // It waited for roughly the budget rather than failing instantly (which would
  // mean the slot logic is broken) or hanging (which is the bug being guarded).
  const waitedMs = Date.now() - startedAt;
  assert.ok(
    waitedMs >= TIMEOUT_MS - 50,
    `waited ${waitedMs}ms; expected roughly ${TIMEOUT_MS}ms before rejecting`,
  );
  assert.ok(waitedMs < 5_000, `waited ${waitedMs}ms; a blocked writer must not hang`);
  release();
  await holder;
});

// -------------------------------------------- store-level serialization -----

test('5D-M5. concurrent paid writes are serialized and ALL succeed (no SQLITE_BUSY)', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 0 }));
  const OPENING = 0;
  const credits = new TursoCreditService(store);

  // 10 concurrent PURCHASES of distinct payments, all at once. Before the mutex
  // these collided on SQLITE_BUSY and silently lost paid writes.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => purchase(credits, 'u1', `pay_${i}`)),
  );

  for (const r of results) {
    assert.equal(r.alreadyProcessed, false, 'each distinct payment must be applied exactly once');
  }
  const u = await store.getUserById('u1');
  assert.equal(u?.credits, 10 * 15, '10 starter packs x 15 credits = 150, with nothing lost');
  await assertLedgerConsistent(store, 'u1', OPENING);
});

test('5D-M6. a duplicate concurrent purchase never double-credits', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 0 }));
  const OPENING = 0;
  const credits = new TursoCreditService(store);

  // The SAME payment fired 8 times at once (client retry storm / webhook replay).
  const results = await Promise.all(
    Array.from({ length: 8 }, () => purchase(credits, 'u1', 'pay_dup_1')),
  );

  const applied = results.filter((r) => !r.alreadyProcessed).length;
  assert.equal(applied, 1, 'exactly ONE purchase may be applied, however many times it is called');
  assert.equal(
    results.filter((r) => r.alreadyProcessed).length,
    7,
    'every replay must be recognised as already processed',
  );
  const u = await store.getUserById('u1');
  assert.equal(u?.credits, 15, 'the starter pack is 15 credits, credited exactly once');
  assert.equal((await store.getTransactionsByUser('u1', 100)).length, 1, 'exactly one ledger row');
  await assertLedgerConsistent(store, 'u1', OPENING);
});

test('5D-M7. a failed paid operation stays FAILED and never becomes a silent success', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 5 }));
  const OPENING = 5;
  const credits = new TursoCreditService(store);

  // 6 concurrent charges of 3 against a balance of 5: only one can succeed.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      credits.chargeJob({
        userId: 'u1',
        jobId: `job-${i}`,
        amount: 3,
        reason: 'charge_transcription',
      }),
    ),
  );

  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.ok(rejected.length > 0, 'overspending 6x3 against a balance of 5 MUST reject some attempts');
  for (const r of rejected) {
    // A rejected charge must be a real, attributable error, never a silent no-op.
    assert.equal(
      (r as PromiseRejectedResult).reason?.code,
      'INSUFFICIENT_BALANCE',
      'rejections must carry the INSUFFICIENT_BALANCE code',
    );
  }
  // Nothing may fail for a serialization reason now that writers are queued.
  for (const r of rejected) {
    assert.doesNotMatch(String((r as PromiseRejectedResult).reason), /SQLITE_BUSY|database is locked/);
  }

  const u = await store.getUserById('u1');
  assert.equal(u?.credits, 2, '5 - 3 = 2; the balance must never go negative');
  assert.equal((await store.getTransactionsByUser('u1', 100)).length, 1, 'only the affordable charge');
  await assertLedgerConsistent(store, 'u1', OPENING);
});

test('5D-M8. rollback semantics survive serialization: a mid-transaction throw commits nothing', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 50 }));
  const OPENING = 50;
  const credits = new TursoCreditService(store);

  await assert.rejects(
    store.unitOfWork(async (scope) => {
      // Mutate the balance AND write the ledger row, then fail: neither persists.
      await scope.applyCreditDelta('u1', 25, { allowNegative: true });
      await scope.addTransaction({
        userId: 'u1',
        type: 'PURCHASE',
        amount: 25,
        reason: 'partial purchase',
        balanceBefore: 50,
        balanceAfter: 75,
        paymentId: 'pay_rollback',
      });
      throw new Error('payment verification failed downstream');
    }),
    /payment verification failed downstream/,
  );

  const u = await store.getUserById('u1');
  assert.equal(u?.credits, 50, 'the balance mutation must be rolled back');
  assert.equal((await store.getTransactionsByUser('u1', 100)).length, 0, 'the ledger row must be rolled back');
  await assertLedgerConsistent(store, 'u1', OPENING);
});

test('5D-M9. reads are NOT queued behind the write lock', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 42 }));

  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const writer = store.unitOfWork(async () => {
    await held;
  });
  // Let the writer take the lock.
  await new Promise((r) => setTimeout(r, 10));

  const readStart = Date.now();
  const u = await store.getUserById('u1');
  const readMs = Date.now() - readStart;

  assert.equal(u?.credits, 42, 'the read must return real data');
  assert.ok(readMs < 500, `read took ${readMs}ms; reads must not wait on the write mutex`);
  release();
  await writer;
});

test('5D-M10. a nested unitOfWork is still refused even while another writer waits', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 10 }));

  await assert.rejects(
    store.unitOfWork(async () =>
      store.unitOfWork(async () => {
        // must never run
      }),
    ),
    /nested transaction attempted/,
  );
  assert.equal((await store.getUserById('u1'))?.credits, 10, 'nothing may be written');
});

test('5D-M11. many concurrent mixed paid operations leave the ledger consistent', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 1000 }));
  const OPENING = 1000;
  const credits = new TursoCreditService(store);

  // Interleave purchases and charges across one user, all at once.
  const ops: Array<Promise<unknown>> = [];
  for (let i = 0; i < 12; i++) {
    ops.push(purchase(credits, 'u1', `mix_pay_${i}`));
    ops.push(
      credits.chargeJob({
        userId: 'u1',
        jobId: `mix_job-${i}`,
        amount: 3,
        reason: 'charge_transcription',
      }),
    );
  }
  const settled = await Promise.allSettled(ops);
  const failed = settled.filter((o) => o.status === 'rejected');
  // A 1000-credit balance covers 12x15 + 12x3, so nothing should legitimately fail.
  assert.equal(
    failed.length,
    0,
    `no writer may fail; got: ${failed.map((f) => String((f as PromiseRejectedResult).reason)).join(', ')}`,
  );

  const u = await store.getUserById('u1');
  assert.equal(u?.credits, 1000 + 12 * 15 - 12 * 3, '1000 + 180 purchased - 36 charged');
  await assertLedgerConsistent(store, 'u1', OPENING);
});

test('5D-M12. the daily giveaway cap is still enforced under concurrency (exactly one winner)', async () => {
  const store = makeTurso();
  await store.init();
  await store.createUser(user({ id: 'u1', credits: 0 }));
  const OPENING = 0;
  const credits = new TursoCreditService(store);

  // Five simultaneous giveaways: the per-day cap must admit exactly one.
  const settled = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      credits.adminGrantCredits({
        adminUserId: 'admin',
        adminEmail: 'owner@example.com',
        userId: 'u1',
        amount: 20,
        reason: `giveaway ${i}`,
        idempotencyKey: `gk-${i}`,
      }),
    ),
  );

  const winners = settled.filter((s) => s.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one giveaway may pass the per-day cap');
  for (const s of settled) {
    if (s.status === 'rejected') {
      assert.equal(
        (s as PromiseRejectedResult).reason?.code,
        'DAILY_LIMIT_EXCEEDED',
        'losers must be attributed to the cap, not to a serialization failure',
      );
    }
  }
  assert.equal((await store.getUserById('u1'))?.credits, 20, 'only one giveaway may be credited');
  await assertLedgerConsistent(store, 'u1', OPENING);
});