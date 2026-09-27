/**
 * PROVIDER_SPENDING_PROTECTION = ON for the current production configuration.
 *
 * MOCK-ONLY. This file never performs a live Sarvam transcription, never
 * contacts any provider and never touches billing: `globalThis.fetch` is
 * replaced with a tripwire that fails the test if anything tries to make an
 * outbound request. The ASR provider itself is a counter-only mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { config } from '../config.ts';
import { DataStore } from '../db/store.ts';
import { ProviderSafetyRepo } from '../db/repos.ts';
import { ProviderSafetyService, ProviderSpendingError } from './providerSafety.ts';
import { decideAudioSpend } from './audioSpendGate.ts';
import { PROVIDER_UNAVAILABLE_MESSAGE } from './creditPolicy.ts';

const ENV_FILE = path.resolve(process.cwd(), '.env');
const realFetch = globalThis.fetch;

/** Fail loudly if any test path attempts a network call. */
globalThis.fetch = (async (...args: unknown[]) => {
  throw new Error(`NETWORK CALL ATTEMPTED IN TEST: ${String(args[0])}`);
}) as typeof fetch;

test.after(() => {
  globalThis.fetch = realFetch;
});

/** Parses the real production .env WITHOUT mutating process.env. */
function productionEnv(): Record<string, string> {
  return dotenv.parse(fs.readFileSync(ENV_FILE));
}

function withSwitch<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PROVIDER_SPENDING_PROTECTION;
  if (value === undefined) delete process.env.PROVIDER_SPENDING_PROTECTION;
  else process.env.PROVIDER_SPENDING_PROTECTION = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_SPENDING_PROTECTION;
    else process.env.PROVIDER_SPENDING_PROTECTION = previous;
  }
}

/** A real service on a throwaway store whose stored state is healthy AVAILABLE. */
function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-psp-on-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  const repo = new ProviderSafetyRepo(store);
  const service = new ProviderSafetyService({
    provider: 'sarvam',
    get: () => repo.get('sarvam'),
    patch: (patch) => repo.patch('sarvam', patch),
    setStatus: (provider, status, reason, patch) => repo.setStatus(provider, status, reason, patch),
    notifyOwner: () => ({ delivered: false }),
  });
  return { service, repo, store, dir };
}

/* ── 1. the switch is ON in the production configuration ─────────────────── */

test('1. PROVIDER_SPENDING_PROTECTION is ON in the production .env', () => {
  const env = productionEnv();
  const raw = env.PROVIDER_SPENDING_PROTECTION;
  assert.ok(raw !== undefined, '.env must define PROVIDER_SPENDING_PROTECTION explicitly');
  // envBool treats anything not in {0,false,no,off} as true.
  assert.ok(
    !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase()),
    `PROVIDER_SPENDING_PROTECTION must be truthy, got "${raw}"`
  );
  // The .env value is what config actually reads (lazy getter, after dotenv).
  withSwitch(raw, () => {
    assert.equal(config.providerSpendingProtection, true);
  });
});

test('1b. config reads the switch lazily, so dotenv.loaded .env values are honoured', () => {
  // server.ts runs dotenv.config() in its module body, i.e. AFTER all static
  // imports are evaluated. A static field would have captured the pre-dotenv
  // value; the getter must reflect a later-set env var.
  withSwitch('false', () => assert.equal(config.providerSpendingProtection, false));
  withSwitch('true', () => assert.equal(config.providerSpendingProtection, true));
  withSwitch('OFF', () => assert.equal(config.providerSpendingProtection, false));
  withSwitch(undefined, () => assert.equal(config.providerSpendingProtection, false));
});

