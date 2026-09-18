/**
 * Provider abstraction contract (ASR_PROVIDER=sarvam | olive | groq | azure).
 *
 * This is the seam that later allows Azure Speech to be added WITHOUT rewriting
 * the queue, credit, storage, or API layers. Every provider returns a uniform
 * result: raw transcript + duration + language + optional 1:1 word timings +
 * diagnostics, and throws typed errors the worker can act on.
 */

/** One token timing (word or phrase chunk) that aligns 1:1 with transcript tokens. */
export interface ProviderWordTiming {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TranscriptionProviderResult {
  /** RAW transcript exactly as returned by the provider (verbatim). */
  transcript: string;
  /** Audio duration in seconds, if known. */
  durationSeconds: number;
  /** BCP-47 language code ('od-IN' for Sarvam, 'or' for Olive, etc.). */
  languageCode: string;
  /** Human label for diagnostics/UI. */
  detectedLanguage: string;
  /**
   * Word-level timings aligned 1:1 with the transcript tokens when the
   * provider returns them; otherwise []. The caller decides whether to trust
   * them (legacy behavior trusts Sarvam timings only when 1:1).
   */
  wordTimings: ProviderWordTiming[];
  /** Non-secret provider diagnostics (model, mode, chunk counts, ...). */
  meta?: Record<string, unknown>;
}

export interface TranscribeOptions {
  /** Hard timeout for a single transcription job (ms). */
  jobTimeoutMs?: number;
  /** BCP-47 language code to send to the provider ('od-IN', 'hi-IN', 'en-IN'). */
  languageCode?: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  /** True when the provider is actually usable (env/credentials present). */
  isConfigured(): boolean;
  /** Transcribe the exact uploaded bytes; raw output only, no segmentation. */
  transcribe(audioBuffer: Buffer, mimeType: string, options?: TranscribeOptions): Promise<TranscriptionProviderResult>;
}

/** Thrown by providers that are not configured / not yet implemented. */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
    this.provider = provider;
  }
}