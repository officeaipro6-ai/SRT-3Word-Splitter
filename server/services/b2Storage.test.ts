/**
 * Backblaze B2 storage provider — configuration, fail-fast and request
 * construction.
 *
 * NO REAL BACKBLAZE CALLS HAPPEN HERE. Every test either inspects a request
 * that was about to be sent (via a stubbed `send`) or exercises pure
 * validation. Nothing is skipped based on whether credentials happen to be
 * present, so the suite behaves identically with or without a real key pair.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  B2StorageProvider,
  B2_ENV_KEYS,
  b2ConfigurationError,
  createB2StorageProvider,
  missingB2EnvKeys,
  validateB2Config,
  type B2Config,
} from './b2Storage.ts';
import { config, assertProductionProviderSelection } from '../config.ts';

/** Obviously fake, obviously safe. Never a real credential. */
const FAKE_KEY_ID = 'FAKEb2keyid0000000000000000000000000000';
const FAKE_APP_KEY = 'FAKEb2applicationkey0000000000000000000000';

const GOOD: B2Config = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  region: 'us-west-004',
  bucket: 'odia-srt-production-storage',
  keyId: FAKE_KEY_ID,
  applicationKey: FAKE_APP_KEY,
};

/**
 * Build a provider whose `send` is intercepted, so no network I/O occurs.
 * Returns the captured commands.
 */
function stubbed(overrides: Partial<B2Config> = {}, reply?: (cmd: any) => any) {
  const sent: any[] = [];
  const provider = createB2StorageProvider({ ...GOOD, ...overrides });
  (provider as any).client = {
    send: async (cmd: any) => {
      sent.push(cmd);
      return reply ? reply(cmd) : {};
    },
  };
  return { provider, sent };
}

/** A 404 as the S3 SDK reports it. */
function notFound(name = 'NotFound') {
  return Object.assign(new Error('missing'), { name, $metadata: { httpStatusCode: 404 } });
}

// ---------------------------------------------------------------------------
// A. Provider configuration
// ---------------------------------------------------------------------------

test('B2-A. the five B2 environment variables are the documented ones', () => {
  assert.deepEqual(Object.values(B2_ENV_KEYS), [
    'B2_ENDPOINT',
    'B2_REGION',
    'B2_BUCKET',
    'B2_KEY_ID',
    'B2_APPLICATION_KEY',
  ]);
});

test('B2-A2. config exposes a getter per B2 variable and reads them from the environment', () => {
  const keys = [
    'B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY',
    'STORAGE_PROVIDER',
  ] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    process.env.B2_ENDPOINT = '  https://s3.us-west-004.backblazeb2.com  ';
    process.env.B2_REGION = ' us-west-004 ';
    process.env.B2_BUCKET = ' odia-srt-production-storage ';
    process.env.B2_KEY_ID = ' k ';
    process.env.B2_APPLICATION_KEY = ' a ';
    process.env.STORAGE_PROVIDER = 'b2';

    assert.equal(config.b2Endpoint, 'https://s3.us-west-004.backblazeb2.com');
    assert.equal(config.b2Region, 'us-west-004');
    assert.equal(config.b2Bucket, 'odia-srt-production-storage');
    assert.equal(config.b2KeyId, 'k');
    assert.equal(config.b2ApplicationKey, 'a');
    assert.equal(config.storageProvider, 'b2');
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
});

