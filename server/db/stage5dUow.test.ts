/**
 * Stage 5D — transaction-scoped Unit of Work, credit atomicity, idempotency and
 * provider-safety parity.
 *
 * All Turso work runs against a real SQLite engine through @libsql/client. The
 * databases are FILE-backed in a temp directory, never `file::memory:`, because
 * @libsql/client hands the client a fresh connection once a transaction starts
 * and an in-memory database is per-connection (the same reason
 * `tursoStore.test.ts` file-backs its transaction tests). These tests never
 * connect to Turso, never read credentials, and never touch data/app.db.json or
 * data/storage/.
 *
 * The JSON half runs against temporary directories, so the reference behaviour and
 * the new Turso behaviour can be compared in the same test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TursoStore } from './tursoStore.ts';
import type { UnitOfWork } from './dataStore.ts';
import { defaultProviderSafety } from './tursoScope.ts';
import { CreditRepo, ProviderSafetyRepo, UserRepo } from './repos.ts';
import { DataStore } from './store.ts';
import { TursoCreditService } from '../services/tursoCreditService.ts';
import { FileCreditService, CreditError } from '../services/creditService.ts';
import type { UserRecord } from './types.ts';

// ------------------------------------------------------------------ helpers ---

/** File-backed store: transactions need a connection-stable database. */
function makeTurso(): TursoStore {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-turso-'));
  return new TursoStore(createClient({ url: `file:${join(dir, 'app.db')}` }));
}

function makeJson(): { store: DataStore; users: UserRepo; credits: CreditRepo } {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-json-'));
  const store = new DataStore(join(dir, 'app.db.json'));
  return { store, users: new UserRepo(store), credits: new CreditRepo(store) };
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

async function seed(store: TursoStore, ...users: UserRecord[]): Promise<void> {
  for (const u of users) await store.createUser(u);
}

/** Insert JSON users with fixed ids (UserRepo mints its own ids). */
function seedJson(store: DataStore, ...users: UserRecord[]): void {
  store.mutate((db) => {
    for (const u of users) db.users.push(u);
  });
}

async function balance(store: TursoStore, id: string): Promise<number> {
  return (await store.getUserById(id))?.credits ?? 0;
}

async function ledger(store: TursoStore): Promise<Array<Record<string, unknown>>> {
  return (await store.getTransactions()) as unknown as Array<Record<string, unknown>>;
}

// =========================================================== PART 1: the UOW ===

test('5D-1. a successful unitOfWork commits', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  const result = await store.unitOfWork(async (scope) => {
    const delta = await scope.applyCreditDelta('u1', -10, { allowNegative: false });
    assert.equal(delta.status, 'ok');
    const txn = await scope.addTransaction({
      userId: 'u1',
      type: 'DEBIT',
      amount: 10,
      reason: 'charge',
      jobId: 'job-1',
      balanceBefore: 100,
      balanceAfter: 90,
    } as never);
    return txn.id;
  });

  assert.ok(typeof result === 'string' && result.length > 0);
  assert.equal(await balance(store, 'u1'), 90, 'balance persisted after commit');
  assert.equal((await ledger(store)).length, 1, 'ledger row persisted in the same transaction');
});

test('5D-2. a throwing unitOfWork rolls back BOTH writes and rethrows the original error', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  const boom = new Error('boom');
  await assert.rejects(
    store.unitOfWork(async (scope) => {
      await scope.applyCreditDelta('u1', -40, { allowNegative: false });
      await scope.addTransaction({
        userId: 'u1',
        type: 'DEBIT',
        amount: 40,
        reason: 'charge',
        jobId: 'job-2',
        balanceBefore: 100,
        balanceAfter: 60,
      } as never);
      throw boom;
    }),
    (err: unknown) => err === boom,
    'the ORIGINAL error instance must propagate'
  );

  assert.equal(await balance(store, 'u1'), 100, 'balance rolled back');
  assert.equal((await ledger(store)).length, 0, 'ledger row rolled back with it');
});

