import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from '../db/store.ts';
import { UserRepo, CreditRepo } from '../db/repos.ts';
import type { CreditMode, UserRecord } from '../db/types.ts';
import { FileCreditService, CreditError } from './creditService.ts';
import { decideAudioSpend, type AudioSpendContext } from './audioSpendGate.ts';
import { creditsForDuration, NOT_ENOUGH_CREDITS_MESSAGE, PROVIDER_UNAVAILABLE_MESSAGE, CANNOT_MEASURE_DURATION_MESSAGE } from './creditPolicy.ts';
import { providerSpendingState, reportProviderQuotaExhausted, resetProviderSafetyForTests } from './providerSafety.ts';
import { config } from '../config.ts';

/** Minimal wallet harness on a throwaway DB file (no production data touched). */
async function makeWallet(
  initialCredits: number,
  opts: { freeTrialsUsed?: number; creditMode?: CreditMode } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-gate-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const users = new UserRepo(store);
  const creditsRepo = new CreditRepo(store);
  const service = new FileCreditService(users, creditsRepo);
  const created = users.createUser('token-hash', initialCredits, 'USER', opts.creditMode ?? 'NORMAL');
  for (let i = 0; i < (opts.freeTrialsUsed ?? 0); i += 1) users.incrementFreeTrialsUsed(created.id);
  return { service, users, creditsRepo, user: users.getById(created.id) as UserRecord };
}

function ctx(user: UserRecord, measuredDurationSeconds: number, extra: Record<string, unknown> = {}): AudioSpendContext {
  // NOTE: `extra` simulates hostile client input. decideAudioSpend must ignore
  // anything that is not the server-measured duration / server-side user row.
  return {
    user: {
      id: user.id,
      creditMode: user.creditMode,
      freeTrialsUsed: user.freeTrialsUsed,
      credits: user.credits,
    },
    measuredDurationSeconds,
    freeTrialLimit: 2,
    ...extra,
  } as AudioSpendContext;
}

/** The exact reservation flow server.ts performs after an OK PAID decision. */
function reserve(service: FileCreditService, user: UserRecord, jobId: string, amount: number) {
  return service.reserveJob({ userId: user.id, jobId, amount, reason: 'reserve_transcription' });
}

test.beforeEach(() => resetProviderSafetyForTests());

/** Every ledger entry for a user (newest last), for assertions. */
const allTxns = (service: FileCreditService, userId: string) => service.getTransactions(userId, 100);

test('required credits come from the server-measured duration (60s=1, 61s=2, 120s=2, 121s=3)', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord;
  const required = (seconds: number) => decideAudioSpend(ctx(w, seconds)).requiredCredits;
  assert.equal(required(60), 1);
  assert.equal(required(61), 2);
  assert.equal(required(120), 2);
  assert.equal(required(121), 3);
  assert.equal(decideAudioSpend(ctx(w, 61)).kind, 'PAID');
  assert.equal(decideAudioSpend(ctx(w, 61)).requiredCredits, creditsForDuration(61));
});

test('a client-supplied duration or balance is IGNORED (server values win)', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 0 } as UserRecord;
  // A lying client claims 1 second and 999 credits; the server measured 180s and
  // the server balance is 0, so 3 credits are required and the request is denied.
  const d = decideAudioSpend(ctx(w, 180, { duration: 1, clientDuration: 1, balance: 999, credits: 999 }));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NEED_CREDITS');
  assert.equal(d.requiredCredits, 3);
  assert.equal(d.balance, 0);
  assert.equal(d.message, NOT_ENOUGH_CREDITS_MESSAGE);
});

test('insufficient credits: 402 BEFORE the provider is called and NO reservation is created', async () => {
  const { service, user, creditsRepo } = await makeWallet(0, { freeTrialsUsed: 2 });
  const d = decideAudioSpend(ctx(user, 180));
  assert.equal(d.ok, false);
  assert.equal(d.status, 402);
  assert.equal(d.code, 'NOT_ENOUGH_CREDITS');
  assert.equal(d.requiredCredits, 3);
  // Server refuses before reserving: no ledger movement at all.
  assert.equal(service.getBalance(user.id), 0);
  assert.equal(allTxns(service,user.id).length, 0);
  assert.equal(creditsRepo.reservationForJob(user.id, 'any'), null);
});

