import express from 'express';
import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import multer from 'multer';
import { runOdiaPipeline } from './server/geminiOdiaPipeline';
import { transcribeRawOdiaWithWhisper } from './server/groqTranscriber';
import {
  transcribeRawOdiaWithSarvam,
  isSarvamConfigured,
  getActiveProvider,
} from './server/sarvamTranscriber';
import {
  transcribeRawOdiaWithOlive,
  isOliveConfigured,
} from './server/oliveTranscriber';
import {
  computeSpeechRegions,
  alignSegmentsToSpeechRegions,
} from './server/voiceTiming';
import { SubtitleSegment } from './src/types';
import {
  formatSrtTimestamp,
  calculateTranscriptionStats,
  findOptimalNaturalWordChunks,
  applyTaggingRule,
  generateSrtContent,
} from './src/utils/srtRules';
import {
  parseWav,
  detectSpeechRegions,
  convertToWav,
  SpeechRegion,
} from './server/audioAnalysis';
import { config } from './server/config';
import { nestedLog, redact } from './server/logger';
import { DataStore } from './server/db/store';
import { UserRepo, JobRepo, CreditRepo, newId } from './server/db/repos';
import { type JobRecord, isJobStatus } from './server/db/types';
import { FileCreditService, CreditError } from './server/services/creditService';
import {
  LocalFileStorageProvider,
  uploadKey,
  srtKey,
  safeOriginalName,
} from './server/services/storage';
import { JobQueue, type RunPipeline } from './server/services/queue';
import { extractToken, hashToken, issueToken, isValidTokenShape } from './server/services/auth';
import {
  validateUpload,
  assertWithinActiveJobLimit,
  SlidingWindowLimiter,
  UploadError,
} from './server/services/uploadPolicy';
import {
  getAsrProvider,
  getAsrProviderName,
  listConfiguredProviders,
  getProviderStrict,
} from './server/providers/registry';
import {
  type TranscriptionProviderResult,
  type TranscriptionProvider,
  ProviderNotConfiguredError,
} from './server/providers/types';

dotenv.config();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

/**
 * SPLIT the RAW transcript into subtitles with a STRICT maximum of 3 words each.
 *
 * Guarantees:
 *   - Preserves the exact raw words (pure partition, no correction/rewrite).
 *   - Every single spoken word is kept, in chronological order, never lost or
 *     duplicated (raw word count == subtotal word count).
 *   - No subtitle exceeds 3 words.
 *   - Uses Sarvam word-level timestamps when they align 1:1 with the transcript
 *     tokens; otherwise falls back to even distribution across the audio
 *     timeline (the existing audio timing logic).
 *
 * All segments are CLEAR_SPEECH. Tagging uses the existing Rule A (unchanged
 * text, no tags) via applyTaggingRule. No tagging/VAD/provider/spelling changes.
 */
