/**
 * Stage 6B — production provider fail-safe.
 *
 * THE DEFECT THIS LOCKS DOWN
 * -------------------------
 * `config.databaseProvider` returned 'json' for ANY value that was not exactly
 * "turso", and `config.storageProvider` returned 'local' for anything that was
 * not exactly "r2" — including an unset variable and a typo like "tursoo". On a
 * host with no persistent disk that is silent, total ledger loss on the next
 * restart, so a production process must now NAME its providers explicitly.
 *
 * Two things are deliberately preserved:
 *   - the getters still default to json/local, so local development and every
 *     existing test that relies on the default is untouched;
 *   - the assertion is a no-op unless NODE_ENV is exactly "production".
 *
 * This is about WHICH backend is selected. Whether that backend's credentials
 * are present is still the job of the existing gates in server.ts, which run
 * afterwards — so "production + turso" must be accepted here even with no
 * TURSO_* variables set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  config,
  assertProductionProviderSelection,
  isProduction,
  PRODUCTION_DATABASE_PROVIDER,
  PRODUCTION_STORAGE_PROVIDER,
} from './config.ts';

type Env = Record<string, string | undefined>;

/** Runs `fn` with exactly `values` applied to process.env, restoring it after. */
function withEnv<T>(values: Env, fn: () => T): T {
  const keys = ['NODE_ENV', 'DATABASE_PROVIDER', 'STORAGE_PROVIDER'] as const;
  const previous: Env = {};
  for (const k of keys) previous[k] = process.env[k];

  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k]!;
    }
  }
}

test('6B. production requires the production providers, and names them', () => {
  assert.equal(PRODUCTION_DATABASE_PROVIDER, 'turso');
  assert.equal(PRODUCTION_STORAGE_PROVIDER, 'r2');
});

// ---------------------------------------------------------------------------
// A. production + missing DATABASE_PROVIDER => fail
// ---------------------------------------------------------------------------

test('6B-A. production with DATABASE_PROVIDER unset fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: undefined, STORAGE_PROVIDER: 'r2' }, () => {
    assert.throws(() => assertProductionProviderSelection(), /DATABASE_PROVIDER is not set/);
  });
});

test('6B-A2. production with an empty DATABASE_PROVIDER fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: '   ', STORAGE_PROVIDER: 'r2' }, () => {
    assert.throws(() => assertProductionProviderSelection(), /DATABASE_PROVIDER is not set/);
  });
});

// ---------------------------------------------------------------------------
// B. production + json => fail
// ---------------------------------------------------------------------------

test('6B-B. production with the local json store fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: 'json', STORAGE_PROVIDER: 'r2' }, () => {
    assert.throws(() => assertProductionProviderSelection(), (err: Error) => {
      assert.match(err.message, /not permitted in production/);
      assert.match(err.message, /"json"/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// C. production + turso => accepted BEFORE credential validation
// ---------------------------------------------------------------------------

test('6B-C. production with turso/r2 is accepted without any credentials present', () => {
  // Credentials are absent on purpose: choosing the provider is not the same
  // question as configuring it, and the server.ts gates still enforce the rest.
  withEnv(
    { NODE_ENV: 'production', DATABASE_PROVIDER: 'turso', STORAGE_PROVIDER: 'r2' },
    () => {
      assert.equal(process.env.TURSO_DATABASE_URL, undefined);
      assert.equal(process.env.TURSO_AUTH_TOKEN, undefined);
      assert.doesNotThrow(() => assertProductionProviderSelection());
      // The getters resolve to the production providers...
      assert.equal(config.databaseProvider, 'turso');
      assert.equal(config.storageProvider, 'r2');
    }
  );
});

test('6B-C2. provider names are accepted case-insensitively and when padded', () => {
  withEnv(
    { NODE_ENV: 'production', DATABASE_PROVIDER: ' Turso ', STORAGE_PROVIDER: 'R2' },
    () => assert.doesNotThrow(() => assertProductionProviderSelection())
  );
});

// ---------------------------------------------------------------------------
// D. production + missing STORAGE_PROVIDER => fail
// ---------------------------------------------------------------------------

test('6B-D. production with STORAGE_PROVIDER unset fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: 'turso', STORAGE_PROVIDER: undefined }, () => {
    assert.throws(() => assertProductionProviderSelection(), /STORAGE_PROVIDER is not set/);
  });
});

test('6B-D2. production with an empty STORAGE_PROVIDER fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: 'turso', STORAGE_PROVIDER: '' }, () => {
    assert.throws(() => assertProductionProviderSelection(), /STORAGE_PROVIDER is not set/);
  });
});

// ---------------------------------------------------------------------------
// E. production + local => fail
// ---------------------------------------------------------------------------