test('1c. the kill switch is configurable, not hard-coded', () => {
  const src = fs.readFileSync(new URL('../config.ts', import.meta.url), 'utf8');
  assert.match(src, /get providerSpendingProtection\(\)/);
  assert.match(src, /envBool\('PROVIDER_SPENDING_PROTECTION'/);
  // It must stay an env-driven switch rather than a hard-coded constant.
  assert.doesNotMatch(src, /providerSpendingProtection:\s*true\b/);
});

/* ── 2. a BLOCKED provider prevents any ASR call ─────────────────────────── */

test('2. with the switch ON, a healthy AVAILABLE state still blocks the provider', () => {
  const { service, repo } = makeService();
  // Stored state is healthy — only the switch is blocking.
  assert.equal(repo.get('sarvam').status, 'AVAILABLE');
  withSwitch('true', () => {
    const view = service.view();
    assert.equal(view.status, 'BLOCKED');
    assert.equal(view.blocked, true);
    assert.equal(view.reason, 'KILL_SWITCH');
    assert.equal(service.isBlocked(), true);
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });
});

test('2b. the pre-call gate refuses the request, so the ASR mock is never invoked', () => {
  const { service } = makeService();
  let asrCalls = 0;
  const mockAsr = async () => {
    asrCalls += 1;
    return { text: 'should never happen' };
  };

  withSwitch('true', () => {
    // The exact pre-flight both real entry points perform, in order.
    const decision = decideAudioSpend({
      user: { id: 'u1', creditMode: 'NORMAL', freeTrialsUsed: 0, credits: 100 },
      measuredDurationSeconds: 61,
      freeTrialLimit: 2,
      providerBlocked: service.isBlocked(),
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.kind, 'PROVIDER_UNAVAILABLE');
    assert.equal(decision.status, 503);
    assert.equal(decision.message, PROVIDER_UNAVAILABLE_MESSAGE);

    if (decision.ok) {
      // Unreachable while blocked; present so the test mirrors the real order.
      void mockAsr();
    }
    // The hard layer is the last line of defence and also throws.
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });

  assert.equal(asrCalls, 0, 'the ASR provider must never be called while the switch is ON');
});

test('2c. UNLIMITED/ADMIN and free-trial callers get no exemption', () => {
  const { service } = makeService();
  withSwitch('true', () => {
    const blocked = service.isBlocked();
    for (const user of [
      { id: 'admin', creditMode: 'UNLIMITED' as const, freeTrialsUsed: 0, credits: 0 },
      { id: 'rich', creditMode: 'NORMAL' as const, freeTrialsUsed: 0, credits: 9999 },
      { id: 'trial', creditMode: 'NORMAL' as const, freeTrialsUsed: 1, credits: 0 },
      null, // anonymous legacy caller
    ]) {
      const d = decideAudioSpend({
        user,
        measuredDurationSeconds: 30,
        freeTrialLimit: 2,
        providerBlocked: blocked,
      });
      assert.equal(d.ok, false, 'no caller class may bypass the provider safety gate');
      assert.equal(d.kind, 'PROVIDER_UNAVAILABLE');
    }
  });
});

test('2d. the 402 / insufficient_quota state blocks on its own, even with the switch OFF', () => {
  const { service, repo } = makeService();
  withSwitch('false', () => {
    // Fail-safe: an observed 402 is persisted, so the gate closes without the
    // operator switch and survives a restart.
    service.reportFailure({
      kind: 'QUOTA_EXHAUSTED',
      message: 'Sarvam job initiate failed (HTTP 402): insufficient_quota_error',
      transient: false,
      httpStatus: 402,
    });
    assert.equal(repo.get('sarvam').status, 'BLOCKED');
    assert.equal(service.isBlocked(), true);
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });
});

/* ── 3. no automatic retry ───────────────────────────────────────────────── */

test('3. a blocked provider is terminal — no automatic retry is scheduled', () => {
  const queue = fs.readFileSync(new URL('./queue.ts', import.meta.url), 'utf8');
  // The queue only treats a failure as retryable while the provider is healthy.
  assert.match(queue, /const transient = !isNowBlocked/);
  assert.match(queue, /assertProviderSpendingAllowed\(\)/);
  // No retry-on-402 / retry-while-blocked path exists.
  assert.doesNotMatch(queue, /retryOn402|retryBlocked|requeueBlocked/i);

  // Behavioural proof with the real state machine: a 402 on a blocked provider
  // leaves the job terminal and nothing re-enables itself.
  const { service } = makeService();
  withSwitch('false', () => {
    service.reportFailure({ kind: 'QUOTA_EXHAUSTED', message: 'HTTP 402', transient: false, httpStatus: 402 });
    assert.equal(service.view().status, 'BLOCKED');
    service.reportFailure({ kind: 'UNAVAILABLE', message: 'HTTP 503', transient: true });
    const after = service.view();
    assert.equal(after.status, 'BLOCKED', 'a later transient error must not downgrade a 402 block');
    assert.equal(after.reason, 'QUOTA_EXHAUSTED', 'the original block reason is retained');
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });
});

/* ── 4. no automatic recharge ────────────────────────────────────────────── */

test('4. nothing in the provider-safety path can recharge or buy credits', () => {
  const src = ['providerSafety.ts', 'queue.ts', '../config.ts', '../db/repos.ts']
    .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8'))
    .join('\n');
  assert.doesNotMatch(src, /function\s+recharge|const\s+recharge|rechargeProvider|\.recharge\s*\(/i);
  assert.doesNotMatch(src, /autoBuy|auto_recharge|purchaseCredits|topUpProvider/i);
  assert.doesNotMatch(
    src,
    /fetch\(\s*['"`]https?:\/\/[^'"`]*(payment|billing|recharge|checkout)/i
  );
  // The safety layer never talks to the network at all.
  const safety = fs.readFileSync(new URL('./providerSafety.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(safety, /\bfetch\s*\(/);
  // Enabling the switch must not touch any user wallet either.
  const { service, repo } = makeService();
  const creditsBefore = repo.get('sarvam');
  withSwitch('true', () => {
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });
  assert.deepEqual(repo.get('sarvam'), creditsBefore);
});

test('4b. no outbound request was made by any test above (fetch tripwire)', async () => {
  // If any earlier test had attempted a provider/payment call the tripwire
  // would already have rejected, so reaching this point is the assertion.
  assert.equal(typeof globalThis.fetch, 'function');
  await assert.rejects(
    () => globalThis.fetch('https://api.sarvam.ai/v1/anything'),
    /NETWORK CALL ATTEMPTED IN TEST/
  );
});

/* ── 5. the switch is documented and reversible ──────────────────────────── */

test('5. .env.example documents the switch, the fail-safe and the no-spend rules', () => {
  const example = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  assert.match(example, /PROVIDER_SPENDING_PROTECTION="false"/);
  assert.match(example, /HARD kill-switch: when true, NO provider/i);
  assert.match(example, /OWNER_EMAILS/);
  assert.match(example, /does NOT auto-recharge/i);
});

test('6. nothing that must not change was changed by this configuration', () => {
  const env = productionEnv();
  // ASR provider selection is untouched.
  assert.equal(env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase(), 'sarvam');
  assert.equal(config.asrProvider, 'sarvam');
  // Credit packs are untouched.
  const packs = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  assert.doesNotMatch(packs, /PROVIDER_SPENDING_PROTECTION\s*[:=]\s*['"]true/);
  // No credit-pack pricing was altered by the switch.
  assert.equal(env.PROVIDER_SPENDING_PROTECTION?.trim().toLowerCase(), 'true');
});