export function buildMax3WordSegments(
  rawTranscript: string,
  totalDuration: number,
  wordTimings: Array<{ text: string; startSeconds: number; endSeconds: number }>
): SubtitleSegment[] {
  const words = rawTranscript.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Use Sarvam timestamps ONLY when they align 1:1 (same count, in order, valid
  // ranges). Otherwise fall back to the existing even-distribution timing so
  // segmentation never fabricates or misaligns timings.
  const hasUsableTimings =
    wordTimings.length === words.length &&
    wordTimings.every(
      (w) =>
        Number.isFinite(w.startSeconds) &&
        Number.isFinite(w.endSeconds) &&
        w.endSeconds >= w.startSeconds
    );

  const chunks = findOptimalNaturalWordChunks(words, 3);
  let cursor = 0;
  let prevEnd = 0;

  return chunks.map((chunkWords, idx) => {
    let startSeconds: number;
    let endSeconds: number;

    if (hasUsableTimings) {
      startSeconds = wordTimings[cursor].startSeconds;
      endSeconds = wordTimings[cursor + chunkWords.length - 1].endSeconds;
    } else if (totalDuration > 0) {
      // Existing audio timing logic: distribute evenly across the timeline.
      const perWord = totalDuration / words.length;
      startSeconds = cursor * perWord;
      endSeconds = (cursor + chunkWords.length) * perWord;
    } else {
      // No duration known: keep every subtitle 1s apart (chronological, valid).
      startSeconds = idx;
      endSeconds = idx + 1;
    }

    // Keep chronological order and valid start < end intervals.
    if (startSeconds < prevEnd) startSeconds = prevEnd;
    if (endSeconds <= startSeconds) endSeconds = startSeconds + 0.001;

    const segStart = Number(startSeconds.toFixed(3));
    const segEnd = Number(endSeconds.toFixed(3));
    prevEnd = segEnd;

    const text = chunkWords.join(' ');
    const { taggedText } = applyTaggingRule(text, 'CLEAR_SPEECH', segEnd - segStart);

    const chunkTimeWordTimings = hasUsableTimings
      ? wordTimings
          .slice(cursor, cursor + chunkWords.length)
          .map((w) => ({ word: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds }))
      : undefined;

    cursor += chunkWords.length;

    return {
      id: idx + 1,
      startSeconds: segStart,
      endSeconds: segEnd,
      startTimeFormatted: formatSrtTimestamp(segStart),
      endTimeFormatted: formatSrtTimestamp(segEnd),
      text,
      classification: 'CLEAR_SPEECH' as const,
      taggedText,
      confidence: 0.98,
      wordTimings: chunkTimeWordTimings,
    };
  });
}

/**
 * Audio-analysis classification used to emit real NOISE / SILENCE / MB tags in
 * the exported SRT, WITHOUT retranscribing and WITHOUT changing the Sarvam
 * speech text, word order, or timestamps.
 *
 * The speech cues produced by max-3-word segmentation sit at real word times
 * (from Sarvam), leaving gaps where the actual audio has noise / silence. This
 * runs the existing VAD `detectSpeechRegions` on the exact uploaded audio and,
 * for every VAD non-speech region NOT already covered by a spoken-word cue:
 *   - noise region                 -> NOISE_ONLY    -> <NOISE></NOISE>
 *   - silence region (>= 2.00s)    -> SILENCE       -> <SIL></SIL>
 *   - speech region, no words      -> UNINTELLIGIBLE-> <MB></MB> (Rule F)
 * Spoken-word cues are kept CLEAR_SPEECH (plain text, never tagged NOISE/SIL),
 * so no invented tags and no normal word is ever marked as noise or silence.
 *
 * Never mutates an existing cue's text or timestamps; tags come entirely from
 * the existing applyTaggingRule (Rules A-F). If the audio cannot be analyzed,
 * the original speech cues are returned unchanged (no invented tags).
 */
export async function applyAudioAnalysisTags(
  audioBuffer: Buffer,
  mimeType: string,
  speechSegments: SubtitleSegment[],
  durationSeconds: number
): Promise<SubtitleSegment[]> {
  const sortSegments = (list: SubtitleSegment[]): SubtitleSegment[] =>
    list
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds)
      .map((s, idx) => ({ ...s, id: idx + 1 }));

  if (speechSegments.length === 0) return [];

  let parsed = parseWav(audioBuffer);
  if (!parsed || parsed.duration <= 0) {
    let converted: Buffer | null = null;
    try {
      converted = await convertToWav(audioBuffer, mimeType || 'audio/wav');
    } catch {
      converted = null;
    }
    if (converted && converted.length > 0) parsed = parseWav(converted);
  }

  const regions: SpeechRegion[] =
    parsed && parsed.duration > 0
      ? detectSpeechRegions(parsed.mono, parsed.sampleRate)
      : [];

  // Short-circuits: no parseable audio or no non-speech regions -> no tags.
  if (!parsed || parsed.duration <= 0 || regions.length === 0) {
    return sortSegments(speechSegments);
  }

  const duration = Math.max(durationSeconds, parsed.duration);

  // BGM/noise intervals detected on the exact uploaded audio. A spoken-word cue
  // whose span overlaps one of these has BGM/noise playing underneath its
  // speech -> classify it SPEECH_WITH_NOISE so the exported SRT wraps the real
  // words as <NOISE>words</NOISE> (Rule B), never plain text and never <MB>.
  const noiseIntervals = regions
    .filter((r) => r.type === 'noise')
    .map((r) => ({ start: r.start, end: r.end }));
  const overlapsNoise = (start: number, end: number): boolean => {
    for (const n of noiseIntervals) {
      if (Math.min(end, n.end) - Math.max(start, n.start) >= 0.5) return true;
    }
    return false;
  };
  const classifiedSpeech = speechSegments.map((s) =>
    overlapsNoise(s.startSeconds, s.endSeconds)
      ? { ...s, classification: 'SPEECH_WITH_NOISE' as const }
      : s
  );

  // Coverage = union of existing speech-cue spans (real spoken words).
  const coverage = speechSegments.map((s) => ({ start: s.startSeconds, end: s.endSeconds }));
  const coveredBy = (start: number, end: number): number => {
    let best = 0;
    for (const c of coverage) {
      const s = Math.max(start, c.start);
      const e = Math.min(end, c.end);
      if (e > s) best = Math.max(best, (e - s) / (end - start));
    }
    return best;
  };

  const nonSpeech: Array<{
    start: number;
    end: number;
    classification: SubtitleSegment['classification'];
  }> = [];

  for (const r of regions) {
    if (r.end - r.start < 0.5) continue;
    if (r.end > duration + 0.05) continue;
    const covered = coveredBy(r.start, r.end);
    if (covered >= 0.4) continue;

    if (r.type === 'noise') {
      nonSpeech.push({ start: r.start, end: r.end, classification: 'NOISE_ONLY' });
    } else if (r.type === 'silence' && r.end - r.start >= 2.0) {
      nonSpeech.push({ start: r.start, end: r.end, classification: 'SILENCE' });
    } else if (r.type === 'speech') {
      // Speech heard by VAD but with no transcribed words -> Rule F <MB></MB>.
      if (r.end - r.start >= 0.8) {
        nonSpeech.push({ start: r.start, end: r.end, classification: 'UNINTELLIGIBLE_SPEECH' });
      }
    }
  }

  if (nonSpeech.length === 0) {
    return sortSegments(classifiedSpeech);
  }

  // Resolve the timeline: speech cues keep their exact spans; non-speech cues
  // are clipped against EVERY speech cue so a tag never sits on a real spoken
  // word, then contiguous same-type non-speech cues are merged.
  const speechSpans = classifiedSpeech
    .slice()
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds)
    .map((s) => ({
      start: s.startSeconds,
      end: s.endSeconds,
      classification: s.classification,
      text: s.text,
      // Keep the real word-level timings so the max-3-word re-split downstream
      // (generateSrtContent / enforceMaxWordsPerSegment) uses exact word times
      // instead of subdividing the segment span.
      wordTimings: s.wordTimings,
    }));

  const nonSpeechSpans = nonSpeech.slice().sort((a, b) => a.start - b.start || a.end - b.end);

  const resolved: typeof speechSpans = [];

  // 1) Place all speech cues first.
  for (const sp of speechSpans) resolved.push({ ...sp });

  // 2) Clip + insert non-speech cues, then merge contiguous same-type ones.
  for (const n of nonSpeechSpans) {
    let start = n.start;
    let end = n.end;
    // Clip against every speech cue.
    for (const sp of speechSpans) {
      if (sp.text.trim().length === 0) continue;
      if (sp.end > start && sp.start < end) {
        // Overlap < 0.3s is ignored; larger overlap clips the non-speech span.
        const overlap = Math.min(end, sp.end) - Math.max(start, sp.start);
        if (overlap >= 0.3) {
          if (sp.start <= start) {
            start = sp.end;
          } else {
            // Speech cue in the middle: keep leading free part, resume after.
            if (sp.start - start >= 0.3) {
              resolved.push({ start, end: sp.start, classification: n.classification, text: '', wordTimings: undefined });
            }
            start = sp.end;
          }
          if (start >= end) break;
        }
      }
    }
    if (end - start >= 0.3) {
      resolved.push({ start, end, classification: n.classification, text: '', wordTimings: undefined });
    }
  }

  // 3) Sort and merge contiguous same-type non-speech cues.
  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: typeof resolved = [];
  for (const a of resolved) {
    const last = merged[merged.length - 1];
    const isNonSpeechA = a.text.trim().length === 0;
    const isNonSpeechLast = last && last.text.trim().length === 0;
    if (
      last &&
      isNonSpeechA &&
      isNonSpeechLast &&
      last.classification === a.classification &&
      a.start <= last.end + 0.001
    ) {
      last.end = Math.max(last.end, a.end);
    } else {
      merged.push({ ...a });
    }
  }

  const finalSegments: SubtitleSegment[] = merged.map((a, idx) => {
    const duration = a.end - a.start;
    const { taggedText } = applyTaggingRule(a.text, a.classification, duration);
    return {
      id: idx + 1,
      startSeconds: Number(a.start.toFixed(3)),
      endSeconds: Number(a.end.toFixed(3)),
      startTimeFormatted: formatSrtTimestamp(a.start),
      endTimeFormatted: formatSrtTimestamp(a.end),
      text: a.text,
      classification: a.classification,
      taggedText,
      confidence: 0.95,
      ...(a.wordTimings && a.wordTimings.length > 0 ? { wordTimings: a.wordTimings } : {}),
    };
  });

  return finalSegments;
}

