/**
 * Azure Speech stub — INTERFACE + CONFIG HOOK ONLY.
 *
 * This is intentionally NOT implemented: Azure signup requires a payment card,
 * no Azure credentials exist on this machine, and the project rule is to never
 * fake credentials. Selecting ASR_PROVIDER=azure therefore fails cleanly with a
 * typed ProviderNotConfiguredError BEFORE any network call.
 *
 * When Azure is later enabled, this file is the single place to wire the Azure
 * Fast Transcription client (POST /speechtotext/transcriptions:transcribe, api
 * version 2025-10-15, locale or-IN) returning the uniform provider result:
 * transcript + durationSeconds + languageCode + wordTimings (offsetMilliseconds
 * / durationMilliseconds normalized to seconds) + meta. The queue, credit and
 * storage layers need NO changes.
 */
import {
  type TranscriptionProvider,
  type TranscriptionProviderResult,
  ProviderNotConfiguredError,
} from './types';
import { config } from '../config';

export const azureProvider: TranscriptionProvider = {
  name: 'azure',

  /** True only when a real key + region are present in the environment. */
  isConfigured: () => config.azureConfigured,

  async transcribe(): Promise<TranscriptionProviderResult> {
    throw new ProviderNotConfiguredError(
      'azure',
      'Azure Speech is not yet configured/implemented for this project. ' +
        'Set ASR_PROVIDER=sarvam (default) to keep using the Sarvam provider, ' +
        'or provide AZURE_SPEECH_KEY and AZURE_SPEECH_REGION after Azure integration is implemented.'
    );
  },
};