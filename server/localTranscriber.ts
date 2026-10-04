/**
 * LOCAL SUBMISSION MODE - local, zero-budget Odia ASR provider.
 *
 * This is a THIRD, opt-in provider that sits alongside the untouched Sarvam
 * production pipeline. It exists for one situation only: an academic SRT
 * submission that must be produced with no cloud/paid ASR budget.
 *
 * What it is:
 *   - A local, open-source, CPU-only Odia ASR: `ai4bharat/indicwav2vec-odia`
 *     (Apache-2.0, Wav2Vec2ForCTC, language "or"), run by a short-lived Python
 *     worker (`scripts/local_asr_worker.py`).
 *   - It transcribes the EXACT uploaded audio bytes. Nothing else.
 *
 * What it is NOT, by construction:
 *   - Not a fallback for the paid providers. It is never selected implicitly and
 *     never used when LOCAL SUBMISSION_MODE is off, so Sarvam stays the default.
 *   - Not a source of invented text. There is no cached, previous, fixture,
 *     template or placeholder transcript anywhere in this path. If the model is
 *     absent or inference fails, this module THROWS - it never returns text.
 *   - Not a paid call. The worker runs with HuggingFace forced offline and every
 *     cache pinned inside the project directory, so it performs no network I/O.
 *
 * Timestamps are REAL: per-word start/end come from the wav2vec2 CTC frame
 * alignment (20 ms frames) measured on the uploaded audio. Nothing is
 * interpolated or guessed.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { config } from './config';

/** Marker for "LOCAL SUBMISSION MODE could not produce a real transcript". */
export class LocalAsrUnavailableError extends Error {
  readonly code = 'LOCAL_ASR_UNAVAILABLE';
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'LocalAsrUnavailableError';
    this.hint = hint;
  }
}

export interface LocalAsrWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * A final subtitle cue produced by the local worker. Windows come from the
 * ACTUAL first/last word CTC timing (never a broad VAD region) and carry at
 * most 3 spoken words, so the server must NOT re-snap them.
 */
