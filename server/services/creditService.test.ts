import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from '../db/store.ts';
import { UserRepo, CreditRepo } from '../db/repos.ts';
import { FileCreditService, CreditError } from './creditService.ts';

async function makeService(initialCredits: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-credits-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const users = new UserRepo(store);
  const credits = new CreditRepo(store);
  const service = new FileCreditService(users, credits);
  const user = users.createUser('token-hash', initialCredits);
  return { service, user, users };
}

test('chargeJob debits exactly once per job (idempotent, no double charge)', async () => {
  const { service, user } = await makeService(100);
  const first = service.chargeJob({ userId: user.id, jobId: 'j1', amount: 10, reason: 'charge_transcription' });
  assert.equal(first.charged, true);
  const second = service.chargeJob({ userId: user.id, jobId: 'j1', amount: 10, reason: 'charge_transcription' });
  assert.equal(second.charged, false); // retry of the same jobId must not charge again
  assert.equal(service.getBalance(user.id), 90);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'DEBIT' && t.jobId === 'j1').length, 1);
});

test('chargeJob refuses when balance is insufficient (never negative)', async () => {
  const { service, user } = await makeService(5);
  assert.throws(() => service.chargeJob({ userId: user.id, jobId: 'j2', amount: 10, reason: 'charge' }), (e: unknown) => e instanceof CreditError && e.code === 'INSUFFICIENT_BALANCE');
  assert.equal(service.getBalance(user.id), 5);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'DEBIT').length, 0);
});

test('refundFinishedJob refunds once and only for a charged job', async () => {
  const { service, user } = await makeService(100);
  service.chargeJob({ userId: user.id, jobId: 'j3', amount: 20, reason: 'charge' });
  assert.equal(service.getBalance(user.id), 80);
  const refund = service.refundFinishedJob(user.id, 'j3', 'refund_failed_job');
  assert.ok(refund);
  assert.equal(refund.transaction.amount, 20);
  assert.equal(service.getBalance(user.id), 100);
  // Second refund is a no-op.
  assert.equal(service.refundFinishedJob(user.id, 'j3', 'refund_failed_job'), null);
  // Never-charged job refund is a no-op too.
  assert.equal(service.refundFinishedJob(user.id, 'never-charged', 'refund_failed_job'), null);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'REFUND').length, 1);
});

test('every transaction carries the correct balanceAfter ledger value', async () => {
  const { service, user } = await makeService(50);
  assert.equal(service.getTransactions(user.id).length, 0);
  void service.chargeJob({ userId: user.id, jobId: 'j4', amount: 15, reason: 'charge' });
  service.refundFinishedJob(user.id, 'j4', 'refund');
  const ledger = service.getTransactions(user.id);
  assert.deepEqual(ledger.map((t) => t.balanceAfter).sort(), [35, 50]); // DEBIT 35 then REFUND 50
});

test('admin grant records ADMIN_ADJUSTMENT with adminUserId and increases balance', async () => {
  const { service, users, user } = await makeService(10);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  const r = service.adminGrantCredits({ adminUserId: admin.id, userId: user.id, amount: 50, reason: 'audit_promo' });
  assert.equal(r.applied, true);
  assert.equal(r.transaction.type, 'ADMIN_ADJUSTMENT');
  assert.equal(r.transaction.adminUserId, admin.id);
  assert.equal(r.transaction.balanceBefore, 10);
  assert.equal(r.transaction.balanceAfter, 60);
  assert.equal(service.getBalance(user.id), 60);
});

test('admin grant is idempotent by idempotencyKey (no double-credit on retry)', async () => {
  const { service, users, user } = await makeService(0);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  const first = service.adminGrantCredits({ adminUserId: admin.id, userId: user.id, amount: 20, reason: 'promo', idempotencyKey: 'grant-key-1' });
  const second = service.adminGrantCredits({ adminUserId: admin.id, userId: user.id, amount: 20, reason: 'promo', idempotencyKey: 'grant-key-1' });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false); // duplicate key -> no second application
  assert.equal(second.transaction.id, first.transaction.id);
  assert.equal(service.getBalance(user.id), 20);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'ADMIN_ADJUSTMENT').length, 1);
});

test('admin debit requires a reason and never produces a negative balance', async () => {
  const { service, users, user } = await makeService(30);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  assert.throws(
    () => service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 5, reason: '   ' }),
    (e: unknown) => e instanceof CreditError && e.code === 'MISSING_REASON'
  );
  const ok = service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 10, reason: 'audit_chargeback' });
  assert.equal(ok.applied, true);
  assert.equal(ok.transaction.type, 'ADMIN_DEBIT');
  assert.equal(service.getBalance(user.id), 20);
  assert.throws(
    () => service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 100, reason: 'over' }),
    (e: unknown) => e instanceof CreditError && e.code === 'INSUFFICIENT_BALANCE'
  );
  assert.equal(service.getBalance(user.id), 20); // refused operation left balance unchanged
});

test('admin debit is idempotent by idempotencyKey', async () => {
  const { service, users, user } = await makeService(100);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 7, reason: 'fix', idempotencyKey: 'deb-key-9' });
  const again = service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 7, reason: 'fix', idempotencyKey: 'deb-key-9' });
  assert.equal(again.applied, false);
  assert.equal(service.getBalance(user.id), 93);
});

