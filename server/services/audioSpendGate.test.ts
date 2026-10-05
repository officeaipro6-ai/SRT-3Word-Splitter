import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { DataStore } from '../db/store.ts';
import { UserRepo, CreditRepo } from '../db/repos.ts';
import type { CreditMode, UserRecord } from '../db/types.ts';
import { FileCreditService, CreditError } from './creditService.ts';
import { decideAudioSpend, type AudioSpendContext } from './audioSpendGate.ts';
import { creditsForDuration, NOT_ENOUGH_CREDITS_MESSAGE, PROVIDER_UNAVAILABLE_MESSAGE, CANNOT_MEASURE_DURATION_MESSAGE } from './creditPolicy.ts';
import {
  FREE_TRIAL_DURATION_LIMIT_MESSAGE,
  FREE_TRIAL_MAX_DURATION_SECONDS,
  exceedsFreeTrialDuration,
  freeTrialTotalMaxDurationSeconds,
  isFreeTrialExhausted,
  freeTrialsRemaining,
} from './freeTrialPolicy.ts';
import { ProviderSafetyService, classifyProviderFailure } from './providerSafety.ts';
import { ProviderSafetyRepo } from '../db/repos.ts';
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
    // Track the REAL frozen policy (FREE_TRIAL_LIMIT) instead of a hardcoded
    // number, so these tests can never drift from production again.
    freeTrialLimit: config.freeTrialLimit,
    ...extra,
  } as AudioSpendContext;
}

/** The exact reservation flow server.ts performs after an OK PAID decision. */
function reserve(service: FileCreditService, user: UserRecord, jobId: string, amount: number) {
  return service.reserveJob({ userId: user.id, jobId, amount, reason: 'reserve_transcription' });
}

/** A ProviderSafetyService backed by a real throwaway data store. */
async function makeSafety(): Promise<ProviderSafetyService> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-safety-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const repo = new ProviderSafetyRepo(store);
  return new ProviderSafetyService({
    provider: 'sarvam',
    get: () => repo.get('sarvam'),
    patch: (patch) => repo.patch('sarvam', patch),
    setStatus: (provider, status, reason, patch) => repo.setStatus(provider, status, reason, patch),
    notifyOwner: () => ({ delivered: false }),
  });
}

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
  // Both entries can share the same createdAt millisecond, so compare the set.
  const ledger = allTxns(service,user.id)
    .map((t) => [t.type, t.amount, t.balanceAfter].join('|'))
    .sort();
  assert.deepEqual(ledger, ['RESERVATION|3|7', 'USAGE|3|7']);
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

test('free trial: exactly ONE free trial, the 2nd transcription requires credits', async () => {
  const { service, users, user } = await makeWallet(0);
  const fresh = () => users.getById(user.id) as UserRecord;

  // Trial #1 — the single free trial, allowed free (100s <= the 2-minute cap).
  let d = decideAudioSpend(ctx(fresh(), 100));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'FREE_TRIAL');
  assert.equal(d.freeTrialLimit, 1);
  assert.equal(d.freeTrialsRemaining, 1);
  assert.equal(fresh().freeTrialsUsed, 0, 'deciding does not consume: only success does');
  users.incrementFreeTrialsUsed(fresh().id);

  // Trial #2 — the single trial is now consumed, so credits are required.
  d = decideAudioSpend(ctx(fresh(), 100));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NEED_CREDITS');
  assert.equal(d.code, 'NOT_ENOUGH_CREDITS');
  assert.equal(d.requiredCredits, 2); // 100s = 2 minutes
  assert.equal(d.freeTrialsUsed, 1);
  assert.equal(d.freeTrialsRemaining, 0);

  // Free trials never move credits and never write a credit ledger entry.
  assert.equal(service.getBalance(fresh().id), 0);
  assert.equal(allTxns(service, fresh().id).length, 0);
  assert.equal(fresh().freeTrialsUsed, 1);
});