export interface LocalAsrSegment {
  id: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface LocalAsrResult {
  transcript: string;
  words: LocalAsrWord[];
  segments: LocalAsrSegment[];
  wordCount: number;
  audioDurationSeconds: number;
  model: string;
  modelDir: string;
  device: string;
  hasReliableTimestamps: boolean;
  timestampNote: string;
  meanLogProb: number | null;
  inferenceSeconds: number;
  speechRegionCount: number;
  speechSeconds: number;
  nonSpeechSeconds: number;
  wordsDroppedAsNonSpeech: number;
}

function projectRoot(): string {
  // server.ts runs from the project root, so cwd is the project directory.
  return process.cwd();
}

/**
 * LOCAL SUBMISSION MODE is OFF unless the operator explicitly turns it on.
 * Removing/unsetting this single env var restores the untouched Sarvam path.
 */
export function isLocalSubmissionModeEnabled(): boolean {
  const v = (process.env.LOCAL_SUBMISSION_MODE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Where the local model lives. Always inside the project (E: drive).
 *
 * An override is allowed, but only if it stays inside the project directory, so
 * the model can never be pointed at C:\Users\sures\Downloads or any other
 * location outside E:\Odia-SRT-App.
 */
export function localModelDir(): string {
  const root = projectRoot();
  const override = (process.env.LOCAL_ASR_MODEL_DIR || '').trim();
  if (!override) return path.join(root, 'models', 'indicwav2vec-odia');

  const resolved = path.resolve(override);
  const rel = path.relative(root, resolved);
  const escapesProject = rel.startsWith('..') || path.isAbsolute(rel);
  if (escapesProject) {
    throw new Error(
      `LOCAL_ASR_MODEL_DIR must point inside the project directory (${root}). ` +
        `Refusing to use ${resolved}: all work must stay on the project drive.`
    );
  }
  return resolved;
}

/** Scratch space for the temporary upload. Always inside the project data dir. */
export function localScratchDir(): string {
  return path.join(config.dataDir, 'local-tmp');
}

/** The model files the worker cannot work without. */
const REQUIRED_MODEL_FILES = ['config.json', 'pytorch_model.bin'];

export function isLocalModelAvailable(): boolean {
  const dir = localModelDir();
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    return REQUIRED_MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

/** Human-readable, actionable message used when the model is not installed. */
export function localModelMissingMessage(): string {
  return (
    'LOCAL SUBMISSION MODE is enabled but the local Odia ASR model is not installed at ' +
    localModelDir() +
    '. No transcript was produced, and none is guessed. Install ' +
    'ai4bharat/indicwav2vec-odia (Apache-2.0) into that folder, or set ' +
    'LOCAL_SUBMISSION_MODE=false to return to the normal Sarvam pipeline.'
  );
}

/**
 * Remove punctuation from spoken subtitle text.
 *
 * Only ASCII punctuation and the Odia sentence marks (danda/double danda) are
 * stripped. DIGITS ARE PRESERVED - they are spoken content. The tagging
 * characters `<` and `>` are deliberately NOT stripped, so <NOISE>/<FIL>
 * behaviour downstream is unchanged.
 *
 * Punctuation is DELETED, not replaced with a space. This matters: the SRT
 * splitter counts words by whitespace, so turning "ନମସ୍କାର," into
 * "ନମସ୍କାର " would invent an extra word and corrupt the max-3-word cues.
 * Word boundaries come from the model's own word delimiter, not from
 * punctuation.
 */
export function stripSpokenPunctuation(text: string): string {
  if (!text) return '';
  return text
    // ASCII punctuation, EXCLUDING '<' (U+003C) and '>' (U+003E) so the tagging
    // characters survive. Written as explicit code points because the natural
    // [:-@] range would swallow both of them.
    .replace(/[\u0021-\u002F\u003A\u003B\u003D\u0040\u005B-\u0060\u007B-\u007E]/g, '')
    // Sentence terminators. Odia has no script-specific danda, so U+0964 /
    // U+0965 (shared with Devanagari) are what Odia text actually uses.
    .replace(/[\u0964\u0965]/g, '')
    .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces the removal exposed
    .trim();
}

function detectExt(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('m4a')) return 'm4a';
  if (m.includes('aac')) return 'aac';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('wav')) return 'wav';
  return 'wav';
}

function pythonExecutable(): string {
  return (process.env.LOCAL_ASR_PYTHON || 'python').trim() || 'python';
}

function workerScript(): string {
  return path.join(projectRoot(), 'scripts', 'local_asr_worker.py');
}

function timeoutMs(): number {
  const raw = Number(process.env.LOCAL_ASR_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 60 * 60 * 1000; // 60 min ceiling for a long CPU-only run
}

function maxSeconds(): number {
  const raw = Number(process.env.LOCAL_ASR_MAX_SECONDS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 45 * 60;
}

/**
 * Run the local Python worker once and parse its single JSON result.
 * Never resolves with text on failure - it rejects instead.
 */
function runWorker(audioPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonExecutable(),
      [
        workerScript(),
        '--audio', audioPath,
        '--model-dir', localModelDir(),
        '--project-dir', projectRoot(),
        '--max-seconds', String(maxSeconds()),
      ],
      {
        cwd: projectRoot(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Belt and braces: the worker also sets these, but a stray dependency
          // in the worker must still never be able to reach the network.
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HOME: path.join(projectRoot(), '.hf-home'),
          HF_HUB_CACHE: path.join(projectRoot(), '.hf-home', 'hub'),
          TORCH_HOME: path.join(projectRoot(), '.hf-home'),
          PYTHONIOENCODING: 'utf-8',
        },
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(
        new LocalAsrUnavailableError(
          'LOCAL SUBMISSION MODE timed out. No transcript was produced.',
          `Raise LOCAL_ASR_TIMEOUT_MS (currently ${timeoutMs()} ms) or use a shorter file.`
        )
      );
    }, timeoutMs());

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new LocalAsrUnavailableError(
          `Could not start the local ASR worker (${pythonExecutable()}): ${err.message}`,
          'Install Python 3.11+ with torch (CPU) and transformers, or set LOCAL_ASR_PYTHON.'
        )
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // The worker prints exactly one JSON object on the last non-empty line.
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let payload: any = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('{')) {
          try {
            payload = JSON.parse(lines[i]);
          } catch {
            payload = null;
          }
          if (payload) break;
        }
      }

      if (!payload) {
        const tail = (stderr || stdout).trim().slice(-600);
        reject(
          new LocalAsrUnavailableError(
            `The local ASR worker produced no result (exit code ${code}). No transcript was produced.`,
            tail || 'Run scripts/local_asr_worker.py manually to see the full error.'
          )
        );
        return;
      }
      if (payload.ok !== true) {
        reject(
          new LocalAsrUnavailableError(
            String(payload.error || 'The local ASR worker failed.'),
            payload.hint ? String(payload.hint) : undefined
          )
        );
        return;
      }
      resolve(payload);
    });
  });
}