test('5D-3. a rejected promise also rolls back (async failure, not just a throw)', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  await assert.rejects(
    store.unitOfWork(async (scope) => {
      await scope.applyCreditDelta('u1', -25, { allowNegative: false });
      return Promise.reject(new Error('async boom'));
    }),
    /async boom/
  );
  assert.equal(await balance(store, 'u1'), 100);
});

test('5D-4. a nested unitOfWork is rejected instead of silently committing early', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  await assert.rejects(
    store.unitOfWork(async (outer) => {
      await outer.applyCreditDelta('u1', -5, { allowNegative: false });
      // Accidental nesting must fail loudly, not open a second transaction.
      await store.unitOfWork(async (inner) => {
        await inner.applyCreditDelta('u1', -5, { allowNegative: false });
      });
    }),
    /nested transaction/i
  );

  assert.equal(await balance(store, 'u1'), 100, 'the outer transaction rolled back too');
});

test('5D-5. the scope exposes no commit/rollback/client, so logic cannot end the transaction', async () => {
  const store = makeTurso();
  await store.init();

  await store.unitOfWork(async (scope) => {
    const s = scope as unknown as Record<string, unknown>;
    assert.equal(s.commit, undefined, 'no commit on the scope');
    assert.equal(s.rollback, undefined, 'no rollback on the scope');
    assert.equal(s.client, undefined, 'no raw libSQL client');
    assert.equal(s.db, undefined, 'no raw libSQL db handle');
    // A nested `transaction` exists only to satisfy the UnitOfWork contract, and
    // it hands out another scope rather than the handle. Inside an open
    // transaction it must refuse outright (proved behaviourally in 5D-26).
    assert.equal(typeof s.transaction, 'function');
    assert.equal((s as { begin?: unknown }).begin, undefined, 'no way to open a transaction');
  });
});

// ============================================ PART 2/3: atomicity + idempotency ===

test('5D-6. applyCreditDelta returns a consistent before/after pair from ONE statement', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  const res = await store.unitOfWork((scope) =>
    scope.applyCreditDelta('u1', -30, { allowNegative: false })
  );
  assert.equal(res.status, 'ok');
  if (res.status === 'ok') {
    assert.equal(res.balanceBefore, 100);
    assert.equal(res.balanceAfter, 70);
  }
  assert.equal(await balance(store, 'u1'), 70);
});

test('5D-7. the non-negative guard is enforced by SQL, so no compensation write is needed', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 5 }));

  const res = await store.unitOfWork((scope) =>
    scope.applyCreditDelta('u1', -10, { allowNegative: false })
  );
  assert.equal(res.status, 'insufficient');
  if (res.status === 'insufficient') assert.equal(res.balance, 5);
  assert.equal(await balance(store, 'u1'), 5, 'balance untouched, never negative');
});

test('5D-8. an unknown user is reported distinctly from an insufficient balance', async () => {
  const store = makeTurso();
  await store.init();
  const res = await store.unitOfWork((scope) =>
    scope.applyCreditDelta('ghost', -1, { allowNegative: false })
  );
  assert.equal(res.status, 'no_user');
});

test('5D-9. CONCURRENT charges cannot overdraw: exactly one succeeds, balance never negative', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 10 })); // two jobs, each costing 10

  // This is the exact body of TursoCreditService.chargeJob's transaction.
  const attempt = (jobId: string) =>
    store
      .unitOfWork(async (scope) => {
        if (await scope.getTransactionByJobAndType('u1', jobId, 'DEBIT')) return 'duplicate';
        const delta = await scope.applyCreditDelta('u1', -10, { allowNegative: false });
        if (delta.status !== 'ok') return 'rejected';
        await scope.addTransaction({
          userId: 'u1',
          type: 'DEBIT',
          amount: 10,
          reason: 'charge',
          jobId,
          balanceBefore: delta.balanceBefore,
          balanceAfter: delta.balanceAfter,
        } as never);
        return 'charged';
      })
      .catch(() => 'error');

  const results = await Promise.all([attempt('job-a'), attempt('job-b')]);
  assert.equal(
    results.filter((r) => r === 'charged').length,
    1,
    `exactly one charge may succeed, got ${JSON.stringify(results)}`
  );
  assert.equal(await balance(store, 'u1'), 0, 'balance lands on zero, never below');
  assert.equal((await ledger(store)).length, 1, 'exactly one DEBIT row exists');
});

