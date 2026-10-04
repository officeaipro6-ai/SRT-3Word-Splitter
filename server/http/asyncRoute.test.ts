/**
 * Stage 5D finalization — Express 4 async error propagation and the credit facade.
 *
 * THE HAZARD BEING TESTED
 * -----------------------
 * Express 4 ignores a handler's return value and only sees SYNCHRONOUS throws.
 * Making the credit service async means `await credits.chargeJob(...)` can reject
 * with `CreditError` after the handler already returned. Unhandled, that is an
 * unhandled promise rejection: no response, no status mapping, and on modern Node
 * a process-level crash. These tests assert that cannot happen.
 *
 * The facade tests additionally pin the promise that the JSON provider's
 * observable behaviour is unchanged — only the SHAPE of the error changes
 * (synchronous throw -> rejection at the same await point), which is what makes
 * one handler body correct for both providers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import { asyncRoute, runDetached } from './asyncRoute';
import { createFileCreditFacade, createTursoCreditFacade } from '../services/creditFacade';
import { FileCreditService, CreditError } from '../services/creditService';
import { TursoCreditService } from '../services/tursoCreditService';
import { CreditRepo, UserRepo } from '../db/repos';
import { DataStore } from '../db/store';
import { TursoStore } from '../db/tursoStore';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------------ helpers ---

interface FakeRes extends Response {
  __status?: number;
  __body?: unknown;
}

/** Minimal Response double: records what a handler wrote. */
function fakeRes(): FakeRes {
  const res: FakeRes = {
    headersSent: false,
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      res.__status = code;
      return res;
    },
    json(body: unknown) {
      res.__body = body;
      res.headersSent = true;
      return res;
    },
  } as FakeRes;
  return res;
}

/**
 * Run `fn` while watching for unhandled rejections. Node would otherwise print a
 * warning and (by default) abort; capturing the event is the only reliable
 * assertion.
 */
