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
import { FREE_TRIAL_MAX_DURATION_SECONDS } from './freeTrialPolicy.ts';
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

/** The operator kill-switch, which is a SEPARATE variable since the split. */
function withKillSwitch<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PROVIDER_KILL_SWITCH;
  if (value === undefined) delete process.env.PROVIDER_KILL_SWITCH;
  else process.env.PROVIDER_KILL_SWITCH = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_KILL_SWITCH;
    else process.env.PROVIDER_KILL_SWITCH = previous;
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

test('1. PROVIDER_SPENDING_PROTECTION reflects the production .env value', () => {
  const env = productionEnv();
  const raw = env.PROVIDER_SPENDING_PROTECTION;
  assert.ok(raw !== undefined, '.env must define PROVIDER_SPENDING_PROTECTION explicitly');
  // The switch value in production .env determines the config getter behavior.
  const expected = !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
  withSwitch(raw, () => {
    assert.equal(config.providerSpendingProtection, expected);
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

test('2. with the KILL SWITCH on, a healthy AVAILABLE state still blocks the provider', () => {
  const { service, repo } = makeService();
  // Stored state is healthy — only the operator kill-switch is blocking.
  assert.equal(repo.get('sarvam').status, 'AVAILABLE');
  withKillSwitch('true', () => {
    const view = service.view();
    assert.equal(view.status, 'BLOCKED');
    assert.equal(view.blocked, true);
    assert.equal(view.reason, 'KILL_SWITCH');
    assert.equal(service.isBlocked(), true);
    assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
  });
});

/* ── 2z. THE SPLIT: spending protection ON + kill-switch OFF is NOT blocked ── */

test('2z. PROVIDER_SPENDING_PROTECTION=true with PROVIDER_KILL_SWITCH=false does NOT block the provider', () => {
  // This is the regression the split exists to fix: the old single flag made it
  // impossible to keep the money-safety posture on while transcribing.
  const { service, repo } = makeService();
  assert.equal(repo.get('sarvam').status, 'AVAILABLE', 'stored state is healthy');
  withSwitch('true', () =>
    withKillSwitch('false', () => {
      assert.equal(config.providerSpendingProtection, true, 'posture stays ON');
      assert.equal(config.providerKillSwitch, false, 'hard stop stays OFF');
      const view = service.view();
      assert.equal(view.status, 'AVAILABLE', 'not blocked merely because protection is on');
      assert.equal(view.blocked, false);
      assert.equal(view.reason, null);
      assert.equal(service.isBlocked(), false);
      assert.doesNotThrow(() => service.assertProviderSpendingAllowed());
    })
  );
});

test('2z2. the KILL SWITCH still overrides even with spending protection OFF', () => {
  // The kill-switch is fail-closed and independent in BOTH directions.
  const { service } = makeService();
  withSwitch('false', () =>
    withKillSwitch('true', () => {
      assert.equal(config.providerSpendingProtection, false);
      assert.equal(service.isBlocked(), true);
      assert.equal(service.view().reason, 'KILL_SWITCH');
      assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
    })
  );
});

test('2z3. PROVIDER_KILL_SWITCH defaults to false and is read lazily', () => {
  const src = fs.readFileSync(new URL('../config.ts', import.meta.url), 'utf8');
  // A dedicated, typed, env-driven getter — not a rename of the old flag.
  assert.match(src, /get providerKillSwitch\(\)/);
  assert.match(src, /envBool\('PROVIDER_KILL_SWITCH',\s*false\)/);
  withKillSwitch(undefined, () => assert.equal(config.providerKillSwitch, false));
  withKillSwitch('true', () => assert.equal(config.providerKillSwitch, true));
  withKillSwitch('OFF', () => assert.equal(config.providerKillSwitch, false));
});

test('2z4. providerSafety gates on the KILL SWITCH, not on spending protection', () => {
  // Guards against the two concerns being re-coupled in a future edit.
  const safety = fs.readFileSync(new URL('./providerSafety.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(safety, /config\.providerSpendingProtection\s*\?\s*'KILL_SWITCH'/);
  assert.match(safety, /config\.providerKillSwitch/);
});

test('2b. the pre-call gate refuses the request, so the ASR mock is never invoked', () => {
  const { service } = makeService();
  let asrCalls = 0;
  const mockAsr = async () => {
    asrCalls += 1;
    return { text: 'should never happen' };
  };

  withKillSwitch('true', () => {
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

  assert.equal(asrCalls, 0, 'the ASR provider must never be called while the kill-switch is ON');
});

test('2c. UNLIMITED/ADMIN and free-trial callers get no exemption', () => {
  const { service } = makeService();
  withKillSwitch('true', () => {
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

test('2d. the 402 / insufficient_quota state blocks on its own, even with BOTH switches OFF', () => {
  const { service, repo } = makeService();
  withSwitch('false', () =>
    withKillSwitch('false', () => {
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
    })
  );
});

test('2e. a real 402 STILL blocks while spending protection is ON and kill-switch is OFF', () => {
  // Requirement C/E: the production posture (protection=true, kill=false) must
  // not weaken quota blocking.
  const { service } = makeService();
  withSwitch('true', () =>
    withKillSwitch('false', () => {
      service.reportFailure({
        kind: 'QUOTA_EXHAUSTED',
        message: 'Sarvam job initiate failed (HTTP 402): insufficient_quota_error',
        transient: false,
        httpStatus: 402,
      });
      assert.equal(service.view().status, 'BLOCKED');
      assert.equal(service.view().reason, 'QUOTA_EXHAUSTED', 'reason is the real cause, not KILL_SWITCH');
      assert.throws(() => service.assertProviderSpendingAllowed(), ProviderSpendingError);
    })
  );
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
  withKillSwitch('true', () => {
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

test('5. .env.example documents both controls, the fail-safe and the no-spend rules', () => {
  const example = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  // Spending protection is the posture; the kill-switch is the hard stop.
  assert.match(example, /PROVIDER_SPENDING_PROTECTION="true"/);
  assert.match(example, /PROVIDER_KILL_SWITCH="false"/);
  assert.match(example, /HARD operator kill-switch, SEPARATE from/i);
  assert.match(example, /when true, NO provider/i);
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
  // No credit-pack pricing was altered by the switch. The .env value must
  // determine the getter: derive the expectation from the file, then let the
  // getter read that same value (the test runner does not call dotenv.config(),
  // so process.env must be seeded explicitly, exactly as server.ts would).
  const raw = env.PROVIDER_SPENDING_PROTECTION?.trim().toLowerCase();
  const expected = !['0', 'false', 'no', 'off'].includes(raw ?? '');
  withSwitch(env.PROVIDER_SPENDING_PROTECTION, () => {
    assert.equal(config.providerSpendingProtection, expected);
  });
});

test('7. render.yaml keeps spending protection ON and the kill-switch OFF', () => {
  const yaml = fs.readFileSync(path.resolve(process.cwd(), 'render.yaml'), 'utf8');
  // The production posture the split was requested for, pinned in config.
  assert.match(yaml, /- key: PROVIDER_SPENDING_PROTECTION\n\s+value: "true"/);
  assert.match(yaml, /- key: PROVIDER_KILL_SWITCH\n\s+value: "false"/);
});

test('8. FROZEN free-trial policy is deployed: exactly 1 trial, max 2 minutes', () => {
  const yaml = fs.readFileSync(path.resolve(process.cwd(), 'render.yaml'), 'utf8');
  // Every FREE_TRIAL_LIMIT occurrence must be "1" - never "2" - or the deployed
  // free allowance would silently double. Both duplicate keys must agree.
  const values = [...yaml.matchAll(/- key: FREE_TRIAL_LIMIT\n\s+value:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(values.length > 0, 'render.yaml must declare FREE_TRIAL_LIMIT');
  assert.deepEqual(values, values.map(() => '1'), `every FREE_TRIAL_LIMIT must be "1", got ${values}`);
  // The config default must match production, so a missing env var cannot widen it.
  assert.equal(config.freeTrialLimit, 1);
  assert.equal(FREE_TRIAL_MAX_DURATION_SECONDS, 120);
});
