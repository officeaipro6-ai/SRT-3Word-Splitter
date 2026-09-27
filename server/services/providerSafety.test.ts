import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from '../db/store.ts';
import { ProviderSafetyRepo } from '../db/repos.ts';
import {
  ProviderSafetyService,
  ProviderSpendingError,
  classifyProviderFailure,
  nextProviderState,
  type ProviderFailure,
} from './providerSafety.ts';
import { config } from '../config.ts';
import { PROVIDER_UNAVAILABLE_MESSAGE } from './creditPolicy.ts';

const QUOTA_402 =
  'Sarvam job initiate failed (HTTP 402): {"error":{"code":"insufficient_quota_error","message":"No credits available"}}';

/** Persisted state on a throwaway store, with a recorded notification log. */
function makeService(opts: { deliver?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-psafety-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  const repo = new ProviderSafetyRepo(store);
  const notified: string[] = [];
  const service = new ProviderSafetyService({
    provider: 'sarvam',
    get: () => repo.get('sarvam'),
    patch: (patch) => repo.patch('sarvam', patch),
    setStatus: (provider, status, reason, patch) => repo.setStatus(provider, status, reason, patch),
    notifyOwner: (payload) => {
      notified.push(payload.event);
      return { delivered: opts.deliver === true };
    },
  });
  return { service, repo, notified, store, dir };
}

const failure = (over: Partial<ProviderFailure> = {}): ProviderFailure => ({
  kind: 'UNAVAILABLE',
  message: 'boom',
  transient: true,
  ...over,
});

test('a 402 insufficient_quota response classifies as QUOTA_EXHAUSTED and is not transient', () => {
  const f = classifyProviderFailure({ message: QUOTA_402 });
  assert.equal(f.kind, 'QUOTA_EXHAUSTED');
  assert.equal(f.transient, false);
  assert.equal(f.httpStatus, 402);
  assert.match(f.message, /no credits available/i);
});

test('a structured insufficient_quota code is a reliable block signal', () => {
  assert.equal(classifyProviderFailure({ status: 402, code: 'insufficient_quota' }).kind, 'QUOTA_EXHAUSTED');
  assert.equal(classifyProviderFailure({ status: 402, code: 'no_credits_available' }).kind, 'QUOTA_EXHAUSTED');
  assert.equal(classifyProviderFailure({ status: 400, code: 'insufficient_quota_error' }).kind, 'QUOTA_EXHAUSTED');
  // A bare 402 without quota wording is still a payment problem -> block.
  assert.equal(classifyProviderFailure({ status: 402, message: 'payment required' }).kind, 'PAYMENT_REQUIRED');
});

test('rate limits stay transient: a 429 that mentions quota must never block', () => {
  const f = classifyProviderFailure({ status: 429, message: 'HTTP 429: rate limit reached for quota bucket' });
  assert.equal(f.kind, 'RATE_LIMIT');
  assert.equal(f.transient, true);
  assert.equal(classifyProviderFailure({ message: 'HTTP 429 too many requests' }).kind, 'RATE_LIMIT');
});

test('other failures classify without ever blocking on thin evidence', () => {
  assert.equal(classifyProviderFailure({ status: 503 }).kind, 'UNAVAILABLE');
  assert.equal(classifyProviderFailure({ status: 401 }).kind, 'AUTH');
  assert.equal(classifyProviderFailure({ status: 403 }).kind, 'AUTH');
  assert.equal(classifyProviderFailure({ message: 'ETIMEDOUT' }).kind, 'UNAVAILABLE');
  assert.equal(classifyProviderFailure({ message: 'something odd happened' }).kind, 'UNKNOWN');
  assert.equal(classifyProviderFailure({}).kind, 'UNKNOWN');
  for (const f of [
    classifyProviderFailure({ message: 'something odd happened' }),
    classifyProviderFailure({ status: 500, message: 'internal error' }),
    classifyProviderFailure({ status: 422, message: 'bad request' }),
  ]) {
    assert.notEqual(f.kind, 'QUOTA_EXHAUSTED');
    assert.notEqual(f.kind, 'PAYMENT_REQUIRED');
  }
});

test('the pure transition table encodes AVAILABLE/WARNING/BLOCKED', () => {
  const base = { current: 'AVAILABLE' as const, killSwitch: false, failuresBefore: 0, warningAfterFailures: 2 };
  // First transient failure keeps AVAILABLE; the second one raises WARNING.
  assert.equal(nextProviderState({ ...base, failure: failure() }), 'AVAILABLE');
  assert.equal(nextProviderState({ ...base, failuresBefore: 1, failure: failure() }), 'WARNING');
  // 402 blocks from ANY state, transient or not.
  assert.equal(
    nextProviderState({ ...base, failure: failure({ kind: 'QUOTA_EXHAUSTED', transient: false }) }),
    'BLOCKED'
  );
  assert.equal(
    nextProviderState({ ...base, current: 'WARNING', failure: failure({ kind: 'QUOTA_EXHAUSTED', transient: false }) }),
    'BLOCKED'
  );
  // BLOCKED is sticky until an admin reset (not a transition function away).
  assert.equal(
    nextProviderState({ ...base, current: 'BLOCKED', failure: failure() }),
    'BLOCKED'
  );
  // The kill-switch blocks regardless of the failure kind.
  assert.equal(nextProviderState({ ...base, killSwitch: true, failure: failure() }), 'BLOCKED');
  // A clean non-transient signal clears WARNING.
  assert.equal(
    nextProviderState({ ...base, current: 'WARNING', failure: failure({ kind: 'UNKNOWN', transient: false }) }),
    'AVAILABLE'
  );
});

test('the state machine records every transition with reason, timestamp and last error', () => {
  const { service } = makeService();
  service.reportFailure(failure());
  service.reportFailure(failure());
  const warned = service.view();
  assert.equal(warned.status, 'WARNING');
  assert.equal(warned.blocked, false);
  assert.equal(warned.reason, null);
  assert.equal(warned.consecutiveFailures, 2);
  assert.ok(warned.updatedAt);
  assert.ok(warned.history.length >= 2);

  const blocked = service.reportFailure(
    failure({ kind: 'QUOTA_EXHAUSTED', transient: false, httpStatus: 402, message: QUOTA_402 })
  );
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reason, 'QUOTA_EXHAUSTED');
  assert.equal(blocked.lastHttpStatus, 402);
  assert.equal(blocked.lastErrorAt != null, true);
  assert.equal(blocked.blockedAt != null, true);
  assert.equal(blocked.history[0].to, 'BLOCKED');
  assert.equal(blocked.history[0].httpStatus, 402);
  assert.equal(blocked.message, PROVIDER_UNAVAILABLE_MESSAGE);

  // The gate refuses a call while blocked...
  assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  // ...and only an admin reset re-opens it.
  const reset = service.resetToAvailable('sumitchinara@gmail.com');
  assert.equal(reset.status, 'AVAILABLE');
  assert.equal(reset.reason, null);
  assert.equal(reset.lastResetBy, 'sumitchinara@gmail.com');
  assert.equal(reset.consecutiveFailures, 0);
  assert.equal(reset.history[0].kind, 'ADMIN_RESET');
  assert.doesNotThrow(() => service.assertProviderSpendingAllowed());
});

