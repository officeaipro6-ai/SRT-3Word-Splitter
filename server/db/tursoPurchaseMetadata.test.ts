/**
 * Razorpay purchase ledger metadata on the Turso provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `transactions` table has no `packageId`/`paymentStatus` columns, while
 * `CreditTransactionRecord` declares them and the Excel purchase history reads
 * both. The transport is `transactions.extra`: `transactionExtraColumn()` folds
 * them in on write, `liftTransactionMetadata()` lifts them back out on read
 * (TursoScope.toTransaction for the atomic scope paths, TursoStore.decodeJsonRow
 * for every store-level read). These tests pin the full round trip against a
 * real file-backed libSQL database — never `file::memory:`, because
 * @libsql/client hands out a fresh connection once a transaction starts and an
 * in-memory database is per-connection.
 *
 * Covered: PURCHASE stores packageId, PURCHASE stores paymentStatus='captured',
 * paymentId stays a first-class column, balanceBefore/balanceAfter/idempotencyKey
 * stay correct, a duplicate payment stays idempotent, and non-Razorpay rows are
 * unchanged (their `extra` is preserved byte-for-byte, no metadata invented).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TursoStore } from './tursoStore.ts';
import { TursoCreditService } from '../services/tursoCreditService.ts';
import type { CreditTransactionRecord, UserRecord } from './types.ts';

// ------------------------------------------------------------------ harness ---

function makeHarness(): { store: TursoStore; raw: ReturnType<typeof createClient>; credits: TursoCreditService } {
  const dir = mkdtempSync(join(tmpdir(), 'rzp-meta-'));
  const url = `file:${join(dir, 'app.db')}`;
  const store = new TursoStore(createClient({ url }));
  // A second connection on the same file, used ONLY to inspect the stored
  // bytes: TursoStore keeps its client private on purpose, and this is the
  // honest way to prove what the INSERT actually wrote.
  const raw = createClient({ url });
  return { store, raw, credits: new TursoCreditService(store) };
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

function purchaseInput(paymentId = 'pay_meta_1') {
  return {
    userId: 'u1',
    planId: 'starter',
    paymentId,
    orderId: `order_${paymentId}`,
    amountInr: 69,
    currency: 'INR',
    planName: 'Starter',
  };
}

async function balance(store: TursoStore): Promise<number> {
  return (await store.getUserById('u1'))?.credits ?? 0;
}

function purchases(rows: readonly CreditTransactionRecord[]): StoredRow[] {
  return rows.filter((t) => t.type === 'PURCHASE') as StoredRow[];
}

/**
 * A ledger row as the Turso provider returns it: the typed record plus the
 * decoded `extra` bag (the provider's `StoredTransaction`). `extra` is not on
 * `CreditTransactionRecord` by design — only this provider carries it.
 */
type StoredRow = CreditTransactionRecord & { extra?: Record<string, unknown> | null };

// ================================================================== tests ====

test('Turso PURCHASE persists packageId and paymentStatus on every read path', async () => {
  const { store, credits } = makeHarness();
  await store.init();
  await store.createUser(user());

  const first = await credits.recordPurchase(purchaseInput());
  assert.equal(first.alreadyProcessed, false);
  assert.equal(first.transaction.packageId, 'starter', 'the write-side record carries the pack');

  // Read path 1: service facade -> TursoStore.getTransactionsByUser (queryTable).
  const viaService = purchases(await credits.getTransactions('u1', 25));
  assert.equal(viaService.length, 1, 'exactly one PURCHASE ledger row');
  assert.equal(viaService[0].packageId, 'starter');
  assert.equal(viaService[0].paymentStatus, 'captured');
  assert.equal(viaService[0].paymentId, 'pay_meta_1');
  assert.equal(viaService[0].extra, null, 'metadata is MOVED out of extra, not copied');

  // Read path 2: store-wide reads (getAllTransactions -> queryTable).
  const viaAll = purchases(await credits.getAllTransactions());
  assert.equal(viaAll[0]?.packageId, 'starter');
  assert.equal(viaAll[0]?.paymentStatus, 'captured');

  // Read path 3: dedicated payment lookup (store.getTransactionByPaymentId).
  const viaPaymentId = await store.getTransactionByPaymentId('pay_meta_1');
  assert.ok(viaPaymentId, 'the paymentId column still resolves the row');
  assert.equal(viaPaymentId.packageId, 'starter');
  assert.equal(viaPaymentId.paymentStatus, 'captured');

  // Read path 4: whole-database snapshot (feeds the synchronous CreditRepo).
  const snap = await store.snapshot();
  const viaSnapshot = purchases(snap.transactions as unknown as CreditTransactionRecord[]);
  assert.equal(viaSnapshot.length, 1);
  assert.equal(viaSnapshot[0].packageId, 'starter');
  assert.equal(viaSnapshot[0].paymentStatus, 'captured');

  // Read path 5: the atomic scope read used by the verify/webhook idempotency
  // check (TursoScope.toTransaction) — replayed through the service so the
  // production code path is what runs.
  const replay = await credits.recordPurchase(purchaseInput());
  assert.equal(replay.alreadyProcessed, true, 'the duplicate payment is idempotent');
  assert.equal(replay.transaction.id, first.transaction.id, 'the ORIGINAL row is returned');
  assert.equal(replay.transaction.packageId, 'starter', 'the scope read lifts the pack');
  assert.equal(replay.transaction.paymentStatus, 'captured');
  assert.equal((replay.transaction as StoredRow).extra, null, 'the scope read does not leak the transport bag');
});