test('a rejected request is fully reversible: credits are only spent on success', async () => {
  const { service, user } = await makeWallet(5, { freeTrialsUsed: 2 });
  // 1 required credit, 5 available -> allowed + reserved
  const d = decideAudioSpend(ctx(user, 40));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'PAID');
  const r = reserve(service, user, 'job-ok', d.requiredCredits as number);
  assert.equal(r.charged, true);
  assert.equal(r.transaction.type, 'RESERVATION');
  assert.equal(service.getBalance(user.id), 4); // blocked, not yet spent
  // A later failure releases it -> nothing consumed.
  const released = service.releaseJobReservation(user.id, 'job-ok', 'release_failed_job');
  assert.ok(released);
  assert.equal(released.transaction.type, 'RELEASE');
  assert.equal(released.transaction.amount, 1);
  assert.equal(service.getBalance(user.id), 5); // fully restored
});

test('successful job: reservation is converted to USAGE and the balance is never double-charged', async () => {
  const { service, user, creditsRepo } = await makeWallet(10, { freeTrialsUsed: 2 });
  const d = decideAudioSpend(ctx(user, 121)); // 3 credits
  assert.equal(d.requiredCredits, 3);
  reserve(service, user, 'job-1', d.requiredCredits as number);
  assert.equal(service.getBalance(user.id), 7);
  const settled = service.settleJobReservation(user.id, 'job-1', 'usage_transcription');
  assert.ok(settled);
  assert.equal(settled.transaction.type, 'USAGE');
  assert.equal(settled.transaction.amount, 3);
  // Settling does NOT move the balance again (the reservation already blocked it).
  assert.equal(service.getBalance(user.id), 7);
  // A late failure after success must never release a consumed job.
  assert.equal(service.releaseJobReservation(user.id, 'job-1', 'release_failed_job'), null);
  assert.equal(service.getBalance(user.id), 7);
  const ledger = allTxns(service,user.id)
    .slice()
    .reverse() // getTransactions is newest-first -> chronological here
    .map((t) => [t.type, t.amount, t.balanceAfter]);
  assert.deepEqual(ledger, [['RESERVATION', 3, 7], ['USAGE', 3, 7]]);
});

test('double-spend is impossible: a second job cannot reserve credits already reserved', async () => {
  const { service, user } = await makeWallet(1, { freeTrialsUsed: 2 });
  // Job A: 60s of audio = exactly 1 credit, only 1 credit in the wallet.
  const a = decideAudioSpend(ctx(user, 60));
  assert.equal(a.ok, true);
  reserve(service, user, 'job-A', a.requiredCredits as number);
  assert.equal(service.getBalance(user.id), 0);
  // Job B: the fresh SERVER balance is now 0 -> rejected, no second reservation.
  const fresh = { ...user, credits: service.getBalance(user.id) } as UserRecord;
  const b = decideAudioSpend(ctx(fresh, 60));
  assert.equal(b.ok, false);
  assert.equal(b.kind, 'NEED_CREDITS');
  assert.equal(b.status, 402);
  assert.throws(
    () => reserve(service, user, 'job-B', 1),
    (e: unknown) => e instanceof CreditError && e.code === 'INSUFFICIENT_BALANCE'
  );
  assert.equal(service.getBalance(user.id), 0);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'RESERVATION').length, 1);
});

test('reservation is idempotent per jobId (a client retry cannot reserve twice)', async () => {
  const { service, user } = await makeWallet(10, { freeTrialsUsed: 2 });
  const first = reserve(service, user, 'retry-me', 2);
  const second = reserve(service, user, 'retry-me', 2);
  assert.equal(first.charged, true);
  assert.equal(second.charged, false);
  assert.equal(second.transaction?.id, first.transaction?.id);
  assert.equal(service.getBalance(user.id), 8);
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'RESERVATION').length, 1);
});

