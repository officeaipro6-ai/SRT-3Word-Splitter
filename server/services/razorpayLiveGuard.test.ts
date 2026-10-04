/**
 * Stage 6B — Razorpay LIVE guard.
 *
 * THE DEFECT THIS LOCKS DOWN
 * -------------------------
 * `readRazorpayConfig()` computed a `testMode` flag and stored it on the config,
 * but nothing ever read it. There was therefore no code-level obstacle to
 * dropping LIVE key IDs into the environment: the application would build a LIVE
 * Razorpay client and take real money while every human still believed it was in
 * TEST mode.
 *
 * The contract now:
 *   - RAZORPAY_LIVE_ENABLED defaults to FALSE, so substituting a key alone can
 *     never activate LIVE;
 *   - an obvious LIVE key (the `rzp_live_` prefix Razorpay issues) is rejected
 *     unless that switch is explicitly true;
 *   - LIVE additionally requires RAZORPAY_TEST_MODE=false, so credentials and
 *     declared mode can never contradict each other;
 *   - rejection returns null, which is this codebase's existing "payments are
 *     safely disabled" signal — the server treats a null config as unavailable;
 *   - TEST behaviour is completely unchanged.
 *
 * Nothing here enables LIVE, and no real credential appears in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readRazorpayConfig, razorpayLiveEnabled, razorpayLiveGuardReason } from './razorpayService.ts';

const RAZORPAY_ENV = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_TEST_MODE',
  'RAZORPAY_LIVE_ENABLED',
] as const;

type Env = Record<string, string | undefined>;

/** Applies `values`, runs `fn`, then restores the real environment exactly. */
function withEnv<T>(values: Env, fn: () => T): T {
  const previous: Env = {};
  for (const k of RAZORPAY_ENV) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of RAZORPAY_ENV) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k]!;
    }
  }
}

/** Obviously-fake credentials. The shapes are real; the values are not. */
const TEST_CREDS = {
  RAZORPAY_KEY_ID: 'rzp_test_FAKEtestkeyid0000',
  RAZORPAY_KEY_SECRET: 'fake-test-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'fake-test-webhook-secret',
} as const;

const LIVE_CREDS = {
  RAZORPAY_KEY_ID: 'rzp_live_FAKElivekeyid00000',
  RAZORPAY_KEY_SECRET: 'fake-live-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'fake-live-webhook-secret',
} as const;

// ---------------------------------------------------------------------------
// A. the switch defaults to false
// ---------------------------------------------------------------------------

test('6B-A. RAZORPAY_LIVE_ENABLED defaults to false', () => {
  withEnv({ RAZORPAY_LIVE_ENABLED: undefined }, () => {
    assert.equal(razorpayLiveEnabled(), false);
  });
});

test('6B-A2. only an explicit "true" enables LIVE', () => {
  for (const v of ['true', 'TRUE', ' True ']) {
    withEnv({ RAZORPAY_LIVE_ENABLED: v }, () =>
      assert.equal(razorpayLiveEnabled(), true, `RAZORPAY_LIVE_ENABLED=${v}`)
    );
  }
  for (const v of ['1', 'yes', 'on', 'false', '', '   ', 'livemaybe']) {
    withEnv({ RAZORPAY_LIVE_ENABLED: v }, () =>
      assert.equal(razorpayLiveEnabled(), false, `RAZORPAY_LIVE_ENABLED=${JSON.stringify(v)}`)
    );
  }
});

// ---------------------------------------------------------------------------
// B. TEST configuration remains usable — unchanged behaviour
// ---------------------------------------------------------------------------

test('6B-B. an ordinary TEST configuration is still accepted', () => {
  withEnv({ ...TEST_CREDS, RAZORPAY_LIVE_ENABLED: undefined, RAZORPAY_TEST_MODE: undefined }, () => {
    const config = readRazorpayConfig();
    assert.ok(config, 'TEST must keep working exactly as before');
    assert.equal(config!.keyId, TEST_CREDS.RAZORPAY_KEY_ID);
    assert.equal(config!.keySecret, TEST_CREDS.RAZORPAY_KEY_SECRET);
    assert.equal(config!.webhookSecret, TEST_CREDS.RAZORPAY_WEBHOOK_SECRET);
    assert.equal(config!.testMode, true, 'TEST mode is still the default');
    assert.equal(razorpayLiveGuardReason(), null);
  });
});

test('6B-B2. TEST still works with LIVE explicitly disabled', () => {
  withEnv({ ...TEST_CREDS, RAZORPAY_LIVE_ENABLED: 'false' }, () => {
    assert.ok(readRazorpayConfig(), 'disabling LIVE must not disturb TEST');
  });
});

test('6B-B3. incomplete credentials still return null, unchanged', () => {
  withEnv({ RAZORPAY_KEY_ID: TEST_CREDS.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: undefined }, () => {
    assert.equal(readRazorpayConfig(), null);
  });
});