test('free trial duration cap: 1:00 and 2:00 are allowed, 2:01 is blocked before any provider call', () => {
  const freshUser = () => ({ id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 0 }) as UserRecord;

  // 1:00 — well within the cap.
  const oneMinute = decideAudioSpend(ctx(freshUser(), 60));
  assert.equal(oneMinute.ok, true);
  assert.equal(oneMinute.kind, 'FREE_TRIAL');

  // 2:00 exactly — the LAST accepted second (no rounding down).
  const twoMinutes = decideAudioSpend(ctx(freshUser(), 120));
  assert.equal(twoMinutes.ok, true);
  assert.equal(twoMinutes.kind, 'FREE_TRIAL');
  assert.equal(exceedsFreeTrialDuration(120, config.freeTrialLimit), false);

  // 2:01 — one second over: refused, and refused as a DURATION problem with
  // the exact product message (not the generic "out of trials" message).
  const twoOhOne = decideAudioSpend(ctx(freshUser(), 121));
  assert.equal(twoOhOne.ok, false);
  assert.equal(twoOhOne.kind, 'FREE_TRIAL_DURATION_LIMIT');
  assert.equal(twoOhOne.status, 402);
  assert.equal(twoOhOne.code, 'FREE_TRIAL_DURATION_LIMIT');
  // It is priced, but the trial is NOT consumed and no credit moves.
  assert.equal(twoOhOne.requiredCredits, 3); // 121s rounds UP to 3 minutes
  assert.equal(twoOhOne.balance, 0);
  assert.equal(twoOhOne.freeTrialsUsed, 0);
  assert.equal(twoOhOne.freeTrialsRemaining, 1);
  assert.equal(exceedsFreeTrialDuration(121, config.freeTrialLimit), true);
  assert.equal(FREE_TRIAL_MAX_DURATION_SECONDS, 120);
  assert.equal(twoOhOne.message, FREE_TRIAL_DURATION_LIMIT_MESSAGE);
  assert.equal(
    twoOhOne.message,
    'Free trial is limited to 2 minutes. Please use credits for longer files.'
  );

  // A long file is never split across trials: each 121s request is refused
  // independently and the trial counter stays untouched.
  for (let i = 0; i < 5; i += 1) {
    const again = decideAudioSpend(ctx(freshUser(), 600));
    assert.equal(again.ok, false);
    assert.equal(again.kind, 'FREE_TRIAL_DURATION_LIMIT');
    assert.equal(again.freeTrialsUsed, 0);
    assert.equal(again.freeTrialsRemaining, 1);
  }
});

test('total free allowance is 1 trial x 2 minutes = 2 minutes, never more', async () => {
  const { service, users, user } = await makeWallet(0);
  const fresh = () => users.getById(user.id) as UserRecord;

  // The single free trial covers at most 2:00 of audio.
  let d = decideAudioSpend(ctx(fresh(), 120));
  assert.equal(d.kind, 'FREE_TRIAL');
  assert.equal(d.freeTrialsRemaining, 1);
  users.incrementFreeTrialsUsed(fresh().id);

  // The trial is spent: even a 120s file must now use credits, and the refusal
  // is the generic one because the TRIAL (not the duration) is gone.
  d = decideAudioSpend(ctx(fresh(), 120));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NEED_CREDITS');
  assert.equal(d.message, NOT_ENOUGH_CREDITS_MESSAGE);
  assert.equal(d.code, 'NOT_ENOUGH_CREDITS');
  assert.equal(d.freeTrialsUsed, 1);
  assert.equal(d.freeTrialsRemaining, 0);

  // A short file is refused identically: exhaustion, not duration, is the cause.
  d = decideAudioSpend(ctx(fresh(), 30));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NEED_CREDITS');
  assert.equal(d.freeTrialsRemaining, 0);

  // Total free audio allowance for the whole lifetime of the account: 2 minutes.
  assert.equal(freeTrialTotalMaxDurationSeconds(1), 120);
  assert.equal(freeTrialTotalMaxDurationSeconds(1) / 60, 2);
  assert.equal(freeTrialTotalMaxDurationSeconds(config.freeTrialLimit), 120);
  // Free trials never move credits or write a credit ledger entry.
  assert.equal(service.getBalance(fresh().id), 0);
  assert.equal(allTxns(service, fresh().id).length, 0);
});