test('6B-E. production with local filesystem storage fails', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: 'turso', STORAGE_PROVIDER: 'local' }, () => {
    assert.throws(() => assertProductionProviderSelection(), (err: Error) => {
      assert.match(err.message, /not permitted in production/);
      assert.match(err.message, /"local"/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Typos and unsupported values, on either variable
// ---------------------------------------------------------------------------

test('6B. a typo such as "tursoo" fails in production instead of silently using json', () => {
  withEnv(
    { NODE_ENV: 'production', DATABASE_PROVIDER: 'tursoo', STORAGE_PROVIDER: 'r2' },
    () => assert.throws(() => assertProductionProviderSelection(), /"tursoo"/)
  );
  withEnv(
    { NODE_ENV: 'production', DATABASE_PROVIDER: 'turso', STORAGE_PROVIDER: 'cloudflare' },
    () => assert.throws(() => assertProductionProviderSelection(), /"cloudflare"/)
  );
});

test('6B. both providers wrong reports both problems in one failure', () => {
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: 'json', STORAGE_PROVIDER: 'local' }, () => {
    assert.throws(() => assertProductionProviderSelection(), (err: Error) => {
      assert.match(err.message, /refusing to start/i);
      assert.match(err.message, /DATABASE_PROVIDER/);
      assert.match(err.message, /STORAGE_PROVIDER/);
      assert.match(err.message, /no silent fallback/i);
      return true;
    });
  });
});

test('6B. an unsafe provider value is never echoed back verbatim', () => {
  // A value outside the safe shape must not be copied into an error that gets
  // logged, in case someone pastes a secret into the wrong variable.
  const leaky = 'rzp_live_x'.repeat(6);
  withEnv({ NODE_ENV: 'production', DATABASE_PROVIDER: leaky, STORAGE_PROVIDER: 'r2' }, () => {
    assert.throws(() => assertProductionProviderSelection(), (err: Error) => {
      assert.ok(!err.message.includes(leaky), 'the raw value must not appear in the error');
      assert.match(err.message, /unrecognised value/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// G. NOT production => existing defaults preserved exactly
// ---------------------------------------------------------------------------

test('6B-G. development and test keep the existing local defaults', () => {
  for (const nodeEnv of [undefined, '', 'development', 'test', 'staging', 'prod']) {
    withEnv({ NODE_ENV: nodeEnv, DATABASE_PROVIDER: undefined, STORAGE_PROVIDER: undefined }, () => {
      assert.doesNotThrow(
        () => assertProductionProviderSelection(),
        `NODE_ENV=${JSON.stringify(nodeEnv)} must not be treated as production`
      );
      assert.equal(config.databaseProvider, 'json', 'json stays the development default');
      assert.equal(config.storageProvider, 'local', 'local stays the development default');
    });
  }
});

test('6B-G2. an explicit json/local selection is still allowed outside production', () => {
  withEnv({ NODE_ENV: 'development', DATABASE_PROVIDER: 'json', STORAGE_PROVIDER: 'local' }, () => {
    assert.doesNotThrow(() => assertProductionProviderSelection());
    assert.equal(config.databaseProvider, 'json');
    assert.equal(config.storageProvider, 'local');
  });
});

test('6B. only the exact value "production" counts as production', () => {
  // Trimmed and case-insensitive, so a padded value is still production.
  for (const v of ['production', '  production', 'PRODUCTION', ' Production ']) {
    withEnv({ NODE_ENV: v }, () => assert.equal(isProduction(), true, `NODE_ENV=${JSON.stringify(v)}`));
  }
  for (const v of ['prod', 'PRODUCTIONX', 'dev', 'productionx', '']) {
    withEnv({ NODE_ENV: v }, () => assert.equal(isProduction(), false, `NODE_ENV=${JSON.stringify(v)}`));
  }
});

// ---------------------------------------------------------------------------
// The assertion must be reachable from server.ts, before any provider is built
// ---------------------------------------------------------------------------

test('6B. server.ts calls the fail-safe during startup', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  assert.match(src, /import \{ config, assertProductionProviderSelection \} from '\.\/server\/config';/);
  // It must run inside startServer(), ahead of the provider selection.
  const body = src.slice(src.indexOf('async function startServer()'));
  const guardAt = body.indexOf('assertProductionProviderSelection();');
  const dbAt = body.indexOf('config.databaseProvider');
  const storageAt = body.indexOf('config.storageProvider');
  assert.ok(guardAt > 0, 'startServer() must call the fail-safe');
  assert.ok(guardAt < dbAt, 'the fail-safe must run before the database provider is chosen');
  assert.ok(guardAt < storageAt, 'the fail-safe must run before the storage provider is chosen');
});