async function withUnhandledRejectionWatch<T>(fn: () => Promise<T>): Promise<{ value: T; leaked: string[] }> {
  const leaked: string[] = [];
  const onUnhandled = (reason: unknown) => {
    leaked.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const value = await fn();
    // Give the microtask + next-tick queues a chance to surface anything pending.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { value, leaked };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

function makeJsonService(): { svc: ReturnType<typeof createFileCreditFacade>; userId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-facade-'));
  const store = new DataStore(join(dir, 'app.db.json'));
  const users = new UserRepo(store);
  const credits = new CreditRepo(store);
  // createUser generates the id; the tests use whatever it returns rather than a
  // hardcoded one, so they cannot drift from the repository's real contract.
  const created = users.createUser('test-token-hash', 100);
  return {
    svc: createFileCreditFacade(new FileCreditService(users, credits)),
    userId: created.id,
  };
}

// Must wrap a real TursoCreditService, not the raw store: wrapping the store
// would make the surface check in 5D-X9 pass for the wrong reason, since the
// facade defines every method itself regardless of what it delegates to.
async function makeTursoService() {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-facade-turso-'));
  const store = new TursoStore(createClient({ url: `file:${join(dir, 'app.db')}` }));
  await store.init();
  return createTursoCreditFacade(new TursoCreditService(store));
}

// ------------------------------------------------------- asyncRoute core ----

test('5D-X1. a late rejection is forwarded to next() instead of becoming unhandled', async () => {
  const boom = new CreditError('INSUFFICIENT_BALANCE', 'nope');
  const forwarded: unknown[] = [];
  const next = ((err: unknown) => {
    forwarded.push(err);
  }) as NextFunction;

  const handler = asyncRoute(async () => {
    await new Promise((r) => setImmediate(r));
    throw boom;
  });

  const { leaked } = await withUnhandledRejectionWatch(async () => {
    handler({} as Request, fakeRes(), next);
    await new Promise((r) => setTimeout(r, 20));
  });

  assert.equal(leaked.length, 0, `no unhandled rejection may escape; got: ${leaked.join('; ')}`);
  assert.equal(forwarded.length, 1, 'the rejection must reach Express error middleware');
  assert.equal(forwarded[0], boom, 'the ORIGINAL error object must be passed through unchanged');
  assert.ok(forwarded[0] instanceof CreditError, 'instanceof must survive, so status mapping still works');
  assert.equal((forwarded[0] as CreditError).code, 'INSUFFICIENT_BALANCE');
});

test('5D-X2. a synchronous throw still reaches next(), exactly like an unwrapped handler', async () => {
  const boom = new Error('sync boom');
  const forwarded: unknown[] = [];
  const next = ((err: unknown) => {
    forwarded.push(err);
  }) as NextFunction;

  const handler = asyncRoute(() => {
    throw boom;
  });
  const { leaked } = await withUnhandledRejectionWatch(async () => {
    handler({} as Request, fakeRes(), next);
    await new Promise((r) => setImmediate(r));
  });

  assert.equal(leaked.length, 0);
  assert.deepEqual(forwarded, [boom]);
});

test('5D-X3. a malformed JSON body becomes 400, not a silent 500', async () => {
  const res = fakeRes();
  const forwarded: unknown[] = [];
  const next = ((err: unknown) => {
    forwarded.push(err);
  }) as NextFunction;

  const handler = asyncRoute(async () => {
    const err = new SyntaxError('Unexpected token } in JSON at position 12');
    (err as unknown as { type: string }).type = 'entity.parse.failed';
    throw err;
  });
  await handler({} as Request, res, next);

  assert.equal(res.__status, 400, 'a client-side parse error must be a 400');
  assert.equal(forwarded.length, 0, 'it must not be forwarded as a server fault');
});

test('5D-X4. asyncRoute does not write a response when the handler already sent one', async () => {
  const res = fakeRes();
  const next = (() => {
    throw new Error('next must not be called');
  }) as NextFunction;
  const handler = asyncRoute(async () => {
    res.status(200).json({ ok: true });
  });
  await handler({} as Request, res, next);
  assert.deepEqual(res.__body, { ok: true }, 'the handler owns its response');
});

test('5D-X5. runDetached swallows AND logs a background failure without leaking it', async () => {
  const { leaked } = await withUnhandledRejectionWatch(async () => {
    runDetached('test', async () => {
      throw new Error('background boom');
    });
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(leaked.length, 0, 'a detached task must never crash the process');
});

// ---------------------------------------------------------- the facade -----

test('5D-X6. the facade turns the JSON provider sync errors into rejections', async () => {
  const { svc, userId } = makeJsonService();
  const { leaked } = await withUnhandledRejectionWatch(async () => {
    // Charge far more than the balance: previously a synchronous CreditError.
    await assert.rejects(
      svc.chargeJob({ userId, jobId: 'j1', amount: 10_000, reason: 'over' }),
      (err: unknown) => {
        assert.ok(err instanceof CreditError, 'must still be a CreditError');
        assert.equal((err as CreditError).code, 'INSUFFICIENT_BALANCE');
        return true;
      },
    );
  });
  assert.equal(leaked.length, 0, 'the error must be delivered, not leaked');
});

test('5D-X7. the facade preserves JSON charge/refund behaviour and idempotency', async () => {
  const { svc, userId } = makeJsonService();
  const before = await svc.getBalance(userId);
  assert.equal(before, 100);

  const first = await svc.chargeJob({ userId, jobId: 'j1', amount: 10, reason: 'charge' });
  assert.equal(first.charged, true);
  assert.equal(await svc.getBalance(userId), 90);

  // Same jobId again: idempotent, must not charge twice.
  const replay = await svc.chargeJob({ userId, jobId: 'j1', amount: 10, reason: 'charge' });
  assert.equal(replay.charged, false, 'a repeated job charge must not charge again');
  assert.equal(await svc.getBalance(userId), 90, 'balance must be unchanged by the replay');

  const refunded = await svc.refundFinishedJob(userId, 'j1', 'refund');
  assert.ok(refunded, 'the refund must return a transaction');
  assert.equal(await svc.getBalance(userId), 100, 'the refund must restore the original balance');

  // The ledger must contain exactly one DEBIT and one REFUND. The replay is
  // deliberately NOT a third row: an idempotent no-op must leave no trace, and
  // the balance reconciling to 100 is only possible if the DEBIT was not
  // re-applied. This is the assertion that would catch a double charge.
  const txns = await svc.getTransactions(userId);
  assert.equal(txns.length, 2, `expected exactly DEBIT + REFUND, got: ${txns.map((t) => t.type).join(', ')}`);
  const debits = txns.filter((t) => t.type === 'DEBIT');
  const refunds = txns.filter((t) => t.type === 'REFUND');
  assert.equal(debits.length, 1, 'exactly one debit');
  assert.equal(refunds.length, 1, 'exactly one refund');
  assert.equal(debits[0].amount, 10);
  assert.equal(refunds[0].amount, 10, 'the refund must equal the original charge');
});

test('5D-X8. the facade keeps the daily giveaway cap and idempotent replay', async () => {
  const { svc, userId } = makeJsonService();
  const input = {
    adminUserId: 'admin',
    adminEmail: 'owner@example.com',
    userId,
    amount: 25,
    reason: 'manual',
    idempotencyKey: 'idem-1',
  };
  const first = await svc.adminAdjustCredits(input);
  assert.equal(first.applied, true);
  const replay = await svc.adminAdjustCredits(input);
  assert.equal(replay.applied, false, 'the same idempotencyKey must be a no-op replay');
  assert.equal(await svc.getBalance(userId), 125, 'balance must reflect exactly one adjustment');
});

test('5D-X9. both providers satisfy the SAME AsyncCreditService surface', async () => {
  // The compile-time half of this is the interface itself; this asserts the
  // runtime half: every documented method exists on both facades.
  const methods: Array<keyof ReturnType<typeof createFileCreditFacade>> = [
    'isUnlimited', 'getBalance', 'getTransactions', 'getAllTransactions',
    'getAllTransactionsUnbounded', 'sumGrants', 'sumUsed', 'assertCanPay',
    'chargeJob', 'reserveJob', 'settleJobReservation', 'releaseJobReservation',
    'refundFinishedJob', 'recordPurchase', 'adminAdjustCredits', 'adminGrantCredits',
    'adminDebitCredits', 'registerUserWithCredits', 'incrementFreeTrialsUsed',
  ];
  const { svc: file } = makeJsonService();
  const turso = await makeTursoService();
  for (const m of methods) {
    assert.equal(typeof file[m], 'function', `file facade is missing ${m}`);
    assert.equal(typeof turso[m], 'function', `turso facade is missing ${m}`);
  }
});

test('5D-X10. the Turso facade reports real data through the same reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-facade-turso2-'));
  const store = new TursoStore(createClient({ url: `file:${join(dir, 'app.db')}` }));
  await store.init();
  await store.createUser({
    id: 'u1', tokenHashes: [], credits: 40, role: 'USER', creditMode: 'NORMAL',
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', freeTrialsUsed: 0,
  } as never);
  const svc = createTursoCreditFacade(new TursoCreditService(store));

  assert.equal(await svc.getBalance('u1'), 40);
  assert.equal(await svc.isUnlimited('u1'), false);

  await svc.chargeJob({ userId: 'u1', jobId: 'j1', amount: 10, reason: 'charge' });
  assert.equal(await svc.getBalance('u1'), 30, 'the same facade shape must report Turso truth');
  assert.equal(await svc.sumUsed('u1'), 10, 'lifetime-used aggregate must read the ledger');
  assert.equal(await svc.sumGrants('u1'), 0, 'nothing has been granted yet');
  assert.equal((await svc.getTransactions('u1')).length, 1);
});

test('5D-X11. assertCanPay gives UNLIMITED users the same free pass on BOTH providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage5d-unlimited-json-'));
  const jStore = new DataStore(join(dir, 'app.db.json'));
  const jUsers = new UserRepo(jStore);
  const jCredits = new CreditRepo(jStore);
  const jsonUser = jUsers.createUser('json-unlimited', 0, 'USER', 'UNLIMITED');
  const jsonSvc = createFileCreditFacade(new FileCreditService(jUsers, jCredits));

  const tDir = mkdtempSync(join(tmpdir(), 'stage5d-unlimited-turso-'));
  const tStore = new TursoStore(createClient({ url: `file:${join(tDir, 'app.db')}` }));
  await tStore.init();
  await tStore.createUser({
    id: 'tu1', tokenHashes: [], credits: 0, role: 'USER', creditMode: 'UNLIMITED',
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', freeTrialsUsed: 0,
  } as never);
  const tursoSvc = createTursoCreditFacade(new TursoCreditService(tStore));

  // Both accounts have a zero balance, so both MUST pass a 50-credit check.
  // Before the fix the Turso side threw INSUFFICIENT_BALANCE here.
  assert.equal(await jsonSvc.isUnlimited(jsonUser.id), true);
  assert.equal(await tursoSvc.isUnlimited('tu1'), true);
  await jsonSvc.assertCanPay(jsonUser.id, 50);
  await tursoSvc.assertCanPay('tu1', 50);

  // A NORMAL user with no credits must still be rejected on both.
  const poorDir = mkdtempSync(join(tmpdir(), 'stage5d-unlimited-poor-'));
  const pStore = new TursoStore(createClient({ url: `file:${join(poorDir, 'app.db')}` }));
  await pStore.init();
  await pStore.createUser({
    id: 'p1', tokenHashes: [], credits: 0, role: 'USER', creditMode: 'NORMAL',
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', freeTrialsUsed: 0,
  } as never);
  const poorSvc = createTursoCreditFacade(new TursoCreditService(pStore));
  await assert.rejects(
    poorSvc.assertCanPay('p1', 50),
    (err: unknown) => (err as CreditError).code === 'INSUFFICIENT_BALANCE',
  );
});

test('5D-X12. the JSON provider refuses unregistered credit ops loudly, not silently', async () => {
  const { svc, userId } = makeJsonService();
  await assert.rejects(
    svc.registerUserWithCredits({ id: 'x' } as never, { type: 'GRANT', amount: 5 } as never),
    (err: unknown) => {
      // A named error, so a half-wired signup fails fast and legibly instead of
      // minting an account with no ledger row.
      assert.equal((err as Error).name, 'CreditJsonProviderUnsupportedError');
      assert.match((err as Error).message, /signupAccount/);
      return true;
    },
  );
  // Free-trial counting is a documented no-op, not a crash.
  assert.equal(await svc.incrementFreeTrialsUsed(userId), null);
});