test('a successful provider call clears WARNING and the failure counter, but never unblocks', async () => {
  const { service } = makeService();
  service.reportFailure(failure());
  service.reportFailure(failure());
  service.reportFailure(failure());
  assert.equal(service.view().status, 'WARNING');
  const recovered = service.reportSuccess();
  assert.equal(recovered.status, 'AVAILABLE', 'a working provider leaves WARNING');
  assert.equal(recovered.reason, null);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.ok(recovered.lastSuccessAt);
  assert.equal(recovered.history[0].kind, 'SUCCESS');
  assert.doesNotThrow(() => service.assertProviderSpendingAllowed());

  service.reportFailure(failure({ kind: 'QUOTA_EXHAUSTED', transient: false, httpStatus: 402 }));
  service.reportSuccess();
  assert.equal(service.view().status, 'BLOCKED'); // success cannot clear a 402 block
});

test('the owner is notified on WARNING and BLOCKED, and only when a transport exists is it "delivered"', () => {
  const quiet = makeService();
  quiet.service.reportFailure(failure());
  quiet.service.reportFailure(failure());
  assert.deepEqual(quiet.notified, ['PROVIDER_WARNING']);
  quiet.service.reportFailure(failure({ kind: 'QUOTA_EXHAUSTED', transient: false, httpStatus: 402 }));
  assert.deepEqual(quiet.notified, ['PROVIDER_WARNING', 'QUOTA_EXHAUSTED']);

  const loud = makeService({ deliver: true });
  loud.service.reportFailure(failure({ kind: 'QUOTA_EXHAUSTED', transient: false, httpStatus: 402 }));
  assert.deepEqual(loud.notified, ['QUOTA_EXHAUSTED']);
  assert.equal(loud.service.view().history[0].notified, true);
});

test('no fake provider balance is ever exposed or stored', () => {
  const { service, repo } = makeService();
  const view = service.view();
  assert.equal(view.balance.known, false);
  assert.equal(view.balance.percent, null);
  assert.equal(view.balance.source, null);
  assert.equal(view.balanceSourceAvailable, false);
  const record = repo.get('sarvam');
  assert.equal(record.balance.known, false);
  assert.equal(record.balance.percent, undefined);
});