// ---------------------------------------------------------------------------
// C. an obvious LIVE key is rejected while LIVE is not enabled
// ---------------------------------------------------------------------------

test('6B-C. a LIVE key is rejected when RAZORPAY_LIVE_ENABLED is not true', () => {
  withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: undefined, RAZORPAY_TEST_MODE: undefined }, () => {
    assert.equal(
      readRazorpayConfig(),
      null,
      'no LIVE client may be constructed from a LIVE key by default'
    );
    const reason = razorpayLiveGuardReason();
    assert.ok(reason, 'the rejection must be explained');
    assert.match(reason, /LIVE key/i);
    assert.match(reason, /RAZORPAY_LIVE_ENABLED/);
  });
});

test('6B-C2. substituting a LIVE key alone does not activate LIVE', () => {
  // The exact accident this guard exists for: only the key changed.
  withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: undefined, RAZORPAY_TEST_MODE: 'true' }, () => {
    assert.equal(readRazorpayConfig(), null);
  });
});

test('6B-C3. a non-"true" LIVE_ENABLED value does not unlock a LIVE key', () => {
  for (const v of ['1', 'yes', 'on', 'false', '', 'true ']) {
    withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: v }, () => {
      if (!razorpayLiveEnabled()) {
        assert.equal(readRazorpayConfig(), null, `RAZORPAY_LIVE_ENABLED=${JSON.stringify(v)}`);
      }
    });
  }
});

test('6B-C4. LIVE credentials with TEST_MODE still true are rejected as contradictory', () => {
  withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: 'true', RAZORPAY_TEST_MODE: 'true' }, () => {
    assert.equal(readRazorpayConfig(), null, 'credentials and declared mode must not contradict');
    assert.match(razorpayLiveGuardReason()!, /RAZORPAY_TEST_MODE/);
  });
});

test('6B-C5. an explicitly, fully opted-in LIVE configuration is not blocked by the guard', () => {
  // This does NOT enable LIVE anywhere: it proves the guard is a gate, not a
  // permanent prohibition, so a deliberate future activation is still possible
  // through the explicit contract.
  withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: 'true', RAZORPAY_TEST_MODE: 'false' }, () => {
    assert.equal(razorpayLiveGuardReason(), null);
    const config = readRazorpayConfig();
    assert.ok(config, 'the explicit LIVE contract is accepted by the guard');
    assert.equal(config!.testMode, false);
  });
});

// ---------------------------------------------------------------------------
// D. no secret value appears in any message the guard produces
// ---------------------------------------------------------------------------

test('6B-D. no secret value appears in the guard reason', () => {
  const secrets = [
    LIVE_CREDS.RAZORPAY_KEY_ID,
    LIVE_CREDS.RAZORPAY_KEY_SECRET,
    LIVE_CREDS.RAZORPAY_WEBHOOK_SECRET,
    TEST_CREDS.RAZORPAY_KEY_ID,
    TEST_CREDS.RAZORPAY_KEY_SECRET,
    TEST_CREDS.RAZORPAY_WEBHOOK_SECRET,
  ];

  const cases: Array<[string, Env]> = [
    ['live default', { ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: undefined }],
    ['live + test mode', { ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: 'true', RAZORPAY_TEST_MODE: 'true' }],
    ['live enabled explicitly', { ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: 'true', RAZORPAY_TEST_MODE: 'false' }],
    ['test', { ...TEST_CREDS }],
  ];

  for (const [label, values] of cases) {
    withEnv(values, () => {
      const reason = razorpayLiveGuardReason();
      if (reason !== null) {
        for (const secret of secrets) {
          assert.ok(!reason.includes(secret), `${label}: the guard must not echo a credential`);
        }
        // Not even a partial fragment of the secret.
        assert.ok(!reason.includes(LIVE_CREDS.RAZORPAY_KEY_ID.slice(0, 9)));
        assert.ok(!reason.includes(LIVE_CREDS.RAZORPAY_KEY_SECRET.slice(0, 4)));
      }
    });
  }
});

test('6B-D2. a rejected LIVE configuration leaves nothing usable behind', () => {
  withEnv({ ...LIVE_CREDS, RAZORPAY_LIVE_ENABLED: undefined }, () => {
    // null is the codebase's existing "feature safely disabled" signal, and it
    // carries no credential, so nothing can leak through a response body.
    const config = readRazorpayConfig();
    assert.equal(config, null);
    assert.equal(JSON.stringify(config), 'null');
  });
});

// ---------------------------------------------------------------------------
// The guard must be enforced at the single point where the client is built
// ---------------------------------------------------------------------------

test('6B. server.ts builds its Razorpay client from the guarded config', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  assert.match(src, /readRazorpayConfig/);
  assert.match(
    src,
    /const razorpay = razorpayConfig \? createRazorpayInstance\(razorpayConfig\) : null;/,
    'the client must still be created only from readRazorpayConfig()'
  );
});