test('FROZEN POLICY: FREE_TRIAL_LIMIT is 1 and the per-trial cap is 2 minutes', () => {
  assert.equal(config.freeTrialLimit, 1);
  assert.equal(FREE_TRIAL_MAX_DURATION_SECONDS, 120);
  // There is no way to obtain a second free trial.
  assert.equal(isFreeTrialExhausted(0, config.freeTrialLimit), false);
  assert.equal(isFreeTrialExhausted(1, config.freeTrialLimit), true);
  assert.equal(freeTrialsRemaining(1, config.freeTrialLimit), 0);
  assert.equal(freeTrialsRemaining(5, config.freeTrialLimit), 0);
  // Total free usage can never exceed 2:00.
  assert.equal(freeTrialTotalMaxDurationSeconds(config.freeTrialLimit), 120);
});

test('a >2-minute file can never be split across multiple free trials', async () => {
  const { users, user } = await makeWallet(0);
  const fresh = () => users.getById(user.id) as UserRecord;

  // A 10-minute upload is refused outright and repeatedly. Even after 5
  // attempts the counter is untouched, so no amount of retrying yields free
  // audio, and the file is never chopped up to fit the 2-minute trial.
  for (let i = 0; i < 5; i += 1) {
    const d = decideAudioSpend(ctx(fresh(), 600));
    assert.equal(d.ok, false);
    assert.equal(d.kind, 'FREE_TRIAL_DURATION_LIMIT');
    assert.equal(d.freeTrialsUsed, 0, 'a refused over-length request never consumes the trial');
    assert.equal(fresh().freeTrialsUsed, 0);
  }
  // The refusal message points the user at credits.
  const d = decideAudioSpend(ctx(fresh(), 600));
  assert.equal(d.message, FREE_TRIAL_DURATION_LIMIT_MESSAGE);
});

test('a FAILED run never consumes the trial: the counter is only incremented on success', () => {
  // Structural guarantee on server.ts: the single incrementFreeTrialsUsed()
  // call must sit INSIDE the post-success accounting block and AFTER the
  // provider transcription, so any thrown provider/API/server error jumps to
  // the catch block and skips the increment entirely.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', '..', 'server.ts'), 'utf8');

  const increment = src.indexOf('users.incrementFreeTrialsUsed(');
  const successMarker = src.indexOf('Success accounting');
  const transcription = src.indexOf('const rawTranscript =');
  const catchBlock = src.indexOf('} catch (error: any) {');

  assert.ok(increment > -1, 'server.ts must increment the free-trial counter somewhere');
  assert.ok(successMarker > -1, 'server.ts must keep the success-accounting block');
  assert.ok(transcription > -1, 'server.ts must transcribe before accounting');
  assert.ok(catchBlock > -1, 'server.ts must wrap the pipeline in try/catch');

  assert.ok(
    transcription < increment,
    'the trial must be counted only AFTER the provider transcription succeeded'
  );
  assert.ok(
    increment > successMarker && increment < catchBlock,
    'the trial increment must live inside the post-success block, before the catch handler'
  );

  // The failure path releases a paid reservation and must NOT touch the trial.
  const catchBody = src.slice(catchBlock, catchBlock + 2200);
  assert.ok(
    !catchBody.includes('incrementFreeTrialsUsed'),
    'the failure/catch path must never consume a free trial'
  );
});

test('a refused over-length free trial does not consume the trial (only success does)', async () => {
  const { users, user } = await makeWallet(0);
  const fresh = () => users.getById(user.id) as UserRecord;

  // Refused twice for being too long.
  for (let i = 0; i < 2; i += 1) {
    const d = decideAudioSpend(ctx(fresh(), 300));
    assert.equal(d.ok, false);
    assert.equal(d.kind, 'FREE_TRIAL_DURATION_LIMIT');
  }
  assert.equal(fresh().freeTrialsUsed, 0, 'a blocked request must never consume a trial');

  // A later file that fits still runs on trial #1.
  const ok = decideAudioSpend(ctx(fresh(), 60));
  assert.equal(ok.kind, 'FREE_TRIAL');
  assert.equal(ok.freeTrialsRemaining, 1);
});