test('free trials: #1 and #2 are allowed free, #3 requires credits (failures never consume)', async () => {
  const { service, users, user } = await makeWallet(0);
  const fresh = () => users.getById(user.id) as UserRecord;

  // Trial #1 — allowed free, consumes nothing.
  let d = decideAudioSpend(ctx(fresh(), 300));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'FREE_TRIAL');
  assert.equal(d.freeTrialsRemaining, 2);
  users.incrementFreeTrialsUsed(fresh().id);

  // Trial #2 — allowed free.
  d = decideAudioSpend(ctx(fresh(), 300));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'FREE_TRIAL');
  assert.equal(d.freeTrialsRemaining, 1);
  users.incrementFreeTrialsUsed(fresh().id);

  // Trial #3 — must pay with credits (0 in the wallet -> 402).
  d = decideAudioSpend(ctx(fresh(), 300));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NEED_CREDITS');
  assert.equal(d.requiredCredits, 5); // 300s = 5 minutes
  // Free trials never move credits and never write a credit ledger entry.
  assert.equal(service.getBalance(fresh().id), 0);
  assert.equal(allTxns(service,fresh().id).length, 0);
  assert.equal(fresh().freeTrialsUsed, 2);
});

test('after 2 successful trials, credits are used and the ledger shows PURCHASE-style usage', async () => {
  const { service, user, users } = await makeWallet(12, { freeTrialsUsed: 2 });
  // Operator grant (stands in for a future purchase): the ONLY credit source.
  service.adminGrantCredits({
    adminUserId: 'admin',
    userId: user.id,
    amount: 12,
    reason: 'purchase_pack',
    idempotencyKey: 'k1',
  });
  assert.equal(service.getBalance(user.id), 24);
  const d = decideAudioSpend(ctx(users.getById(user.id) as UserRecord, 121));
  assert.equal(d.kind, 'PAID');
  assert.equal(d.requiredCredits, 3);
  reserve(service, user, 'paid-1', d.requiredCredits as number);
  service.settleJobReservation(user.id, 'paid-1', 'usage_transcription');
  assert.equal(service.getBalance(user.id), 21);
  const types = allTxns(service, user.id).map((t) => t.type);
  assert.ok(types.includes('ADMIN_GRANT'));
  assert.ok(types.includes('RESERVATION'));
  assert.ok(types.includes('USAGE'));
});

test('trials exhausted + unmeasurable duration -> 422, provider never called', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord;
  const d = decideAudioSpend(ctx(w, 0));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NO_DURATION');
  assert.equal(d.status, 422);
  assert.equal(d.message, CANNOT_MEASURE_DURATION_MESSAGE);
});

test('UNLIMITED accounts are exempt from credits, anonymous callers keep legacy access', () => {
  const unlimited = { id: 'a', creditMode: 'UNLIMITED', freeTrialsUsed: 0, credits: 0 } as UserRecord;
  assert.equal(decideAudioSpend(ctx(unlimited, 300)).kind, 'UNLIMITED');
  const anon = decideAudioSpend({ user: null, measuredDurationSeconds: 300, freeTrialLimit: 2 });
  assert.equal(anon.ok, true);
  assert.equal(anon.kind, 'ANONYMOUS');
});

test('FREE_TRIAL_LIMIT=0 keeps the legacy "cap disabled" behaviour', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 9, credits: 0 } as UserRecord;
  const d = decideAudioSpend({ user: w, measuredDurationSeconds: 300, freeTrialLimit: 0 } as AudioSpendContext);
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'FREE_TRIAL');
});

test('UNLIMITED accounts never reserve credits', async () => {
  const { service, user, creditsRepo } = await makeWallet(0, { creditMode: 'UNLIMITED' });
  const r = service.reserveJob({ userId: user.id, jobId: 'unl-1', amount: 3, reason: 'reserve_transcription' });
  assert.equal(r.charged, false);
  assert.equal(r.unlimited, true);
  assert.equal(service.getBalance(user.id), 0);
  assert.equal(allTxns(service,user.id).length, 0);
});