test('5D-10. concurrent charges for the SAME job never produce two ledger rows', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  const attempt = () =>
    store.unitOfWork(async (scope) => {
      const existing = await scope.getTransactionByJobAndType('u1', 'same-job', 'DEBIT');
      if (existing) return 'duplicate';
      const delta = await scope.applyCreditDelta('u1', -20, { allowNegative: false });
      if (delta.status !== 'ok') return 'rejected';
      await scope.addTransaction({
        userId: 'u1',
        type: 'DEBIT',
        amount: 20,
        reason: 'charge',
        jobId: 'same-job',
        balanceBefore: delta.balanceBefore,
        balanceAfter: delta.balanceAfter,
      } as never);
      return 'charged';
    });

  // The embedded driver cannot queue concurrent write transactions (see 5D-25),
  // so a SQLITE_BUSY here is a legitimate outcome. The invariant under test is
  // the one that matters for money: AT MOST ONE charge is ever applied.
  const settled = await Promise.allSettled([attempt(), attempt(), attempt()]);
  const outcomes = settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : /SQLITE_BUSY/.test(String((r.reason as Error)?.message))
        ? 'busy'
        : 'error'
  );

  assert.equal(outcomes.filter((o) => o === 'charged').length, 1, `one charge only: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.filter((o) => o === 'error').length, 0, 'no unexpected failure');
  assert.equal((await ledger(store)).length, 1, 'exactly one DEBIT row exists');
  assert.equal(await balance(store, 'u1'), 80, 'debited exactly once, never twice');
});

test('5D-11. repeated retries of ONE paymentId credit exactly once', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 0, email: 'buyer@example.com' }));

  // The body of TursoCreditService.recordPurchase's transaction. (recordPurchase
  // itself cannot be exercised end to end because creditPolicy.getPlanById
  // references an undefined CREDIT_PLANS — a pre-existing break in BOTH
  // providers, reported in Stage 5D. What this test pins is the idempotency
  // mechanism the purchase path depends on.)
  const attempt = () =>
    store.unitOfWork(async (scope) => {
      const existing = await scope.getTransactionByPaymentId('pay_dup_1');
      if (existing) return 'already';
      const delta = await scope.applyCreditDelta('u1', 50, { allowNegative: true });
      if (delta.status !== 'ok') return 'rejected';
      await scope.addTransaction({
        userId: 'u1',
        type: 'PURCHASE',
        amount: 50,
        reason: 'purchase',
        paymentId: 'pay_dup_1',
        balanceBefore: delta.balanceBefore,
        balanceAfter: delta.balanceAfter,
      } as never);
      return 'applied';
    });

  // Sequential retries are what a redelivered gateway webhook actually looks
  // like, and each must be a no-op after the first.
  assert.equal(await attempt(), 'applied', 'the first delivery grants the credits');
  assert.equal(await attempt(), 'already');
  assert.equal(await attempt(), 'already');

  assert.equal((await ledger(store)).filter((t) => t.paymentId === 'pay_dup_1').length, 1);
  assert.equal(await balance(store, 'u1'), 50, 'credited exactly once');

  // Concurrent duplicates must also apply at most once.
  const race = await Promise.allSettled([attempt(), attempt(), attempt()]);
  const applied = race.filter((r) => r.status === 'fulfilled' && r.value === 'applied').length;
  assert.equal(applied, 0, 'a redelivery never grants again');
  assert.equal(await balance(store, 'u1'), 50, 'still credited exactly once');
});

test('5D-12. the admin idempotencyKey is honoured, and the daily giveaway cap is atomic', async () => {
  const store = makeTurso();
  await store.init();
  await seed(
    store,
    user({ id: 'admin', credits: 0, role: 'ADMIN', ownerEmail: 'owner@example.com' }),
    user({ id: 'target', credits: 0, email: 'target@example.com' })
  );
  const svc = new TursoCreditService(store);

  const grant = (key: string) =>
    svc.adminAdjustCredits({
      userId: 'target',
      amount: 100,
      reason: 'giveaway',
      adminUserId: 'admin',
      idempotencyKey: key,
    });

  const a = await grant('giveaway-key-1');
  const b = await grant('giveaway-key-1');
  assert.equal(a.applied, true, 'first grant applies');
  assert.equal(b.applied, false, 'a replayed key does not apply again');
  assert.equal(b.transaction.id, a.transaction.id, 'the replay returns the ORIGINAL transaction');
  assert.equal(await balance(store, 'target'), 100, 'credited exactly once');

  // A DIFFERENT key on the same IST day must still be refused by the daily cap.
  await assert.rejects(
    grant('giveaway-key-2'),
    (err: unknown) => err instanceof CreditError && err.code === 'DAILY_LIMIT_EXCEEDED'
  );
  assert.equal(await balance(store, 'target'), 100, 'the daily cap held');
});

test('5D-13. free-trial increments are atomic and never under-count', async () => {
  const store = makeTurso();
  await store.init();
  await seed(store, user({ freeTrialsUsed: 0 }));
  const svc = new TursoCreditService(store);

  // Sequential: the counter must advance exactly once per success.
  assert.equal(await svc.incrementFreeTrialsUsed('u1'), 1);
  assert.equal(await svc.incrementFreeTrialsUsed('u1'), 2);
  assert.equal((await store.getUserById('u1'))?.freeTrialsUsed, 2);

  // Concurrent: an atomic UPDATE ... RETURNING means no increment is ever lost,
  // and none is ever double-applied, whichever way the driver resolves them.
  const race = await Promise.allSettled([
    svc.incrementFreeTrialsUsed('u1'),
    svc.incrementFreeTrialsUsed('u1'),
    svc.incrementFreeTrialsUsed('u1'),
  ]);
  const succeeded = race.filter((r) => r.status === 'fulfilled').length;
  const after = (await store.getUserById('u1'))?.freeTrialsUsed ?? 0;
  assert.equal(after, 2 + succeeded, 'the counter equals 2 + the number that succeeded');
  assert.ok(after >= 2, 'the counter never went backwards');
});

test('5D-14. registration writes the user and its opening ledger row atomically', async () => {
  const store = makeTurso();
  await store.init();
  const svc = new TursoCreditService(store);

  const txn = await svc.registerUserWithCredits(
    user({ id: 'newbie', credits: 20, email: 'n@example.com' }),
    {
      userId: 'newbie',
      type: 'CREDIT',
      amount: 20,
      reason: 'signup_bonus',
      balanceBefore: 0,
      balanceAfter: 20,
    } as never
  );

  assert.ok(txn.id);
  assert.equal(await balance(store, 'newbie'), 20);
  assert.equal((await ledger(store)).length, 1, 'the FK-backed ledger row landed with the user');
});

test('5D-15. a failure during registration leaves NEITHER the user nor the ledger row', async () => {
  const store = makeTurso();
  await store.init();

  await assert.rejects(
    store.unitOfWork(async (scope) => {
      await scope.createUser(user({ id: 'doomed', email: 'd@example.com' }));
      await scope.addTransaction({
        userId: 'doomed',
        type: 'CREDIT',
        amount: 20,
        reason: 'signup_bonus',
        balanceBefore: 0,
        balanceAfter: 20,
      } as never);
      throw new Error('after both writes');
    }),
    /after both writes/
  );

  assert.equal(await store.getUserById('doomed'), null, 'the user insert rolled back');
  assert.equal((await ledger(store)).length, 0, 'the ledger insert rolled back');
});

// ===================================================== PART 4: provider safety ===

test('5D-16. Turso synthesises the SAME AVAILABLE default as the JSON store', async () => {
  const store = makeTurso();
  await store.init();
  const scope = store.rootScope();

  const turso = await scope.getProviderSafety('sarvam');
  assert.equal(turso.status, 'AVAILABLE', 'a never-written provider reads AVAILABLE, not null');
  assert.equal(turso.balance.known, false, 'we never invent a balance');
  assert.equal(turso.consecutiveFailures, 0);
  assert.equal(turso.provider, 'sarvam');

  const { store: json } = makeJson();
  await json.init();
  const jsonRecord = new ProviderSafetyRepo(json).get('sarvam');
  assert.deepEqual(turso, jsonRecord, 'the Turso default is identical to the JSON default');
  assert.deepEqual(turso, defaultProviderSafety('sarvam'));
});

test('5D-17. a real provider-safety state round-trips through the scope', async () => {
  const store = makeTurso();
  await store.init();
  const scope = store.rootScope();

  const blocked = await scope.patchProviderSafety('sarvam', {
    status: 'BLOCKED',
    reason: 'KILL_SWITCH',
    lastError: 'provider said no',
  } as never);
  assert.equal(blocked.status, 'BLOCKED');

  const reread = await scope.getProviderSafety('sarvam');
  assert.equal(reread.status, 'BLOCKED', 'state persisted');
  assert.equal(reread.reason, 'KILL_SWITCH');
  assert.equal(reread.lastError, 'provider said no');
});

// ============================== PART 5: JSON behaviour must be unchanged ========

test('5D-18. JSON credit service: charge once, never negative, refund once', async () => {
  const { store, users, credits } = makeJson();
  await store.init();
  seedJson(store, user({ credits: 100 }));
  const svc = new FileCreditService(users, credits);

  assert.equal(svc.chargeJob({ userId: 'u1', jobId: 'j1', amount: 30, reason: 'charge' }).charged, true);
  assert.equal(
    svc.chargeJob({ userId: 'u1', jobId: 'j1', amount: 30, reason: 'charge' }).charged,
    false,
    'a job is charged at most once'
  );
  assert.equal(users.getById('u1')!.credits, 70);

  assert.throws(
    () => svc.chargeJob({ userId: 'u1', jobId: 'j2', amount: 1000, reason: 'charge' }),
    (e: unknown) => e instanceof CreditError && e.code === 'INSUFFICIENT_BALANCE'
  );
  assert.equal(users.getById('u1')!.credits, 70, 'a refused charge leaves no trace');

  assert.ok(svc.refundFinishedJob('u1', 'j1', 'done'));
  assert.equal(users.getById('u1')!.credits, 100);
  assert.equal(svc.refundFinishedJob('u1', 'j1', 'done'), null, 'never refunded twice');
  assert.equal(svc.refundFinishedJob('u1', 'never-charged', 'x'), null, 'no refund without a charge');
});

test('5D-19. JSON reservation -> settle -> release semantics are unchanged', async () => {
  const { store, users, credits } = makeJson();
  await store.init();
  seedJson(store, user({ credits: 100 }));
  const svc = new FileCreditService(users, credits);

  assert.equal(svc.reserveJob({ userId: 'u1', jobId: 'r1', amount: 40, reason: 'r' }).charged, true);
  assert.equal(users.getById('u1')!.credits, 60, 'a reservation blocks the credits');
  assert.equal(svc.reserveJob({ userId: 'u1', jobId: 'r1', amount: 40, reason: 'r' }).charged, false);

  const settled = svc.settleJobReservation('u1', 'r1', 'used');
  assert.ok(settled, 'settled once');
  assert.equal(
    svc.settleJobReservation('u1', 'r1', 'used')!.transaction.id,
    settled.transaction.id,
    'settling twice returns the original'
  );
  assert.equal(users.getById('u1')!.credits, 60, 'USAGE does not move the balance again');
  assert.equal(svc.releaseJobReservation('u1', 'r1', 'release'), null, 'consumed is never released');
});

test('5D-20. JSON release returns the blocked credits exactly once', async () => {
  const { store, users, credits } = makeJson();
  await store.init();
  seedJson(store, user({ credits: 100 }));
  const svc = new FileCreditService(users, credits);

  svc.reserveJob({ userId: 'u1', jobId: 'r2', amount: 40, reason: 'r' });
  assert.equal(users.getById('u1')!.credits, 60);
  assert.ok(svc.releaseJobReservation('u1', 'r2', 'released'));
  assert.equal(users.getById('u1')!.credits, 100, 'the credits came back');
  assert.equal(svc.releaseJobReservation('u1', 'r2', 'released'), null, 'never released twice');
});

test('5D-21. JSON giveaway idempotency is unchanged', async () => {
  const { store, users, credits } = makeJson();
  await store.init();
  seedJson(
    store,
    user({ id: 'admin', credits: 0, role: 'ADMIN', ownerEmail: 'o@example.com' }),
    user({ id: 'target', credits: 0 })
  );
  const svc = new FileCreditService(users, credits);

  const grant = () =>
    svc.adminAdjustCredits({
      userId: 'target',
      amount: 50,
      reason: 'promo',
      adminUserId: 'admin',
      idempotencyKey: 'promo-1',
    });

  assert.equal(grant().applied, true);
  const replay = grant();
  assert.equal(replay.applied, false, 'a replayed key does not re-apply');
  assert.equal(users.getById('target')!.credits, 50, 'credited exactly once');
  assert.equal(credits.listAll().filter((t) => t.idempotencyKey === 'promo-1').length, 1);
});

test('5D-22. a REFUSED admin debit writes neither a ledger row nor a balance change', async () => {
  const { store, users, credits } = makeJson();
  await store.init();
  seedJson(
    store,
    user({ id: 'admin', credits: 0, role: 'ADMIN', ownerEmail: 'o@example.com' }),
    user({ id: 'target', credits: 10 })
  );
  const svc = new FileCreditService(users, credits);

  assert.throws(
    () =>
      svc.adminDebitCredits({
        userId: 'target',
        amount: 999,
        reason: 'oops',
        adminUserId: 'admin',
        idempotencyKey: 'bad-1',
      }),
    (e: unknown) => e instanceof CreditError && e.code === 'INSUFFICIENT_BALANCE'
  );
  assert.equal(users.getById('target')!.credits, 10, 'balance untouched');
  assert.equal(credits.listAll().length, 0, 'no ledger row from a refused operation');

  // The key is still unused, so a later valid debit with the same key applies.
  const ok = svc.adminDebitCredits({
    userId: 'target',
    amount: 5,
    reason: 'ok',
    adminUserId: 'admin',
    idempotencyKey: 'bad-1',
  });
  assert.equal(ok.applied, true);
  assert.equal(users.getById('target')!.credits, 5);
});

test('5D-23. Turso and JSON agree on the resulting balance for the same charge', async () => {
  const { store: jStore, users: jUsers, credits: jCredits } = makeJson();
  await jStore.init();
  seedJson(jStore, user({ credits: 100 }));
  new FileCreditService(jUsers, jCredits).chargeJob({
    userId: 'u1',
    jobId: 'same',
    amount: 35,
    reason: 'charge',
  });

  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));
  await new TursoCreditService(store).chargeJob({
    userId: 'u1',
    jobId: 'same',
    amount: 35,
    reason: 'charge',
  });

  assert.equal(await balance(store, 'u1'), jUsers.getById('u1')!.credits, 'same final balance');
  assert.equal(
    (await ledger(store)).length,
    jCredits.listAll().length,
    'same number of ledger rows'
  );
});

test('5D-24. UNLIMITED accounts are bypassed identically on both providers', async () => {
  const { store: jStore, users: jUsers, credits: jCredits } = makeJson();
  await jStore.init();
  seedJson(jStore, user({ credits: 0, creditMode: 'UNLIMITED' }));
  const jsonRes = new FileCreditService(jUsers, jCredits).chargeJob({
    userId: 'u1',
    jobId: 'u',
    amount: 10,
    reason: 'charge',
  });

  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 0, creditMode: 'UNLIMITED' }));
  const tursoRes = await new TursoCreditService(store).chargeJob({
    userId: 'u1',
    jobId: 'u',
    amount: 10,
    reason: 'charge',
  });

  assert.equal(jsonRes.unlimited, true);
  assert.equal(tursoRes.unlimited, true);
  assert.equal(jsonRes.transaction, null, 'no sentinel transaction on JSON');
  assert.equal(tursoRes.transaction, null, 'no sentinel transaction on Turso');
  assert.equal(jCredits.listAll().length, 0);
  assert.equal((await ledger(store)).length, 0);
});
test('5D-25. PINNED LIMITATION: the embedded driver refuses concurrent write transactions', async () => {
  // @libsql/client's sqlite3 backend drops its connection when `transaction()`
  // begins and exposes no busy_timeout knob, so a second concurrent writer gets
  // SQLITE_BUSY immediately instead of queueing. This is SAFE (the loser rolls
  // back having written nothing) but it means the embedded `file:` driver cannot
  // serialise writes for us. Pinned here so a future driver upgrade that changes
  // the behaviour is noticed rather than silently assumed.
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));

  const write = () =>
    store.unitOfWork(async (scope) => {
      await scope.applyCreditDelta('u1', -1, { allowNegative: false });
    });

  const results = await Promise.allSettled([write(), write(), write()]);
  const busy = results.filter(
    (r) => r.status === 'rejected' && /SQLITE_BUSY/.test(String((r.reason as Error)?.message))
  ).length;
  const ok = results.filter((r) => r.status === 'fulfilled').length;

  assert.equal(ok + busy, 3, 'every attempt either committed or reported SQLITE_BUSY');
  assert.ok(ok >= 1, 'at least one write gets through');
  // Critically: no partial state. Balance must equal 100 minus committed writes.
  assert.equal(await balance(store, 'u1'), 100 - ok, 'no partial or double-applied write');
  assert.equal((await ledger(store)).length, 0);
});

test('5D-26. the declared UnitOfWork contract is satisfied, and nesting is refused', async () => {
  // Compile-time proof: assigning to UnitOfWork<TursoScope> fails to typecheck if
  // TursoScope stops implementing the contract in server/db/dataStore.ts.
  const store = makeTurso();
  await store.init();
  await seed(store, user({ credits: 100 }));
  const uow: UnitOfWork<TursoScope> = store.rootScope();

  const committed = await uow.transaction(async (scoped) => {
    const d = await scoped.applyCreditDelta('u1', -5, { allowNegative: false });
    return d.status;
  });
  assert.equal(committed, 'ok');
  assert.equal(await balance(store, 'u1'), 95);

  // A scope already inside a transaction must refuse to open a nested one.
  await assert.rejects(
    store.unitOfWork(async (scoped) => {
      await scoped.transaction(async () => undefined);
    }),
    /only available on the root scope|already inside a transaction/
  );
  assert.equal(await balance(store, 'u1'), 95, 'the refused nesting changed nothing');
});