/**
 * Transcribe the EXACT uploaded audio locally and return the raw Odia text with
 * real per-word timings. No segmentation, no spelling correction, no caching.
 *
 * @param audioBuffer The EXACT bytes uploaded by the browser.
 * @param mimeType    MIME type of the upload.
 */
export async function transcribeRawOdiaWithLocalAsr(
  audioBuffer: Buffer,
  mimeType: string
): Promise<LocalAsrResult> {
  if (!isLocalSubmissionModeEnabled()) {
    throw new LocalAsrUnavailableError(
      'LOCAL SUBMISSION MODE is not enabled (LOCAL_SUBMISSION_MODE is not set to true).',
      'Do not call the local provider while LOCAL SUBMISSION MODE is off.'
    );
  }
  if (!isLocalModelAvailable()) {
    throw new LocalAsrUnavailableError(localModelMissingMessage());
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new LocalAsrUnavailableError(
      'LOCAL SUBMISSION MODE received no audio to transcribe.'
    );
  }

  const scratch = localScratchDir();
  await fsp.mkdir(scratch, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const audioPath = path.join(scratch, `upload-${stamp}.${detectExt(mimeType)}`);

  try {
    await fsp.writeFile(audioPath, audioBuffer);
    const payload = await runWorker(audioPath);

    const words: LocalAsrWord[] = Array.isArray(payload.words) ? payload.words : [];
    const transcript = stripSpokenPunctuation(String(payload.transcript || ''));

    // Keep the transcript and the word list consistent with each other. The
    // caller needs a 1:1 word/timing mapping, so the text is rebuilt FROM the
    // word timings - this can never lose or invent a word.
    const cleanedWords = words
      .map((w) => ({
        text: stripSpokenPunctuation(String(w?.text ?? '')),
        startSeconds: Number(w?.startSeconds),
        endSeconds: Number(w?.endSeconds),
      }))
      .filter(
        (w) =>
          w.text.length > 0 &&
          Number.isFinite(w.startSeconds) &&
          Number.isFinite(w.endSeconds) &&
          w.endSeconds >= w.startSeconds
      );
    const finalTranscript = cleanedWords.map((w) => w.text).join(' ');

    // The worker already produced the final max-3-word cues from real word
    // timing. Pass them through untouched (punctuation scrubbed again for
    // safety). Validation is numeric only: never invent or re-time a cue here.
    const segments: LocalAsrSegment[] = Array.isArray(payload.segments)
      ? payload.segments
          .map((s: any, i: number) => ({
            id: Number.isFinite(Number(s?.id)) ? Number(s.id) : i + 1,
            startSeconds: Number(s?.startSeconds),
            endSeconds: Number(s?.endSeconds),
            text: stripSpokenPunctuation(String(s?.text ?? '')),
          }))
          .filter(
            (s) =>
              s.text.length > 0 &&
              Number.isFinite(s.startSeconds) &&
              Number.isFinite(s.endSeconds) &&
              s.endSeconds >= s.startSeconds
          )
      : [];

    return {
      transcript: finalTranscript,
      words: cleanedWords,
      segments,
      wordCount: cleanedWords.length,
      audioDurationSeconds: Number(payload.audioDurationSeconds) || 0,
      model: String(payload.model || 'ai4bharat/indicwav2vec-odia'),
      modelDir: String(payload.modelDir || localModelDir()),
      device: 'cpu',
      hasReliableTimestamps: payload.hasReliableTimestamps === true,
      timestampNote: String(
        payload.timestampNote ||
          'Per-word start/end from wav2vec2 CTC frame alignment (20 ms frames).'
      ),
      meanLogProb:
        payload.meanLogProb === null || payload.meanLogProb === undefined
          ? null
          : Number(payload.meanLogProb),
      inferenceSeconds: Number(payload.inferenceSeconds) || 0,
      speechRegionCount: Number(payload.speechRegionCount) || 0,
      speechSeconds: Number(payload.speechSeconds) || 0,
      nonSpeechSeconds: Number(payload.nonSpeechSeconds) || 0,
      wordsDroppedAsNonSpeech: Number(payload.wordsDroppedAsNonSpeech) || 0,
    };
  } finally {
    // The temporary upload never outlives the request.
    try {
      await fsp.rm(audioPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