test('B2-A3. unset B2 variables read as null, never as an empty string', () => {
  const keys = ['B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(config.b2Endpoint, null);
    assert.equal(config.b2Region, null);
    assert.equal(config.b2Bucket, null);
    assert.equal(config.b2KeyId, null);
    assert.equal(config.b2ApplicationKey, null);

    // A blank value is treated as absent, so it fails fast like a missing one.
    process.env.B2_KEY_ID = '   ';
    assert.equal(config.b2KeyId, null);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
});

// ---------------------------------------------------------------------------
// B. Missing B2 credentials fail fast — never a silent fallback to local
// ---------------------------------------------------------------------------

test('B2-B. missingB2EnvKeys reports every absent variable and nothing when all are set', () => {
  const full = {
    B2_ENDPOINT: GOOD.endpoint,
    B2_REGION: GOOD.region,
    B2_BUCKET: GOOD.bucket,
    B2_KEY_ID: FAKE_KEY_ID,
    B2_APPLICATION_KEY: FAKE_APP_KEY,
  };
  assert.deepEqual(missingB2EnvKeys({}), [
    'B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY',
  ]);
  assert.deepEqual(missingB2EnvKeys({ ...full, B2_KEY_ID: '   ', B2_REGION: undefined }), [
    'B2_REGION', 'B2_KEY_ID',
  ]);
  assert.deepEqual(missingB2EnvKeys(full), []);
});

test('B2-B2. the configuration error names the missing VARIABLES and no credential value', () => {
  const err = b2ConfigurationError(['B2_KEY_ID', 'B2_APPLICATION_KEY']);
  assert.match(err.message, /B2_KEY_ID/);
  assert.match(err.message, /B2_APPLICATION_KEY/);
  assert.match(err.message, /no silent fallback/i);
  // It must never contain a credential value.
  assert.ok(!err.message.includes(FAKE_KEY_ID));
  assert.ok(!err.message.includes(FAKE_APP_KEY));
});

test('B2-B3. the configuration error stays secret-free even when a secret was pasted into a variable', () => {
  // An operator who pastes the application key into B2_BUCKET must not get it
  // echoed back into a logged startup error.
  const pasted = 'b2appkeyLEAKED' + 'x'.repeat(20);
  const missing = missingB2EnvKeys({ B2_BUCKET: pasted });
  const err = b2ConfigurationError(missing);
  assert.ok(!err.message.includes(pasted), 'a pasted secret must not reach the error');
});

test('B2-B4. validateB2Config refuses to build a client from an incomplete config', () => {
  for (const field of ['endpoint', 'region', 'bucket', 'keyId', 'applicationKey'] as const) {
    assert.throws(
      () => validateB2Config({ ...GOOD, [field]: '' }),
      new RegExp(B2_ENV_KEYS[field]),
      `${field} must be required`
    );
  }
  assert.doesNotThrow(() => validateB2Config(GOOD));
});

test('B2-B5. constructing the provider with a missing credential throws before any request', () => {
  assert.throws(() => createB2StorageProvider({ ...GOOD, keyId: '' }), /B2_KEY_ID is required/);
  assert.throws(() => createB2StorageProvider({ ...GOOD, applicationKey: '' }), /B2_APPLICATION_KEY is required/);
});

test('B2-B6. the production fail-safe rejects every non-b2 storage provider', () => {
  const prevNode = process.env.NODE_ENV;
  const prevDb = process.env.DATABASE_PROVIDER;
  const prevSt = process.env.STORAGE_PROVIDER;
  try {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_PROVIDER = 'turso';
    for (const bad of ['local', 'r2', 'cloudflare', '', '   ', 'b22', undefined as any]) {
      if (bad === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = bad;
      assert.throws(
        () => assertProductionProviderSelection(),
        /STORAGE_PROVIDER/,
        `STORAGE_PROVIDER=${JSON.stringify(bad)} must not start a production process`
      );
    }
    // The production value is accepted, including padded/case-varied forms —
    // this is the pre-existing Stage 6B contract (test 6B-C2), which only ever
    // ever resolves to 'b2'.
    for (const ok of ['b2', 'B2', ' b2 ']) {
      process.env.STORAGE_PROVIDER = ok;
      assert.doesNotThrow(
        () => assertProductionProviderSelection(),
        `STORAGE_PROVIDER=${JSON.stringify(ok)} must be accepted`
      );
      assert.equal(config.storageProvider, 'b2');
    }
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
    if (prevDb === undefined) delete process.env.DATABASE_PROVIDER; else process.env.DATABASE_PROVIDER = prevDb;
    if (prevSt === undefined) delete process.env.STORAGE_PROVIDER; else process.env.STORAGE_PROVIDER = prevSt;
  }
});

// ---------------------------------------------------------------------------
// C. put / get / exists / delete request construction
// ---------------------------------------------------------------------------

test('B2-C. put sends PutObjectCommand with the bucket, key and bytes', async () => {
  const { provider, sent } = stubbed();
  const body = Buffer.from('odia srt bytes');
  await provider.put('uploads/job-1.wav', body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].constructor.name, 'PutObjectCommand');
  assert.equal(sent[0].input.Bucket, GOOD.bucket);
  assert.equal(sent[0].input.Key, 'uploads/job-1.wav');
  assert.equal(sent[0].input.Body, body);
});

test('B2-C2. get sends GetObjectCommand and returns the bytes', async () => {
  const body = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nଓଡ଼ିଆ\n');
  const { provider, sent } = stubbed({}, () => ({ Body: (async function* () { yield body; })() }));
  const out = await provider.get('srt/abc-od-IN.srt');
  assert.equal(sent[0].constructor.name, 'GetObjectCommand');
  assert.equal(sent[0].input.Bucket, GOOD.bucket);
  assert.equal(sent[0].input.Key, 'srt/abc-od-IN.srt');
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out!.toString(), body.toString());
});