test('Turso stores the metadata inside transactions.extra and paymentId as its own column', async () => {
  const { store, raw, credits } = makeHarness();
  await store.init();
  await store.createUser(user());

  await credits.recordPurchase(purchaseInput('pay_raw_1'));

  const res = await raw.execute({
    sql: 'SELECT extra, paymentId, type, amount, balanceBefore, balanceAfter, idempotencyKey FROM transactions',
    args: [],
  });
  assert.equal(res.rows.length, 1, 'one ledger row written');
  const row = res.rows[0] as Record<string, unknown>;

  // The fold: metadata lives in the overflow bag, because there is no column.
  const extra = JSON.parse(String(row.extra));
  assert.equal(extra.packageId, 'starter');
  assert.equal(extra.paymentStatus, 'captured');

  // Unchanged first-class persistence: paymentId, the audit pair and the
  // (unset for purchases) idempotency key are exactly as before.
  assert.equal(row.paymentId, 'pay_raw_1');
  assert.equal(row.type, 'PURCHASE');
  assert.equal(Number(row.amount), 15, 'the starter pack credits are unchanged');
  assert.equal(Number(row.balanceBefore), 100, 'balanceBefore reflects the pre-purchase balance');
  assert.equal(Number(row.balanceAfter), 115, 'balanceAfter reflects the credited balance');
  assert.equal(row.idempotencyKey, null, 'recordPurchase keys on paymentId, not idempotencyKey');
  assert.equal(await balance(store), 115, 'the balance matches balanceAfter');
});

test('a duplicate payment credits once and the balance/ledger stay consistent', async () => {
  const { store, credits } = makeHarness();
  await store.init();
  await store.createUser(user());

  const first = await credits.recordPurchase(purchaseInput('pay_dup_1'));
  const second = await credits.recordPurchase(purchaseInput('pay_dup_1'));

  assert.equal(first.alreadyProcessed, false);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(second.transaction.id, first.transaction.id);
  assert.equal(second.credits, first.credits, 'the replay reports the unchanged balance');
  assert.equal(await balance(store), 115, 'credited exactly once');

  const rows = await credits.getTransactions('u1', 25);
  assert.equal(purchases(rows).length, 1, 'one PURCHASE row for one payment');
  const purchase = rows[0];
  assert.equal(purchase.packageId, 'starter');
  assert.equal(purchase.paymentStatus, 'captured');
  assert.equal(purchase.balanceBefore, 100);
  assert.equal(purchase.balanceAfter, 115);
});

test('non-Razorpay transactions are unchanged: no metadata invented, extra preserved byte-for-byte', async () => {
  const { store, credits } = makeHarness();
  await store.init();
  await store.createUser(user({ credits: 0 }));
  await store.createUser(user({ id: 'admin', credits: 0, role: 'ADMIN', ownerEmail: 'owner@example.com' }));

  // An admin grant: idempotencyKey/adminUserId are first-class columns and must
  // keep round-tripping exactly, with no purchase metadata anywhere.
  const grant = await credits.adminAdjustCredits({
    userId: 'u1',
    amount: 40,
    reason: 'giveaway',
    adminUserId: 'admin',
    idempotencyKey: 'meta-test-key-1',
  });
  assert.equal(grant.applied, true);

  // A scope-level DEBIT carrying a caller-supplied extra bag: the fold must
  // merge NOTHING into a bag it was not asked to carry metadata for.
  await store.unitOfWork(async (scope) => {
    const delta = await scope.applyCreditDelta('u1', -10, { allowNegative: false });
    assert.equal(delta.status, 'ok');
    await scope.addTransaction({
      userId: 'u1',
      type: 'DEBIT',
      amount: 10,
      reason: 'charge',
      jobId: 'job-1',
      balanceBefore: 40,
      balanceAfter: 30,
      idempotencyKey: 'debit-key-1',
      extra: { note: 'kept' },
    } as never);
  });

  const rows: StoredRow[] = await credits.getTransactions('u1', 25);
  assert.equal(rows.length, 2, 'both non-purchase rows written');

  const admin = rows.find((t) => t.type === 'ADMIN_ADJUSTMENT')!;
  assert.ok(admin);
  assert.equal(admin.idempotencyKey, 'meta-test-key-1', 'idempotencyKey round-trips');
  assert.equal(admin.adminUserId, 'admin', 'adminUserId round-trips');
  assert.equal(admin.extra, null, 'a purchase-free row keeps extra NULL');
  assert.equal(admin.packageId, undefined, 'no packageId is invented for a non-purchase');
  assert.equal(admin.paymentStatus, undefined, 'no paymentStatus is invented for a non-purchase');

  const debit = rows.find((t) => t.type === 'DEBIT')!;
  assert.ok(debit);
  assert.equal(debit.idempotencyKey, 'debit-key-1');
  assert.equal(debit.jobId, 'job-1');
  assert.equal(debit.balanceBefore, 40);
  assert.equal(debit.balanceAfter, 30);
  assert.deepEqual(debit.extra, { note: 'kept' }, 'the caller extra bag is preserved byte-for-byte');
  assert.equal(debit.packageId, undefined);
  assert.equal(debit.paymentStatus, undefined);

  assert.equal(await balance(store), 30, '40 granted - 10 charged');
});
