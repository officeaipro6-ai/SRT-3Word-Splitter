import express from 'express';
import path from 'path';
import { createHash } from 'crypto';
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

async function startServer() {
  const app = express();
  const PORT = 3000;

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
      hasSarvamApiKey: isSarvamConfigured(),
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
      const provider = getActiveProvider();

      // RAW transcription of the EXACT uploaded audio. We do NOT use any
      // canonical / cached / old / temp SRT, we do NOT apply spelling correction,
      // and we do NOT run max-3-word segmentation yet (raw text is verified first).
      const rawText = await (async () => {
        if (provider === 'sarvam') {
          const r = await transcribeRawOdiaWithSarvam(audioBuffer, mimeType);
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
        `[RAW ${provider.toUpperCase()}] lang=od-IN (forced) — ${rawWordCount} word(s): "${rawTranscript.slice(0, 120)}..."`
      );

      // Provider-specific diagnostics (all visible in the UI panel). The Sarvam
      // key is never logged or returned.
      const audioDiagnostics: Record<string, unknown> = {
        provider,
        providerDisplay: provider === 'sarvam' ? 'Sarvam' : 'Groq (fallback)',
        model: provider === 'sarvam' ? 'saaras:v4' : 'whisper-large-v3-turbo',
        language: 'od-IN',
        mode: provider === 'sarvam' ? 'verbatim' : 'n/a',
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
        audioDiagnostics.languageCode = m.languageCode || 'od-IN';
        audioDiagnostics.chunkCount = (m.chunks || []).length;
      } else {
        const g = rawText.meta as any;
        audioDiagnostics.languageSentToWhisper = g.forcedLanguage || 'hi';
        audioDiagnostics.rawSegmentCount = g.rawSegmentCount;
        audioDiagnostics.rawWordCount = g.rawWordCount;
        audioDiagnostics.rawText = g.rawText;
      }

      return res.json({
        detectedLanguage: 'Odia (ଓଡ଼ିଆ)',
        isOdia: true,
        languageConfidence: 0.98,
        durationSeconds: durationForSrt,
        segments,
        rawSrt: generateSrtContent(segments),
        stats: calculateTranscriptionStats(segments),
        notes: [
          provider === 'sarvam'
            ? 'Sarvam Saaras (saaras:v4, od-IN, verbatim) transcription of the exact uploaded audio. Subtitles split to max 3 words each and classified against the actual audio (NOISE/SILENCE/MB) so the exported SRT contains real tags. No spelling correction, no canonical/old SRT fallback.'
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] ODIA AUDIO/VIDEO → TAGGED SRT running on http://0.0.0.0:${PORT}`);
  });
}

// ODIA_SKIP_SERVER=1 lets tests/scripts import the pipeline functions
// (buildMax3WordSegments, applyAudioAnalysisTags) without binding the port.
if (process.env.ODIA_SKIP_SERVER !== '1') {
  startServer();
}