test('kill switch blocks EVERY caller (no bypass) with the exact product message', () => {
  const previous = config.providerSpendingProtection;
  config.providerSpendingProtection = true;
  try {
    for (const user of [
      { id: 'n', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 100 } as UserRecord, // free trial
      { id: 'e', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord, // paid, enough credits
      { id: 'u', creditMode: 'UNLIMITED', freeTrialsUsed: 0, credits: 0 } as UserRecord, // admin/unlimited
    ]) {
      const d = decideAudioSpend(ctx(user, 60));
      assert.equal(d.ok, false);
      assert.equal(d.kind, 'PROVIDER_UNAVAILABLE');
      assert.equal(d.status, 503);
      assert.equal(d.message, PROVIDER_UNAVAILABLE_MESSAGE);
    }
    // Anonymous callers are NOT exempt from the hard stop.
    const anon = decideAudioSpend({ user: null, measuredDurationSeconds: 60, freeTrialLimit: 2 });
    assert.equal(anon.ok, false);
    assert.equal(anon.kind, 'PROVIDER_UNAVAILABLE');
    assert.equal(providerSpendingState().blocked, true);
    assert.equal(providerSpendingState().reason, 'kill_switch');
  } finally {
    config.providerSpendingProtection = previous;
  }
});

test('quota quarantine blocks the next request, and expires on its own (no auto-recharge)', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord;
  assert.equal(decideAudioSpend(ctx(w, 60)).ok, true);
  // Provider reported "no credits available": quarantine for the cooldown.
  const now = new Date().toISOString();
  const until = reportProviderQuotaExhausted(now);
  assert.equal(until, new Date(Date.parse(now) + config.providerQuotaCooldownMs).toISOString());
  const blocked = decideAudioSpend(ctx(w, 60));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'PROVIDER_UNAVAILABLE');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.message, PROVIDER_UNAVAILABLE_MESSAGE);
  assert.equal(providerSpendingState().reason, 'quota_cooldown');
  // The cooldown is finite: once it has elapsed, processing resumes by itself
  // (it never buys credits and never charges the user).
  const stale = reportProviderQuotaExhausted(
    new Date(Date.now() - config.providerQuotaCooldownMs - 1000).toISOString()
  );
  assert.ok(Date.parse(stale) < Date.now());
  assert.equal(decideAudioSpend(ctx(w, 60)).ok, true);
  resetProviderSafetyForTests();
  assert.equal(decideAudioSpend(ctx(w, 60)).ok, true);
});

test('payment buttons cannot create credits (no purchase/checkout route exists)', () => {
  const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  // The pack catalog is display-only: there is no endpoint that turns a click
  // into credits (that requires a payment gateway, which does not exist yet).
  assert.doesNotMatch(
    src,
    /app\.(post|get|put|patch)\(\s*['"`]\/api\/[^'"`]*(purchase|checkout|payment|paynow|orders)/i
  );
  // No payment SDK is imported anywhere in the server.
  assert.doesNotMatch(src, /from\s+['"](razorpay|stripe|paypal|paytm|phonepe|ccavenue)/i);
  // The server never writes a PURCHASE ledger entry: credits can only come from
  // an operator grant (admin), the initial grant, or a refund/release.
  assert.doesNotMatch(src, /type:\s*'PURCHASE'/);
  const service = fs.readFileSync(new URL('./creditService.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(service, /this\.apply\([^)]*'PURCHASE'/);
  assert.match(service, /adminGrantCredits/);
});

test('ledger supports every transaction type required by the product spec', () => {
  const types = fs.readFileSync(new URL('../db/types.ts', import.meta.url), 'utf8');
  for (const required of ['FREE_TRIAL', 'PURCHASE', 'RESERVATION', 'USAGE', 'RELEASE', 'REFUND', 'ADMIN_ADJUSTMENT']) {
    assert.match(types, new RegExp(`'${required}'`), `${required} is a supported ledger type`);
  }
});