test('UNLIMITED accounts bypass charges with no DEBIT and no sentinel balance', async () => {
  const { service, users } = await makeService(0);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  assert.equal(service.isUnlimited(admin.id), true);
  // A huge multi-job charge does NOT touch the balance and creates no txn.
  for (let i = 0; i < 50; i++) {
    const r = service.chargeJob({ userId: admin.id, jobId: `unlim-${i}`, amount: 1, reason: 'charge_transcription' });
    assert.equal(r.unlimited, true);
    assert.equal(r.charged, false);
    assert.equal(r.transaction, null);
  }
  assert.equal(service.getBalance(admin.id), 0); // no fake 999999... sentinel
  assert.equal(service.getTransactions(admin.id).filter((t) => t.type === 'DEBIT').length, 0);
  assert.doesNotThrow(() => service.assertCanPay(admin.id, 1000));
});

test('admin aggregates: sumGrants / sumUsed / getAllTransactions', async () => {
  const { service, users, user } = await makeService(10);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  service.adminAdjustCredits({ adminUserId: admin.id, userId: user.id, amount: 40, reason: 'promo' });
  service.adminDebitCredits({ adminUserId: admin.id, userId: user.id, amount: 5, reason: 'fix' });
  service.chargeJob({ userId: user.id, jobId: 'agg-1', amount: 2, reason: 'charge_transcription' });
  assert.equal(service.sumGrants(user.id), 40); // manual adjustment only
  assert.equal(service.sumUsed(user.id), 7); // admin debit 5 + charge 2
  assert.equal(service.getBalance(user.id), 43);
  const all = service.getAllTransactions();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((t) => t.type).sort(), ['ADMIN_ADJUSTMENT', 'ADMIN_DEBIT', 'DEBIT']);
});

/**
 * Manual credit adjustments are always ADMIN_ADJUSTMENT (never a fake
 * PURCHASE) and must carry the full audit payload: admin account, target user,
 * amount added, balance before/after, timestamp, reason and the transaction id.
 */
test('admin adjustment records a complete ADMIN_ADJUSTMENT audit entry', async () => {
  const { service, users, user } = await makeService(150);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  users.setOwnerEmail(admin.id, 'OfficeAIPro6@Gmail.com');

  const before = new Date();
  const result = service.adminAdjustCredits({
    adminUserId: admin.id,
    userId: user.id,
    amount: 500,
    reason: 'manual top-up',
    idempotencyKey: 'adj-1',
  });
  const txn = result.transaction;

  assert.equal(result.applied, true);
  assert.equal(txn.type, 'ADMIN_ADJUSTMENT');
  assert.notEqual(txn.type, 'PURCHASE');
  assert.equal(txn.amount, 500); // credits ADDED
  assert.equal(txn.userId, user.id); // target user
  assert.equal(txn.adminUserId, admin.id); // acting admin account
  assert.equal(txn.adminEmail, 'officeaipro6@gmail.com'); // canonical, not the raw claim
  assert.equal(txn.balanceBefore, 150);
  assert.equal(txn.balanceAfter, 650);
  assert.equal(txn.reason, 'manual top-up');
  assert.ok(txn.id && txn.id.length > 0); // transaction id
  assert.ok(Date.parse(txn.createdAt) >= before.getTime() - 1000); // timestamp
  assert.equal(service.getBalance(user.id), 650);

  // Every ledger entry (not just adjustments) records balance before + after.
  const adjustAgain = service.adminAdjustCredits({
    adminUserId: admin.id,
    userId: user.id,
    amount: 10,
    reason: 'second top-up',
  });
  assert.equal(adjustAgain.transaction.balanceBefore, 650);
  assert.equal(adjustAgain.transaction.balanceAfter, 660);
  for (const t of service.getTransactions(user.id, 20)) {
    assert.equal(typeof t.balanceBefore, 'number');
    assert.equal(typeof t.balanceAfter, 'number');
  }

  // Idempotent: the same key never double-applies.
  const replay = service.adminAdjustCredits({
    adminUserId: admin.id,
    userId: user.id,
    amount: 500,
    reason: 'manual top-up',
    idempotencyKey: 'adj-1',
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.transaction.id, txn.id);
  assert.equal(service.getBalance(user.id), 660);

  // A reason is mandatory and the amount must be a positive integer.
  assert.throws(
    () => service.adminAdjustCredits({ adminUserId: admin.id, userId: user.id, amount: 5, reason: '   ' }),
    /reason is required/i
  );
  assert.throws(
    () => service.adminAdjustCredits({ adminUserId: admin.id, userId: user.id, amount: 0, reason: 'zero' }),
    /positive whole number/i
  );
  assert.throws(
    () => service.adminAdjustCredits({ adminUserId: admin.id, userId: 'nope', amount: 5, reason: 'ghost' }),
    /Unknown target user/i
  );

  // The legacy grant alias is recorded as the same manual-adjustment type.
  const legacy = service.adminGrantCredits({
    adminUserId: admin.id,
    userId: user.id,
    amount: 5,
    reason: 'legacy path',
  });
  assert.equal(legacy.transaction.type, 'ADMIN_ADJUSTMENT');
});

test('no manual credit path can create a PURCHASE ledger entry', async () => {
  const { service, users, user } = await makeService(0);
  const admin = users.createUser('admin-hash', 0, 'ADMIN', 'UNLIMITED');
  service.adminAdjustCredits({ adminUserId: admin.id, userId: user.id, amount: 500, reason: 'top-up' });
  service.adminGrantCredits({ adminUserId: admin.id, userId: user.id, amount: 500, reason: 'grant alias' });
  const types = service.getAllTransactions().map((t) => t.type);
  assert.deepEqual(types, ['ADMIN_ADJUSTMENT', 'ADMIN_ADJUSTMENT']);
  assert.equal(service.getBalance(user.id), 1000);
});