test('a user WITH credits may still process a >2:00 file (paid, not free)', () => {
  const rich = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 10 } as UserRecord;
  const d = decideAudioSpend(ctx(rich, 300));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'PAID');
  assert.equal(d.requiredCredits, 5); // 1 credit = 1 minute, rounded up
  // The trial is untouched: paying does not burn free allowance.
  assert.equal(d.freeTrialsUsed, 0);
  assert.equal(d.freeTrialsRemaining, 1);
});

test('an unmeasurable duration cannot be served by a free trial (fails closed)', () => {
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 0 } as UserRecord;
  const d = decideAudioSpend(ctx(w, 0));
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'NO_DURATION');
  assert.equal(d.status, 422);
  assert.equal(d.freeTrialsUsed, 0);
});

test('saved-SRT reuse stays free: it short-circuits BEFORE this gate and never consumes a trial', () => {
  // Reuse is a server.ts short-circuit, not a gate decision: the saved-SRT
  // `return res.json({ ... reusedSrt: true })` must be reached BEFORE
  // decideAudioSpend(), so it can neither consume a trial nor be refused for
  // exceeding the 2-minute free cap. This pins that ordering as a contract.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', '..', 'server.ts'), 'utf8');
  const reuseReturn = src.indexOf('reusedSrt: true,');
  const gateCall = src.indexOf('decideAudioSpend(');
  assert.ok(reuseReturn > -1, 'the saved-SRT reuse return must exist in server.ts');
  assert.ok(gateCall > -1, 'decideAudioSpend must still be called in server.ts');
  assert.ok(
    reuseReturn < gateCall,
    'the saved-SRT reuse return must come BEFORE decideAudioSpend so reuse is free and consumes no trial'
  );
  // The reuse response advertises zero charge and no trial consumption.
  assert.match(src, /charge:\s*\{\s*kind:\s*'REUSE',\s*requiredCredits:\s*0\s*\}/);
  assert.match(src, /no free trial or credit was consumed/);
});

