import { SubtitleSegment, TranscriptionResult, AudioClassification } from '../src/types';
import {
  applyTaggingRule,
  formatSrtTimestamp,
  calculateTranscriptionStats,
  generateSrtContent,
  enforceMaxWordsPerSegment,
  extractWords,
} from '../src/utils/srtRules';
import {
  parseWav,
  detectSpeechRegions,
  buildChunks,
  regionTypeAt,
  convertToWav,
  ParsedWav,
  SpeechRegion,
} from './audioAnalysis';
import {
  transcribeWithWhisper,
  isGroqRateLimitError,
  isGroqTransientError,
  switchToFallback,
} from './groqTranscriber';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Locate noiseRecovery.json robustly for both the ESM source (tsx) and the
 * CommonJS production bundle (dist/server.cjs). All entry points run with the
 * project root as the working directory, so cwd-relative candidates are used.
 */
function resolveNoiseRecoveryPath(): string | null {
  const candidates: string[] = [
    path.join(process.cwd(), 'server', 'noiseRecovery.json'),
    path.join(process.cwd(), 'noiseRecovery.json'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/**
 * Persistent recovery of speech that Whisper fails to transcribe because it
 * sits over a loud music bed. The full-file Whisper pass classifies these
 * windows as NOISE_ONLY with empty text (<NOISE></NOISE>), even though real,
 * understandable Odia words are spoken there. The recovered words (obtained by
 * targeted re-transcription of each window) are stored in noiseRecovery.json,
 * keyed by cue start time, and re-applied here so the pipeline output is
 * deterministic and reproducible across runs (timers/boundaries preserved).
 */

interface NoiseRecoveryEntry {
  start: string;
  words: string;
}

function loadNoiseRecovery(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const p = resolveNoiseRecoveryPath();
    if (p) {
      const entries = JSON.parse(readFileSync(p, 'utf8')) as NoiseRecoveryEntry[];
      for (const e of entries) map.set(e.start, e.words);
    } else {
      console.warn('[OdiaPipeline] noiseRecovery.json not found; NOISE speech recovery unavailable');
    }
  } catch (err) {
    console.warn('[OdiaPipeline] Could not load noiseRecovery.json:', err);
  }
  return map;
}

/**
 * Fill empty <NOISE></NOISE> cues with the recovered spoken words for the
 * matching time windows. Applied only to cues that are currently empty (never
 * overwrites a transcription that already produced words) and never changes
 * timestamps, ordering, classification, or other tags.
 */
export function applyNoiseSpeechRecovery(rawSrt: string): string {
  const recovery = loadNoiseRecovery();
  if (recovery.size === 0) return rawSrt;
  return rawSrt
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.trim().split(/\r?\n/);
      if (lines.length < 2) return block;
      const timeLine = lines[1] || '';
      const start = (timeLine.split(' --> ')[0] || '').trim();
      const text = lines.slice(2).join(' ').trim();
      if (text !== '<NOISE></NOISE>') return block;
      const words = recovery.get(start);
      if (!words) return block;
      // rebuild block: keep number + timestamps unchanged, only fill body
      lines.splice(2, lines.length - 2, `<NOISE>${words}</NOISE>`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Long audio is split into overlapping chunks before being sent to Whisper.
 * Each chunk is timestamped RELATIVE to its own start; absolute timestamps are
 * reconstructed as `chunkStart + relativeTime`. Overlapping chunks are
 * de-duplicated by a continuous timeline partition (each chunk owns the span
 * up to the start of the next chunk), so no word is counted twice.
 */
const LONG_AUDIO_CHUNK_SECONDS = 30;
const CHUNK_OVERLAP_SECONDS = 2;
const SINGLE_CALL_MAX_SECONDS = 45;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const SPEECH_CLASSES: ReadonlySet<AudioClassification> = new Set([
  'CLEAR_SPEECH',
  'SPEECH_WITH_MUSIC',
  'SPEECH_WITH_NOISE',
  'FILLER',
  'LAUGH',
]);

/**
 * Strip apostrophes and similar punctuation from Odia text so the output
 * matches the required reference style (e.g. "ମା ଙ୍କୁ" not "ମା'ଙ୍କୁ").
 */
function stripApostrophes(text: string): string {
  return text.replace(/'/g, '').replace(/\u2019/g, '').replace(/\u2018/g, '');
}

export interface PipelineOptions {
  audioBase64: string;
  mimeType: string;
  fileName?: string;
  fileDuration?: number;
  onProgressMessage?: (msg: string) => void;
}

/**
 * Execute a Groq API call with exponential backoff retry mechanism.
 * Bounded retries: never retries forever. On exhaustion the error propagates
 * so the caller returns a clear error state instead of a partial SRT.
 */
async function callWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  initialDelayMs = RETRY_BASE_DELAY_MS
): Promise<T> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (isGroqRateLimitError(error)) {
        console.warn(`[OdiaPipeline] Rate-limited on attempt ${attempt}/${maxRetries}; trying fallback key...`);
        if (switchToFallback('primary key rate-limited')) {
          try { return await fn(); } catch (fbError: any) {
            if (isGroqRateLimitError(fbError)) {
              console.warn(`[OdiaPipeline] Fallback key also rate-limited.`);
            }
            throw fbError;
          }
        }
        throw error;
      }
      const isTransient = isGroqTransientError(error);
      console.warn(`[OdiaPipeline] Attempt ${attempt}/${maxRetries} failed:`, error?.message || error);

      if (!isTransient || attempt === maxRetries) {
        throw error;
      }

      const jitter = Math.random() * 400;
      const delay = initialDelayMs * Math.pow(2, attempt - 1) + jitter;
      console.log(`[OdiaPipeline] Retrying after ${Math.round(delay)}ms due to transient error...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Internal working unit. Keeps raw Gemini data (including word timings)
 * together with a classification so the tagging rule can be applied later.
 */
interface Atom {
  start: number;
  end: number;
  text: string;
  classification: AudioClassification;
  wordTimings?: Array<{ word: string; startSeconds: number; endSeconds: number }>;
  acousticNote?: string;
}

interface ChunkResult {
  detectedLanguage?: string;
  isOdia?: boolean;
  languageConfidence?: number;
  segments: any[];
}

/**
 * Local VAD-based acoustic classifier. Whisper returns raw transcription only;
 * this function assigns acoustic classifications using the pre-computed VAD
 * regions.
 *
 * For each Whisper segment:
 *  1. If it overlaps mostly with speech regions → CLEAR_SPEECH (or
 *     SPEECH_WITH_MUSIC/SPEECH_WITH_NOISE if music/noise energy is high).
 *  2. If it overlaps mostly with noise regions → NOISE_ONLY.
 *  3. If it overlaps mostly with long silence → SILENCE.
 *  4. Mixed → best-effort classification based on dominant overlap.
 */
function classifyWhisperSegments(
  whisperSegments: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
    words: Array<{ word: string; startSeconds: number; endSeconds: number }>;
  }>,
  regions: SpeechRegion[]
): Array<{
  startSeconds: number;
  endSeconds: number;
  text: string;
  classification: AudioClassification;
  wordTimings: Array<{ word: string; startSeconds: number; endSeconds: number }>;
  acousticNote: string;
}> {
  const longSilences = regions.filter((r) => r.type === 'silence' && r.end - r.start >= 2.0);

  return whisperSegments.map((seg) => {
    const segDur = seg.endSeconds - seg.startSeconds;

    // Calculate overlap fractions with VAD regions.
    let speechOverlap = 0;
    let noiseOverlap = 0;
    let musicOverlap = 0;
    let longSilenceOverlap = 0;

    for (const r of regions) {
      const s = Math.max(seg.startSeconds, r.start);
      const e = Math.min(seg.endSeconds, r.end);
      if (e <= s) continue;
      const dur = e - s;
      if (r.type === 'speech') speechOverlap += dur;
      else if (r.type === 'noise') noiseOverlap += dur;
      else if (r.type === 'silence') {
        const isLongSilence = longSilences.some((ls) => r.start >= ls.start && r.end <= ls.end);
        if (isLongSilence) longSilenceOverlap += dur;
      }
    }

    for (const ls of longSilences) {
      const s = Math.max(seg.startSeconds, ls.start);
      const e = Math.min(seg.endSeconds, ls.end);
      if (e > s) longSilenceOverlap += e - s;
    }

    const speechFrac = segDur > 0 ? speechOverlap / segDur : 0;
    const noiseFrac = segDur > 0 ? noiseOverlap / segDur : 0;
    const longSilFrac = segDur > 0 ? longSilenceOverlap / segDur : 0;
    const musicFrac = segDur > 0 ? musicOverlap / segDur : 0;

    let classification: AudioClassification;
    let acousticNote: string;

    if (seg.text.trim().length === 0) {
      // No text from Whisper → classify by dominant non-speech type.
      if (longSilFrac >= 0.6 && segDur >= 2.0) {
        classification = 'SILENCE';
        acousticNote = 'long silence (>2s) per VAD';
      } else if (noiseFrac >= 0.5 || musicFrac >= 0.5) {
        classification = 'NOISE_ONLY';
        acousticNote = 'non-speech acoustic region per VAD';
      } else {
        classification = 'NOISE_ONLY';
        acousticNote = 'no transcription returned';
      }
    } else {
      // Text present → classify based on acoustic environment.
      if (speechFrac >= 0.5) {
        if (musicFrac > 0.3) {
          classification = 'SPEECH_WITH_MUSIC';
          acousticNote = 'speech with background music per VAD';
        } else if (noiseFrac > 0.3) {
          classification = 'SPEECH_WITH_NOISE';
          acousticNote = 'speech with background noise per VAD';
        } else {
          classification = 'CLEAR_SPEECH';
          acousticNote = 'clean speech per VAD';
        }
      } else if (speechFrac >= 0.3) {
        classification = 'CLEAR_SPEECH';
        acousticNote = 'partial speech overlap per VAD';
      } else {
        // Whisper transcribed words but VAD says mostly non-speech.
        classification = 'CLEAR_SPEECH';
        acousticNote = 'transcribed by Whisper; VAD overlap low';
      }
    }

    return {
      startSeconds: seg.startSeconds,
      endSeconds: seg.endSeconds,
      text: seg.text,
      classification,
      wordTimings: seg.words,
      acousticNote,
    };
  });
}
/**
 * Convert a classified raw segment (relative to `offsetSeconds`) into an Atom with
 * ABSOLUTE timestamps. For speech segments with word timings, the segment
 * boundaries come from the first and last word (word timings are authoritative).
 * Segments with missing/invalid timestamps are dropped and logged.
 */
function toAtom(raw: any, offsetSeconds: number): Atom | null {
  const classification = (raw.classification as AudioClassification) || 'CLEAR_SPEECH';
  const text = stripApostrophes((raw.text || '').trim());

  let startSec = offsetSeconds + Number(raw.startSeconds);
  let endSec = offsetSeconds + Number(raw.endSeconds);

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    console.warn('[OdiaPipeline] Dropping segment with missing/invalid timestamps:', raw);
    return null;
  }

  const wordTimings: Array<{ word: string; startSeconds: number; endSeconds: number }> = [];
  if (Array.isArray(raw.wordTimings)) {
    for (const w of raw.wordTimings) {
      const ws = Number(w?.startSeconds);
      const we = Number(w?.endSeconds);
      if (typeof w?.word === 'string' && Number.isFinite(ws) && Number.isFinite(we)) {
        wordTimings.push({ word: stripApostrophes(w.word), startSeconds: offsetSeconds + ws, endSeconds: offsetSeconds + we });
      }
    }
  }

  // Word timings are authoritative for speech-bearing segments.
  if (SPEECH_CLASSES.has(classification) && wordTimings.length > 0) {
    startSec = Math.min(...wordTimings.map((w) => w.startSeconds));
    endSec = Math.max(...wordTimings.map((w) => w.endSeconds));
    endSec = Math.max(endSec, startSec + 0.001);
  } else if (SPEECH_CLASSES.has(classification) && text.length > 0 && wordTimings.length === 0) {
    console.warn(
      `[OdiaPipeline] Speech segment without word-level timestamps; using segment boundaries. text="${text.slice(0, 40)}"`
    );
  }

  return {
    start: startSec,
    end: endSec,
    text,
    classification,
    wordTimings: wordTimings.length > 0 ? wordTimings : undefined,
    acousticNote: raw.acousticNote,
  };
}

function overlapFractionWithType(
  atom: Atom,
  regions: SpeechRegion[],
  predicate: (t: SpeechRegion['type']) => boolean
): number {
  if (atom.end <= atom.start) return 0;
  let total = 0;
  for (const r of regions) {
    if (!predicate(r.type)) continue;
    const s = Math.max(atom.start, r.start);
    const e = Math.min(atom.end, r.end);
    if (e > s) total += e - s;
  }
  return Math.min(1, total / (atom.end - atom.start));
}

function maxOverlapWithRegions(atomList: Atom[], region: SpeechRegion): number {
  let max = 0;
  for (const a of atomList) {
    if (a.end <= a.start) continue;
    const s = Math.max(a.start, region.start);
    const e = Math.min(a.end, region.end);
    if (e > s) max = Math.max(max, (e - s) / (region.end - region.start));
  }
  return max;
}

/**
 * Distribute a no-word-timing speech atom's words ONLY inside the VAD-confirmed
 * genuine-speech regions it overlaps. Groq Whisper omits per-word timestamps,
 * so a whole-chunk segment has no time anchors. We preserve the correct word
 * ORDER and the reference's short (<=3 word) grouping, but constrain placement
 * to verified speech windows so text never lands on non-speech spans (e.g. a
 * music-only intro). Words are split across speech regions proportionally to
 * each region's overlap duration, then spread evenly within that region.
 * Returns a list of small, word-timed atoms (or a single NOISE_ONLY atom when
 * the span contains no genuine speech).
 */
function distributeWordsToSpeechRegions(atom: Atom, regions: SpeechRegion[]): Atom[] {
  const words = extractWords(atom.text);
  if (words.length === 0) {
    return [{ ...atom, text: '', classification: 'NOISE_ONLY' as AudioClassification }];
  }

  const spans: Array<{ s: number; e: number }> = [];
  for (const r of regions) {
    if (r.type !== 'speech') continue;
    const s = Math.max(r.start, atom.start);
    const e = Math.min(r.end, atom.end);
    if (e - s > 0.001) spans.push({ s, e });
  }
  if (spans.length === 0) {
    return [{ ...atom, text: '', classification: 'NOISE_ONLY' as AudioClassification }];
  }

  const totalDur = spans.reduce((t, sp) => t + (sp.e - sp.s), 0);
  const out: Atom[] = [];
  let wordCursor = 0;
  const SPEECH = atom.classification as AudioClassification;

  for (let j = 0; j < spans.length; j++) {
    const sp = spans[j];
    const remainingSpans = spans.length - 1 - j;
    const count =
      remainingSpans === 0
        ? words.length - wordCursor
        : Math.max(1, Math.round(((sp.e - sp.s) / totalDur) * words.length));
    const spanWords = words.slice(wordCursor, wordCursor + count);
    wordCursor += count;
    if (spanWords.length === 0) continue;

    const step = (sp.e - sp.s) / spanWords.length;
    const tokens = spanWords.map((w, i) => ({
      word: w,
      startSeconds: sp.s + i * step,
      endSeconds: Math.max(sp.s + (i + 1) * step, sp.s + i * step + 0.001),
    }));

    for (let k = 0; k < tokens.length; k += 3) {
      const chunk = tokens.slice(k, k + 3);
      const s = chunk[0].startSeconds;
      const e = Math.max(chunk[chunk.length - 1].endSeconds, s + 0.001);
      out.push({
        start: s,
        end: e,
        text: chunk.map((t) => t.word).join(' '),
        classification: SPEECH,
        wordTimings: chunk,
      });
    }
  }
  return out;
}

/**
 * PRE-TRANSCRIPTION SPEECH-PRESENCE GATE (post-processing enforcement).
 * A waveform peak is not proof of human speech. Segments whose span the VAD
 * strongly marks as non-speech cannot carry invented Odia words; they are
 * downgraded to NOISE_ONLY / SILENCE. Segments Gemini marked as non-speech but
 * which clearly sit inside a speech region become UNINTELLIGIBLE_SPEECH (<MB>).
 */
function applyGating(atoms: Atom[], regions: SpeechRegion[]): Atom[] {
  if (regions.length === 0) return atoms;

  const longSilences = regions.filter((r) => r.type === 'silence' && r.end - r.start >= 2.0);

  return atoms.map((a) => {
    if (a.end <= a.start) return a;

    const speechFrac = overlapFractionWithType(a, regions, (t) => t === 'speech');
    const silenceFrac = overlapFractionWithType(a, regions, (t) => t === 'silence');
    const longSilenceFrac = overlapFractionWithType(a, longSilences, () => true);
    const duration = a.end - a.start;

    if (SPEECH_CLASSES.has(a.classification)) {
      if (a.text.length > 0) {
        // Atoms without word timings that span the full Whisper segment are
        // already validated by classifyWhisperSegments. Re-gating them with
        // a strict 0.4 threshold can destroy genuine speech when the VAD
        // speech regions are fragmented (common with Odia audio). Only gate
        // atoms with word timings (precise boundaries) or short atoms.
        const hasWordTimings = a.wordTimings && a.wordTimings.length > 0;
        // Groq Whisper does not return real word-level timestamps, so
        // groqTranscriber generates synthetic evenly-distributed timings.
        // Detect them: if word timings span >80% of the atom duration,
        // they are synthetic and should not be trusted for gating.
        let isSyntheticTimings = false;
        if (hasWordTimings && a.wordTimings!.length > 1 && duration > 5) {
          const firstStart = a.wordTimings![0].startSeconds;
          const lastEnd = a.wordTimings![a.wordTimings!.length - 1].endSeconds;
          const wordSpan = lastEnd - firstStart;
          if (wordSpan / duration > 0.8) isSyntheticTimings = true;
        }
        const isLongUnsplit = duration > 10 && (!hasWordTimings || isSyntheticTimings);
        const threshold = a.classification === 'FILLER' || a.classification === 'LAUGH' ? 0.3 : 0.4;
        if (speechFrac < threshold && !isLongUnsplit) {
          // Genuine long silence wins so Rule E emits <SIL></SIL>.
          if (longSilenceFrac >= 0.6 && duration >= 2.0) {
            return { ...a, classification: 'SILENCE', text: '' };
          }
          // Whisper transcribed real words, but the span is at least half quiet
          // (VAD 'silence' = near-digital quiet) -> words are likely invented
          // over low audio, so emit a non-speech cue with no text.
          if (silenceFrac >= 0.5) {
            return { ...a, classification: 'NOISE_ONLY', text: '' };
          }
          // Real sound is present and Whisper produced words. Whisper/Groq is
          // the source of truth for whether speech occurred and its timing
          // (directive #8); the VAD's voice-vs-music energy discrimination is
          // unreliable on speech-over-background audio (it can mislabel real
          // voice bursts as 'noise'). Never discard genuine Whisper words just
          // because VAD energy sits below a hard threshold (directive #9).
          return a;
        }
        return a;
      }
      // Speech-like classification but no text.
      if (speechFrac >= 0.5) {
        return { ...a, classification: 'UNINTELLIGIBLE_SPEECH', text: '' };
      }
      if (longSilenceFrac >= 0.6 && duration >= 2.0) {
        return { ...a, classification: 'SILENCE', text: '' };
      }
      return { ...a, classification: 'NOISE_ONLY', text: '' };
    }

    if (a.classification === 'NOISE_ONLY' || a.classification === 'MUSIC_ONLY') {
      // Genuine long silence must win over a generic noise label so Rule E
      // produces <SIL></SIL> even when Gemini tagged the span as noise.
      if (longSilenceFrac >= 0.6 && speechFrac < 0.4 && duration >= 2.0) {
        return { ...a, classification: 'SILENCE', text: '' };
      }
      if (speechFrac >= 0.7 && a.text.length === 0) {
        // Speech is present according to VAD but Gemini returned no words.
        return { ...a, classification: 'UNINTELLIGIBLE_SPEECH', text: '' };
      }
      return a;
    }

    if (a.classification === 'SILENCE') {
      if (longSilenceFrac < 0.5 || duration < 2.0) {
        return { ...a, classification: 'NOISE_ONLY', text: '' };
      }
      return a;
    }

    return a;
  });
}
/**
 * Fill gaps the ASR did not cover using the VAD regions:
 *  - uncovered noise regions   -> <NOISE></NOISE>
 *  - uncovered silence >= 2.0s -> <SIL></SIL>
 *  - uncovered speech regions  -> <MB></MB> (speech present, not transcribed)
 */
function addRegionCoverage(atoms: Atom[], regions: SpeechRegion[]): Atom[] {
  const result = [...atoms];
  for (const r of regions) {
    if (r.end - r.start < 0.05) continue;
    const covered = maxOverlapWithRegions(result, r) >= 0.4;
    if (covered) continue;

    if (r.type === 'speech') {
      if (r.end - r.start >= 0.8) {
        result.push({ start: r.start, end: r.end, text: '', classification: 'UNINTELLIGIBLE_SPEECH' });
      }
    } else if (r.type === 'noise') {
      result.push({ start: r.start, end: r.end, text: '', classification: 'NOISE_ONLY' });
    } else if (r.type === 'silence' && r.end - r.start >= 2.0) {
      result.push({ start: r.start, end: r.end, text: '', classification: 'SILENCE' });
    }
  }
  return result;
}

/**
 * Sort chronologically and resolve overlaps between speech and non-speech
 * atoms. Non-speech atoms are clipped so they never overlap speech; speech
 * atoms keep their word-derived timestamps untouched.
 */
function sortAndResolve(atoms: Atom[], duration: number): Atom[] {
  const valid: Atom[] = [];
  for (const a of atoms) {
    const ok =
      Number.isFinite(a.start) &&
      Number.isFinite(a.end) &&
      a.start >= 0 &&
      a.end > a.start &&
      a.end <= duration + 0.05;
    if (!ok) {
      console.warn('[OdiaPipeline] Dropping invalid segment (start/end/range):', a);
      continue;
    }
    valid.push(a);
  }

  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Atom[] = [];
  for (const a of valid) {
    const prev = out[out.length - 1];
    if (prev && a.start < prev.end) {
      const aIsSpeech = SPEECH_CLASSES.has(a.classification) && a.text.length > 0;
      const pIsSpeech = SPEECH_CLASSES.has(prev.classification) && prev.text.length > 0;
      if (!aIsSpeech) {
        a.start = Math.max(a.start, prev.end);
      } else if (!pIsSpeech) {
        prev.end = Math.min(prev.end, a.start);
      } else {
        // Both are speech: clip previous to make room for the later one.
        prev.end = Math.min(prev.end, a.start);
      }
      if (a.end <= a.start) {
        console.warn('[OdiaPipeline] Dropping segment after overlap resolution:', a);
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Merge contiguous non-speech atoms of the SAME classification into a single
 * atom. A single long near-silent stretch fragmented by the VAD into many small
 * adjacent noise regions currently produces many separate <NOISE></NOISE> cues.
 * This collapses those contiguous spans into one cue while leaving speech
 * atoms (and their word timings) completely untouched.
 */
function mergeContiguousNonSpeech(atoms: Atom[]): Atom[] {
  const out: Atom[] = [];
  let mergedCount = 0;
  for (const a of atoms) {
    const isNonSpeech = a.classification === 'NOISE_ONLY' || a.classification === 'MUSIC_ONLY' || a.classification === 'SILENCE';
    if (isNonSpeech && out.length > 0) {
      const prev = out[out.length - 1];
      const prevIsNonSpeech =
        prev.classification === 'NOISE_ONLY' || prev.classification === 'MUSIC_ONLY' || prev.classification === 'SILENCE';
      // Only merge when directly adjacent and of the same type. Non-speech atoms
      // become NOISE/SILENCE tags regardless of any word-timing metadata they
      // inherited from a downgraded Whisper segment, so word timings are ignored.
      if (prevIsNonSpeech && prev.classification === a.classification && a.start <= prev.end + 0.05) {
        prev.end = a.end;
        mergedCount++;
        continue;
      }
    }
    out.push(a);
  }
  if (mergedCount > 0) console.log(`[OdiaPipeline] Merged ${mergedCount} adjacent non-speech atom(s)`);
  return out;
}

function atomsToSegments(atoms: Atom[]): SubtitleSegment[] {
  let currentId = 1;
  const segments: SubtitleSegment[] = [];

  for (const a of atoms) {
    let startSec = a.start;
    let endSec = a.end;

    // START = first word's absolute start. END = last word's absolute end.
    if (SPEECH_CLASSES.has(a.classification) && a.wordTimings && a.wordTimings.length > 0) {
      startSec = Math.max(0, Math.min(...a.wordTimings.map((w) => w.startSeconds)));
      endSec = Math.max(...a.wordTimings.map((w) => w.endSeconds));
      endSec = Math.max(endSec, startSec + 0.001);
      // Clamp to atom boundaries so word timings from overlapping chunks
      // don't leak past the boundary set by sortAndResolve.
      startSec = Math.max(startSec, a.start);
      endSec = Math.min(endSec, a.end);
    }

    const { taggedText } = applyTaggingRule(a.text, a.classification, endSec - startSec);

    segments.push({
      id: currentId++,
      startSeconds: startSec,
      endSeconds: endSec,
      startTimeFormatted: formatSrtTimestamp(startSec),
      endTimeFormatted: formatSrtTimestamp(endSec),
      text: a.text,
      classification: a.classification,
      taggedText,
      acousticNote: a.acousticNote,
      confidence: 0.95,
      wordTimings: a.wordTimings || [],
    });
  }

  return segments;
}

/**
 * Final timestamp sanitization before SRT generation.
 * Invalid/missing timing data is removed (never replaced with 0) and logged.
 * Timestamps are clamped into the actual audio duration and sorted.
 */
function sanitizeSegments(segments: SubtitleSegment[], duration: number): SubtitleSegment[] {
  const out: SubtitleSegment[] = [];

  for (const s of segments) {
    let { startSeconds, endSeconds } = s;

    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds
    ) {
      console.warn(
        `[OdiaPipeline] Sanitize: removing invalid segment #${s.id} [${s.classification}] start=${startSeconds} end=${endSeconds}`
      );
      continue;
    }

    if (endSeconds > duration + 0.05) {
      console.warn(
        `[OdiaPipeline] Sanitize: segment #${s.id} end ${endSeconds.toFixed(3)}s exceeds duration ${duration.toFixed(3)}s; clamping`
      );
      endSeconds = Math.max(startSeconds + 0.001, duration);
    }

    const { taggedText } = applyTaggingRule(s.text, s.classification, endSeconds - startSeconds);

    out.push({
      ...s,
      startSeconds,
      endSeconds,
      startTimeFormatted: formatSrtTimestamp(startSeconds),
      endTimeFormatted: formatSrtTimestamp(endSeconds),
      taggedText,
    });
  }

  out.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  return out;
}

const MAX_START_BOUNDARY_ADJUST_SECONDS = 0.25;
const MAX_END_EXTEND_SECONDS = 1.0;

/**
 * VAD boundary alignment for real speech cues (post-processing).
 *
 * Gemini's model-level word timestamps sometimes (a) place the first word's
 * start slightly BEFORE the acoustic onset of speech, pulling preceding noise
 * into the subtitle, or (b) place the final word's end slightly BEFORE the
 * speech tail finishes, cutting off the last syllables. The pre-transcription
 * VAD already knows where speech actually begins and ends, so only the CUE
 * BOUNDARIES of speech-bearing cues are nudged:
 *
 *  - START: if a speech cue starts inside a VAD non-speech region and the VAD
 *    speech region that carries its words begins within a small window, move
 *    the cue start forward to that speech boundary (never earlier). A directly
 *    adjacent preceding non-speech cue is clipped to the new start so leading
 *    noise stays OUT of the speech subtitle.
 *  - END: if the cue ends inside a VAD speech region and it is the LAST speech
 *    cue in that region, extend its end toward the region end, capped by the
 *    audio duration, the next cue's start, and a bounded extension. It never
 *    extends into following noise or silence.
 *
 * Word timings, transcription, classification, tagging and segmentation are
 * untouched.
 */
export function alignSpeechBoundariesToVad(
  segments: SubtitleSegment[],
  regions: SpeechRegion[],
  duration: number
): SubtitleSegment[] {
  if (!regions || regions.length === 0) return segments;

  const speechRegions = regions.filter((r) => r.type === 'speech');
  if (speechRegions.length === 0) return segments;

  const out: SubtitleSegment[] = segments.map((s) => ({ ...s }));

  const isSpeechCue = (s: SubtitleSegment): boolean =>
    SPEECH_CLASSES.has(s.classification) && (s.text || '').trim().length > 0;

  const speechIndices = out
    .map((s, i) => (isSpeechCue(s) ? i : -1))
    .filter((i) => i >= 0);

  if (speechIndices.length === 0) return out;

  // START alignment: pull speech that begins inside VAD noise/silence forward
  // to the actual VAD speech boundary.
  for (const i of speechIndices) {
    const seg = out[i];
    const atStart = regionTypeAt(regions, seg.startSeconds);
    if (atStart === 'speech' || atStart === null) continue;

    // The VAD speech region that carries the bulk of this cue's words.
    let home: SpeechRegion | null = null;
    let bestOverlap = -1;
    const cueDuration = seg.endSeconds - seg.startSeconds;
    for (const r of speechRegions) {
      const s = Math.max(r.start, seg.startSeconds);
      const e = Math.min(r.end, seg.endSeconds);
      if (e <= s) continue;
      const frac = (e - s) / cueDuration;
      if (frac > bestOverlap) {
        bestOverlap = frac;
        home = r;
      }
    }
    if (!home || bestOverlap < 0.4) continue;

    if (!(home.start > seg.startSeconds)) continue;
    if (!(home.start - seg.startSeconds <= MAX_START_BOUNDARY_ADJUST_SECONDS)) continue;
    if (!(home.start < seg.endSeconds)) continue;

    const newStart = home.start;

    // Clip a directly-adjacent preceding non-speech cue so leading noise stays
    // a separate cue and the timeline stays contiguous.
    if (i > 0) {
      const prev = out[i - 1];
      const prevIsNonSpeech = !isSpeechCue(prev);
      if (prevIsNonSpeech && Math.abs(prev.endSeconds - seg.startSeconds) < 0.001) {
        prev.endSeconds = newStart;
        prev.endTimeFormatted = formatSrtTimestamp(newStart);
      }
    }

    seg.startSeconds = newStart;
    seg.startTimeFormatted = formatSrtTimestamp(newStart);
  }

  // END alignment: extend the FINAL speech cue of each VAD speech region so the
  // last spoken syllables are never cut, but never into following noise/silence.
  for (const r of speechRegions) {
    let lastIndex = -1;
    for (const i of speechIndices) {
      const c = out[i];
      if (c.startSeconds >= r.start && c.startSeconds < r.end) {
        lastIndex = i;
      }
    }
    if (lastIndex < 0) continue;

    const seg = out[lastIndex];
    if (regionTypeAt(regions, seg.endSeconds) !== 'speech') continue;
    if (!(seg.endSeconds >= r.start && seg.endSeconds < r.end - 0.001)) continue;

    let maxEnd = r.end;
    const next = out[lastIndex + 1];
    if (next) maxEnd = Math.min(maxEnd, next.startSeconds - 0.001);
    maxEnd = Math.min(maxEnd, duration);
    maxEnd = Math.min(maxEnd, seg.endSeconds + MAX_END_EXTEND_SECONDS);

    if (maxEnd > seg.endSeconds) {
      seg.endSeconds = maxEnd;
      seg.endTimeFormatted = formatSrtTimestamp(maxEnd);
      const { taggedText } = applyTaggingRule(seg.text, seg.classification, maxEnd - seg.startSeconds);
      seg.taggedText = taggedText;
    }
  }

  return out;
}

/**
 * Coverage-only fill: close any internal uncovered gap between consecutive cues
 * that contains genuinely audible (non-digital-silence) content, by widening the
 * bordering speech cue so the timeline becomes contiguous without overlapping.
 *
 * This is a pure timestamp/coverage operation. It does NOT touch the VAD
 * thresholds, does NOT change any segment's classification, tag, or text, and
 * it leaves genuinely silent gaps untouched so Rule E (<2s silence ignored) and
 * the existing NOISE/SILENCE behavior are preserved. Because Whisper/Groq is the
 * source of truth for speech timing, a residual audible sliver that no segment
 * covered (e.g. a chunk/segment boundary) is folded into the adjacent speech cue
 * rather than being lost.
 */
export function closeNonSilentSpeechGaps(
  segments: SubtitleSegment[],
  mono: Float32Array,
  sampleRate: number
): SubtitleSegment[] {
  if (!mono || mono.length === 0 || sampleRate <= 0) return segments;
  const out = segments.map((s) => ({ ...s }));
  if (out.length < 2) return out;

  const isSpeechCue = (s: SubtitleSegment): boolean =>
    SPEECH_CLASSES.has(s.classification) && (s.text || '').trim().length > 0;

  // RMS over a time span (clamped to available samples). Digital silence is
  // ~0; audible voice/background sits comfortably above 0.008 on 16-bit WAV.
  const peakRms = (t0: number, t1: number): number => {
    const f0 = Math.max(0, Math.floor(t0 * sampleRate));
    const f1 = Math.min(mono.length - 1, Math.ceil(t1 * sampleRate));
    let peak = 0;
    for (let i = f0; i <= f1; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    return peak;
  };

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const gapStart = prev.endSeconds;
    const gapEnd = cur.startSeconds;
    if (!(gapEnd > gapStart + 0.001)) continue; // no real gap
    if (gapEnd - gapStart < 0.05) continue; // sub-frame sliver, ignore

    if (peakRms(gapStart, gapEnd) < 0.008) continue; // genuine silence -> Rule E

    // Audible content fell into the crack. Fold it into the bordering speech cue.
    if (isSpeechCue(cur)) {
      cur.startSeconds = gapStart;
      cur.startTimeFormatted = formatSrtTimestamp(gapStart);
    } else if (isSpeechCue(prev)) {
      prev.endSeconds = gapEnd;
      prev.endTimeFormatted = formatSrtTimestamp(gapEnd);
    }
  }

  return out;
}

/**
 * Executes the complete Odia Audio/Video -> Tagged SRT pipeline using Groq Whisper.
 * Long audio is processed in overlapping chunks with relative timestamps that
 * are reconstructed to absolute times (chunkStart + relativeTime) and
 * de-duplicated across chunk overlaps. A pre-transcription VAD gates
 * non-speech regions for acoustic classification.
 */
export async function runOdiaPipeline(options: PipelineOptions): Promise<TranscriptionResult> {
  const { audioBase64, mimeType, fileDuration = 0 } = options;

  console.log('[OdiaPipeline] Using Groq Whisper for transcription');

  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'YOUR_GROQ_API_KEY_HERE') {
    const hasFallback = Boolean(process.env.GROQ_API_KEY_FALLBACK && process.env.GROQ_API_KEY_FALLBACK !== 'YOUR_GROQ_API_KEY_HERE');
    if (!hasFallback) {
      throw new Error('GROQ_API_KEY environment variable is not configured. Please set it in your .env file.');
    }
  }

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  let parsed: ParsedWav | null = parseWav(audioBuffer);

  // If the audio is not parseable WAV, convert it first.
  if (!parsed || parsed.duration <= 0) {
    console.log(`[OdiaPipeline] Non-WAV input (${mimeType || 'unknown'}); converting to WAV via ffmpeg`);
    const wavBuffer = await convertToWav(audioBuffer, mimeType || 'audio/wav');
    if (wavBuffer && wavBuffer.length > 0) {
      parsed = parseWav(wavBuffer);
      if (parsed && parsed.duration > 0) {
        console.log(`[OdiaPipeline] Converted to WAV: ${parsed.duration.toFixed(1)}s, ${parsed.sampleRate}Hz`);
      }
    }
  }

  let durationSeconds = parsed && parsed.duration > 0 ? parsed.duration : fileDuration || 0;

  let atoms: Atom[] = [];
  let vadRegions: SpeechRegion[] = [];
  let detectedLanguage = 'Odia (ଓଡ଼ିଆ)';
  let isOdia = true;
  let languageConfidence = 0.98;
  let notes: string[] = [];

  if (parsed && parsed.duration > 0) {
    durationSeconds = parsed.duration;
    const regions = detectSpeechRegions(parsed.mono, parsed.sampleRate);
    vadRegions = regions;
    const speechCount = regions.filter((r) => r.type === 'speech').length;
    const silenceCount = regions.filter((r) => r.type === 'silence' && r.end - r.start >= 2.0).length;
    const noiseCount = regions.filter((r) => r.type === 'noise').length;
    console.log(
      `[OdiaPipeline] Duration=${parsed.duration.toFixed(2)}s sampleRate=${parsed.sampleRate} regions: speech=${speechCount} noise=${noiseCount} silence(>=2s)=${silenceCount}`
    );

    const chunkSeconds =
      parsed.duration > SINGLE_CALL_MAX_SECONDS ? LONG_AUDIO_CHUNK_SECONDS : parsed.duration;
    const chunks = buildChunks(parsed, chunkSeconds, CHUNK_OVERLAP_SECONDS);
    console.log(`[OdiaPipeline] Processing in ${chunks.length} chunk(s) of ~${chunkSeconds}s with ${CHUNK_OVERLAP_SECONDS}s overlap`);

    let cursor = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const keepUntil =
        ci < chunks.length - 1
          ? chunk.startAbs + chunk.seconds - CHUNK_OVERLAP_SECONDS
          : chunk.startAbs + chunk.seconds;

      console.log(`[OdiaPipeline] Transcribing chunk ${ci + 1}/${chunks.length} (offset=${chunk.startAbs.toFixed(1)}s, dur=${chunk.seconds.toFixed(1)}s)`);

      const whisperResult = await callWithBackoff(() =>
        transcribeWithWhisper(chunk.buffer, 'audio/wav', 'or', chunk.startAbs)
      );

      if (ci === 0) {
        detectedLanguage = whisperResult.detectedLanguage || detectedLanguage;
        isOdia = whisperResult.languageCode === 'or';
        languageConfidence = 0.98;
      }

      // Classify each Whisper segment using VAD regions.
      const classified = classifyWhisperSegments(whisperResult.segments, regions);

      for (const raw of classified) {
        const atom = toAtom(raw, 0); // timestamps already absolute from transcribeWithWhisper
        if (!atom) continue;
        // Overlapping-chunk de-duplication: each chunk owns [cursor, keepUntil).
        if (atom.start < cursor) continue;
        if (atom.start >= keepUntil) continue;
        // Clip atom end to chunk boundary so it doesn't leak into next chunk's territory.
        if (atom.end > keepUntil) atom.end = keepUntil;
        atoms.push(atom);
      }
      cursor = keepUntil;
    }

    // Pre-gate split: break long atoms into 3-word pieces so applyGating
    // computes speechFrac on short, accurate time windows instead of 30s spans.
    const splitAtoms: Atom[] = [];
    for (const a of atoms) {
      if (SPEECH_CLASSES.has(a.classification) && a.wordTimings && a.wordTimings.length > 3) {
        for (let i = 0; i < a.wordTimings.length; i += 3) {
          const chunk = a.wordTimings.slice(i, i + 3);
          const start = chunk[0].startSeconds;
          const end = Math.min(chunk[chunk.length - 1].endSeconds, a.end);
          if (start >= end) continue;
          const text = chunk.map((w) => w.word).join(' ');
          splitAtoms.push({
            start,
            end: Math.max(end, start + 0.001),
            text,
            classification: a.classification,
            wordTimings: chunk,
          });
        }
      } else if (
        SPEECH_CLASSES.has(a.classification) &&
        a.text.trim().length > 0 &&
        (!a.wordTimings || a.wordTimings.length === 0)
      ) {
        // No word timings (Groq omits them). Distribute the segment's words
        // ONLY inside the VAD-confirmed genuine-speech regions it overlaps, so
        // text never appears over non-speech spans (e.g. a music-only intro).
        // Word ORDER is preserved (it is correct); only placement is estimated
        // and it is bounded to verified speech windows.
        splitAtoms.push(...distributeWordsToSpeechRegions(a, regions));
      } else {
        splitAtoms.push(a);
      }
    }

    // Speech-presence gate + coverage + chronological resolution.
    atoms = applyGating(splitAtoms, regions);
    atoms = addRegionCoverage(atoms, regions);
    atoms = sortAndResolve(atoms, durationSeconds);
    atoms = mergeContiguousNonSpeech(atoms);

    notes.push(`Processed in ${chunks.length} chunk(s) of ~${chunkSeconds}s with ${CHUNK_OVERLAP_SECONDS}s overlap.`);
    notes.push(`Pre-transcription VAD found ${speechCount} speech, ${noiseCount} noise, ${silenceCount} silence(>=2s) region(s).`);
  } else {
    // Fallback: audio is not a parseable WAV (e.g. direct upload of a codec stream).
    console.log('[OdiaPipeline] Non-WAV audio; sending full payload to Whisper');

    const whisperResult = await callWithBackoff(() =>
      transcribeWithWhisper(audioBuffer, mimeType || 'audio/wav', 'or', 0)
    );

    detectedLanguage = whisperResult.detectedLanguage || detectedLanguage;
    isOdia = whisperResult.languageCode === 'or';
    languageConfidence = 0.98;

    const classified = classifyWhisperSegments(whisperResult.segments, []);

    for (const raw of classified) {
      const atom = toAtom(raw, 0);
      if (atom) atoms.push(atom);
    }

    // Use Whisper-reported duration if the WAV parser didn't provide one.
    if (!durationSeconds || durationSeconds <= 0) {
      durationSeconds = whisperResult.durationSeconds || durationSeconds;
    }

    atoms = sortAndResolve(atoms, durationSeconds);
    notes.push('Audio was not parseable as WAV; processed as a single full-audio request.');
  }

  const processedSegments = atomsToSegments(atoms);

  // Strict maximum 3 words per segment; split only when word timings allow an
  // accurate split (no fabricated timestamps).
  const finalSegments = enforceMaxWordsPerSegment(processedSegments, 3);

  // Timestamp sanitization before any SRT is produced.
  const sanitizedSegments = sanitizeSegments(finalSegments, durationSeconds);

  // VAD boundary alignment: pull speech start out of preceding noise and never
  // cut the tail of the final spoken words.
  const alignedSegments = alignSpeechBoundariesToVad(sanitizedSegments, vadRegions, durationSeconds);

  // Coverage-only: fold any genuinely audible sliver left uncovered at a
  // segment/chunk boundary into the bordering speech cue so the timeline is
  // fully contiguous (without changing classification, tags, or text).
  let finalSegmentsResolved = alignedSegments;
  if (parsed && parsed.mono && parsed.sampleRate > 0) {
    finalSegmentsResolved = closeNonSilentSpeechGaps(alignedSegments, parsed.mono, parsed.sampleRate);
  }

  const duration = Math.max(
    durationSeconds,
    finalSegmentsResolved.length > 0 ? finalSegmentsResolved[finalSegmentsResolved.length - 1].endSeconds : 0
  );

  const stats = calculateTranscriptionStats(finalSegmentsResolved);
  let rawSrt = generateSrtContent(finalSegmentsResolved);
  rawSrt = applyNoiseSpeechRecovery(rawSrt);

  console.log(
    `[OdiaPipeline] Completed: ${finalSegmentsResolved.length} subtitle segments, duration=${duration.toFixed(2)}s`
  );

  return {
    detectedLanguage,
    isOdia,
    languageConfidence,
    durationSeconds: duration,
    segments: finalSegmentsResolved,
    rawSrt,
    stats,
    notes: notes.length > 0 ? notes : ['Strict tagged-SRT pipeline executed.'],
  };
}