test('a corrupt/hand-edited provider state is normalised safely, never trusted blindly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-psafety-bad-'));
  const file = path.join(dir, 'app.db.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      users: [],
      jobs: [],
      transactions: [],
      providerSafety: { status: 'TOTALLY_BOGUS', reason: 'invented', balance: { known: true, percent: 'lots' } },
    }),
    'utf8'
  );
  const store = new DataStore(file);
  await store.init();
  const repo = new ProviderSafetyRepo(store);
  const record = repo.get('sarvam');
  assert.equal(record.status, 'AVAILABLE');
  assert.equal(record.reason, null);
  assert.equal(record.balance.known, false);
  assert.equal(record.balance.percent, undefined);
});

test('a BLOCKED state survives a full store reload (no silent re-enable on restart)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-psafety-restart-'));
  const file = path.join(dir, 'app.db.json');
  const first = new DataStore(file);
  await first.init();
  const repo1 = new ProviderSafetyRepo(first);
  const svc1 = new ProviderSafetyService({
    provider: 'sarvam',
    get: () => repo1.get('sarvam'),
    patch: (p) => repo1.patch('sarvam', p),
    setStatus: (p, status, reason, patch) => repo1.setStatus(p, status, reason, patch),
    notifyOwner: () => ({ delivered: false }),
  });
  svc1.reportFailure(failure({ kind: 'QUOTA_EXHAUSTED', transient: false, httpStatus: 402, message: QUOTA_402 }));
  await new Promise((r) => setTimeout(r, 80)); // let the queued persist flush

  const second = new DataStore(file);
  await second.init();
  const repo2 = new ProviderSafetyRepo(second);
  const svc2 = new ProviderSafetyService({
    provider: 'sarvam',
    get: () => repo2.get('sarvam'),
    patch: (p) => repo2.patch('sarvam', p),
    setStatus: (p, status, reason, patch) => repo2.setStatus(p, status, reason, patch),
    notifyOwner: () => ({ delivered: false }),
  });
  assert.equal(svc2.isBlocked(), true);
  assert.equal(svc2.view().status, 'BLOCKED');
  assert.equal(svc2.view().reason, 'QUOTA_EXHAUSTED');
  assert.throws(() => svc2.assertProviderSpendingAllowed(), /temporarily unavailable/i);
});

test('the kill switch forces BLOCKED even with a healthy stored state', () => {
  const { service } = makeService();
  // Drive the REAL env -> config path (server.ts loads dotenv after imports, so
  // the switch is a lazy getter; assigning the config field directly is no
  // longer possible, and would not prove the .env value is honoured).
  const previous = process.env.PROVIDER_SPENDING_PROTECTION;
  process.env.PROVIDER_SPENDING_PROTECTION = 'true';
  try {
    assert.equal(config.providerSpendingProtection, true);
    assert.equal(service.view().status, 'BLOCKED');
    assert.equal(service.view().reason, 'KILL_SWITCH');
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_SPENDING_PROTECTION;
    else process.env.PROVIDER_SPENDING_PROTECTION = previous;
  }
  assert.equal(service.view().status, 'AVAILABLE');
});

/** No recharge/auto-buy/paid-fallback capability may exist in this layer. */
test('there is no automatic recharge, retry-on-402 or paid fallback provider anywhere', () => {
  const src = ['providerSafety.ts', 'queue.ts', '../db/repos.ts', '../config.ts']
    .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8'))
    .join('\n');
  // No recharge/auto-buy code path exists (the words may appear in comments, so
  // match callable forms only).
  assert.doesNotMatch(src, /function\s+recharge|const\s+recharge|rechargeProvider|\.recharge\s*\(/i);
  assert.doesNotMatch(src, /autoBuy|auto_recharge|purchaseCredits|topUpProvider/i);
  // No outbound call to any payment/billing endpoint from the safety layer.
  assert.doesNotMatch(src, /fetch\(\s*['"`]https?:\/\/[^'"`]*(payment|billing|recharge|checkout)/i);
  // The safety layer itself never calls out to the network at all.
  assert.doesNotMatch(
    fs.readFileSync(new URL('./providerSafety.ts', import.meta.url), 'utf8'),
    /\bfetch\s*\(|https?:\/\/(?!api\.sarvam)/i
  );
  // The queue treats a blocked provider as terminal: no retry scheduling.
  const queue = fs.readFileSync(new URL('./queue.ts', import.meta.url), 'utf8');
  assert.match(queue, /const transient = !isNowBlocked/);
  assert.match(queue, /assertProviderSpendingAllowed/);
});