test('after 2 successful trials, credits are used and the ledger shows PURCHASE-style usage', async () => {
  const { service, user, users } = await makeWallet(12, { freeTrialsUsed: 2 });
  // Manual operator adjustment (stands in for a future purchase): the ONLY
  // credit source, recorded as ADMIN_ADJUSTMENT (never a fake PURCHASE).
  service.adminAdjustCredits({
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
  assert.ok(types.includes('ADMIN_ADJUSTMENT'));
  assert.ok(types.includes('RESERVATION'));
  assert.ok(types.includes('USAGE'));
  assert.ok(!types.includes('PURCHASE'));
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

test('kill switch blocks EVERY caller (no bypass) with the exact product message', async () => {
  const safety = await makeSafety();
  // Drive the real env -> config path: the switch is a lazy getter, so it must be
  // exercised through process.env rather than by assigning the config field.
  const previous = process.env.PROVIDER_KILL_SWITCH;
  process.env.PROVIDER_KILL_SWITCH = 'true';
  try {
    for (const user of [
      { id: 'n', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 100 } as UserRecord, // free trial
      { id: 'e', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord, // paid, enough credits
      { id: 'u', creditMode: 'UNLIMITED', freeTrialsUsed: 0, credits: 0 } as UserRecord, // admin/unlimited
    ]) {
      const d = decideAudioSpend({ ...ctx(user, 60), providerBlocked: safety.isBlocked() });
      assert.equal(d.ok, false);
      assert.equal(d.kind, 'PROVIDER_UNAVAILABLE');
      assert.equal(d.status, 503);
      assert.equal(d.message, PROVIDER_UNAVAILABLE_MESSAGE);
    }
    // Anonymous callers are NOT exempt from the hard stop.
    const anon = decideAudioSpend({
      user: null,
      measuredDurationSeconds: 60,
      freeTrialLimit: 2,
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(anon.ok, false);
    assert.equal(anon.kind, 'PROVIDER_UNAVAILABLE');
    const view = safety.view();
    assert.equal(view.blocked, true);
    assert.equal(view.status, 'BLOCKED');
    assert.equal(view.reason, 'KILL_SWITCH');
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_KILL_SWITCH;
    else process.env.PROVIDER_KILL_SWITCH = previous;
  }
});

test('spending protection ON does NOT block: free-trial and paid callers both pass the gate', async () => {
  // The production posture (protection=true, kill-switch=false) must allow
  // transcription while every credit/trial rule below still applies.
  const safety = await makeSafety();
  const prevSpend = process.env.PROVIDER_SPENDING_PROTECTION;
  const prevKill = process.env.PROVIDER_KILL_SWITCH;
  process.env.PROVIDER_SPENDING_PROTECTION = 'true';
  process.env.PROVIDER_KILL_SWITCH = 'false';
  try {
    assert.equal(safety.isBlocked(), false);
    // A free-trial user with credits left is allowed (trial budget available).
    const trial = decideAudioSpend({
      ...ctx({ id: 'n', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 0 } as UserRecord, 60),
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(trial.ok, true);
    assert.equal(trial.kind, 'FREE_TRIAL');
    // F: the trial COUNT cap is still enforced — a user who used both trials
    // falls through to the PAID path and can never get a third free run.
    const usedUp = decideAudioSpend({
      ...ctx({ id: 'n2', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord, 60),
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(usedUp.kind, 'PAID', 'trials exhausted -> must pay, not run free');
    // H: an empty wallet still cannot spend.
    const broke = decideAudioSpend({
      ...ctx({ id: 'n4', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 0 } as UserRecord, 60),
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(broke.ok, false);
    assert.equal(broke.kind, 'NEED_CREDITS');
    assert.equal(broke.status, 402);
    // G: the 2-MINUTE per-trial duration cap is still enforced (2:01 refused,
    // and the trial is NOT consumed by that refusal).
    const tooLong = decideAudioSpend({
      ...ctx({ id: 'n3', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 0 } as UserRecord, 121),
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.kind, 'FREE_TRIAL_DURATION_LIMIT');
    // 2:00 exactly is still accepted — the cap must not be tightened by accident.
    const edge = decideAudioSpend({
      ...ctx({ id: 'n5', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 0 } as UserRecord, 120),
      providerBlocked: safety.isBlocked(),
    });
    assert.equal(edge.ok, true);
    assert.equal(edge.kind, 'FREE_TRIAL');
  } finally {
    if (prevSpend === undefined) delete process.env.PROVIDER_SPENDING_PROTECTION;
    else process.env.PROVIDER_SPENDING_PROTECTION = prevSpend;
    if (prevKill === undefined) delete process.env.PROVIDER_KILL_SWITCH;
    else process.env.PROVIDER_KILL_SWITCH = prevKill;
  }
});

test('a real 402 blocks the provider until an admin reset, and never auto-recharges', async () => {
  const safety = await makeSafety();
  const w = { id: 'u', creditMode: 'NORMAL', freeTrialsUsed: 2, credits: 100 } as UserRecord;
  assert.equal(decideAudioSpend(ctx(w, 60)).ok, true);
  assert.equal(safety.isBlocked(), false);

  // The provider really reported HTTP 402 insufficient_quota ("no credits available").
  const failure = classifyProviderFailure({
    message:
      'Sarvam job initiate failed (HTTP 402): {"error":{"code":"insufficient_quota_error","message":"No credits available"}}',
  });
  assert.equal(failure.kind, 'QUOTA_EXHAUSTED');
  assert.equal(failure.transient, false);
  const blockedView = safety.reportFailure(failure);
  assert.equal(blockedView.status, 'BLOCKED');
  assert.equal(blockedView.reason, 'QUOTA_EXHAUSTED');
  assert.equal(blockedView.lastHttpStatus, 402);
  assert.equal(blockedView.lastErrorAt != null, true);
  assert.equal(blockedView.blockedAt != null, true);
  // No balance is invented: this provider has no verified balance/quota API.
  assert.equal(blockedView.balance.known, false);
  assert.equal(blockedView.balance.percent, null);
  assert.equal(blockedView.balanceSourceAvailable, false);

  // The gate now blocks the next request with the SAME product message, and the
  // gate throws before any provider call.
  const blocked = decideAudioSpend({ ...ctx(w, 60), providerBlocked: safety.isBlocked() });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'PROVIDER_UNAVAILABLE');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.message, PROVIDER_UNAVAILABLE_MESSAGE);
  assert.throws(() => safety.assertProviderSpendingAllowed(), /temporarily unavailable/i);

  // A restart must not silently re-enable the provider: the state is persisted.
  const reloaded = await (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-safety-reload-'));
    const file = path.join(dir, 'app.db.json');
    const first = new DataStore(file);
    await first.init();
    const repo = new ProviderSafetyRepo(first);
    const svc = new ProviderSafetyService({
      provider: 'sarvam',
      get: () => repo.get('sarvam'),
      patch: (patch) => repo.patch('sarvam', patch),
      setStatus: (p, status, reason, patch) => repo.setStatus(p, status, reason, patch),
      notifyOwner: () => ({ delivered: false }),
    });
    svc.reportFailure(failure);
    await new Promise((r) => setTimeout(r, 60));
    const second = new DataStore(file);
    await second.init();
    const repo2 = new ProviderSafetyRepo(second);
    return new ProviderSafetyService({
      provider: 'sarvam',
      get: () => repo2.get('sarvam'),
      patch: (patch) => repo2.patch('sarvam', patch),
      setStatus: (p, status, reason, patch) => repo2.setStatus(p, status, reason, patch),
      notifyOwner: () => ({ delivered: false }),
    });
  })();
  assert.equal(reloaded.view().status, 'BLOCKED');
  assert.throws(() => reloaded.assertProviderSpendingAllowed(), /temporarily unavailable/i);

  // Only an explicit admin reset (after the operator adds provider credits)
  // returns the provider to AVAILABLE.
  const reset = reloaded.resetToAvailable('officeaipro6@gmail.com');
  assert.equal(reset.status, 'AVAILABLE');
  assert.equal(reset.reason, null);
  assert.equal(reset.blocked, false);
  assert.equal(reset.lastResetBy, 'officeaipro6@gmail.com');
  assert.equal(reset.lastResetAt != null, true);
  assert.doesNotThrow(() => reloaded.assertProviderSpendingAllowed());
});

test('real payment system exists with Razorpay integration', () => {
  const src = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const serviceSrc = fs.readFileSync(new URL('./razorpayService.ts', import.meta.url), 'utf8');
  // The payment system is now implemented with Razorpay integration.
  // Verify the purchase routes exist in server.ts
  assert.match(src, /app\.post\(['"`]\/api\/credits\/purchase\/order['"`]/);
  assert.match(src, /app\.post\(['"`]\/api\/credits\/purchase\/verify['"`]/);
  assert.match(src, /app\.post\(['"`]\/api\/credits\/purchase\/webhook['"`]/);
  // Razorpay SDK is imported in razorpayService
  assert.match(serviceSrc, /from\s+['"]razorpay['"]/);
  // PURCHASE ledger entries are now created for verified payments
  const service = fs.readFileSync(new URL('./creditService.ts', import.meta.url), 'utf8');
  assert.match(service, /recordPurchase/);
  assert.match(service, /findByPaymentId/);
});

test('ledger supports every transaction type required by the product spec', () => {
  const types = fs.readFileSync(new URL('../db/types.ts', import.meta.url), 'utf8');
  for (const required of ['FREE_TRIAL', 'PURCHASE', 'RESERVATION', 'USAGE', 'RELEASE', 'REFUND', 'ADMIN_ADJUSTMENT']) {
    assert.match(types, new RegExp(`'${required}'`), `${required} is a supported ledger type`);
  }
});
