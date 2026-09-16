/**
 * Olive Odia ASR (OdiaGenAI) integration for Odia transcription.
 *
 * Olive is an optional, SELECTABLE transcription provider (OdiaGenAI's
 * faster-whisper Odia fine-tune: whisper-odia-small-finetune-int8-ct2). It is
 * deliberately separate from the ACTIVE Sarvam pipeline, which is preserved
 * unchanged as the default and remains available as the primary provider.
 *
 * Enable Olive only via `TRANSCRIPTION_PROVIDER=olive` and point
 * `OLIVE_API_URL` at a running Olive server (local default http://127.0.0.1:5000,
 * or the public Hugging Face Space). When unused, this module has no effect.
 *
 * Request (multipart/form-data, EXACT upstream bytes):
 *   - audio        : the exact uploaded audio file
 *   - to_simple    : 0   (keep the script exactly as recognised)
 *   - remove_pun   : 0   (keep punctuation)
 *   - language     : or  (FORCE Odia)
 *   - task         : transcribe
 *
 * Response:
 *   { "results": [ { "result": "ଓଡ଼ିଆ ଟେକ୍ସଟ୍", "start": 0, "end": 3 } ], "code": 0 }
 *
 * The recognised text is passed through RAW - NO spelling correction, NO word
 * re-ordering, NO transliteration, NO max-3-word segmentation here
 * (segmentation is deferred until the raw Odia text is verified downstream).
 */

import type { SarvamRawResult, SarvamChunk } from './sarvamTranscriber';

const DEFAULT_OLIVE_API_URL = 'http://127.0.0.1:5000';

export interface OliveSegment {
  result: string;
  start: number;
  end: number;
}

export interface OliveRecognitionResponse {
  results: OliveSegment[];
  code: number;
}

export interface OliveTranscribeOptions {
  jobTimeoutMs?: number;
  /** Test hook: override the base URL instead of env/OLIVE_API_URL. */
  baseUrl?: string;
}

/** True when the user explicitly configured an Olive server URL in .env. */
export function isOliveConfigured(): boolean {
  const url = (process.env.OLIVE_API_URL || '').trim();
  return Boolean(url && url !== 'YOUR_OLIVE_API_URL_HERE');
}

/** Resolve the Olive server base URL (env override, else the local default). */
export function getOliveApiUrl(): string {
  const url = (process.env.OLIVE_API_URL || '').trim();
  if (!url || url === 'YOUR_OLIVE_API_URL_HERE') return DEFAULT_OLIVE_API_URL;
  return url.replace(/\/+$/, '');
}

function detectExt(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('mp3')) return 'mp3';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('m4a')) return 'm4a';
  if (m.includes('aac')) return 'aac';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('wav')) return 'wav';
  return 'wav';
}

/**
 * Transcribe an audio buffer with Olive Odia ASR and return the RAW Odia text
 * exactly as recognised, with no spelling correction and no segmentation.
 *
 * @param audioBuffer The EXACT bytes uploaded by the browser.
 * @param mimeType    MIME type of the audio.
 * @param opts        Optional settings (job timeout, base URL override).
 */
export async function transcribeRawOdiaWithOlive(
  audioBuffer: Buffer,
  mimeType: string = 'audio/wav',
  opts: OliveTranscribeOptions = {}
): Promise<SarvamRawResult> {
  const timeoutMs = opts.jobTimeoutMs && opts.jobTimeoutMs > 0 ? opts.jobTimeoutMs : 180000;
  const baseUrl = (opts.baseUrl || getOliveApiUrl()).replace(/\/+$/, '');
  const ext = detectExt(mimeType);
  const fileName = `odia_upload.${ext}`;

  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(audioBuffer)]), fileName);
  form.append('to_simple', '0');
  form.append('remove_pun', '0');
  form.append('language', 'or');
  form.append('task', 'transcribe');

  console.log(`[OLIVE] POST ${baseUrl}/recognition (language=or, task=transcribe, ${audioBuffer.length} bytes)...`);

  const res = await fetch(`${baseUrl}/recognition`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rawBody = await res.text();
  if (!res.ok) {
    let detail = rawBody;
    try {
      detail = JSON.stringify(JSON.parse(rawBody));
    } catch {
      /* keep raw body */
    }
    throw new Error(`Olive recognition failed (HTTP ${res.status}): ${detail || '(empty response body)'}`);
  }

  let parsed: OliveRecognitionResponse | null = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.code !== 'number' || !Array.isArray(parsed.results)) {
    throw new Error(`Olive recognition returned an unparseable response: ${rawBody.slice(0, 500)}`);
  }
  if (parsed.code !== 0) {
    throw new Error(`Olive recognition reported error code ${parsed.code}: ${rawBody.slice(0, 500)}`);
  }

  const chunks: SarvamChunk[] = [];
  let durationSeconds = 0;
  for (const segment of parsed.results) {
    const text = String(segment?.result ?? '').trim();
    const start = Number(segment?.start) || 0;
    const end = Number(segment?.end) || 0;
    if (!text) continue;
    chunks.push({ text, startSeconds: start, endSeconds: end });
    if (end > durationSeconds) durationSeconds = end;
  }

  const transcript = chunks.map((c) => c.text).join(' ');

  return {
    transcript,
    languageCode: 'or',
    detectedLanguage: 'Odia (ଓଡ଼ିଆ)',
    durationSeconds,
    chunks,
  };
}