/**
 * Provider registry — the single place that resolves ASR_PROVIDER to a
 * TranscriptionProvider implementation.
 */
import { config, type ProviderName } from '../config';
import { type TranscriptionProvider } from './types';
import { sarvamProvider } from './sarvamProvider';
import { oliveProvider } from './oliveProvider';
import { groqProvider } from './groqProvider';
import { azureProvider } from './azureProvider';

const providers: Record<ProviderName, TranscriptionProvider> = {
  sarvam: sarvamProvider,
  olive: oliveProvider,
  groq: groqProvider,
  azure: azureProvider,
};

/** Resolve the ACTIVE provider from ASR_PROVIDER / TRANSCRIPTION_PROVIDER. */
export function getAsrProvider(): TranscriptionProvider {
  return providers[config.asrProvider];
}

/** Name of the active provider (safe for logs and /api/health). */
export function getAsrProviderName(): string {
  return config.asrProvider;
}

/** Names of providers that are currently usable (configured). */
export function listConfiguredProviders(): string[] {
  return (Object.keys(providers) as ProviderName[]).filter((n) => providers[n].isConfigured());
}

export function getProvider(name: ProviderName): TranscriptionProvider {
  return providers[name];
}

/** Resolve a provider by stored name (throws on unknown names). */
export function getProviderStrict(name: string): TranscriptionProvider {
  const provider = (providers as Record<string, TranscriptionProvider | undefined>)[name];
  if (!provider) throw new Error(`Unknown ASR provider "${name}".`);
  return provider;
}