test('B2-C2b. get returns null on a missing object instead of throwing', async () => {
  for (const err of [notFound('NoSuchKey'), notFound('NotFound')]) {
    const { provider } = stubbed({}, () => { throw err; });
    assert.equal(await provider.get('srt/missing.srt'), null);
  }
});

test('B2-C2c. get propagates a real error rather than hiding it as "missing"', async () => {
  const boom = Object.assign(new Error('access denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
  const { provider } = stubbed({}, () => { throw boom; });
  await assert.rejects(() => provider.get('srt/x.srt'), /access denied/);
});

test('B2-C3. exists sends HeadObjectCommand and reports presence', async () => {
  const { provider, sent } = stubbed();
  assert.equal(await provider.exists('uploads/job-1.wav'), true);
  assert.equal(sent[0].constructor.name, 'HeadObjectCommand');
  assert.equal(sent[0].input.Key, 'uploads/job-1.wav');

  const missing = stubbed({}, () => { throw notFound('NotFound'); });
  assert.equal(await missing.provider.exists('uploads/nope.wav'), false);
});

test('B2-C4. delete sends DeleteObjectCommand', async () => {
  const { provider, sent } = stubbed();
  await provider.delete('uploads/job-1.wav');
  assert.equal(sent[0].constructor.name, 'DeleteObjectCommand');
  assert.equal(sent[0].input.Bucket, GOOD.bucket);
  assert.equal(sent[0].input.Key, 'uploads/job-1.wav');
});

test('B2-C5. delete stays best-effort: a missing object is not an error', async () => {
  const { provider } = stubbed({}, () => { throw notFound('NoSuchKey'); });
  await assert.doesNotReject(() => provider.delete('uploads/gone.wav'));
});

// ---------------------------------------------------------------------------
// D. Object key behaviour is preserved exactly
// ---------------------------------------------------------------------------

test('B2-D. application keys are passed through unchanged; only a leading / is stripped', async () => {
  const { provider, sent } = stubbed();
  const keys = [
    'uploads/9f1c-job-1.wav',
    'srt/33e289ccfe90f2c4e27749e3eec0cce2cc6d38ac55b388e92ece43a637639946-od-IN.srt',
    'community-attachments/report-1.bin',
    'uploads/nested/deep/file.mp3',
  ];
  for (const k of keys) await provider.put(k, Buffer.from('x'));
  assert.deepEqual(sent.map((c) => c.input.Key), keys);

  const { provider: p2, sent: s2 } = stubbed();
  await p2.put('/uploads/leading-slash.wav', Buffer.from('x'));
  assert.equal(s2[0].input.Key, 'uploads/leading-slash.wav');
});

// ---------------------------------------------------------------------------
// E. The client is built from the environment values, with no hardcoded secrets
// ---------------------------------------------------------------------------

test('B2-E. the S3 client receives endpoint, region and the credentials', async () => {
  const provider = createB2StorageProvider(GOOD);
  const client: any = (provider as any).client;

  const endpoint = await client.config.endpoint();
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.hostname, 's3.us-west-004.backblazeb2.com');
  assert.equal(await client.config.region(), GOOD.region);

  const creds = await client.config.credentials();
  assert.equal(creds.accessKeyId, FAKE_KEY_ID);
  assert.equal(creds.secretAccessKey, FAKE_APP_KEY);

  // Path style keeps the wire format predictable for a custom endpoint.
  const fps = client.config.forcePathStyle;
  assert.equal(typeof fps === 'function' ? await fps() : fps, true);
});

test('B2-E2. the provider targets the configured bucket', () => {
  assert.equal(createB2StorageProvider(GOOD).bucketName, GOOD.bucket);
  assert.equal(
    createB2StorageProvider({ ...GOOD, bucket: 'other-bucket' }).bucketName,
    'other-bucket'
  );
});

// ---------------------------------------------------------------------------
// F. No secret values are logged
// ---------------------------------------------------------------------------

test('B2-F. no B2 credential value appears in any error the provider can produce', () => {
  const messages = [
    b2ConfigurationError(missingB2EnvKeys({})).message,
    b2ConfigurationError(['B2_KEY_ID']).message,
  ];
  for (const field of ['endpoint', 'region', 'bucket', 'keyId', 'applicationKey'] as const) {
    try {
      validateB2Config({ ...GOOD, [field]: '' });
    } catch (e) {
      messages.push((e as Error).message);
    }
  }
  for (const m of messages) {
    assert.ok(!m.includes(FAKE_KEY_ID), `key id leaked into: ${m}`);
    assert.ok(!m.includes(FAKE_APP_KEY), `application key leaked into: ${m}`);
  }
});

test('B2-F2. b2Storage.ts contains no literal credential and no console output', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/b2Storage.ts'), 'utf8');
  assert.doesNotMatch(src, /console\.(log|error|warn|info)/, 'the provider must not log');
  // A B2 key ID is 25 chars of base64-ish text; assert no long opaque literal
  // is assigned to the credential fields.
  assert.doesNotMatch(src, /keyId:\s*['"][A-Za-z0-9+/]{16,}['"]/);
  assert.doesNotMatch(src, /applicationKey:\s*['"][A-Za-z0-9+/]{16,}['"]/);
});

// ---------------------------------------------------------------------------
// G. server.ts wires b2 -> B2Storage and keeps local for development
// ---------------------------------------------------------------------------

test('B2-G. server.ts selects B2Storage for b2 and LocalFileStorageProvider otherwise', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  assert.match(src, /config\.storageProvider === 'b2'/);
  assert.match(src, /createB2StorageProvider/);
  assert.match(src, /endpoint: config\.b2Endpoint/);
  assert.match(src, /region: config\.b2Region/);
  assert.match(src, /bucket: config\.b2Bucket/);
  assert.match(src, /keyId: config\.b2KeyId/);
  assert.match(src, /applicationKey: config\.b2ApplicationKey/);
  // Local storage must remain available for development.
  assert.match(src, /new LocalFileStorageProvider\(config\.storageDir\)/);

  // The fail-fast must run before the b2 branch builds anything.
  const b2At = src.indexOf("config.storageProvider === 'b2'");
  const throwAt = src.indexOf('b2ConfigurationError(missingB2Vars)', b2At);
  assert.ok(b2At > 0 && throwAt > b2At, 'missing B2 credentials must throw in the b2 branch');
});

test('B2-G2. production storage can no longer be Cloudflare R2', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  // R2 survives only in a branch guarded by an explicit 'r2' comparison that
  // assertProductionProviderSelection() makes unreachable in production.
  assert.match(src, /config\.storageProvider === 'r2'/);
  const cfg = fs.readFileSync(path.join(process.cwd(), 'server/config.ts'), 'utf8');
  assert.match(cfg, /PRODUCTION_STORAGE_PROVIDER: StorageProviderType = 'b2'/);
});

test('B2-G3. the production provider assertion still runs before storage is chosen', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function startServer()'));
  const guardAt = body.indexOf('assertProductionProviderSelection();');
  const storageAt = body.indexOf('config.storageProvider');
  assert.ok(guardAt > 0, 'the fail-safe must still be called at startup');
  assert.ok(guardAt < storageAt, 'the fail-safe must run before storage selection');
});

// ---------------------------------------------------------------------------
// H. render.yaml
// ---------------------------------------------------------------------------

test('B2-H. render.yaml configures B2 for production and holds no credential', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'render.yaml'), 'utf8');
  assert.match(src, /- key: STORAGE_PROVIDER\n\s+value: b2/);
  assert.match(src, /- key: B2_ENDPOINT\n\s+value: https:\/\/s3\.us-west-004\.backblazeb2\.com/);
  assert.match(src, /- key: B2_REGION\n\s+value: us-west-004/);
  assert.match(src, /- key: B2_BUCKET\n\s+value: odia-srt-production-storage/);
  // Secrets are placeholders only.
  assert.match(src, /# - key: B2_KEY_ID/);
  assert.match(src, /# - key: B2_APPLICATION_KEY/);
  // Cloudflare R2 is gone from the production configuration.
  assert.doesNotMatch(src, /R2_ACCOUNT_ID/);
  assert.doesNotMatch(src, /- key: R2_/);
  // Untouched production settings.
  assert.match(src, /- key: DATABASE_PROVIDER\n\s+value: turso/);
  assert.match(src, /- key: PROVIDER_SPENDING_PROTECTION\n\s+value: "true"/);
  assert.match(src, /- key: DATA_DIR\n\s+value: \/tmp\/odia-srt-data/);
  assert.match(src, /- key: NODE_ENV\n\s+value: production/);
});