/**
 * Queue-worker pipeline: the EXACT same post-processing as the legacy
 * synchronous /api/process-audio route (max-3-word segmentation -> VAD tagging
 * -> voice-aligned timing -> SRT + stats), so a queued job yields the identical
 * tagged SRT. No rule logic is duplicated; these are the same functions.
 */
export const runJobPipeline: RunPipeline = async ({
  audioBuffer,
  mimeType,
  provider,
  providerResult,
  fileDurationSeconds,
}) => {
  const rawTranscript = providerResult.transcript.trim();
  const durationForSrt =
    provider === 'sarvam' && providerResult.durationSeconds > 0
      ? providerResult.durationSeconds
      : fileDurationSeconds || 0;
  const wordTimings = provider === 'sarvam' ? providerResult.wordTimings : [];
  let segments: SubtitleSegment[] =
    rawTranscript.length > 0 ? buildMax3WordSegments(rawTranscript, durationForSrt, wordTimings) : [];
  segments = await applyAudioAnalysisTags(audioBuffer, mimeType, segments, durationForSrt);
  const voiceRegions = await computeSpeechRegions(audioBuffer, mimeType || 'audio/wav');
  segments = alignSegmentsToSpeechRegions(segments, voiceRegions);
  const rawSrt = generateSrtContent(segments);
  const wordCount = segments.reduce((sum, s) => sum + (s.text.split(/\s+/).filter(Boolean).length), 0);
  return { rawSrt, segmentCount: segments.length, wordCount, provider };
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // ---------------------------------------------------------------------------
  // Architecture layer: durable user/job/credit stores + storage + queue.
  // Everything below is ADDITIVE — the legacy /api/process-audio behaviour is
  // untouched. These instances are wired in-process; a future deployment swaps
  // DataStore/StorageProvider/JobQueue for cloud backends behind the same
  // interfaces.
  // ---------------------------------------------------------------------------
  const store = new DataStore(config.dbFile);
  await store.init();
  const users = new UserRepo(store);
  const creditsRepo = new CreditRepo(store);
  const jobs = new JobRepo(store);
  const credits = new FileCreditService(users, creditsRepo);
  const storage = new LocalFileStorageProvider(config.storageDir);
  const queue = new JobQueue({
    repo: jobs,
    storage,
    credits,
    getProvider: getProviderStrict as (name: string) => TranscriptionProvider,
    runPipeline: runJobPipeline,
  });
  const uploadLimiter = new SlidingWindowLimiter(config.uploadRateLimitWindowMs, config.uploadRateLimitMax);

  /** Bearer-token auth: resolves identity, verifies ownership, records access. */
  function auth() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = extractToken(req);
      if (!isValidTokenShape(token)) {
        return res.status(401).json({ error: 'Missing or invalid bearer token. Create a session via POST /api/session.' });
      }
      const user = users.getByToken(hashToken(token as string));
      if (!user) {
        return res.status(401).json({ error: 'Unknown or expired session. Create a session via POST /api/session.' });
      }
      users.touch(user.id);
      res.locals.user = user;
      next();
    };
  }

  /** Never leak internal storage paths / keys to clients. */
  function publicJob(job: JobRecord) {
    const base = {
      id: job.id,
      status: job.status,
      provider: job.provider,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      retryCount: job.retryCount,
      lastError: job.lastError,
      errorCode: job.errorCode,
      creditsCharged: job.creditsCharged,
      input: {
        originalName: job.input.originalName,
        mimeType: job.input.mimeType,
        sizeBytes: job.input.sizeBytes,
        sha256: job.input.sha256,
        durationSeconds: job.input.durationSeconds,
      },
    };
    return job.output ? { ...base, output: { segmentCount: job.output.segmentCount, wordCount: job.output.wordCount } } : base;
  }

  // JSON payload parser for base64 uploads
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  // API Routes
  app.get('/api/health', (req, res) => {
    const hasApiKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE');
    const hasFallback = Boolean(process.env.GROQ_API_KEY_FALLBACK && process.env.GROQ_API_KEY_FALLBACK !== 'YOUR_GROQ_API_KEY_HERE');
    res.json({
      status: 'ok',
      service: 'ODIA AUDIO/VIDEO → TAGGED SRT Engine',
      activeProvider: getActiveProvider(),
      asrProvider: getAsrProviderName(),
      availableProviders: listConfiguredProviders(),
      hasAzure: config.azureConfigured,
      jobsEnabled: config.enableJobQueue,
      hasSarvamApiKey: isSarvamConfigured(),
      hasOlive: isOliveConfigured(),
      hasApiKey,
      hasFallback,
      timestamp: new Date().toISOString(),
    });
  });

  // Primary AI processing endpoint (accepts multipart file or JSON with base64 audio)
  app.post('/api/process-audio', upload.single('mediaFile'), async (req, res) => {
    try {
      let audioBase64 = '';
      let mimeType = 'audio/wav';
      let fileName = 'audio.wav';
      let fileDuration = 0;

      if (req.file) {
        audioBase64 = req.file.buffer.toString('base64');
        mimeType = req.file.mimetype || 'audio/wav';
        fileName = req.file.originalname || 'uploaded_media';
      } else if (req.body && req.body.audioBase64) {
        audioBase64 = req.body.audioBase64;
        mimeType = req.body.mimeType || 'audio/wav';
        fileName = req.body.fileName || 'uploaded_media';
        fileDuration = Number(req.body.duration) || 0;
      } else {
        return res.status(400).json({
          error: 'No audio or video data provided. Please upload a media file or provide base64 audio data.',
        });
      }

      // ------------------------------------------------------------------
      // Language selection routing (multi-language support).
      //   - 'odia'   -> od-IN
      //   - 'hindi'  -> hi-IN
      //   - 'english'-> en-IN
      // The selection is STRICTLY validated: missing, unknown, or inconsistent
      // values are rejected with a 400 error. The server NEVER silently assumes
      // Odia. od-IN is used only when the user explicitly selects Odia, exactly
      // as before. The explicit BCP-47 code may also be supplied as `languageCode`;
      // when both `language` and `languageCode` are present they must agree.
      // The resolved code is then sent to the active ASR provider (Sarvam).
      // ------------------------------------------------------------------
      const LANGUAGE_CODE_BY_KEY: Record<string, string> = {
        odia: 'od-IN',
        hindi: 'hi-IN',
        english: 'en-IN',
      };
      const rawLang = String(req.body.language ?? '').trim().toLowerCase();
      const requestedLanguage = Object.prototype.hasOwnProperty.call(LANGUAGE_CODE_BY_KEY, rawLang)
        ? rawLang
        : null;
      const rawCode = String(req.body.languageCode ?? '').trim().toUpperCase();
      const explicitCode = ['od-IN', 'hi-IN', 'en-IN'].includes(rawCode) ? rawCode : null;

      if (!requestedLanguage && !explicitCode) {
        return res.status(400).json({ error: 'Please select a valid language before processing.' });
      }
      if (requestedLanguage && explicitCode && LANGUAGE_CODE_BY_KEY[requestedLanguage] !== explicitCode) {
        return res.status(400).json({ error: 'Please select a valid language before processing.' });
      }
      const languageCode = requestedLanguage ? LANGUAGE_CODE_BY_KEY[requestedLanguage] : (explicitCode as string);
      const languageName = {
        'od-IN': 'Odia (ଓଡ଼ିଆ)',
        'hi-IN': 'Hindi (हिन्दी)',
        'en-IN': 'English',
      }[languageCode];
      const isLanguageDetected = false; // no reliable auto-detector in this system
      const languageConfidence = 0; // never fabricated

      console.log(`  language(request): ${requestedLanguage} -> ${languageCode} (${languageName})`);

      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const fileSizeBytes = audioBuffer.length;
      const sha256 = createHash('sha256').update(audioBuffer).digest('hex');

      console.log('');
      console.log('==========================================================');
      console.log('[AUDIO INPUT DIAGNOSTIC]');
      console.log(`  fileName     : ${fileName}`);
      console.log(`  mimeType     : ${mimeType}`);
      console.log(`  fileSize     : ${fileSizeBytes} bytes (${(fileSizeBytes / 1024).toFixed(2)} KB)`);
      console.log(`  duration(client): ${fileDuration}s`);
      console.log(`  sha256       : ${sha256}`);
      console.log('==========================================================');

      // Choose the ACTIVE transcription provider.
      //   - Sarvam (default): designed for Indian languages; forces Odia od-IN,
      //     model saaras:v4, mode verbatim.
      //   - Groq (fallback): kept available for testing via TRANSCRIPTION_PROVIDER=groq.
      //   - Olive (opt-in): OdiaGenAI Whisper Odia fine-tune via
      //     TRANSCRIPTION_PROVIDER=olive + OLIVE_API_URL. Never default.
      const provider = getActiveProvider();

      // RAW transcription of the EXACT uploaded audio. We do NOT use any
      // canonical / cached / old / temp SRT, we do NOT apply spelling correction,
      // and we do NOT run max-3-word segmentation yet (raw text is verified first).
      const rawText = await (async () => {
        if (provider === 'sarvam') {
          const r = await transcribeRawOdiaWithSarvam(audioBuffer, mimeType, { languageCode });
          return { text: r.transcript, duration: r.durationSeconds, meta: r };
        } else if (provider === 'olive') {
          const r = await transcribeRawOdiaWithOlive(audioBuffer, mimeType);
          return { text: r.transcript, duration: r.durationSeconds, meta: r };
        } else {
          const r = await transcribeRawOdiaWithWhisper(audioBuffer, mimeType);
          return { text: r.rawText, duration: r.durationSeconds, meta: r };
        }
      })();

      // RAW transcription of the EXACT uploaded audio. We do NOT use any
      // canonical / cached / old / temp SRT, we do NOT apply spelling correction.
      const rawTranscript = rawText.text.trim();
      const durationForSrt =
        provider === 'sarvam' && rawText.duration && rawText.duration > 0
          ? rawText.duration
          : fileDuration || 0;

      // Subtitle segmentation: split the RAW transcript into subtitles with a
      // strict maximum of 3 words each, preserving every spoken word in exact
      // order (no loss, no duplication, no invented words). Timing comes from
      // Sarvam word timestamps when available, else the existing even
      // distribution across the audio timeline. Tagging stays CLEAR_SPEECH
      // (Rule A), untouched.
      const sarvamWordTimings =
        provider === 'sarvam'
          ? ((rawText.meta as any)?.chunks as Array<{
              text: string;
              startSeconds: number;
              endSeconds: number;
            }>) || []
          : [];

      let segments: SubtitleSegment[] =
        rawTranscript.length > 0
          ? buildMax3WordSegments(rawTranscript, durationForSrt, sarvamWordTimings)
          : [];

      // TAGGING: classify the timeline against the ACTUAL audio via the existing
      // VAD analysis and insert real NOISE / SILENCE / MB tags for the portions
      // of the audio that are genuinely non-speech (never over spoken words,
      // never inventing tags). Spoken-word cues keep their exact Sarvam text,
      // word order, and timestamps.
      const taggedSegments = await applyAudioAnalysisTags(
        audioBuffer,
        mimeType,
        segments,
        durationForSrt
      );
      segments = taggedSegments;

      // VOICE-ALIGNED TIMING: snap spoken-word cue boundaries to the actual
      // voice regions detected on the exact uploaded audio (Start = first
      // overlapping speech region's start, End = last overlapping speech
      // region's end), so subtitles appear ONLY over real speech - never over
      // leading/trailing silence or BGM - while staying clamped between the
      // neighboring cues (no overlaps, no invented timing). Text and tags are
      // never modified; non-speech cues are untouched.
      const voiceRegions = await computeSpeechRegions(audioBuffer, mimeType || 'audio/wav');
      const beforeAligned = segments;
      segments = alignSegmentsToSpeechRegions(segments, voiceRegions);
      const alignedCount = segments.reduce(
        (acc, s, idx) => {
          const prev = beforeAligned[idx];
          if (prev && (prev.startSeconds !== s.startSeconds || prev.endSeconds !== s.endSeconds)) acc++;
          return acc;
        },
        0
      );
      console.log(
        `[VOICE TIMING] speechRegions=${voiceRegions.filter((r) => r.type === 'speech').length}, ` +
          `cuesRealigned=${alignedCount}`
      );

      // Verification: raw word count must equal final subtitle word count.
      const rawWordCount = rawTranscript.split(/\s+/).filter(Boolean).length;
      const finalWordCount = segments.reduce((sum, s) => sum + (s.text.split(/\s+/).filter(Boolean).length), 0);
      const tagCounts = segments.reduce(
        (acc, s) => {
          if (s.classification === 'SILENCE') acc.silence++;
          else if (s.classification === 'NOISE_ONLY' || s.classification === 'MUSIC_ONLY') acc.noise++;
          else if (s.classification === 'UNINTELLIGIBLE_SPEECH' || s.classification === 'SPEECH_WITH_MUSIC') acc.mb++;
          else if (s.classification === 'FILLER' || s.classification === 'LAUGH') acc.filler++;
          else acc.clear++;
          return acc;
        },
        { clear: 0, noise: 0, silence: 0, mb: 0, filler: 0 }
      );
      console.log(
        `[SEGMENTATION] raw words=${rawWordCount}, final words=${finalWordCount}, subtitles=${segments.length} ` +
          `(word preservation: ${rawWordCount === finalWordCount ? 'OK' : 'MISMATCH'})`
      );
      console.log(
        `[TAGGING] clear=${tagCounts.clear} noise=<NOISE>${tagCounts.noise}</NOISE> sil=<SIL>${tagCounts.silence}</SIL> ` +
          `mb=<MB>${tagCounts.mb}</MB> filler=<FIL>${tagCounts.filler}</FIL>`
      );

      console.log(
        `[RAW ${provider.toUpperCase()}] lang=${languageCode}${requestedLanguage === 'auto' ? ' (auto/default od-IN)' : ` (requested ${requestedLanguage})`} — ${rawWordCount} word(s): "${rawTranscript.slice(0, 120)}..."`
      );

      // Provider-specific diagnostics (all visible in the UI panel). The Sarvam
      // key is never logged or returned.
      const audioDiagnostics: Record<string, unknown> = {
        provider,
        providerDisplay:
          provider === 'sarvam'
            ? 'Sarvam'
            : provider === 'olive'
              ? 'Olive (OdiaGenAI Whisper)'
              : 'Groq (fallback)',
        model:
          provider === 'sarvam'
            ? 'saaras:v4'
            : provider === 'olive'
              ? 'whisper-odia-small-finetune-int8-ct2'
              : 'whisper-large-v3-turbo',
        language: provider === 'olive' ? 'or' : languageCode,
        languageCode: provider === 'olive' ? 'or' : languageCode,
        languageName,
        requestedLanguage,
        mode:
          provider === 'sarvam' ? 'verbatim' : provider === 'olive' ? 'transcribe' : 'n/a',
        fileName,
        mimeType,
        fileSizeBytes,
        durationSeconds: fileDuration,
        sha256,
        rawTranscript,
        wordCount: rawTranscript.split(/\s+/).filter(Boolean).length,
        finalSegmentCount: segments.length,
        maxWordsPerSegment: Math.max(
          0,
          ...segments.map((s) => s.text.split(/\s+/).filter(Boolean).length)
        ),
      };

      if (provider === 'sarvam') {
        const m = rawText.meta as any;
        // Keep audioDiagnostics.languageCode = the code WE sent to the ASR
        // (set above). Record what the provider echoed separately so the
        // diagnostic never mislabels od-IN as "sent" for hi-IN/en-IN.
        audioDiagnostics.asrReportedLanguage = m.languageCode || 'od-IN';
        audioDiagnostics.chunkCount = (m.chunks || []).length;
      } else if (provider === 'olive') {
        const o = rawText.meta as any;
        audioDiagnostics.languageCode = o.languageCode || 'or';
        audioDiagnostics.chunkCount = (o.chunks || []).length;
      } else {
        const g = rawText.meta as any;
        audioDiagnostics.languageSentToWhisper = g.forcedLanguage || 'hi';
        audioDiagnostics.rawSegmentCount = g.rawSegmentCount;
        audioDiagnostics.rawWordCount = g.rawWordCount;
        audioDiagnostics.rawText = g.rawText;
      }

      return res.json({
        detectedLanguage: languageName,
        isOdia: languageCode === 'od-IN',
        languageConfidence,
        languageCode,
        languageName,
        requestedLanguage,
        isLanguageDetected,
        durationSeconds: durationForSrt,
        segments,
        rawSrt: generateSrtContent(segments),
        stats: calculateTranscriptionStats(segments),
        notes: [
          provider === 'sarvam'
            ? `Sarvam Saaras (saaras:v4, ${languageCode}, verbatim) transcription of the exact uploaded audio. Subtitles split to max 3 words each and classified against the actual audio (NOISE/SILENCE/MB) so the exported SRT contains real tags. No spelling correction, no canonical/old SRT fallback.`
            : provider === 'olive'
              ? 'Olive OdiaGenAI Whisper (language=or) transcription of the exact uploaded audio. Subtitles split to max 3 words each and classified against the actual audio (NOISE/SILENCE/MB) so the exported SRT contains real tags. No spelling correction, no canonical/old SRT fallback.'
              : 'Groq raw transcription (fallback provider). Subtitles split to max 3 words each and classified against the actual audio. No spelling correction, no canonical/old SRT fallback.',
        ],
        audioDiagnostics,
      });
    } catch (error: any) {
      console.error('[Odia Pipeline Error]:', error);
      const rawMessage = error?.message || '';
      const lower = rawMessage.toLowerCase();
      const isRateLimited = lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota');
      const isUnavailable = lower.includes('503') || lower.includes('unavailable') || lower.includes('overloaded');

      let userFriendlyMessage = rawMessage || 'Failed to process audio with Odia transcription pipeline.';
      let statusCode = 500;
      let isTransient = false;

      if (isRateLimited) {
        statusCode = 429;
        userFriendlyMessage = 'Transcription provider rate limit exceeded. Please wait a moment and try again.';
      } else if (isUnavailable) {
        statusCode = 503;
        isTransient = true;
        userFriendlyMessage = 'Transcription provider is temporarily unavailable (503). Please click "Retry" in a moment.';
      }

      return res.status(statusCode).json({
        error: userFriendlyMessage,
        isTransient,
        details: rawMessage,
      });
    }
  });

  // Fast Language Detection endpoint (Step 1 standalone check)
  app.post('/api/detect-language', async (req, res) => {
    try {
      const { audioBase64, mimeType } = req.body;
      if (!audioBase64) {
        return res.status(400).json({ error: 'Missing audio data' });
      }

      // Run full pipeline to get accurate language + preliminary segments
      const result = await runOdiaPipeline({
        audioBase64,
        mimeType: mimeType || 'audio/wav',
      });

      return res.json({
        detectedLanguage: result.detectedLanguage,
        isOdia: result.isOdia,
        confidence: result.languageConfidence,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // ADDITIVE architecture API: async job queue + credits + sessions.
  // These routes never change the legacy /api/process-audio behaviour.
  // ---------------------------------------------------------------------------

  // Create a session: returns an opaque bearer token (stored server-side as a
  // hash) plus the user's server-maintained credit balance.
  // Admin bootstrap: if the request body includes `adminBootstrapToken` equal to
  // the operator's env secret, the resulting user is granted role ADMIN +
  // creditMode UNLIMITED. This is the ONLY server-side path that assigns roles;
  // client-supplied role/creditMode fields are never trusted.
  app.post('/api/session', (req, res) => {
    try {
      const existing = extractToken(req);
      const bootstrap = typeof req.body?.adminBootstrapToken === 'string' ? req.body.adminBootstrapToken.trim() : '';
      const isAdminBootstrap = Boolean(config.adminBootstrapToken && bootstrap && config.adminBootstrapToken.length === bootstrap.length) &&
        timingSafeEqual(Buffer.from(config.adminBootstrapToken as string, 'utf8'), Buffer.from(bootstrap, 'utf8'));
      let userId: string;
      if (existing && isValidTokenShape(existing)) {
        const user = users.getByToken(hashToken(existing));
        if (!user) return res.status(401).json({ error: 'Unknown or expired session token.' });
        userId = user.id;
      } else {
        const tokenHash = hashToken(issueToken());
        const user = users.createUser(tokenHash, config.initialCredits);
        if (config.initialCredits > 0) {
          creditsRepo.add({
            userId: user.id,
            amount: config.initialCredits,
            type: 'CREDIT',
            reason: 'initial_grant',
            jobId: undefined,
            balanceAfter: user.credits,
          });
        }
        userId = user.id;
      }
      if (isAdminBootstrap) {
        users.setRole(userId, 'ADMIN');
        users.setCreditMode(userId, 'UNLIMITED');
        nestedLog.info('admin role granted via bootstrap token', { userId });
      }
      const token = issueToken();
      users.addToken(userId, hashToken(token));
      const user = users.getById(userId);
      res.json({
        userId,
        token,
        credits: user?.credits ?? 0,
        role: user?.role ?? 'USER',
        creditMode: user?.creditMode ?? 'NORMAL',
        unlimited: (user?.creditMode ?? 'NORMAL') === 'UNLIMITED',
        provider: getAsrProviderName(),
        createdAt: user?.createdAt,
      });
    } catch (err: any) {
      nestedLog.error('session creation failed', { message: redact(err.message) });
      res.status(500).json({ error: 'Failed to create session.' });
    }
  });

  // Upload -> validate -> charge credits server-side -> enqueue (async worker).
  // No long audio is transcribed inside this request.
  app.post('/api/jobs', auth(), upload.single('mediaFile'), (req, res) => {
    void (async () => {
      try {
        const user = res.locals.user;
        if (!uploadLimiter.isAllowed(`${user.id}:${req.ip || ''}`)) {
          return res.status(429).json({ error: 'Upload rate limit exceeded. Please try again later.', code: 'RATE_LIMITED' });
        }
        const file = req.file;
        if (!file) {
          return res.status(400).json({
            error: 'Missing mediaFile. Use multipart/form-data with a mediaFile field (plus an optional duration field).',
          });
        }
        validateUpload({ mimeType: file.mimetype || 'audio/wav', sizeBytes: file.size });
        const active = jobs.countActiveForUser(user.id);
        assertWithinActiveJobLimit(active);

        const jobId = newId();
        const buffer = file.buffer;
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        // Charge BEFORE enqueueing; chargeJob is idempotent per jobId, so a
        // client retry can never double-charge.
        const charged = credits.chargeJob({
          userId: user.id,
          jobId,
          amount: config.creditsPerJob,
          reason: 'charge_transcription',
        });
        const storageKey = uploadKey(jobId, file.mimetype || 'audio/wav');
        try {
          await storage.put(storageKey, buffer);
        } catch (putErr) {
          credits.refundFinishedJob(user.id, jobId, 'refund_storage_failure');
          throw putErr;
        }

        const now = new Date().toISOString();
        jobs.create({
          id: jobId,
          userId: user.id,
          status: 'QUEUED',
          provider: getAsrProviderName(),
          input: {
            storageKey,
            originalName: safeOriginalName(file.originalname),
            mimeType: file.mimetype || 'audio/wav',
            sizeBytes: file.size,
            sha256,
            durationSeconds: Number(req.body.duration) || 0,
          },
          creditTxnId: charged.transaction?.id,
          creditsCharged: charged.transaction ? config.creditsPerJob : 0,
          createdAt: now,
          retryCount: 0,
        });
        const job = jobs.getForUser(jobId, user.id) as JobRecord;
        nestedLog.info('job enqueued', { jobId, userId: user.id, sizeBytes: file.size });
        return res.status(202).json({ job: publicJob(job) });
      } catch (err: any) {
        if (err instanceof UploadError) {
          return res.status(err.httpStatus).json({ error: err.message, code: err.code });
        }
        if (err instanceof CreditError) {
          return res.status(402).json({ error: err.message, code: err.code });
        }
        if (err instanceof ProviderNotConfiguredError) {
          return res.status(503).json({ error: err.message, code: err.code });
        }
        nestedLog.error('job enqueue failed', { message: redact(err.message) });
        return res.status(500).json({ error: 'Failed to enqueue job.' });
      }
    })();
  });

  // List own jobs (ownership-filtered), optional ?status= filter.
  app.get('/api/jobs', auth(), (req, res) => {
    const user = res.locals.user;
    const statusParam = String(req.query.status || '').trim().toUpperCase();
    const status = isJobStatus(statusParam) ? statusParam : undefined;
    const list = jobs.listForUser(user.id, status).map(publicJob);
    res.json({ jobs: list });
  });

  // Own-job detail (ownership-checked; 404 for other users' jobs).
  app.get('/api/jobs/:id', auth(), (req, res) => {
    const user = res.locals.user;
    const job = jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job: publicJob(job) });
  });

  // Stream own completed SRT (ownership-checked).
  app.get('/api/jobs/:id/srt', auth(), (req, res) => {
    const user = res.locals.user;
    const job = jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status !== 'COMPLETED' || !job.output) {
      return res.status(409).json({ error: `SRT is not ready yet (job status: ${job.status}).` });
    }
    const fileName = safeOriginalName(job.input.originalName).replace(/\.[^.]+$/, '') + '.srt';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(job.output.rawSrt);
  });

  // Cancel an unstarted/running own job (refunds the charge).
  app.post('/api/jobs/:id/cancel', auth(), (req, res) => {
    const user = res.locals.user;
    const job = jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
      return res.status(409).json({ error: `Job cannot be cancelled (status: ${job.status}).` });
    }
    jobs.update(job.id, { status: 'CANCELLED', completedAt: new Date().toISOString() });
    credits.refundFinishedJob(user.id, job.id, 'refund_cancelled_job');
    nestedLog.info('job cancelled', { jobId: job.id, userId: user.id });
    const updated = jobs.getForUser(job.id, user.id) as JobRecord;
    res.json({ job: publicJob(updated) });
  });

  // Own credit balance + ledger (server-authoritative; never client values).
  app.get('/api/credits/me', auth(), (req, res) => {
    const user = res.locals.user;
    const fresh = users.getById(user.id);
    res.json({
      userId: user.id,
      credits: fresh?.credits ?? 0,
      role: fresh?.role ?? 'USER',
      creditMode: fresh?.creditMode ?? 'NORMAL',
      unlimited: (fresh?.creditMode ?? 'NORMAL') === 'UNLIMITED',
      transactions: credits.getTransactions(user.id, 25),
      provider: getAsrProviderName(),
    });
  });

  // ---------------------------------------------------------------------------
  // ADMIN API (role-checked server-side; never trusts a client-supplied role).
  // Every route here runs auth() + requireAdmin(), so a non-admin session gets
  // 401 (no auth) or 403 (authenticated but not admin).
  // ---------------------------------------------------------------------------
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = res.locals.user;
    if (!user || user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden: admin role required.', code: 'FORBIDDEN' });
    }
    next();
  };

  // Public projection for admin listings (never token hashes, never secrets).
  function adminUserView(userId: string) {
    const u = users.getById(userId);
    if (!u) return null;
    return {
      id: u.id,
      role: u.role,
      creditMode: u.creditMode,
      unlimited: u.creditMode === 'UNLIMITED',
      credits: u.credits,
      purchasedCredits: u.purchasedCredits ?? 0,
      bonusCredits: u.bonusCredits ?? 0,
      totalGranted: credits.sumGrants(userId),
      totalUsed: credits.sumUsed(userId),
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt ?? null,
    };
  }

  function adminJobView(job: JobRecord) {
    return {
      id: job.id,
      userId: job.userId,
      status: job.status,
      provider: job.provider,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      retryCount: job.retryCount,
      lastError: job.lastError,
      errorCode: job.errorCode,
      creditsCharged: job.creditsCharged,
      input: {
        originalName: job.input.originalName,
        mimeType: job.input.mimeType,
        sizeBytes: job.input.sizeBytes,
        durationSeconds: job.input.durationSeconds,
      },
    };
  }

  // List all users with balance + lifetime aggregates (admin dashboard).
  app.get('/api/admin/users', auth(), requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const usersList = users.listUsers().slice(0, limit).map((u) => adminUserView(u.id));
    res.json({ users: usersList });
  });

  // Single user detail incl. recent ledger (admin dashboard).
  app.get('/api/admin/users/:id', auth(), requireAdmin, (req, res) => {
    const view = adminUserView(req.params.id);
    if (!view) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: view, transactions: credits.getTransactions(req.params.id, 50) });
  });

  // All transactions across users (admin Transaction History).
  app.get('/api/admin/transactions', auth(), requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    let list = credits.getAllTransactions(limit);
    if (userId) list = list.filter((t) => t.userId === userId);
    res.json({ transactions: list });
  });

  // All jobs across users (admin Jobs dashboard).
  app.get('/api/admin/jobs', auth(), requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    let list = jobs.listAll(limit);
    if (userId) list = list.filter((j) => j.userId === userId);
    res.json({ jobs: list.map(adminJobView) });
  });

  // Admin credit grant (idempotent via idempotencyKey; reason mandatory).
  app.post('/api/admin/credits/grant', auth(), requireAdmin, (req, res) => {
    try {
      const result = credits.adminGrantCredits({
        adminUserId: res.locals.user.id,
        userId: String(req.body?.userId || ''),
        amount: Number(req.body?.amount),
        reason: String(req.body?.reason || ''),
        idempotencyKey: req.body?.idempotencyKey,
      });
      res.json({ transaction: result.transaction, applied: result.applied });
    } catch (err: any) {
      if (err instanceof CreditError) {
        return res.status(err.code === 'NO_USER' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      nestedLog.error('admin grant failed', { message: redact(err.message) });
      res.status(500).json({ error: 'Failed to grant credits.' });
    }
  });

  // Admin credit debit (idempotent via idempotencyKey; reason mandatory; never negative).
  app.post('/api/admin/credits/debit', auth(), requireAdmin, (req, res) => {
    try {
      const result = credits.adminDebitCredits({
        adminUserId: res.locals.user.id,
        userId: String(req.body?.userId || ''),
        amount: Number(req.body?.amount),
        reason: String(req.body?.reason || ''),
        idempotencyKey: req.body?.idempotencyKey,
      });
      res.json({ transaction: result.transaction, applied: result.applied });
    } catch (err: any) {
      if (err instanceof CreditError) {
        return res.status(err.code === 'NO_USER' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      nestedLog.error('admin debit failed', { message: redact(err.message) });
      res.status(500).json({ error: 'Failed to debit credits.' });
    }
  });

  // Mount Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Multer/multipart error handling (additive; legacy routes unaffected).
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.name === 'MulterError') {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds the upload limit of ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB.`
        : `Upload error: ${err.message}`;
      return res.status(413).json({ error: msg });
    }
    next(err);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] ODIA AUDIO/VIDEO → TAGGED SRT running on http://0.0.0.0:${PORT}`);
    if (config.enableJobQueue) {
      queue.rehydrate();
      queue.start();
      nestedLog.info('job queue worker started', { provider: getAsrProviderName() });
    } else {
      nestedLog.warn('job queue disabled (ENABLE_JOB_QUEUE=false) job endpoints will not process work');
    }
  });
}

// ODIA_SKIP_SERVER=1 lets tests/scripts import the pipeline functions
// (buildMax3WordSegments, applyAudioAnalysisTags) without binding the port.
if (process.env.ODIA_SKIP_SERVER !== '1') {
  startServer();
}
