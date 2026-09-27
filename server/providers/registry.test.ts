import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAsrProvider, getAsrProviderName, getProviderStrict, listConfiguredProviders } from './registry.ts';
import { ProviderNotConfiguredError } from './types.ts';

function isolateProviderEnv() {
  const hadAsr = process.env.ASR_PROVIDER;
  const hadTranscription = process.env.TRANSCRIPTION_PROVIDER;
  delete process.env.ASR_PROVIDER;
  delete process.env.TRANSCRIPTION_PROVIDER;
  return () => {
    if (hadAsr) process.env.ASR_PROVIDER = hadAsr;
    if (hadTranscription) process.env.TRANSCRIPTION_PROVIDER = hadTranscription;
  };
}

test('default provider is sarvam (unchanged active provider)', () => {
  const restore = isolateProviderEnv();
  try {
    assert.equal(getAsrProviderName(), 'sarvam');
    assert.equal(getAsrProvider().name, 'sarvam');
  } finally {
    restore();
  }
});

test('unknown provider name throws a clear error', () => {
  assert.throws(() => getProviderStrict('does-not-exist'), /Unknown ASR provider/);
});

test('azure provider exists but is NOT configured without credentials', () => {
  const azure = getProviderStrict('azure');
  assert.equal(azure.isConfigured(), false);
});

test('azure transcribe throws ProviderNotConfiguredError (no network, no fake creds)', async () => {
  const azure = getProviderStrict('azure');
  await assert.rejects(() => azure.transcribe(Buffer.from('x'), 'audio/wav'), (e: unknown) => e instanceof ProviderNotConfiguredError);
});

test('registry is never empty of known names', () => {
  const names = listConfiguredProviders();
  assert.ok(Array.isArray(names));
  for (const n of ['sarvam', 'olive', 'groq', 'azure']) {
    assert.equal(typeof getProviderStrict(n).transcribe, 'function');
  }
});