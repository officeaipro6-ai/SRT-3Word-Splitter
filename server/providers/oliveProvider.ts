/**
 * Olive adapter (opt-in Odia ASR — OdiaGenAI Whisper fine-tune).
 *
 * Thin wrapper over the existing `transcribeRawOdiaWithOlive`. Never selected
 * implicitly; only active when ASR_PROVIDER=olive (or TRANSCRIPTION_PROVIDER=olive).
 */
import { transcribeRawOdiaWithOlive, isOliveConfigured } from '../oliveTranscriber';
import {
  type TranscriptionProvider,
  type TranscriptionProviderResult,
  ProviderNotConfiguredError,
} from './types';

export const oliveProvider: TranscriptionProvider = {
  name: 'olive',

  isConfigured: () => isOliveConfigured(),

  async transcribe(audioBuffer, mimeType, options): Promise<TranscriptionProviderResult> {
    if (!isOliveConfigured()) {
      throw new ProviderNotConfiguredError(
        'olive',
        'OLIVE_API_URL is not configured. Set OLIVE_API_URL in the server .env file to use the Olive provider.'
      );
    }
    const meta = await transcribeRawOdiaWithOlive(audioBuffer, mimeType, {
      jobTimeoutMs: options?.jobTimeoutMs,
    });
    return {
      transcript: meta.transcript,
      durationSeconds: meta.durationSeconds,
      languageCode: meta.languageCode || 'or',
      detectedLanguage: meta.detectedLanguage,
      wordTimings: (meta.chunks || []).map((c) => ({
        text: c.text,
        startSeconds: c.startSeconds,
        endSeconds: c.endSeconds,
      })),
      meta: {
        languageCode: meta.languageCode || 'or',
        chunkCount: (meta.chunks || []).length,
      },
    };
  },
};