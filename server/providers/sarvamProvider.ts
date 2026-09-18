/**
 * Sarvam adapter — the ACTIVE provider.
 *
 * Thin wrapper over the existing production function `transcribeRawOdiaWithSarvam`
 * (batch API, saaras:v4, od-IN, verbatim). No logic is duplicated or altered:
 * segmentation/tagging/timing still run downstream exactly as today.
 */
import {
  transcribeRawOdiaWithSarvam,
  isSarvamConfigured,
  type SarvamRawResult,
} from '../sarvamTranscriber';
import {
  type TranscriptionProvider,
  type TranscriptionProviderResult,
  ProviderNotConfiguredError,
} from './types';

/** Wrap a Sarvam chunk array into the uniform word-timing shape. */
export function mapSarvamChunks(chunks: Array<{ text: string; startSeconds: number; endSeconds: number }>) {
  return (chunks || []).map((c) => ({
    text: c.text,
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
  }));
}

export const sarvamProvider: TranscriptionProvider = {
  name: 'sarvam',

  isConfigured: () => isSarvamConfigured(),

  async transcribe(audioBuffer, mimeType, options): Promise<TranscriptionProviderResult> {
    if (!isSarvamConfigured()) {
      throw new ProviderNotConfiguredError(
        'sarvam',
        'SARVAM_API_KEY is not configured. Set SARVAM_API_KEY in the server .env file.'
      );
    }
    const meta: SarvamRawResult = await transcribeRawOdiaWithSarvam(audioBuffer, mimeType, {
      jobTimeoutMs: options?.jobTimeoutMs,
      languageCode: options?.languageCode,
    });
    return {
      transcript: meta.transcript,
      durationSeconds: meta.durationSeconds,
      languageCode: meta.languageCode || 'od-IN',
      detectedLanguage: meta.detectedLanguage,
      wordTimings: mapSarvamChunks(meta.chunks),
      meta: {
        languageCode: meta.languageCode || 'od-IN',
        chunkCount: (meta.chunks || []).length,
      },
    };
  },
};