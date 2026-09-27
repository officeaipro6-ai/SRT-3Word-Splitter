/**
 * Groq adapter (fallback Whisper ASR for testing — whisper-large-v3-turbo).
 *
 * Thin wrapper over `transcribeRawOdiaWithWhisper`. No segmentation or spelling
 * correction is applied here (raw output only), matching the legacy route.
 */
import { transcribeRawOdiaWithWhisper } from '../groqTranscriber';
import { type TranscriptionProvider, type TranscriptionProviderResult } from './types';

export const groqProvider: TranscriptionProvider = {
  name: 'groq',

  // Groq needs a key; reuse the existing health-check convention.
  isConfigured: () => {
    const key = (process.env.GROQ_API_KEY || '').trim();
    const fb = (process.env.GROQ_API_KEY_FALLBACK || '').trim();
    return Boolean(
      (key && key !== 'YOUR_GROQ_API_KEY_HERE') || (fb && fb !== 'YOUR_GROQ_API_KEY_HERE')
    );
  },

  async transcribe(audioBuffer, mimeType, _options): Promise<TranscriptionProviderResult> {
    const meta = await transcribeRawOdiaWithWhisper(audioBuffer, mimeType);
    return {
      transcript: meta.rawText,
      durationSeconds: meta.durationSeconds,
      languageCode: meta.languageCode,
      detectedLanguage: meta.detectedLanguage,
      /* Groq falls back to the existing even-distribution timing in the legacy
         route; keep the same behavior here. */
      wordTimings: [],
      meta: {
        forcedLanguage: meta.forcedLanguage,
        rawSegmentCount: meta.rawSegmentCount,
        rawWordCount: meta.rawWordCount,
      },
    };
  },
};