import express from 'express';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import multer from 'multer';
import { runOdiaPipeline } from './server/geminiOdiaPipeline';
import { transcribeRawOdiaWithWhisper } from './server/groqTranscriber';
// LOCAL SUBMISSION MODE (temporary, opt-in, zero-budget): a local open-source
// Odia ASR that is completely separate from the Sarvam production pipeline.
import {
  isLocalSubmissionModeEnabled,
  transcribeRawOdiaWithLocalAsr,
} from './server/localTranscriber';
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
  detectBgmUnderVoiceIntervals,
  convertToWav,
  SpeechRegion,
} from './server/audioAnalysis';
import { parseSavedSrt } from './server/canonicalSrt';
import { config, assertProductionProviderSelection } from './server/config';
import { nestedLog, redact } from './server/logger';
import type { DataStore } from './server/db/store';
import type { DataStoreProvider } from './server/db/dataStore';
import { UserRepo, JobRepo, CreditRepo, ProviderSafetyRepo, ModerationRepo, LoginActivityRepo, newId } from './server/db/repos';
import { type JobRecord, type UserRecord, isJobStatus } from './server/db/types';
import { type SupportCategory } from './server/db/types';
import {
  CommunityModerationService,
  COMMUNITY_GUIDELINES,
  TELEGRAM_MODERATION_NOTE,
} from './server/services/communityModeration';
import { FileCreditService } from './server/services/creditService';
import { CreditError } from './server/services/creditRules';
import {
  createFileCreditFacade,
  createTursoCreditFacade,
  type AsyncCreditService,
} from './server/services/creditFacade';
import {
  createFileAccountFacade,
  createTursoAccountFacade,
  type AsyncAccountService,
} from './server/services/accountFacade';
import { TursoAccountService } from './server/services/tursoAccountService';
import { TursoCreditService } from './server/services/tursoCreditService';
import { asyncRoute, runDetached } from './server/http/asyncRoute';
import {
  readRazorpayConfig,
  createRazorpayInstance,
  createRazorpayOrder,
  verifyWebhookSignature,
  verifyPaymentSignature,
  parseWebhookPayload,
  createPurchaseTransaction,
  CREDIT_PLANS,
  getPlanById,
} from './server/services/razorpayService';
import {
  LocalFileStorageProvider,
  uploadKey,
  srtKey,
  srtHashKey,
  safeOriginalName,
  extensionForMime,
} from './server/services/storage';
import { createStorageProvider } from './server/services/r2Storage';
import { b2ConfigurationError, missingB2EnvKeys } from './server/services/b2Storage';
import { JobQueue, type RunPipeline } from './server/services/queue';
import { extractToken, hashToken, issueToken, isValidTokenShape, selectSessionToken } from './server/services/auth';
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
import {
  freeTrialsRemaining,
  freeTrialsUsedFor,
} from './server/services/freeTrialPolicy';
import { CREDIT_PACKS, PROVIDER_UNAVAILABLE_MESSAGE } from './server/services/creditPolicy';
import { resolveMonth } from './server/services/loginActivityService';
import type { LoginAlertTransport } from './server/services/loginAlertService';
import {
  AsyncLoginActivityService,
  createFileLoginActivityStore,
  createTursoLoginActivityStore,
  runDailyLoginAlert,
  startDailyLoginAlertSchedulerAsync,
  type LoginActivityStore,
} from './server/services/asyncLoginActivity';
import type { TursoStore } from './server/db/tursoStore';
import { runLoginAlert, startDailyLoginAlertScheduler } from './server/services/loginAlertService';
import { createTelegramTransport, readTelegramConfig, toLoginAlertTransport } from './server/services/notifications';
import {
  createEmailSender,
  verificationEmailFor,
  classifyDeliveryError,
  type EmailSender,
} from './server/services/emailTransport';
import {
  isEmailVerified,
  isVerificationTokenValid,
  resendCooldownRemainingMs,
  hashVerificationToken,
} from './server/services/emailVerification';
import {
  normalizeAccountEmail,
  isValidAccountEmail,
} from './server/services/accountService';

import {
  ProviderSafetyService,
  ProviderSpendingError,
  classifyProviderFailure,
  type ProviderSafetyView,
} from './server/services/providerSafety';
import { decideAudioSpend } from './server/services/audioSpendGate';
import { createOwnerNotifier, type OwnerNotifier } from './server/services/notifications';
import { verifyBootstrapTokenIntegrity } from './server/services/bootstrapTokenGuard';
import {
  authorizeOwnerSession,
  authorizeTranscriber,
  isVerifiedOwner,
  ownerRejectionMessage,
  normalizeEmail,
  type OwnerRejection,
} from './server/authz';
import { signupAccount, loginAccount, type AccountBroker } from './server/services/accountService';

dotenv.config();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

/**
 * COMMUNITY attachment upload — deliberately SEPARATE from the ASR upload
 * middleware above.
 *
 * The transcription pipeline's `ALLOWED_MIME_TYPES` accepts audio/video only
 * and must not be widened to make community screenshots work. So this uploader
 * has its own allowlist (image, video, audio) and its own, smaller 25MB cap, and
 * persists to a dedicated `community-attachments` directory that is only ever
 * read back through an authenticated admin route.
 */
const COMMUNITY_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const COMMUNITY_ATTACHMENT_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

const communityUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COMMUNITY_ATTACHMENT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (COMMUNITY_ATTACHMENT_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
      cb(null, true);
      return;
    }
    // Silently drop disallowed types rather than 500: the route reports why.
    cb(null, false);
  },
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
/**
 * Decoded wall-clock duration (seconds) of the uploaded media using the local
 * ffmpeg WAV decode (parseWav handles true WAV inputs directly). Returns 0
 * when the audio cannot be decoded locally.
 */
async function measureAudioDurationSeconds(inputBuffer: Buffer, inputMimeType: string): Promise<number> {
  const direct = parseWav(inputBuffer);
  if (direct && direct.duration > 0) return direct.duration;
  try {
    const wav = await convertToWav(inputBuffer, inputMimeType || 'audio/wav');
    if (!wav) return 0;
    const parsed = parseWav(wav);
    return parsed && parsed.duration > 0 ? parsed.duration : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the wall-clock ranges for Sarvam phrase/segment anchors. Entries
 * with invalid spans are bridged between the previous valid end and the next
 * valid start (or the decoded audio duration). Returns null when the anchors
 * cannot be fully resolved so the caller falls back to safe even distribution.
 */
function resolvePhraseRanges(
  phrases: Array<{ startSeconds: number; endSeconds: number }>,
  totalDuration: number
): Array<[number, number]> | null {
  const ranges: Array<[number, number] | null> = phrases.map((p) => {
    if (
      Number.isFinite(p.startSeconds) &&
      Number.isFinite(p.endSeconds) &&
      p.endSeconds > p.startSeconds
    ) {
      return [p.startSeconds, p.endSeconds] as [number, number];
    }
    return null;
  });

  let lastEnd = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (!ranges[i]) {
      let nextStart = totalDuration > 0 ? totalDuration : lastEnd;
      for (let j = i + 1; j < ranges.length; j++) {
        if (ranges[j]) {
          nextStart = ranges[j]![0];
          break;
        }
      }
      if (nextStart <= lastEnd) return null;
      ranges[i] = [lastEnd, nextStart];
    }
    lastEnd = ranges[i]![1];
  }

  if (ranges.every((r) => r !== null) && ranges.some((r) => r![1] > r![0])) {
    return ranges as Array<[number, number]>;
  }
  return null;
}

/**
 * Number of transcript words owned by each Sarvam phrase. Primary: phrase text
 * word counts (used when they sum exactly to the transcript length). Fallback:
 * duration-proportional counts that always sum exactly to the transcript
 * length. Returns [] when neither can be trusted.
 */
function phraseCountsForList(
  phrases: Array<{ text: string; startSeconds: number; endSeconds: number }>,
  wordCount: number
): number[] {
  const textCounts = phrases.map((p) => (p.text || '').split(/\s+/).filter(Boolean).length);
  if (textCounts.reduce((a, b) => a + b, 0) === wordCount) return textCounts;

  const spans = phrases.map((p) =>
    Number.isFinite(p.startSeconds) && Number.isFinite(p.endSeconds) && p.endSeconds > p.startSeconds
      ? p.endSeconds - p.startSeconds
      : 0
  );
  const totalSpan = spans.reduce((a, b) => a + b, 0);
  if (totalSpan <= 0) return [];

  const counts = spans.map((s) => Math.floor((s / totalSpan) * wordCount + 0.5));
  let diff = wordCount - counts.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard < spans.length * 2 + 1) {
    const maxSpan = Math.max(...spans);
    const idx = spans.indexOf(maxSpan);
    counts[idx] += diff > 0 ? 1 : -1;
    if (counts[idx] < 0) counts[idx] = 0;
    diff += diff > 0 ? -1 : 1;
    guard++;
  }
  return counts.reduce((a, b) => a + b, 0) === wordCount ? counts : [];
}

export function buildMax3WordSegments(
  rawTranscript: string,
  totalDuration: number,
  wordTimings: Array<{ text: string; startSeconds: number; endSeconds: number }>,
  scalingFactor = 1
): SubtitleSegment[] {
  const words = rawTranscript.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const validRange = (w: { startSeconds: number; endSeconds: number }) =>
    Number.isFinite(w.startSeconds) &&
    Number.isFinite(w.endSeconds) &&
    w.endSeconds >= w.startSeconds;

  // Use Sarvam timestamps ONLY when they align 1:1 (same count, in order, valid
  // ranges). Otherwise anchor to Sarvam phrase/segment timestamps (words mapped
  // to phrases by index), preserving every word, the max-3 rule, phrase gaps,
  // and the real audio timeline. Even distribution is the last resort.
  const hasUsableTimings = wordTimings.length === words.length && wordTimings.every(validRange);

  const chunks = findOptimalNaturalWordChunks(words, 3);
  let cursor = 0;
  let prevEnd = 0;

  if (hasUsableTimings) {
    return chunks.map((chunkWords, idx) => {
      let segStart = wordTimings[cursor].startSeconds;
      let segEnd = wordTimings[cursor + chunkWords.length - 1].endSeconds;

      // Keep chronological order and valid start < end intervals.
      if (segStart < prevEnd) segStart = prevEnd;
      if (segEnd <= segStart) segEnd = segStart + 0.001;

      segStart = Number(segStart.toFixed(3));
      segEnd = Number(segEnd.toFixed(3));
      prevEnd = segEnd;

      const text = chunkWords.join(' ');
      const { taggedText } = applyTaggingRule(text, 'CLEAR_SPEECH', segEnd - segStart);

      const chunkTimeWordTimings = wordTimings
        .slice(cursor, cursor + chunkWords.length)
        .map((w) => ({ word: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds }));

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

  // Phrase-anchor path: Sarvam returned phrase/segment timestamps (not 1:1 word
  // timestamps). Map every transcript word to a phrase by index, chunk each
  // phrase's words with the max-3 rule, and place each cue proportionally
  // inside its phrase range so real phrase gaps are preserved. When the
  // provider's durations are compressed/expanded relative to the locally
  // decoded audio, phrase ranges are rescaled to the real timeline first.
  if (wordTimings.length > 0) {
    const phraseAnchors =
      scalingFactor > 0 && scalingFactor !== 1
        ? wordTimings.map((p) => ({
            text: p.text,
            startSeconds: p.startSeconds * scalingFactor,
            endSeconds: p.endSeconds * scalingFactor,
          }))
        : wordTimings;
    const resolved = resolvePhraseRanges(phraseAnchors, totalDuration);
    const counts = resolved ? phraseCountsForList(phraseAnchors, words.length) : [];
    if (
      resolved &&
      counts.length === phraseAnchors.length &&
      counts.reduce((a, b) => a + b, 0) === words.length
    ) {
      const out: SubtitleSegment[] = [];
      let wordIdx = 0;
      let segId = 1;
      for (let i = 0; i < phraseAnchors.length; i++) {
        const pCount = counts[i];
        if (pCount <= 0) continue;
        const phraseWords = words.slice(wordIdx, wordIdx + pCount);
        const [pStart, pEnd] = resolved[i];
        const span = pEnd - pStart;
        const phraseChunks = findOptimalNaturalWordChunks(phraseWords, 3);
        let offset = 0;
        for (const pc of phraseChunks) {
          let segStart = pStart + (offset / phraseWords.length) * span;
          let segEnd = pStart + ((offset + pc.length) / phraseWords.length) * span;
          if (segStart < prevEnd) segStart = prevEnd;
          if (segEnd <= segStart) segEnd = segStart + 0.001;
          segStart = Number(segStart.toFixed(3));
          segEnd = Number(segEnd.toFixed(3));
          prevEnd = segEnd;

          const text = pc.join(' ');
          const { taggedText } = applyTaggingRule(text, 'CLEAR_SPEECH', segEnd - segStart);

          out.push({
            id: segId++,
            startSeconds: segStart,
            endSeconds: segEnd,
            startTimeFormatted: formatSrtTimestamp(segStart),
            endTimeFormatted: formatSrtTimestamp(segEnd),
            text,
            classification: 'CLEAR_SPEECH' as const,
            taggedText,
            confidence: 0.98,
            wordTimings: undefined,
          });
          offset += pc.length;
        }
        wordIdx += pCount;
      }
      if (out.length > 0 && wordIdx === words.length) {
        return out;
      }
    }
  }

  // Last resort: distribute evenly across the (decoded) audio timeline when no
  // usable timestamps or phrase anchors are available.
  return chunks.map((chunkWords, idx) => {
    let startSeconds: number;
    let endSeconds: number;

    if (totalDuration > 0) {
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
      wordTimings: undefined,
    };
  });
}

/**
 * Audio-analysis classification used to emit real tags in the exported SRT,
 * WITHOUT retranscribing and WITHOUT changing the Sarvam speech text, word
 * order, or timestamps.
 *
 * The speech cues produced by max-3-word segmentation sit at real word times
 * (from Sarvam). This runs the existing VAD `detectSpeechRegions` plus the
 * ADDITIVE `detectBgmUnderVoiceIntervals` on the exact uploaded audio and
 * classifies each spoken-word cue:
 *   - cue overlaps a VAD noise region OR a BGM-under-voice interval (>= 0.5s)
 *     -> SPEECH_WITH_NOISE -> <NOISE>spoken words</NOISE> (Rule B)
 *   - otherwise             -> CLEAR_SPEECH -> plain text (Rule A)
 *   - the FIRST spoken cue that starts AFTER the acoustic (VAD speech) onset —
 *     i.e. an intro BGM/music-only head precedes the first Sarvam word anchor —
 *     is split at the actual voice onset (see below).
 *
 * Approved tagging rules (2026-09-27, rev 2):
 *   A. clear voice only            -> plain text
 *   B. voice + BGM/noise           -> <NOISE>spoken words</NOISE>
 *   C. BGM/music/noise only        -> <NOISE></NOISE>
 *   5. <SIL> must NOT be auto-generated
 *   6. <MB> must NEVER be generated
 * Intro split (rev 2): the BGM-only intro head is preserved as its OWN
 * NOISE_ONLY cue exposing <NOISE></NOISE> (Rule C), and the spoken cue starts
 * at the first Sarvam word anchor (the actual voice onset) wrapping its real
 * words (Rule B) or staying plain (Rule A). The head is NEVER trimmed away;
 * mid-track BGM-only gaps with no spoken cue over them still produce no
 * subtitle. No cue text is mutated and no VAD threshold or Sarvam timestamp is
 * changed. If the audio cannot be analyzed, the original cues are returned
 * unchanged (no invented tags).
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

  // BGM/noise intervals detected on the exact uploaded audio, from two sources:
  //   1) VAD 'noise' regions (music-only swells, noise crests, audible backdrop
  //      loud enough to be non-speech),
  //   2) ADDITIVE BGM-under-voice intervals (`detectBgmUnderVoiceIntervals`):
  //      backdrop music hidden inside VAD 'speech' windows because it sits
  //      below voiceFloor.
  const noiseIntervals = regions
    .filter((r) => r.type === 'noise')
    .map((r) => ({ start: r.start, end: r.end }));
  const bgmIntervals =
    parsed && parsed.duration > 0
      ? detectBgmUnderVoiceIntervals(parsed.mono, parsed.sampleRate)
      : [];
  const overlapsSource = (start: number, end: number): boolean => {
    for (const n of noiseIntervals) {
      if (Math.min(end, n.end) - Math.max(start, n.start) >= 0.5) return true;
    }
    for (const n of bgmIntervals) {
      if (Math.min(end, n.end) - Math.max(start, n.start) >= 0.5) return true;
    }
    return false;
  };
  // A spoken-word cue overlapping BGM/noise underneath its speech (>= 0.5s) is
  // SPEECH_WITH_NOISE so the exported SRT wraps the real words as
  // <NOISE>words</NOISE> (Rule B); otherwise it stays CLEAR_SPEECH (plain text,
  // Rule A). Text and timestamps are never touched.
  const classifiedSpeech = speechSegments.map((s) =>
    overlapsSource(s.startSeconds, s.endSeconds)
      ? { ...s, classification: 'SPEECH_WITH_NOISE' as const }
      : s
  );

  // Refresh each cue's taggedText from its (possibly updated) classification so
  // the UI's Tagged Output Preview and active-cue display match the exported
  // SRT. Classification and text are never changed here; only taggedText is
  // recomputed via the exact same applyTaggingRule used by generateSrtContent.
  const withTaggedText = classifiedSpeech.map((s) => ({
    ...s,
    taggedText: applyTaggingRule(
      s.text,
      s.classification,
      s.endSeconds - s.startSeconds
    ).taggedText,
  }));

  // Intro split (Rule C, rev 2): if the first spoken cue starts AFTER the
  // acoustic onset of the voice (VAD speech) region, the audio before its
  // first word anchor is a BGM/music-only head. Instead of folding that head
  // into the spoken cue, split the cue at the actual voice onset: the head
  // becomes its own NOISE_ONLY cue emitting exactly <NOISE></NOISE> (the cue
  // is NOT trimmed away), and the spoken cue keeps its Sarvam-anchored start
  // (voice onset) with the real words wrapped per Rule B/A. No VAD threshold
  // or Sarvam timestamp is changed and no cue text is mutated.
  const MIN_BGM_ONLY_HEAD_SECONDS = 0.05;
  let emitted = withTaggedText;
  const firstSpeechStart = regions.reduce(
    (m, r) => (r.type === 'speech' && r.start < m ? r.start : m),
    Infinity
  );
  if (Number.isFinite(firstSpeechStart)) {
    const firstCue = withTaggedText.reduce((a, b) =>
      b.startSeconds < a.startSeconds ? b : a
    );
    const headEnd = firstCue.startSeconds;
    if (headEnd - firstSpeechStart >= MIN_BGM_ONLY_HEAD_SECONDS) {
      const head: SubtitleSegment = {
        id: 0,
        startSeconds: Number(firstSpeechStart.toFixed(3)),
        endSeconds: headEnd,
        startTimeFormatted: formatSrtTimestamp(firstSpeechStart),
        endTimeFormatted: formatSrtTimestamp(headEnd),
        text: '',
        classification: 'NOISE_ONLY',
        taggedText: '<NOISE></NOISE>',
        confidence: 0.98,
      };
      emitted = [head, ...emitted];
    }
  }
  return sortSegments(emitted);
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

  // Real wall-clock duration of the uploaded audio (local ffmpeg decode),
  // used instead of the provider-reported duration so queued jobs match the
  // synchronous route and subtitle timing spans the actual audio.
  const decodedAudioDuration = await measureAudioDurationSeconds(audioBuffer, mimeType || 'audio/wav');
  const durationForSrt =
    decodedAudioDuration > 0
      ? decodedAudioDuration
      : provider === 'sarvam' && providerResult.durationSeconds > 0
        ? providerResult.durationSeconds
        : fileDurationSeconds || 0;
  const durScaling =
    decodedAudioDuration > 0 && provider === 'sarvam' && providerResult.durationSeconds > 0
      ? decodedAudioDuration / providerResult.durationSeconds
      : 1;
  const wordTimings = provider === 'sarvam' ? providerResult.wordTimings : [];
  let segments: SubtitleSegment[] =
    rawTranscript.length > 0 ? buildMax3WordSegments(rawTranscript, durationForSrt, wordTimings, durScaling) : [];
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

  // Bind the port FIRST, before any fallible initialization below. Render
  // scans for an open port the moment the process starts, but listen() used to
  // be the last statement of startServer (~2500 lines below): any startup
  // failure (missing provider env, unreachable Turso, stale dist/) killed the
  // process before a port ever opened, and Render reported the misleading
  // "Port scan timeout reached, no open ports detected" instead of the real
  // error. Until initialization finishes, /api/health answers 503 so Render's
  // health check keeps retrying and only turns healthy once the real handler
  // registered below is live.
  let bootReady = false;
  app.get('/api/health', (_req, res, next) => {
    if (bootReady) {
      next();
    } else {
      res.status(503).json({ status: 'starting' });
    }
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Server] Odia SRT — Audio/Video → Tagged SRT  |  http://localhost:${PORT}/\n` +
        `[Server] Admin Dashboard (owner only)         |  http://localhost:${PORT}/admin\n` +
        `[Server] serving: ${process.cwd()}`,
    );
  });

  // A port collision is the exact failure that hid the real app behind a stale
  // one. Report WHO owns the port and refuse to continue.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[Server] FATAL: port ${PORT} is already in use.\n` +
          `        This process will NOT start, and the server already on the port is NOT\n` +
          `        necessarily this application — it may be a stale copy or an unrelated dev\n` +
          `        server, which is how an old UI can be served at http://localhost:${PORT}/.\n` +
          `        Find it with:  Get-NetTCPConnection -State Listen -LocalPort ${PORT}\n` +
          `        Stop it with:  Stop-Process -Id <pid>\n` +
          `        Or run this app on another port:  $env:PORT=3001; npm start\n`,
      );
      process.exit(1);
    }
    console.error('[Server] fatal listen error', err);
    process.exit(1);
  });

  // Stage 6B: fail fast, BEFORE any provider is constructed, if a production
  // process has not named its production providers explicitly. A no-op unless
  // NODE_ENV=production, so local development and the test suite are unchanged.
  // The per-provider credential checks below still run afterwards.
  assertProductionProviderSelection();

  // ---------------------------------------------------------------------------
  // Architecture layer: durable user/job/credit stores + storage + queue.
// Everything below is ADDITIVE — the legacy /api/process-audio behaviour is
// untouched. These instances are wired in-process; a future deployment swaps
// DataStore/StorageProvider/JobQueue for cloud backends behind the same
// interfaces.
// ---------------------------------------------------------------------------
// Initialize database provider
let store: DataStoreProvider;
let accounts: AsyncAccountService;
let credits: AsyncCreditService;
let loginActivityRepo: LoginActivityRepo | undefined;
if (config.databaseProvider === 'turso') {
  if (!config.tursoDatabaseUrl || !config.tursoAuthToken) {
    throw new Error('Turso configuration required: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set when DATABASE_PROVIDER=turso');
  }
  const { createTursoStore } = await import('./server/db/tursoStore');
  const tursoStore = await createTursoStore(config.tursoDatabaseUrl, config.tursoAuthToken);
  store = tursoStore;
  // Production runs the libSQL provider, which cannot back the SYNCHRONOUS
  // `UserRepo` (`snapshot()` is a Promise there and `mutate()` throws). Mount
  // the async account facade for this provider so signup/login/session resolve
  // against real rows instead of throwing a 500.
  accounts = createTursoAccountFacade(new TursoAccountService(tursoStore));
  // The credit surface must be selected from the SAME provider as `accounts`.
  // Leaving `FileCreditService` wired here was the second half of the outage:
  // `CreditRepo.listForUser` reads the synchronous `snapshot()`, so `/api/credits/me`
  // threw `Cannot read properties of undefined (reading 'filter')` and answered 500
  // even once identity resolution had been fixed.
  credits = createTursoCreditFacade(new TursoCreditService(tursoStore));
} else {
  const { DataStore } = await import('./server/db/store');
  store = new DataStore(config.dbFile);
  loginActivityRepo = new LoginActivityRepo(store);
  accounts = createFileAccountFacade(new UserRepo(store), new CreditRepo(store));
  credits = createFileCreditFacade(new FileCreditService(new UserRepo(store), new CreditRepo(store)));
}
await store.init();

const users = new UserRepo(store);
const creditsRepo = new CreditRepo(store);
const jobs = new JobRepo(store);
const providerSafetyRepo = new ProviderSafetyRepo(store);
const moderationRepo = new ModerationRepo(store);
/**
 * The ONE credit surface the HTTP layer uses.
 *
 * It is an async facade so a single handler body is correct for BOTH providers:
 * the JSON provider's synchronous methods are wrapped (a sync throw becomes a
 * rejection at the same `await`), and the libSQL provider's methods are already
 * async. Nothing downstream branches on which store is mounted, and no handler
 * has to be rewritten when the provider changes.
 *
 * `credits` is assigned in the provider block above so it can never disagree with
 * `accounts` about which backend is live.
 */

// Initialize storage provider.
//
// Production storage is Backblaze B2 over its S3-compatible API. `b2` is the
// only value a production process can reach here: assertProductionProviderSelection()
// runs first and refuses to start unless STORAGE_PROVIDER is exactly 'b2', so
// there is no path by which a production boot silently lands on local storage.
// The 'r2' branch remains for non-production compatibility only.
let storage: any;
if (config.storageProvider === 'b2') {
  const missingB2Vars = missingB2EnvKeys(process.env);
  if (missingB2Vars.length > 0) {
    throw b2ConfigurationError(missingB2Vars);
  }
  const { createB2StorageProvider } = await import('./server/services/b2Storage');
  storage = createB2StorageProvider({
    endpoint: config.b2Endpoint!,
    region: config.b2Region!,
    bucket: config.b2Bucket!,
    keyId: config.b2KeyId!,
    applicationKey: config.b2ApplicationKey!,
  });
} else if (config.storageProvider === 'r2') {
  if (!config.r2AccountId || !config.r2AccessKeyId || !config.r2SecretAccessKey || !config.r2Bucket) {
    throw new Error('R2 configuration required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET must be set when STORAGE_PROVIDER=r2');
  }
  const { createStorageProvider } = await import('./server/services/r2Storage');
  storage = createStorageProvider('r2', { r2Config: {
    accountId: config.r2AccountId!,
    accessKeyId: config.r2AccessKeyId!,
    secretAccessKey: config.r2SecretAccessKey!,
    bucket: config.r2Bucket!,
  }});
} else {
  const { LocalFileStorageProvider } = await import('./server/services/storage');
  storage = new LocalFileStorageProvider(config.storageDir);
}

// Community & Support moderation. Additive: no existing pipeline, credit,
// provider-safety or auth path reads or writes these.
const moderation = new CommunityModerationService(moderationRepo);
// Attachments live in their own directory, never mixed with job uploads.
const communityAttachments = new LocalFileStorageProvider(
  path.join(config.dataDir, 'community-attachments')
);
// Monthly login analytics + the daily Telegram login report.
//
// Provider-aware on purpose. These tables used to be read/written through the
// SYNCHRONOUS LoginActivityRepo, whose snapshot()/mutate() do not work on
// libSQL: reads silently returned an empty list (so every metric reported ZERO)
// and writes threw (so nothing was ever recorded). The daily report's "already
// sent" guard therefore always reported "not sent", Telegram was messaged on
// every tick, and the follow-up save threw - the same report, repeatedly.
//
// `loginActivityStore` is selected alongside `accounts`/`credits`, and the daily
// report is gated by a PERSISTED ATOMIC claim (see runDailyLoginAlert), not by
// an in-memory flag, so restarts and multiple instances cannot duplicate it.
const loginActivityStore: LoginActivityStore =
  config.databaseProvider === 'turso'
    ? createTursoLoginActivityStore(store as unknown as TursoStore)
    : createFileLoginActivityStore(loginActivityRepo);
const loginActivity = new AsyncLoginActivityService(loginActivityStore);

  /**
   * Owner notifications. NO transport is configured: alerts are rendered,
   * recorded locally and logged only. This is deliberate — there is no WhatsApp
   * (or any other messaging) integration in this project and none was invented.
   * A future transport is added by passing it here, nothing else changes.
   */
  const notifier: OwnerNotifier = createOwnerNotifier({ log: nestedLog });

  /**
   * ADMIN_BOOTSTRAP_TOKEN integrity check.
   *
   * On every start the configured secret is read from the server-side .env,
   * fingerprinted (HMAC-SHA256 over a locally generated pepper) and compared,
   * in constant time, with the baseline recorded in the gitignored data dir.
   * This is strictly READ-ONLY with respect to the secret: it is never
   * generated, rotated, recovered, replaced or written back, its value is never
   * logged or returned, and a mismatch or a missing value fails safely and waits
   * for manual correction. Delivery is transport-neutral and no channel is
   * configured, so an alert is recorded locally and the notification setup is
   * reported as pending (WhatsApp is NOT connected).
   */
  const tokenGuard = await verifyBootstrapTokenIntegrity({
    token: config.adminBootstrapToken,
    stateFile: path.join(config.dataDir, 'bootstrap-token-guard.json'),
    projectDir: process.cwd(),
    log: nestedLog,
  });
  if (tokenGuard.status === 'CHANGED' || tokenGuard.status === 'MISSING') {
    nestedLog.warn('bootstrap token integrity: manual correction required', {
      status: tokenGuard.status,
      code: tokenGuard.alert?.code,
      delivered: tokenGuard.alert?.delivered ?? false,
      notificationPending: tokenGuard.notificationPending,
      action: 'No token was generated or replaced. Verify the server-side .env manually.',
    });
  }

  /**
   * Provider safety: a LOCALLY STORED state machine (AVAILABLE / WARNING /
   * BLOCKED) persisted in the data store, so a restart can never silently
   * re-enable a provider that reported an exhausted balance. Checked
   * immediately before every ASR call.
   */
  const providerSafety = new ProviderSafetyService({
    provider: getAsrProviderName(),
    get: () => providerSafetyRepo.get(getAsrProviderName()),
    patch: (patch) => providerSafetyRepo.patch(getAsrProviderName(), patch),
    setStatus: (provider, status, reason, patch) =>
      providerSafetyRepo.setStatus(provider, status, reason, patch),
    notifyOwner: (payload) => notifier.notifyOwner(payload),
    log: nestedLog,
  });

  const queue = new JobQueue({
    repo: jobs,
    storage,
    credits,
    getProvider: getProviderStrict as (name: string) => TranscriptionProvider,
    runPipeline: runJobPipeline,
    providerSafety,
  });

  // Razorpay payment gateway — test mode by default, credentials from .env.
  // Returns null if credentials are not configured (feature safely disabled).
  const razorpayConfig = readRazorpayConfig();
  const razorpay = razorpayConfig ? createRazorpayInstance(razorpayConfig) : null;
  const razorpayEnabled = !!razorpay;

  const uploadLimiter = new SlidingWindowLimiter(config.uploadRateLimitWindowMs, config.uploadRateLimitMax);
  // Email-ownership verification transport. Log mode (default when no Resend
  // API key is configured) prints the verification links so a dev/Preview can
  // exercise the flow; Resend mode delivers real mail via the HTTPS API.
  const verificationSender = createEmailSender();
  // One boot line that answers the first production question: which transport
  // did this process actually pick (resend = Resend HTTPS 443, log = dev
  // fallback). Mode only — never the API key or sender credentials.
  nestedLog.info('email transport configured', { transport: verificationSender.mode });
  // Resend throttle: a per-address+IP generous allowance on top of the per-account
  // cooldown so a volume guesser can't cycle many addresses through 429s.
  const resendRateLimiter = new SlidingWindowLimiter(60 * 60 * 1000, 10);

  /**
   * Bearer-token auth: resolves identity, verifies ownership, records access.
   *
   * ASYNC on purpose. Identity resolution goes through `accounts` (the
   * provider-aware facade), so on the production libSQL provider the lookup is
   * an awaited round trip rather than a synchronous read that cannot work.
   *
   * The middleware rejects rather than calling `next(err)`: a database failure
   * while resolving identity must not fall through to a handler that assumes
   * `res.locals.user` is populated. Express 4 never awaits middleware, so the
   * promise chain below is fully self-contained — every path calls `next()`
   * exactly once or writes the response.
   */
  function auth() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = extractToken(req);
      if (!isValidTokenShape(token)) {
        return res.status(401).json({ error: 'Missing or invalid bearer token. Create a session via POST /api/session.' });
      }
      void (async () => {
        const user = await accounts.getByToken(hashToken(token as string));
        if (!user) {
          res.status(401).json({ error: 'Unknown or expired session. Create a session via POST /api/session.' });
          return;
        }
        // Activity tracking must never fail an authorized request.
        await accounts.touch(user.id).catch((e) => {
          nestedLog.warn('session touch failed', { message: redact((e as Error).message) });
        });
        res.locals.user = user;
        next();
      })().catch((err) => {
        nestedLog.error('auth middleware failed', { message: redact((err as Error).message) });
        if (!res.headersSent) res.status(500).json({ error: 'Failed to verify session.' });
      });
    };
  }

  /**
   * MANDATORY authentication for every transcription entry point (the audio ->
   * SRT pipeline). This is `auth()` plus the transcription authorization
   * decision from `authorizeTranscriber`, covering both identities:
   *
   *   - verified customer (email ownership proven)        -> allowed
   *   - valid ADMIN/owner session (bootstrap + allowlist) -> allowed, and NO
   *     customer email-ownership step is required of an owner
   *   - unverified customer                              -> blocked (403)
   *   - ADMIN session whose owner address left the allowlist (revoked) -> 403
   *   - unknown/expired/bogus token                      -> blocked (401)
   *
   * It must be registered BEFORE `upload.single(...)` so an unauthenticated
   * request is refused before multer reads, buffers or stores the body. That
   * ordering is the difference between "401" and "the attacker's audio was
   * uploaded and processed anyway".
   */
  function requireTranscriber() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = extractToken(req);
      if (!isValidTokenShape(token)) {
        return res.status(401).json({
          error: 'Sign in to transcribe. Create an account or sign in to continue.',
          code: 'AUTH_REQUIRED',
        });
      }
      void (async () => {
        const user = await accounts.getByToken(hashToken(token as string));
        if (!user) {
          res.status(401).json({
            error: 'Your session is unknown or has expired. Please sign in again.',
            code: 'SESSION_INVALID',
          });
          return;
        }
        // The single authorization boundary for the pipeline: verified customer
        // OR verified owner. An ADMIN session is never routed through the
        // customer email-ownership step.
        const grant = authorizeTranscriber(user);
        if (grant.ok !== true) {
          res.status(grant.status).json({ error: grant.error, code: grant.code });
          return;
        }
        await accounts.touch(user.id).catch((e) => {
          nestedLog.warn('session touch failed', { message: redact((e as Error).message) });
        });
        res.locals.user = user;
        next();
      })().catch((err) => {
        nestedLog.error('requireTranscriber failed', { message: redact((err as Error).message) });
        if (!res.headersSent) res.status(500).json({ error: 'Failed to verify session.' });
      });
    };
  }

  /**
   * EMAIL OWNERSHIP VERIFICATION — gate for authenticated-but-unverified callers.
   *
   * Used on subscription/charge paths that also admit ADMIN sessions (which
   * requireTranscriber() would accept as owners, not as customers). It only
   * refuses accounts that possess an email AND still have it unverified;
   * ADMIN/no-email users are always allowed, exactly like authorizeTranscriber.
   */
  function requireEmailVerified() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const user = res.locals.user;
      if (!user) {
        return res.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' });
      }
      if (!isEmailVerified(user)) {
        return res.status(403).json({
          error: 'Please verify your email before continuing.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
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

  // JSON payload parser for base64 uploads.
  //
  // Razorpay webhook signatures are HMACs over the EXACT raw request bytes, but
  // once express.json has parsed the body the route only sees a plain object.
  // Capture the raw buffer here — before JSON.parse — and only for the webhook
  // path, so signature verification can use the bytes Razorpay actually signed.
  // No other route's behaviour or memory profile changes.
  app.use(
    express.json({
      limit: '100mb',
      verify: (req, _res, buf) => {
        if ((req as express.Request).path === '/api/credits/purchase/webhook') {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        }
      },
    }),
  );
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
      providerSpendingProtection: config.providerSpendingProtection,
      providerKillSwitch: config.providerKillSwitch,
      providerSafety: providerSafety.view(),
      // Backward-compatible flag names for existing clients.
      providerSpendingBlocked: providerSafety.isBlocked(),
      providerSafetyStatus: providerSafety.view().status,
      providerBalanceKnown: providerSafety.view().balance.known,
      timestamp: new Date().toISOString(),
    });
  });

  // Primary AI processing endpoint (accepts multipart file or JSON with base64 audio)
  // `requireTranscriber()` is deliberately BEFORE `upload.single(...)`.
  //
  // It used to be neither: this route accepted a completely unauthenticated
  // request and transcribed it. Because the free-trial counter and the credit
  // gate are both keyed on a KNOWN user, an anonymous caller was charged
  // nothing at all - while Sarvam was still called, on the operator's account.
  // Any caller could spend real provider money without an account.
  //
  // Ordering matters: registering the gate first means an unauthenticated
  // request is refused with 401 before multer reads the body, so no upload is
  // buffered, no job is created, no provider is contacted, and no free trial or
  // credit is touched.
  app.post('/api/process-audio', requireTranscriber(), upload.single('mediaFile'), async (req, res) => {
    // Set when a paid request reserves credits BEFORE the provider call. Always
    // settled on success and released on ANY error, so a failed/over-quota job
    // can never consume the user's credits (no double-spend, no charge for
    // unused processing). Declared outside the try so the catch can release it.
    let paidReservation: { userId: string; jobId: string; requiredCredits: number } | null = null;
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

      // ------------------------------------------------------------------
      // IDENTITY + FREE-TRIAL USAGE LIMIT (server-side enforcement).
      //   - `requireTranscriber()` (registered before the upload middleware) has
      //     ALREADY resolved a server-verified identity (customer OR verified
      //     owner) and put it in `res.locals.user`. There is no anonymous branch
      //     any more: an unauthenticated request never reaches this line.
      //   - The trial counter increments ONLY after a successful pipeline run
      //     below, so failed uploads / API errors never consume a trial.
      //   - The monetization credit gate runs AFTER the duration is measured and
      //     BEFORE any provider call (see below).
      // ------------------------------------------------------------------
      // Re-read from `res.locals` rather than re-resolving the token: the gate
      // already proved the session is live, and doing it once keeps a single
      // source of truth for "who is this request".
      const sessionUser: UserRecord | null = (res.locals.user as UserRecord | undefined) ?? null;
      if (!sessionUser) {
        // Defensive only. If this ever fires, the gate was bypassed and we must
        // fail closed rather than transcribe anonymously.
        return res.status(401).json({
          error: 'Sign in to transcribe. Create an account or sign in to continue.',
          code: 'AUTH_REQUIRED',
        });
      }
      const freeTrialsUsed = freeTrialsUsedFor(sessionUser);

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

      // ------------------------------------------------------------------
      // SAVED-SRT REUSE (free, zero Sarvam): when the exact uploaded audio
      // (SHA-256) + language already produced an SRT, reopening/reusing it must
      // NOT call Sarvam again and must NOT consume a free trial or credit. The
      // saved SRT is the source of truth for every subsequent preview/edit/tag/
      // download/reopen operation. Only the explicit "Generate SRT again"
      // action (regenerate=true) forces a fresh transcription request.
      // ------------------------------------------------------------------
      const regenerateRequested = req.body && req.body.regenerate === true;
      const savedSrtKey = srtHashKey(sha256, languageCode);
      if (!regenerateRequested) {
        const savedSrtBytes = await storage.get(savedSrtKey);
        if (savedSrtBytes) {
          const savedRawSrt = savedSrtBytes.toString('utf8');
          const savedSegments = parseSavedSrt(savedRawSrt);
          const savedDurationSeconds =
            savedSegments.length > 0 ? savedSegments[savedSegments.length - 1].endSeconds : fileDuration;
          const reuseUsage = {
            freeTrialsUsed,
            freeTrialLimit: config.freeTrialLimit,
            freeTrialsRemaining: freeTrialsRemaining(freeTrialsUsed, config.freeTrialLimit),
          };
          const reuseWallet =
            sessionUser === null
              ? null
              : {
                  credits: await credits.getBalance(sessionUser.id),
                  creditMode: sessionUser.creditMode,
                  unlimited: sessionUser.creditMode === 'UNLIMITED',
                };
          nestedLog.info('reused saved SRT (no provider call, no charge)', {
            savedSrtKey,
            reusedSrt: true,
            cues: savedSegments.length,
          });
          return res.json({
            detectedLanguage: languageName,
            isOdia: languageCode === 'od-IN',
            languageConfidence: 0,
            languageCode,
            languageName,
            requestedLanguage,
            isLanguageDetected,
            durationSeconds: savedDurationSeconds,
            segments: savedSegments,
            rawSrt: savedRawSrt,
            stats: calculateTranscriptionStats(savedSegments),
            usage: reuseUsage,
            wallet: reuseWallet,
            charge: { kind: 'REUSE', requiredCredits: 0 },
            notes: [
              'Reused the saved SRT for this exact audio. No new transcription request was made, no free trial or credit was consumed.',
            ],
            localSubmissionMode: false,
            reusedSrt: true,
          });
        }
      }

      // ------------------------------------------------------------------
      // CREDIT GATE (server-side monetization, enforced BEFORE any provider
      // call). Product rules:
      //   - 1 credit = 1 minute of the SERVER-MEASURED upload duration, rounded
      //     UP: 0-60s -> 1, 61-120s -> 2, 121-180s -> 3, ... The client-supplied
      //     duration (req.body.duration) is NEVER used for pricing.
      //   - Exactly 2 successful free trials per NORMAL user (failures never
      //     consume). FREE_TRIAL_LIMIT=0 keeps the legacy "cap off" meaning.
      //   - After the trials, credit balance must cover the required credits,
      //     else 402 NOT_ENOUGH_CREDITS BEFORE the provider is contacted.
      //   - The provider safety gate applies to EVERY caller (incl. UNLIMITED and
      //     anonymous) and blocks processing entirely with the "Processing
      //     temporarily unavailable" message while the locally stored state is
      //     BLOCKED (402 / insufficient quota / kill-switch).
      //   - Requests blocked here NEVER reach the provider and NEVER touch the
      //     wallet (except a PAID request, which reserves the exact amount so a
      //     concurrent request cannot double-spend the same credits).
      // ------------------------------------------------------------------
      // LOCAL SUBMISSION MODE (temporary): when the operator sets
      // LOCAL_SUBMISSION_MODE=true the transcription step below runs a LOCAL,
      // open-source, CPU-only Odia ASR instead of any paid cloud provider.
      // It makes no billable API call at all, so the provider spending gate
      // cannot apply to it. This is the ONLY exemption and it is deliberately
      // narrow: it is keyed on the local mode flag, so Sarvam, Groq and Olive
      // remain fully gated by PROVIDER_SPENDING_PROTECTION exactly as before.
      // Unset LOCAL_SUBMISSION_MODE and the paid path is bit-for-bit unchanged.
      const localSubmissionMode = isLocalSubmissionModeEnabled();
      if (localSubmissionMode) {
        nestedLog.warn(
          'LOCAL SUBMISSION MODE active - local Odia ASR, no paid provider call',
          { provider: 'local' }
        );
      }

      const decodedAudioDuration = await measureAudioDurationSeconds(audioBuffer, mimeType);
      const spendDecision = decideAudioSpend({
        user: sessionUser
          ? {
              id: sessionUser.id,
              creditMode: sessionUser.creditMode,
              freeTrialsUsed,
              credits: sessionUser.credits,
            }
          : null,
        measuredDurationSeconds: decodedAudioDuration,
        freeTrialLimit: config.freeTrialLimit,
        // See above: only the zero-cost local provider is exempt.
        providerBlocked: providerSafety.isBlocked() && !localSubmissionMode,
      });
      if (!spendDecision.ok) {
        nestedLog.info('audio spend gated', {
          userId: sessionUser?.id,
          kind: spendDecision.kind,
          code: spendDecision.code,
        });
        const body: Record<string, unknown> = {
          error: spendDecision.message,
          code: spendDecision.code,
          freeTrialsUsed,
          freeTrialLimit: config.freeTrialLimit,
          freeTrialsRemaining: freeTrialsRemaining(freeTrialsUsed, config.freeTrialLimit),
        };
        if (spendDecision.requiredCredits !== undefined) body.requiredCredits = spendDecision.requiredCredits;
        if (spendDecision.balance !== undefined) body.balance = spendDecision.balance;
        return res.status(spendDecision.status ?? 500).json(body);
      }
      if (spendDecision.kind === 'PAID' && sessionUser) {
        const jobId = newId();
        await credits.reserveJob({
          userId: sessionUser.id,
          jobId,
          amount: spendDecision.requiredCredits as number,
          reason: 'reserve_transcription',
        });
        paidReservation = {
          userId: sessionUser.id,
          jobId,
          requiredCredits: spendDecision.requiredCredits as number,
        };
        nestedLog.info('credits reserved', {
          userId: sessionUser.id,
          amount: paidReservation.requiredCredits,
          jobId,
        });
      }

      // Choose the ACTIVE transcription provider.
      //   - Sarvam (default): designed for Indian languages; forces Odia od-IN,
      //     model saaras:v4, mode verbatim.
      //   - Groq (fallback): kept available for testing via TRANSCRIPTION_PROVIDER=groq.
      //   - Olive (opt-in): OdiaGenAI Whisper Odia fine-tune via
      //     TRANSCRIPTION_PROVIDER=olive + OLIVE_API_URL. Never default.
      //   - local: ONLY when LOCAL SUBMISSION_MODE=true. Temporary zero-budget
      //     local Odia ASR; no cloud/paid API is contacted.
      const provider = localSubmissionMode ? ('local' as const) : getActiveProvider();

      // RAW transcription of the EXACT uploaded audio. We do NOT use any
      // canonical / cached / old / temp SRT, we do NOT apply spelling correction,
      // and we do NOT run max-3-word segmentation yet (raw text is verified first).
      const rawText = await (async () => {
        if (provider === 'local') {
          // LOCAL SUBMISSION MODE: local, open-source, CPU-only Odia ASR on the
          // EXACT uploaded audio. Returns real per-word timings (CTC alignment).
          const r = await transcribeRawOdiaWithLocalAsr(audioBuffer, mimeType);
          return {
            text: r.transcript,
            duration: r.audioDurationSeconds,
            meta: { words: r.words, localAsr: r },
          };
        } else if (provider === 'sarvam') {
          const r = await transcribeRawOdiaWithSarvam(audioBuffer, mimeType, {
            languageCode,
            jobTimeoutMs: config.jobTimeoutMs,
          });
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

      // Subtitle timing spans the actual audio timeline. `decodedAudioDuration`
      // is the server-measured wall-clock duration of the uploaded audio (local
      // ffmpeg decode), already computed by the pre-provider credit gate above;
      // it is reused here so the gate and the SRT timeline always agree.
      const durationForSrt =
        decodedAudioDuration > 0
          ? decodedAudioDuration
          : provider === 'sarvam' && rawText.duration && rawText.duration > 0
            ? rawText.duration
            : fileDuration || 0;
      const durScaling =
        decodedAudioDuration > 0 && provider === 'sarvam' && rawText.duration > 0
          ? decodedAudioDuration / rawText.duration
          : 1;

      // Subtitle segmentation: split the RAW transcript into subtitles with a
      // strict maximum of 3 words each, preserving every spoken word in exact
      // order (no loss, no duplication, no invented words). Timing comes from
      // Sarvam word timestamps when available (1:1), else from Sarvam
      // phrase/segment anchors (words mapped to phrases by index, phrase gaps
      // preserved), else the existing even distribution across the DECODED
      // audio timeline. Tagging stays CLEAR_SPEECH (Rule A), untouched.
      const sarvamWordTimings =
        provider === 'sarvam'
          ? ((rawText.meta as any)?.chunks as Array<{
              text: string;
              startSeconds: number;
              endSeconds: number;
            }>) || []
          : [];

      // LOCAL SUBMISSION MODE supplies REAL per-word timings measured by the
      // local model's CTC frame alignment, so the existing 1:1 branch of
      // buildMax3WordSegments places every cue on a real spoken word instead of
      // distributing it evenly. Nothing here is interpolated or invented.
      const localWordTimings =
        provider === 'local'
          ? ((rawText.meta as any)?.words as Array<{
              text: string;
              startSeconds: number;
              endSeconds: number;
            }>) || []
          : [];

      // For Sarvam this is identical to the previous behaviour.
      const providerWordTimings =
        provider === 'sarvam' ? sarvamWordTimings : localWordTimings;

      console.log(
        `  [TIMING] decodedWav=${decodedAudioDuration.toFixed(3)}s sarvamDuration=${(rawText.duration || 0).toFixed(3)}s ` +
          `providerChunks=${(provider === 'sarvam' ? ((rawText.meta as any)?.chunks || []).length : 0)} words=${rawTranscript.split(/\s+/).filter(Boolean).length}`
      );

      // LOCAL SUBMISSION MODE: the worker already produced the FINAL cues
      // directly from its VAD speech-region-clipped, per-region CTC inference.
      // Each window is the ACTUAL first/last word timing (20 ms frame alignment
      // on the exact uploaded audio), max 3 spoken words, punctuation-free,
      // and chunked so no cue ever spans confirmed non-speech/BGM. They are
      // used VERBATIM and the re-tagging + VAD re-snap are SKIPPED: both would
      // otherwise override the real word timing the worker measured.
      let workerWordCursor = 0;
      const workerCuesRaw =
        provider === 'local'
          ? (((rawText.meta as any)?.localAsr?.segments as Array<{
              id?: number;
              startSeconds: number;
              endSeconds: number;
              text: string;
            }>) || [])
          : [];
      let segments: SubtitleSegment[] = [];
      if (workerCuesRaw.length > 0) {
        let segId = 1;
        for (const cue of workerCuesRaw) {
          const startSeconds = Number(cue.startSeconds);
          const endSeconds = Number(cue.endSeconds);
          const text = String(cue.text ?? '').trim();
          if (
            !text ||
            !Number.isFinite(startSeconds) ||
            !Number.isFinite(endSeconds) ||
            endSeconds < startSeconds
          ) {
            continue;
          }
          const wordsInCue = text.split(/\s+/).filter(Boolean).length;
          const cueWordTimings = localWordTimings
            .slice(workerWordCursor, workerWordCursor + wordsInCue)
            .map((w) => ({ word: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds }));
          workerWordCursor += wordsInCue;
          segments.push({
            id: segId++,
            startSeconds,
            endSeconds,
            startTimeFormatted: formatSrtTimestamp(startSeconds),
            endTimeFormatted: formatSrtTimestamp(endSeconds),
            text,
            classification: 'CLEAR_SPEECH' as const,
            taggedText: applyTaggingRule(text, 'CLEAR_SPEECH', endSeconds - startSeconds)
              .taggedText,
            confidence: 0.98,
            wordTimings: cueWordTimings,
          });
        }
        // rawWordCount === finalWordCount is still verified below: the cues
        // partition every word the worker recognised, in order, with no loss.
        console.log(
          `[VOICE TIMING] local worker cues used verbatim=${segments.length} (real CTC word timing; VAD re-snap skipped)`
        );
      } else {
        segments =
          rawTranscript.length > 0
            ? buildMax3WordSegments(rawTranscript, durationForSrt, providerWordTimings, durScaling)
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
      }

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

      // Success accounting: this pipeline run succeeded.
      //   - PAID requests: convert the pre-request credit reservation into final
      //     USAGE (the exact reserved amount; balance already blocked above, so
      //     there is no double-spend).
      //   - FREE_TRIAL requests for NORMAL users: consume exactly one trial and
      //     append a zero-amount FREE_TRIAL ledger entry (server-side, persisted,
      //     so a refresh cannot reset it). Anonymous / UNLIMITED never counted.
      const usage: {
        freeTrialsUsed: number;
        freeTrialLimit: number;
        freeTrialsRemaining: number;
      } = {
        freeTrialsUsed,
        freeTrialLimit: config.freeTrialLimit,
        freeTrialsRemaining: freeTrialsRemaining(freeTrialsUsed, config.freeTrialLimit),
      };
      if (paidReservation) {
        await credits.settleJobReservation(paidReservation.userId, paidReservation.jobId, 'usage_transcription');
        nestedLog.info('paid credits used', {
          userId: paidReservation.userId,
          amount: paidReservation.requiredCredits,
          jobId: paidReservation.jobId,
        });
      } else if (sessionUser && spendDecision.kind === 'FREE_TRIAL') {
        // UNCHANGED free-trial accounting, now actually reachable.
        //
        // The POLICY is untouched: one trial per user, `config.freeTrialLimit`,
        // and the 2-minute cap are all still decided by `freeTrialPolicy.ts`
        // before we get here. Only the PERSISTENCE changed: the increment used to
        // go through the synchronous `users.incrementFreeTrialsUsed`, whose
        // `store.mutate()` throws on the libSQL provider, so a successful free
        // transcription 500'd at the very last step and the trial was never
        // consumed. It now uses the provider-aware facade (a conditional SQL
        // UPDATE ... RETURNING), which is correct on both providers.
        const incremented = await accounts.incrementFreeTrialsUsed(sessionUser.id);
        if (incremented !== null) {
          usage.freeTrialsUsed = incremented;
          usage.freeTrialsRemaining = freeTrialsRemaining(incremented, config.freeTrialLimit);
          // Zero-amount FREE_TRIAL ledger entry, exactly as before: it is the
          // audit trail for "a trial was spent", not a credit movement.
          await accounts
            .recordFreeTrialUsage(sessionUser.id, sessionUser.credits ?? 0)
            .catch((e) => nestedLog.warn('free trial ledger entry failed', { message: redact((e as Error).message) }));
          nestedLog.info('free trial used', { userId: sessionUser.id, used: incremented, limit: config.freeTrialLimit });
        }
      }

      // Server-maintained wallet snapshot (credit balances are NEVER read from
      // the client). Missing when the caller is anonymous (no identity).
      const wallet =
        sessionUser === null
          ? null
          : {
              credits: await credits.getBalance(sessionUser.id),
              creditMode: sessionUser.creditMode,
              unlimited: sessionUser.creditMode === 'UNLIMITED',
            };

      const generatedSrt = generateSrtContent(segments);

      // Persist the generated SRT so any reopen/re-upload of this exact audio +
      // language reuses it (free) instead of making another Sarvam request.
      // Best-effort: a storage failure must never fail an otherwise-successful
      // transcription (the SRT is still returned to the caller).
      try {
        await storage.put(savedSrtKey, Buffer.from(generatedSrt, 'utf8'));
        nestedLog.info('saved generated SRT for reuse', { savedSrtKey, cues: segments.length });
      } catch (saveErr) {
        nestedLog.warn('could not save SRT for reuse', { savedSrtKey, error: String(saveErr) });
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
        rawSrt: generatedSrt,
        stats: calculateTranscriptionStats(segments),
        usage,
        wallet,
        charge: {
          kind: spendDecision.kind,
          requiredCredits: spendDecision.requiredCredits ?? 0,
        },
        notes: [
          provider === 'local'
            ? 'LOCAL SUBMISSION MODE: local open-source Odia ASR (ai4bharat/indicwav2vec-odia, Apache-2.0) transcribed the EXACT uploaded audio on this machine. No Sarvam, Groq, Olive or other paid/cloud API was contacted and nothing was spent. The model ran ONLY on detected speech regions (VAD-clipped), so music/noise-only spans never reach it and no words are hallucinated over BGM. Subtitles are at most 3 spoken words each, timed from the ACTUAL first/last per-word CTC frame alignment mapped back to the exact uploaded audio timeline (cue windows never span non-speech gaps; no VAD re-snap). Punctuation is removed from spoken words. No spelling correction and no cached/previous/fixture transcript.'
            : provider === 'sarvam'
            ? `Sarvam Saaras (saaras:v4, ${languageCode}, verbatim) transcription of the exact uploaded audio. Subtitles split to max 3 words each and classified against the actual audio (NOISE/SILENCE/MB) so the exported SRT contains real tags. No spelling correction, no canonical/old SRT fallback.`
            : provider === 'olive'
              ? 'Olive OdiaGenAI Whisper (language=or) transcription of the exact uploaded audio. Subtitles split to max 3 words each and classified against the actual audio (NOISE/SILENCE/MB) so the exported SRT contains real tags. No spelling correction, no canonical/old SRT fallback.'
              : 'Groq raw transcription (fallback provider). Subtitles split to max 3 words each and classified against the actual audio. No spelling correction, no canonical/old SRT fallback.',
        ],
        // Clear, machine-readable LOCAL SUBMISSION MODE labelling.
        localSubmissionMode: provider === 'local',
        localAsr:
          provider === 'local'
            ? {
                model: (rawText.meta as any)?.localAsr?.model ?? 'ai4bharat/indicwav2vec-odia',
                modelDir: (rawText.meta as any)?.localAsr?.modelDir ?? null,
                device: (rawText.meta as any)?.localAsr?.device ?? 'cpu',
                wordCount: (rawText.meta as any)?.localAsr?.wordCount ?? 0,
                cueCount: (rawText.meta as any)?.localAsr?.segments?.length ?? 0,
                speechRegionCount: (rawText.meta as any)?.localAsr?.speechRegionCount ?? 0,
                speechSecTotal: (rawText.meta as any)?.localAsr?.speechSeconds ?? null,
                hasReliableTimestamps: (rawText.meta as any)?.localAsr?.hasReliableTimestamps === true,
                timestampNote: (rawText.meta as any)?.localAsr?.timestampNote ?? null,
                meanLogProb: (rawText.meta as any)?.localAsr?.meanLogProb ?? null,
                inferenceSeconds: (rawText.meta as any)?.localAsr?.inferenceSeconds ?? null,
              }
          : undefined,
        audioDiagnostics,
      });
    } catch (error: any) {
      console.error('[Odia Pipeline Error]:', error);

      // A reserved-but-unfinished paid job must NEVER consume credits: return
      // the reserved amount to the wallet and record a RELEASE ledger entry.
      if (paidReservation) {
        try {
          await credits.releaseJobReservation(paidReservation.userId, paidReservation.jobId, 'release_failed_job');
          nestedLog.info('reservation released', {
            userId: paidReservation.userId,
            jobId: paidReservation.jobId,
            amount: paidReservation.requiredCredits,
          });
        } catch (releaseErr) {
          // Never mask the original pipeline error with a release failure.
          nestedLog.error('reservation release failed', { userId: paidReservation.userId, error: String(releaseErr) });
        }
      }

      const rawMessage = error?.message || '';
      const lower = rawMessage.toLowerCase();
      const isRateLimited = lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests');
      const isUnavailable = lower.includes('503') || lower.includes('unavailable') || lower.includes('overloaded');

      // Classify the provider failure and let the LOCALLY STORED state machine
      // decide. A reliable 402 (insufficient_quota / "no credits available")
      // transitions the provider to BLOCKED: the next request is rejected
      // before any API call, no retry is scheduled, no automatic recharge is
      // attempted and no paid fallback provider is used. The owner is alerted
      // through notifyOwner(). Only an admin reset returns it to AVAILABLE.
      const providerFailure = classifyProviderFailure({ message: rawMessage });
      let safetyView: ProviderSafetyView | null = null;
      // A ProviderSpendingError is our own gate decision, not a provider
      // failure, so it is never counted as one.
      if (providerFailure.kind !== 'UNKNOWN' && !(error instanceof ProviderSpendingError)) {
        safetyView = providerSafety.reportFailure(providerFailure);
      }
      if (safetyView?.status === 'BLOCKED') {
        nestedLog.warn('provider BLOCKED — no further provider calls until an admin reset', {
          provider: safetyView.provider,
          reason: safetyView.reason,
          lastHttpStatus: safetyView.lastHttpStatus,
        });
      }

      let userFriendlyMessage = rawMessage || 'Failed to process audio with Odia transcription pipeline.';
      let statusCode = 500;
      let isTransient = false;

      if (safetyView?.status === 'BLOCKED') {
        // Existing temporary-unavailable response — exactly the same copy the
        // pre-call gate returns, so blocked users always see one message.
        statusCode = 503;
        userFriendlyMessage = PROVIDER_UNAVAILABLE_MESSAGE;
      } else if (isRateLimited) {
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
  // `requireTranscriber()` BEFORE the handler: this route calls `runOdiaPipeline`,
  // i.e. it performs real ASR work against the configured provider. It used to
  // be completely unauthenticated, so it was a second free provider-spend hole
  // even after /api/process-audio was locked down. No auth -> 401, no pipeline
  // call, no provider data leaves the process.
  app.post('/api/detect-language', requireTranscriber(), async (req, res) => {
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
  //
  // ADMIN/owner bootstrap: the request must present BOTH
  //   1. `adminBootstrapToken` equal to the server-held env secret, AND
  //   2. `ownerEmail` that is on the SERVER-SIDE allowlist (OWNER_EMAILS,
  //      default: officeaipro6@gmail.com, sumitchinara@gmail.com).
  // Both are verified server-side (see server/authz.ts); the email claim alone
  // grants nothing, and an allowlisted email without the secret is REFUSED with
  // 403. This is the ONLY path that assigns a role — client-supplied
  // role/creditMode fields are never read.
  app.post('/api/session', asyncRoute(async (req, res) => {
    try {
      const existing = extractToken(req);
      const ownerAttempt = authorizeOwnerSession({
        bootstrapToken: req.body?.adminBootstrapToken,
        claimedEmail: req.body?.ownerEmail,
      });
      const isAdminBootstrap = ownerAttempt.ok;
      if (!isAdminBootstrap && req.body?.adminBootstrapToken) {
        // An owner claim that failed verification is never silently downgraded
        // to a normal session: report why, without echoing the secret.
        const code = (ownerAttempt as { code: OwnerRejection }).code;
        nestedLog.warn('admin bootstrap refused', { code, hasEmail: Boolean(normalizeEmail(req.body?.ownerEmail)) });
        return res.status(403).json({ error: ownerRejectionMessage(code), code });
      }
      let userId: string;
      let presentedIsLive = false;
      if (existing && isValidTokenShape(existing)) {
        const user = await accounts.getByToken(hashToken(existing));
        if (!user) return res.status(401).json({ error: 'Unknown or expired session token.' });
        userId = user.id;
        presentedIsLive = true;
      } else {
        const tokenHash = hashToken(issueToken());
        const user = await accounts.createSessionUser(tokenHash, config.initialCredits);
        userId = user.id;
      }
      if (isAdminBootstrap) {
        // Persist the CANONICAL allowlisted email (not the raw claim).
        await accounts.setRole(userId, 'ADMIN');
        await accounts.setCreditMode(userId, 'UNLIMITED');
        await accounts.setOwnerEmail(userId, ownerAttempt.ownerEmail);
        nestedLog.info('admin role granted via verified owner bootstrap', {
          userId,
          ownerEmail: ownerAttempt.ownerEmail,
        });
      }
      // Hand back the token the caller already proved it holds. A refresh must
      // not append a second hash to users.tokenHashes for the same session;
      // addToken stays idempotent and still refreshes lastSeenAt.
      const token = selectSessionToken(existing, presentedIsLive) ?? issueToken();
      await accounts.addToken(userId, hashToken(token));
      const user = await accounts.getById(userId);
      const freeTrialsUsed = freeTrialsUsedFor(user);
      // Monthly login analytics: one event per genuine session. A browser
      // refresh re-hits this route with the same token and is collapsed by the
      // service's refresh-dedup window, so it cannot inflate the counts.
      // Observational only: a failure here must never break session creation.
      try {
    await loginActivity.record({
      userId,
      email: user?.email ?? undefined,
      method: isAdminBootstrap ? 'OWNER_BOOTSTRAP' : 'SESSION',
      outcome: 'SUCCESS',
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
      } catch (e) {
        nestedLog.warn('login activity record failed', { message: redact((e as Error).message) });
      }
      res.json({
        userId,
        token,
        credits: user?.credits ?? 0,
        role: user?.role ?? 'USER',
        creditMode: user?.creditMode ?? 'NORMAL',
        unlimited: (user?.creditMode ?? 'NORMAL') === 'UNLIMITED',
        freeTrialsUsed,
        freeTrialLimit: config.freeTrialLimit,
        freeTrialsRemaining: freeTrialsRemaining(freeTrialsUsed, config.freeTrialLimit),
        provider: getAsrProviderName(),
        createdAt: user?.createdAt,
        email: user?.email ?? null,
        account: Boolean(user?.email),
        emailVerified: isEmailVerified(user),
        lastLoginAt: user?.lastLoginAt ?? null,
      });
    } catch (err: any) {
      nestedLog.error('session creation failed', { message: redact(err.message) });
      res.status(500).json({ error: 'Failed to create session.' });
    }
  }));

  // Normal email/password USER accounts — a separate auth surface from the
  // ADMIN bootstrap (authorizeOwnerSession). Users never need the bootstrap
  // token and signup always produces a plain USER account (never ADMIN).
  // Shared session body so /api/session and the account endpoints stay in sync.
  function sessionPayload(user: UserRecord | null | undefined, token: string) {
    const freeTrialsUsed = freeTrialsUsedFor(user);
    return {
      userId: user?.id ?? '',
      token,
      credits: user?.credits ?? 0,
      role: user?.role ?? 'USER',
      creditMode: user?.creditMode ?? 'NORMAL',
      unlimited: (user?.creditMode ?? 'NORMAL') === 'UNLIMITED',
      freeTrialsUsed,
      freeTrialLimit: config.freeTrialLimit,
      freeTrialsRemaining: freeTrialsRemaining(freeTrialsUsed, config.freeTrialLimit),
      provider: getAsrProviderName(),
      createdAt: user?.createdAt,
      email: user?.email ?? null,
      account: Boolean(user?.email),
      emailVerified: isEmailVerified(user),
      lastLoginAt: user?.lastLoginAt ?? null,
    };
  }

  // `asyncRoute` is mandatory here: `accounts.*` returns Promises on BOTH
  // providers, so a rejection (a duplicate email racing two signups, a libSQL
  // write failure) would otherwise escape Express 4's synchronous error capture
  // and, on Node 15+, terminate the process. No mock auth, no fabricated
  // success: a failure still surfaces as 5xx from the catch below.
  app.post('/api/account/signup', asyncRoute(async (req, res) => {
    try {
      const result = await accounts.signup(req.body ?? {}, config.initialCredits);
      if (!result.ok || !result.user) {
        const status = result.code === 'EMAIL_TAKEN' ? 409 : 400;
        return res.status(status).json({ error: result.error, code: result.code ?? 'VALIDATION' });
      }
      const token = issueToken();
      await accounts.addToken(result.user.id, hashToken(token));
      const user = await accounts.getById(result.user.id);
      // A signup immediately establishes a real session, so it is the customer's
      // FIRST successful login. Recording it here (not only on a later session
      // refresh) is what makes the daily report's "new users" metric correct for
      // a customer who signs up and never signs in again. Observational only:
      // the response below is produced regardless of whether this lands.
      try {
        await loginActivity.record({
          userId: result.user.id,
          email: result.user.email ?? undefined,
          method: 'SESSION',
          outcome: 'SUCCESS',
          ip: req.ip,
          userAgent: String(req.headers['user-agent'] ?? ''),
        });
      } catch (e) {
        nestedLog.warn('signup login-activity record failed', { message: redact((e as Error).message) });
      }
      // EMAIL OWNERSHIP VERIFICATION: a fresh account is unverified until it
      // proves the inbox. Persist the token hash first, then deliver the link
      // best-effort — a transport failure must never fail the signup, and a
      // resendable link always exists because the hash is already on disk.
      if (user && user.email) {
        try {
          const rawToken = await accounts.issueVerification(user.id);
          if (rawToken) {
            const baseUrl = appBaseUrlForRequest(req);
            const { message } = verificationEmailFor(user.email, rawToken, { requestBaseUrl: baseUrl });
            const delivery = await verificationSender.sender(message);
            nestedLog.info('verification email sent', {
              userId: user.id,
              transport: verificationSender.mode,
              delivered: delivery.delivered,
              ...(delivery.delivered ? {} : { deliveryError: classifyDeliveryError(delivery.error) }),
            });
          }
        } catch (e) {
          nestedLog.warn('verification email issuance failed (signup continues)', {
            userId: user.id,
            message: redact((e as Error).message),
          });
        }
      }
      return res.status(201).json(sessionPayload(user, token));
    } catch (err: any) {
      nestedLog.error('account signup failed', { message: redact(err.message) });
      return res.status(500).json({ error: 'Failed to create account.' });
    }
  }));

  app.post('/api/account/login', asyncRoute(async (req, res) => {
    try {
const result = await accounts.login(req.body ?? {});
      if (!result.ok || !result.user) {
        // A FAILED sign-in is recorded with no user, no email and no request
        // metadata: the caller is unauthenticated, so the submitted address and
        // device are untrusted input and are not persisted.
        try {
      await loginActivity.record({
        userId: '',
        method: 'ACCOUNT_LOGIN',
        outcome: 'FAILURE',
        failureCode: result.code ?? 'INVALID_CREDENTIALS',
      });
        } catch (e) {
          nestedLog.warn('failed-login record error', { message: redact((e as Error).message) });
        }
        // Unverified accounts are told so with a distinct status + code so the
        // UI can route them to the verification screen without treating it as a
        // credential error. No token is ever issued on this path — the session
        // remains unauthenticated until the email is proven.
        const status = result.code === 'EMAIL_NOT_VERIFIED' ? 403 : 401;
        return res.status(status).json({ error: result.error, code: result.code ?? 'INVALID_CREDENTIALS' });
      }
      const token = issueToken();
      await accounts.addToken(result.user.id, hashToken(token));
      try {
    await loginActivity.record({
      userId: result.user.id,
      email: result.user.email ?? undefined,
      method: 'ACCOUNT_LOGIN',
      outcome: 'SUCCESS',
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });
      } catch (e) {
        nestedLog.warn('login activity record failed', { message: redact((e as Error).message) });
      }
      return res.json(sessionPayload(result.user, token));
    } catch (err: any) {
      nestedLog.error('account login failed', { message: redact(err.message) });
      return res.status(500).json({ error: 'Failed to sign in.' });
    }
  }));

  // Logout: revoke the presented token server-side (the client also clears its
  // stored token). Revocation is immediate — the token cannot be reused, and
  // the revocation is awaited so the 200 genuinely means "this token is dead"
  // rather than "we accepted a request to delete it".
  app.post('/api/account/logout', auth(), asyncRoute(async (req, res) => {
    try {
      const user = res.locals.user;
      const raw = extractToken(req);
      if (user && raw && isValidTokenShape(raw)) {
        await accounts.revokeToken(user.id, hashToken(raw));
      }
      return res.json({ ok: true });
    } catch (err: any) {
      nestedLog.error('account logout failed', { message: redact(err.message) });
      return res.status(500).json({ error: 'Failed to sign out.' });
    }
  }));

  // Consensus base URL for verification links: the request's own origin wins
  // (so a Preview app links back to exactly the host the user is on, and
  // render.com's x-forwarded-proto keeps the scheme https), else the loopback
  // default the built-in static client targets.
  function appBaseUrlForRequest(req: express.Request): string {
    const proto =
      (String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || req.protocol || 'http').replace(/[^a-zA-Z0-9+.]/g, '') || 'http';
    const host = String(req.headers.host || 'localhost:3000').trim();
    return `${proto}://${host}`;
  }

  function escapeHtml(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // A tiny inline page for the email link destination — no SPA route exists and
  // the bare JSON body would look broken in a browser tab.
  function renderVerificationPage(res: express.Response, ok: boolean, message: string): void {
    const color = ok ? '#059669' : '#b91c1c';
    res.status(200).send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Email verification — Odia SRT</title></head>' +
        '<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;height:100vh;display:flex;align-items:center;justify-content:center">' +
        `<div style="max-width:420px;padding:32px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center">` +
        `<div style="font-size:40px;margin-bottom:12px">${ok ? '✅' : '⚠️'}</div>` +
        `<h1 style="font-size:20px;margin:0 0 8px;color:${color}">${escapeHtml(message)}</h1>` +
        ok
          ? '<p style="color:#6b7280;font-size:14px;line-height:1.5">You can now close this tab and sign in to continue transcribing.</p>'
          : '<p style="color:#6b7280;font-size:14px;line-height:1.5">Check your inbox for a fresh verification link, or request a new one from the app.</p>' +
            '<p style="margin:24px 0 0"><a href="/" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Go to Odia SRT</a></p>' +
        '</div></body></html>'
    );
  }

  // EMAIL OWNERSHIP VERIFICATION — link consumption.
  // Content-negotiated: the browser sees a small inline page, API/tests get JSON.
  // The token is single-use: consuming it ALSO marks the account verified, and
  // every state where the presented link is not the live, unexpired match
  // renders the same neutral "invalid or expired" outcome.
  app.get('/api/auth/verify-email', asyncRoute(async (req, res) => {
    const raw = typeof req.query.token === 'string' ? req.query.token : '';
    const acceptsJson = req.accepts(['json', 'html']) === 'json';
    const finish = (ok: boolean, message: string, status: number): void => {
      if (acceptsJson) return void res.status(status).json({ ok, message, status });
      renderVerificationPage(res, ok, message);
    };
    try {
      if (!raw) return finish(false, 'That verification link is missing or invalid. It may have expired or already been used.', 404);
      const tokenHash = hashVerificationToken(raw);
      const user = await accounts.getByEmailVerificationTokenHash(tokenHash);
      if (!user || !isVerificationTokenValid(user, tokenHash)) {
        return finish(false, 'That verification link is invalid or has expired.', 404);
      }
      await accounts.markEmailVerified(user.id);
      try {
        await loginActivity.record({
          userId: user.id,
          email: user.email ?? undefined,
          method: 'EMAIL_VERIFY',
          outcome: 'SUCCESS',
          ip: req.ip,
          userAgent: String(req.headers['user-agent'] ?? ''),
        });
      } catch (e) {
        nestedLog.warn('verify login-activity record failed', { message: redact((e as Error).message) });
      }
      return finish(true, 'Your email has been verified. You can now sign in and continue transcribing.', 200);
    } catch (err: any) {
      nestedLog.error('email verification failed', { message: redact(err.message) });
      return finish(false, 'Something went wrong while verifying your email. Please try again.', 500);
    }
  }));

  // EMAIL OWNERSHIP VERIFICATION — resend.
  // 202 for known and unknown addresses alike (no address enumeration), 429 on
  // the per-account cooldown or the per-address/IP throttle.
  //
  // OBSERVABILITY (production requirement): before this instrumentation every
  // pre-send gate answered SILENTLY — cooldown/rate-limit 429s and neutral
  // 202s produced no log line at all, so a click that never reached the email
  // sender was indistinguishable from one that did. Now:
  //   1. one "request received" line proves the route was reached,
  //   2. one "decision" line states WHICH gate answered (never the address),
  //   3. "token issued" / "send attempt" (with the selected transport) /
  //      "email sent" (with the result) bracket the delivery itself.
  // Safe fields only: no email address, no raw or hashed token, no password,
  // no session token, no API key.
  const NEUTRAL_VERIFICATION_NOTICE =
    'If this address has an account that still needs verification, a fresh link has been sent to it. Check your inbox now.';
  app.post('/api/account/resend-verification', asyncRoute(async (req, res) => {
    try {
      // Header presence ONLY — the token value is never read or logged here.
      nestedLog.info('resend verification request received', {
        authenticated: Boolean(req.headers.authorization),
        hasEmail: Boolean(req.body?.email),
      });
      const raw = normalizeAccountEmail(req.body?.email);
      if (!raw || !isValidAccountEmail(raw)) {
        nestedLog.info('resend verification decision', { outcome: 'invalid_email', status: 400 });
        return res.status(400).json({ error: 'A valid email address is required.', code: 'VALIDATION' });
      }
      if (!resendRateLimiter.isAllowed(`${raw}:${req.ip || ''}`)) {
        nestedLog.info('resend verification decision', { outcome: 'rate_limited', status: 429, ip: req.ip });
        return res.status(429).json({ error: 'Too many requests. Please wait before trying again.', code: 'RATE_LIMITED' });
      }
      const user = await accounts.getByEmail(raw);
      if (!user || !user.email) {
        // Indistinguishable from a real send: the address is not learnable here.
        nestedLog.info('resend verification decision', { outcome: 'unknown_account', knownAccount: false, status: 202 });
        return res.status(202).json({ ok: true, message: NEUTRAL_VERIFICATION_NOTICE });
      }
      if (isEmailVerified(user)) {
        nestedLog.info('resend verification decision', {
          outcome: 'already_verified',
          knownAccount: true,
          userId: user.id,
          status: 202,
        });
        return res.status(202).json({ ok: true, message: 'This email is already verified — you can sign in now.' });
      }
      const cooldownMs = resendCooldownRemainingMs(user);
      if (cooldownMs > 0) {
        nestedLog.info('resend verification decision', {
          outcome: 'cooldown',
          knownAccount: true,
          userId: user.id,
          cooldownMs,
          status: 429,
        });
        return res.status(429).json({
          error: 'A verification link was sent recently. Please wait before requesting another verification email.',
          code: 'RESEND_COOLDOWN',
          retryAfterMs: cooldownMs,
        });
      }
      const rawToken = await accounts.issueVerification(user.id);
      if (!rawToken) {
        // Still a neutral 202 (a 500 here would leak account existence), but
        // NOW an error line names the userId so the failure is visible.
        nestedLog.error('resend verification token issuance failed', { userId: user.id });
        nestedLog.info('resend verification decision', {
          outcome: 'token_issue_failed',
          knownAccount: true,
          userId: user.id,
          status: 202,
        });
        return res.status(202).json({ ok: true, message: NEUTRAL_VERIFICATION_NOTICE });
      }
      nestedLog.info('resend verification token issued', { userId: user.id });
      const baseUrl = appBaseUrlForRequest(req);
      const { message } = verificationEmailFor(user.email, rawToken, { requestBaseUrl: baseUrl });
      // Sender selected (resend|log) + the attempt itself — emitted BEFORE the
      // transport call so a hanging/failed send still leaves a trace.
      nestedLog.info('resend verification send attempt', { userId: user.id, transport: verificationSender.mode });
      const delivery = await verificationSender.sender(message);
      nestedLog.info('resend verification email sent', {
        userId: user.id,
        transport: verificationSender.mode,
        delivered: delivery.delivered,
        ...(delivery.delivered ? {} : { deliveryError: classifyDeliveryError(delivery.error) }),
      });
      return res.status(202).json({ ok: true, message: NEUTRAL_VERIFICATION_NOTICE });
    } catch (err: any) {
      nestedLog.error('resend verification failed', { message: redact(err.message) });
      return res.status(500).json({ error: 'Failed to send the verification email.' });
    }
  }));

  // Upload -> validate -> charge credits server-side -> enqueue (async worker).
  // No long audio is transcribed inside this request.
  // The middleware chain is kept on one line and UNCHANGED: `auth()` must run
  // before `upload.single()` (an unauthenticated caller must never get a file
  // buffered to disk), and a route-registration guard asserts that literal
  // ordering. Only the handler itself gained the asyncRoute() wrapper.
  app.post('/api/jobs', auth(), requireEmailVerified(), upload.single('mediaFile'), asyncRoute(async (req, res) => {
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
const active = await jobs.countActiveForUser(user.id);
      assertWithinActiveJobLimit(active);

        // Provider safety gate: while the LOCALLY STORED state is BLOCKED (a
        // reliable 402 / insufficient-quota report, or the operator
        // kill-switch), NO new provider job is ever created — before charging or
        // enqueueing anything. Applies to every caller, including
        // ADMIN/UNLIMITED. There is no auto-recharge, no retry and no fallback.
        if (providerSafety.isBlocked()) {
          return res.status(503).json({
            error: PROVIDER_UNAVAILABLE_MESSAGE,
            code: 'PROVIDER_UNAVAILABLE',
            providerSafety: {
              status: providerSafety.view().status,
              reason: providerSafety.view().reason,
            },
          });
        }

        const jobId = newId();
        const buffer = file.buffer;
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        // Charge BEFORE enqueueing; chargeJob is idempotent per jobId, so a
        // client retry can never double-charge.
        const charged = await credits.chargeJob({
          userId: user.id,
          jobId,
          amount: config.creditsPerJob,
          reason: 'charge_transcription',
        });
        const storageKey = uploadKey(jobId, file.mimetype || 'audio/wav');
        try {
          await storage.put(storageKey, buffer);
        } catch (putErr) {
          await credits.refundFinishedJob(user.id, jobId, 'refund_storage_failure');
          throw putErr;
        }

const now = new Date().toISOString();
      await jobs.create({
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
const job = (await jobs.getForUser(jobId, user.id)) as JobRecord;
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
        if (err instanceof ProviderSpendingError) {
          return res.status(503).json({ error: err.message, code: err.code });
        }
        nestedLog.error('job enqueue failed', { message: redact(err.message) });
        return res.status(500).json({ error: 'Failed to enqueue job.' });
      }
    })
  );

  // List own jobs (ownership-filtered), optional ?status= filter.
  app.get('/api/jobs', auth(), asyncRoute(async (req, res) => {
    const user = res.locals.user;
    const statusParam = String(req.query.status || '').trim().toUpperCase();
    const status = isJobStatus(statusParam) ? statusParam : undefined;
    const list = (await jobs.listForUser(user.id, status)).map(publicJob);
    res.json({ jobs: list });
  }));

  // Own-job detail (ownership-checked; 404 for other users' jobs).
  app.get('/api/jobs/:id', auth(), asyncRoute(async (req, res) => {
    const user = res.locals.user;
    const job = await jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job: publicJob(job) });
  }));

  // Stream own completed SRT (ownership-checked).
  app.get('/api/jobs/:id/srt', auth(), asyncRoute(async (req, res) => {
    const user = res.locals.user;
    const job = await jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status !== 'COMPLETED' || !job.output) {
      return res.status(409).json({ error: `SRT is not ready yet (job status: ${job.status}).` });
    }
    const fileName = safeOriginalName(job.input.originalName).replace(/\.[^.]+$/, '') + '.srt';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(job.output.rawSrt);
  }));

  // Cancel an unstarted/running own job (refunds the charge).
  app.post('/api/jobs/:id/cancel', auth(), asyncRoute(async (req, res) => {
    const user = res.locals.user;
    const job = await jobs.getForUser(req.params.id, user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
      return res.status(409).json({ error: `Job cannot be cancelled (status: ${job.status}).` });
    }
    await jobs.update(job.id, { status: 'CANCELLED', completedAt: new Date().toISOString() });
    await credits.refundFinishedJob(user.id, job.id, 'refund_cancelled_job');
    nestedLog.info('job cancelled', { jobId: job.id, userId: user.id });
    const updated = (await jobs.getForUser(job.id, user.id)) as JobRecord;
    res.json({ job: publicJob(updated) });
  }));

  // Own credit balance + ledger (server-authoritative; never client values).
  app.get('/api/credits/me', auth(), asyncRoute(async (req, res) => {
    const user = res.locals.user;
    // Provider-aware read: on the libSQL provider the balance lives in the row
    // and `users.getById` cannot work, so the wallet a signed-in customer sees
    // must come through the facade or it silently reads as zero.
    const fresh = await accounts.getById(user.id);
    res.json({
      userId: user.id,
      credits: fresh?.credits ?? 0,
      role: fresh?.role ?? 'USER',
      creditMode: fresh?.creditMode ?? 'NORMAL',
      unlimited: (fresh?.creditMode ?? 'NORMAL') === 'UNLIMITED',
      transactions: await credits.getTransactions(user.id, 25),
      provider: getAsrProviderName(),
    });
  }));

  // Credit PACK CATALOG (public). These are PRODUCT DEFINITIONS ONLY: there is
  // no payment gateway yet, so every pack is a placeholder ("Coming Soon" in the
  // UI) and no transaction can actually create credits. Prices are display-only.
  app.get('/api/credits/packs', (_req, res) => {
    res.json({ packs: CREDIT_PLANS });
  });

  // ----------------------------------------------------
  // CREDIT PURCHASE — Razorpay integration (server-verified)
  // Test mode by default; requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
  // RAZORPAY_WEBHOOK_SECRET in .env. Returns 503 if not configured.
  // ---------------------------------------------------------------------------

  // Create a Razorpay order for a credit purchase.
  // Client provides ONLY the plan ID; server resolves amount/credits from locked plans.
  app.post('/api/credits/purchase/order', auth(), async (req, res) => {
    if (!razorpayEnabled || !razorpay) {
      return res.status(503).json({
        error: 'Payment system is not configured. Please contact the operator.',
        code: 'PAYMENT_UNAVAILABLE',
      });
    }
    const user = res.locals.user;
    const planId = String(req.body?.planId ?? '').trim();
    if (!planId) {
      return res.status(400).json({ error: 'Plan ID is required.', code: 'MISSING_PLAN' });
    }
    const plan = getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan ID.', code: 'INVALID_PLAN' });
    }

    try {
      const result = await createRazorpayOrder(razorpay!, {
        userId: user.id,
        planId: plan.id,
        userEmail: user.email,
        receiptPrefix: 'credits',
      });
      // Return only safe data needed for frontend checkout
      res.json({
        orderId: result.orderId,
        amount: result.amount, // in paise
        currency: result.currency,
        keyId: razorpayConfig!.keyId,
        plan: {
          id: result.plan.id,
          name: result.plan.name,
          credits: result.plan.credits,
          priceInr: result.plan.priceInr,
        },
      });
    } catch (err) {
      nestedLog.error('razorpay order creation failed', { message: String(err) });
      return res.status(500).json({ error: 'Failed to create payment order.', code: 'ORDER_FAILED' });
    }
  });

  // Verify payment after Razorpay checkout redirect / callback.
  // Client sends orderId, paymentId, signature from Razorpay checkout.
  // Server verifies signature with Razorpay secret before crediting.
  app.post('/api/credits/purchase/verify', auth(), asyncRoute(async (req, res) => {
    if (!razorpayEnabled || !razorpay) {
      return res.status(503).json({ error: 'Payment system is not configured.', code: 'PAYMENT_UNAVAILABLE' });
    }
    const user = res.locals.user;
    const { orderId, paymentId, signature, planId } = req.body ?? {};
    if (!orderId || !paymentId || !signature || !planId) {
      return res.status(400).json({ error: 'Missing required fields.', code: 'MISSING_FIELDS' });
    }
    const plan = getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan ID.', code: 'INVALID_PLAN' });
    }

    // Verify Razorpay payment signature
    const isValid = verifyPaymentSignature(razorpayConfig!.keySecret, orderId, paymentId, signature);
    if (!isValid) {
      nestedLog.warn('razorpay signature verification failed', { userId: user.id, orderId, paymentId });
      return res.status(400).json({ error: 'Invalid payment signature.', code: 'INVALID_SIGNATURE' });
    }

    // Fetch payment details from Razorpay to confirm amount/currency/status
    let paymentDetails;
    try {
      paymentDetails = await razorpay!.payments.fetch(paymentId);
    } catch (err) {
      nestedLog.error('razorpay fetch payment failed', { paymentId, message: String(err) });
      return res.status(500).json({ error: 'Failed to verify payment.', code: 'VERIFY_FAILED' });
    }

    // Verify the payment belongs to the expected order and plan
    if (paymentDetails.order_id !== orderId) {
      return res.status(400).json({ error: 'Order mismatch.', code: 'ORDER_MISMATCH' });
    }
    if (paymentDetails.status !== 'captured') {
      return res.status(400).json({ error: `Payment not captured (status: ${paymentDetails.status}).`, code: 'PAYMENT_NOT_CAPTURED' });
    }
    if (paymentDetails.amount !== plan.priceInr * 100) {
      return res.status(400).json({ error: 'Amount mismatch.', code: 'AMOUNT_MISMATCH' });
    }
    if (paymentDetails.currency !== 'INR') {
      return res.status(400).json({ error: 'Currency mismatch.', code: 'CURRENCY_MISMATCH' });
    }

    // PAYER BINDING: the payment must belong to the CALLING session. The payer
    // is recorded in the order notes when the server creates the order
    // (razorpayService.createRazorpayOrder), so the order — not the client —
    // decides who may claim it. Payment notes are accepted as a fallback.
    // Fail-closed: an unidentifiable payer is rejected, and the response never
    // echoes whose account the payment actually belongs to.
    let payerUserId: string;
    try {
      const orderDetails = await razorpay!.orders.fetch(orderId);
      const orderNotes = orderDetails.notes ?? {};
      const paymentNotes = (paymentDetails as { notes?: Record<string, unknown> }).notes ?? {};
      payerUserId = String(orderNotes.userId ?? paymentNotes.userId ?? '');
    } catch (err) {
      nestedLog.error('razorpay fetch order failed', { userId: user.id, orderId, message: String(err) });
      return res.status(500).json({ error: 'Failed to verify payment.', code: 'VERIFY_FAILED' });
    }
    if (payerUserId !== user.id) {
      nestedLog.warn('razorpay verify: payer mismatch', { userId: user.id, orderId });
      return res.status(403).json({
        error: 'This payment belongs to a different account.',
        code: 'PAYER_MISMATCH',
      });
    }

    // Use the credit service's recordPurchase method (handles idempotency, ledger, etc.)
    const result = await credits.recordPurchase({
      userId: user.id,
      planId: plan.id,
      paymentId,
      orderId,
      amountInr: plan.priceInr,
      currency: 'INR',
      planName: plan.name,
      email: user.email,
    });

    res.json({
      success: true,
      transaction: result.transaction,
      credits: result.credits,
      alreadyProcessed: result.alreadyProcessed,
    });
  }));

  // Razorpay webhook endpoint — receives payment.captured, payment.failed, etc.
  // Verifies webhook signature against the EXACT raw request bytes (captured by
  // the express.json verify hook above; a route-level express.raw parser would
  // be skipped because the global parser has already consumed the body).
  app.post('/api/credits/purchase/webhook', asyncRoute(async (req, res) => {
    if (!razorpayEnabled || !razorpay) {
      return res.status(503).json({ error: 'Payment system not configured.' });
    }

    const signature = req.headers['x-razorpay-signature'] as string;
    if (!signature) {
      nestedLog.warn('razorpay webhook missing signature');
      return res.status(400).json({ error: 'Missing signature.' });
    }

    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      nestedLog.warn('razorpay webhook missing raw request body');
      return res.status(400).json({ error: 'Missing request body.' });
    }
    if (!verifyWebhookSignature(razorpayConfig!.webhookSecret, rawBody, signature)) {
      nestedLog.warn('razorpay webhook signature verification failed');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    const payment = parseWebhookPayload(payload);
    if (!payment) {
      // Not a payment event we care about (e.g., order.paid, refund.processed)
      return res.json({ received: true });
    }

    // Only process successful captures
    if (payment.status !== 'captured') {
      nestedLog.info('razorpay webhook: non-captured payment', { status: payment.status, paymentId: payment.paymentId });
      return res.json({ received: true });
    }

    // Verify the user exists
    const user = await accounts.getById(payment.userId);
    if (!user) {
      nestedLog.warn('razorpay webhook: unknown user', { userId: payment.userId });
      return res.json({ received: true, error: 'Unknown user' });
    }

    const plan = getPlanById(payment.planId);
    if (!plan) {
      nestedLog.warn('razorpay webhook: invalid plan', { planId: payment.planId });
      return res.json({ received: true, error: 'Invalid plan' });
    }

    // Verify amount matches
    if (payment.amount !== plan.priceInr) {
      nestedLog.warn('razorpay webhook: amount mismatch', { expected: plan.priceInr, got: payment.amount });
      return res.json({ received: true, error: 'Amount mismatch' });
    }

    // Use the credit service's recordPurchase method (handles idempotency, ledger, etc.)
    // Idempotency is enforced inside the transaction via paymentId for both providers.
    const result = await credits.recordPurchase({
      userId: payment.userId,
      planId: payment.planId,
      paymentId: payment.paymentId,
      orderId: payment.orderId,
      amountInr: payment.amount,
      currency: payment.currency,
      planName: plan.name,
      email: payment.email,
    });

    nestedLog.info('razorpay webhook: credits added', {
      userId: payment.userId,
      paymentId: payment.paymentId,
      credits: plan.credits,
      alreadyProcessed: result.alreadyProcessed,
    });

    res.json({ received: true, creditsAdded: plan.credits, alreadyProcessed: result.alreadyProcessed });
  }));

  // ---------------------------------------------------------------------------
  // COMMUNITY & SUPPORT (additive).
  //
  // Every moderation decision is made HERE, on the server. The client sends
  // text (and optionally a file) and can never declare a verdict, a
  // restriction, a start time, an expiry or a remaining duration — those are
  // ignored/unrepresentable by construction. A restricted user is refused here
  // even if they bypass or spoof the UI entirely.
  // ---------------------------------------------------------------------------

  const SUPPORT_CATEGORIES: SupportCategory[] = [
    'TRANSCRIPTION',
    'TIMING',
    'TAGGING',
    'SRT',
    'CREDITS',
    'LOGIN',
    'OTHER',
  ];

  /** Display labels for the UI (the wire format stays the stable enum value). */
  const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
    TRANSCRIPTION: 'Transcription',
    TIMING: 'Timing',
    TAGGING: 'Tagging',
    SRT: 'SRT',
    CREDITS: 'Credits',
    LOGIN: 'Login',
    OTHER: 'Other',
  };

  /** Public, read-only guidance + support categories. Contains no user data. */
  app.get('/api/community/guidelines', (_req, res) => {
    res.json({
      guidelines: COMMUNITY_GUIDELINES,
      categories: SUPPORT_CATEGORIES,
      categoryLabels: SUPPORT_CATEGORY_LABELS,
      attachmentMaxBytes: COMMUNITY_ATTACHMENT_MAX_BYTES,
      attachmentAccept: 'image/*, video/*, audio/*',
      telegram: TELEGRAM_MODERATION_NOTE,
    });
  });

  /** The signed-in user's own restriction state (server-computed). */
  app.get('/api/community/status', auth(), (req, res) => {
    const user = res.locals.user;
    res.json({ userId: user.id, ...moderation.statusFor(user.id) });
  });

  /**
   * Submit a community post or a support request.
   *   POST /api/community/messages    kind=COMMUNITY|SUPPORT
   *   POST /api/community/reports     kind=REPORT (a moderated problem report)
   */
  const submitCommunityMessage = (req: express.Request, res: express.Response) => {
    const user = res.locals.user;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) {
      return res.status(400).json({ error: 'A message is required.', code: 'EMPTY_MESSAGE' });
    }
    if (body.length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters).', code: 'MESSAGE_TOO_LONG' });
    }

    // Optional attachment: a user may send a screenshot / screen recording /
    // audio clip with a support request. Only image|video|audio MIME types and
    // only under the community cap are accepted (separate from the ASR policy).
    let attachment: { name: string; mime: string; bytes: number; key: string } | undefined;
    const file = (req.file ?? undefined) as Express.Multer.File | undefined;
    if (file) {
      if (file.size > COMMUNITY_ATTACHMENT_MAX_BYTES) {
        return res.status(413).json({
          error: 'Attachment is too large.',
          code: 'ATTACHMENT_TOO_LARGE',
        });
      }
      const mime = String(file.mimetype || '').toLowerCase();
      if (!COMMUNITY_ATTACHMENT_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
        return res.status(415).json({
          error: 'Attachment must be an image, video or audio file.',
          code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
        });
      }
      attachment = {
        name: safeOriginalName(file.originalname || 'attachment'),
        mime,
        bytes: file.size,
        key: `${user.id}/${newId()}${extensionForMime(mime)}`,
      };
    }

    const requestedCategory = typeof req.body?.category === 'string' ? req.body.category : undefined;
    const category =
      requestedCategory && (SUPPORT_CATEGORIES as string[]).includes(requestedCategory)
        ? (requestedCategory as SupportCategory)
        : undefined;

    // The kind comes from the ROUTE, never from the body, so a user cannot
    // submit a "community post" through the support endpoint or vice versa.
    const kind: 'COMMUNITY' | 'SUPPORT' | 'REPORT' = (res.locals.communityKind ?? 'COMMUNITY') as
      | 'COMMUNITY'
      | 'SUPPORT'
      | 'REPORT';
    const storeKind: 'COMMUNITY' | 'SUPPORT' = kind === 'COMMUNITY' ? 'COMMUNITY' : 'SUPPORT';

    // Store the attachment bytes BEFORE moderation so a flagged-but-reviewed
    // report keeps its evidence. Storage is private to the server.
    const attachPromise = attachment && file
      ? communityAttachments.put(attachment.key, file.buffer)
      : Promise.resolve();

    attachPromise
      .then(() => {
        const result = moderation.reviewSubmission({
          userId: user.id,
          kind: storeKind,
          body,
          category,
          attachment,
        });
        res.status(result.status).json({
          outcome: result.outcome,
          message: result.message,
          accepted: result.accepted,
          messageId: result.messageId,
          restriction: result.restriction,
          case: result.case
            ? {
                id: result.case.id,
                action: result.case.action,
                category: result.case.category,
                createdAt: result.case.createdAt,
              }
            : undefined,
        });
      })
      .catch((err) => {
        nestedLog.error('community submission failed', { error: String(err) });
        res.status(500).json({ error: 'Could not save the submission. Please try again.', code: 'SAVE_FAILED' });
      });
  };

  app.post('/api/community/messages', auth(), communityUpload.single('attachment'), (req, res) => {
    res.locals.communityKind = 'COMMUNITY';
    submitCommunityMessage(req, res);
  });

  app.post('/api/community/reports', auth(), communityUpload.single('attachment'), (req, res) => {
    res.locals.communityKind = 'REPORT';
    submitCommunityMessage(req, res);
  });

  app.post('/api/community/support', auth(), communityUpload.single('attachment'), (req, res) => {
    res.locals.communityKind = 'SUPPORT';
    submitCommunityMessage(req, res);
  });

  // ---------------------------------------------------------------------------
  // ADMIN API — server-side owner verification.
  //
  // Two independent checks, both AFTER bearer-token authentication:
  //   1. the session's stored role is ADMIN (only ever assigned server-side when
  //      the admin bootstrap secret was presented), and
  //   2. the session's stored ownerEmail is still on the SERVER-SIDE allowlist
  //      (OWNER_EMAILS, default: the two product-owner addresses).
  // A browser-supplied email/role in any request body or header is ignored, so a
  // normal user can never reach a credit, balance, trial or history mutation.
  // ---------------------------------------------------------------------------
  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = res.locals.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHENTICATED' });
    }
    if (user.role !== 'ADMIN' || !isVerifiedOwner(user)) {
      nestedLog.warn('admin request refused', { userId: user.id, hasOwnerEmail: Boolean(user.ownerEmail) });
      return res.status(403).json({
        error: 'Forbidden: a verified owner account is required for admin access.',
        code: 'FORBIDDEN',
      });
    }
    next();
  };

  // Public projection for admin listings (never token hashes, never secrets).
  /**
   * Async because the lifetime credit aggregates are credit-ledger reads, which are
   * async on the libSQL provider. Returning a Promise keeps ONE implementation
   * that is correct for both providers.
   */
  async function adminUserView(userId: string) {
    const u = await accounts.getById(userId);
    if (!u) return null;
    return {
      id: u.id,
      role: u.role,
      creditMode: u.creditMode,
      unlimited: u.creditMode === 'UNLIMITED',
      credits: u.credits,
      purchasedCredits: u.purchasedCredits ?? 0,
      bonusCredits: u.bonusCredits ?? 0,
      totalGranted: await credits.sumGrants(userId),
      totalUsed: await credits.sumUsed(userId),
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt ?? null,
      // Only verified owner accounts carry an email; it is shown to admins so an
      // owner can find their own account. It is never a search key for others.
      ownerEmail: u.ownerEmail ?? null,
      // Normal (email/password) account email + last login, shown to admins
      // through the protected admin area only.
      email: u.email ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
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
  // `?q=` searches by user id or by a verified owner email (server-side match).
  app.get('/api/admin/users', auth(), requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const list = query
      ? await accounts.searchUsers(query, limit)
      : (await accounts.listUsers()).slice(0, limit);
    const views = await Promise.all(list.map((u) => adminUserView(u.id)));
    res.json({ users: views, query });
  }));

  // Single user detail incl. recent ledger (admin dashboard).
  app.get('/api/admin/users/:id', auth(), requireAdmin, asyncRoute(async (req, res) => {
    const view = await adminUserView(req.params.id);
    if (!view) return res.status(404).json({ error: 'User not found.' });
    const transactions = await credits.getTransactions(req.params.id, 50);
    res.json({ user: view, transactions });
  }));

  // All transactions across users (admin Transaction History).
  app.get('/api/admin/transactions', auth(), requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    let list = await credits.getAllTransactions(limit);
    if (userId) list = list.filter((t) => t.userId === userId);
    res.json({ transactions: list });
  }));


  // ---------------------------------------------------- monthly login activity

  // Month-wise login analytics for the admin dashboard. `?month=YYYY-MM`
  // defaults to the current IST month; `?q=` searches id/email/date; the table
  // is paginated, but the numbers always describe the WHOLE month.
  app.get('/api/admin/login-activity', auth(), requireAdmin, asyncRoute(async (req, res) => {
    try {
      const month = resolveMonth(req.query.month);
      const result = await loginActivity.queryMonth({
        month,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
      });
      res.json({ ...result, availableMonths: await loginActivity.availableMonths() });
    } catch (err) {
      nestedLog.error('admin login activity failed', { err: String(err) });
      res.status(500).json({ error: 'LOGIN_ACTIVITY_FAILED' });
    }
  }));

  // The daily "yesterday's logins" alert log, newest first.
  app.get('/api/admin/login-alerts', auth(), requireAdmin, asyncRoute(async (_req, res) => {
    try {
      res.json({ alerts: await loginActivityStore.listAlerts(60) });
    } catch (err) {
      nestedLog.error('admin login alerts failed', { err: String(err) });
      res.status(500).json({ error: 'LOGIN_ALERTS_FAILED' });
    }
  }));

  // Manual trigger for the same idempotent job the scheduler runs. Used by the
  // admin button and by ops; re-running for an already-reported day is a no-op
  // because the report is gated by the persisted atomic claim.
  app.post('/api/admin/login-alerts/run', auth(), requireAdmin, asyncRoute(async (_req, res) => {
    try {
      const { alert, duplicate } = await runDailyLoginAlert(loginActivity, loginActivityStore, {});
      res.json({ alert, duplicate });
    } catch (err) {
      nestedLog.error('manual login alert failed', { err: String(err) });
      res.status(500).json({ error: 'LOGIN_ALERT_FAILED' });
    }
  }));


  // All jobs across users (admin Jobs dashboard).
  app.get('/api/admin/jobs', auth(), requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    let list = await jobs.listAll(limit);
    if (userId) list = list.filter((j) => j.userId === userId);
    res.json({ jobs: list.map(adminJobView) });
  }));

  /**
   * CANONICAL manual credit adjustment.
   *
   * Always records ONE ledger entry of type ADMIN_ADJUSTMENT (never PURCHASE,
   * because no payment was taken) containing: amount added, balance before,
   * balance after, the acting admin (id + server-verified email), the mandatory
   * reason, the timestamp and the transaction id. Idempotent via
   * idempotencyKey. The admin's email is taken from res.locals (their own
   * verified account), never from the request body.
   */
  const applyAdminAdjustment = asyncRoute(async (req: express.Request, res: express.Response) => {
    const admin = res.locals.user;
    try {
      const result = await credits.adminAdjustCredits({
        adminUserId: admin.id,
        adminEmail: admin.ownerEmail,
        userId: String(req.body?.userId || ''),
        amount: Number(req.body?.amount),
        reason: String(req.body?.reason || ''),
        idempotencyKey: req.body?.idempotencyKey,
      });
      nestedLog.info('admin credit adjustment applied', {
        adminUserId: admin.id,
        adminEmail: admin.ownerEmail,
        targetUserId: result.transaction.userId,
        amount: result.transaction.amount,
        balanceBefore: result.transaction.balanceBefore,
        balanceAfter: result.transaction.balanceAfter,
        type: result.transaction.type,
      });
      res.json({
        transaction: result.transaction,
        applied: result.applied,
        user: await adminUserView(result.transaction.userId),
      });
    } catch (err: any) {
      if (err instanceof CreditError) {
        return res.status(err.code === 'NO_USER' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      nestedLog.error('admin credit adjustment failed', { message: redact(err.message) });
      res.status(500).json({ error: 'Failed to apply the credit adjustment.' });
    }
  });

  app.post('/api/admin/credits/adjust', auth(), requireAdmin, applyAdminAdjustment);

  // Legacy alias: still a manual adjustment, so it also records ADMIN_ADJUSTMENT.
  app.post('/api/admin/credits/grant', auth(), requireAdmin, applyAdminAdjustment);

  // Admin credit debit (idempotent via idempotencyKey; reason mandatory; never negative).
  app.post('/api/admin/credits/debit', auth(), requireAdmin, asyncRoute(async (req, res) => {
    try {
      const result = await credits.adminDebitCredits({
        adminUserId: res.locals.user.id,
        adminEmail: res.locals.user.ownerEmail,
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
  }));

  // Provider safety state: status, reason, timestamps, last error, balance
  // honesty flag. Read-only; includes the local state-change history.
  app.get('/api/admin/provider/safety', auth(), requireAdmin, (_req, res) => {
    res.json({ providerSafety: providerSafety.view() });
  });

  /**
   * Manual operator reset to AVAILABLE. The ONLY way out of BLOCKED, and the
   * documented workflow: the operator adds credits to the provider account
   * FIRST, then resets here. This endpoint never charges anything, never calls
   * the provider and never touches user credit balances — it only re-opens the
   * gate, with the acting admin's email recorded in the audit trail.
   */
  app.post('/api/admin/provider/safety/reset', auth(), requireAdmin, (req, res) => {
    const admin = res.locals.user;
    const view = providerSafety.resetToAvailable(admin.ownerEmail as string);
    nestedLog.warn('provider safety reset to AVAILABLE by admin', {
      adminUserId: admin.id,
      adminEmail: admin.ownerEmail,
      previousStatus: view.history[0]?.from ?? view.status,
    });
    res.json({ providerSafety: view });
  });

  // Recent owner alerts (recorded locally; no delivery channel is configured).
  app.get('/api/admin/alerts', auth(), requireAdmin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    res.json({
      alerts: notifier.recent(limit),
      // Explicitly reported so the UI never implies a working WhatsApp link.
      delivery: {
        transports: notifier.transportNames(),
        connected: notifier.transportNames().length > 0,
        note:
          notifier.transportNames().length === 0
            ? 'No notification channel is configured. Alerts are recorded locally only (WhatsApp is NOT connected).'
            : null,
      },
    });
  });

  /**
   * Admin-only moderation view. Requires a verified owner account exactly like
   * every other admin route (auth() + requireAdmin).
   */
  app.get('/api/admin/moderation', auth(), requireAdmin, asyncRoute(async (_req, res) => {
    const now = Date.now();
    // User lookups go through the async account facade: `users.getById` is a
    // synchronous repository read that cannot work on the libSQL provider, so
    // every email/ownerEmail in this view used to be a hard 500 in production.
    const decorate = async <T extends { userId: string }>(rows: T[]) =>
      Promise.all(
        rows.map(async (row) => {
          const u = await accounts.getById(row.userId);
          return { row, email: u?.email ?? null, ownerEmail: u?.ownerEmail ?? null };
        })
      );
    const restrictions = await decorate(moderationRepo.activeRestrictions(now));
    const cases = await decorate(moderationRepo.listCases(200));
    res.json({
      activeRestrictions: restrictions.map(({ row: r, email, ownerEmail }) => ({
        userId: r.userId,
        email,
        ownerEmail,
        startedAt: r.startedAt,
        expiresAt: r.expiresAt,
        extendedCount: r.extendedCount,
        automatic: r.automatic,
      })),
      cases: cases.map(({ row: c, email, ownerEmail }) => ({
        id: c.id,
        userId: c.userId,
        email,
        ownerEmail,
        category: c.category,
        action: c.action,
        confidence: c.confidence,
        automatic: c.automatic,
        createdAt: c.createdAt,
        reason: c.reason,
        excerpt: c.excerpt,
        adminNote: c.adminNote ?? null,
        reviewedAt: c.reviewedAt ?? null,
        restrictionStartedAt: c.restrictionStartedAt ?? null,
        restrictionExpiresAt: c.restrictionExpiresAt ?? null,
      })),
      messages: moderationRepo.listMessages(200).map((m) => ({
        id: m.id,
        userId: m.userId,
        kind: m.kind,
        category: m.category ?? null,
        body: m.body,
        accepted: m.accepted,
        createdAt: m.createdAt,
        attachmentName: m.attachmentName ?? null,
        attachmentMime: m.attachmentMime ?? null,
        attachmentBytes: m.attachmentBytes ?? null,
        attachmentKey: m.attachmentKey ?? null,
      })),
      telegram: TELEGRAM_MODERATION_NOTE,
    });
  }));

  /** Mark a moderation case reviewed. */
  app.post('/api/admin/moderation/cases/:id/review', auth(), requireAdmin, (req, res) => {
    const user = res.locals.user;
    const out = moderation.reviewCase({
      caseId: req.params.id,
      adminUserId: user.id,
      adminEmail: user.email ?? user.ownerEmail,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined,
    });
    if (!out.ok) return res.status(404).json({ error: out.reason, code: 'NOT_FOUND' });
    res.json({ ok: true, case: out.case });
  });

  /** Manually extend an active restriction (server-bounded duration). */
  app.post('/api/admin/moderation/restrictions/extend', auth(), requireAdmin, (req, res) => {
    const user = res.locals.user;
    const targetId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (!targetId) {
      return res.status(400).json({ error: 'userId is required.', code: 'MISSING_USER_ID' });
    }
    const out = moderation.extendRestriction({
      userId: targetId,
      additionalMs: Number(req.body?.additionalMs ?? Number(req.body?.additionalHours ?? 0) * 3600_000),
      adminUserId: user.id,
      adminEmail: user.email ?? user.ownerEmail,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined,
    });
    if (!out.ok) {
      return res.status(out.reason?.includes('positive') ? 400 : 404).json({
        error: out.reason,
        code: 'EXTEND_FAILED',
      });
    }
    res.json({ ok: true, restriction: out.restriction, case: out.case });
  });

  /** Release a restriction early. */
  app.post('/api/admin/moderation/restrictions/release', auth(), requireAdmin, (req, res) => {
    const user = res.locals.user;
    const targetId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    if (!targetId) {
      return res.status(400).json({ error: 'userId is required.', code: 'MISSING_USER_ID' });
    }
    const out = moderation.releaseRestriction({
      userId: targetId,
      adminUserId: user.id,
      adminEmail: user.email ?? user.ownerEmail,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined,
    });
    if (!out.ok) return res.status(404).json({ error: out.reason, code: 'RELEASE_FAILED' });
    res.json({ ok: true, restriction: out.restriction, case: out.case });
  });

  /**
   * Private, admin-authenticated attachment retrieval. Attachments are never
   * publicly addressable: no user can read another user's screenshot.
   */
  app.get('/api/admin/moderation/attachments/:userId/*key', auth(), requireAdmin, async (req, res) => {
    const { userId } = req.params;
    const rawKey = Array.isArray(req.params.key) ? req.params.key.join('/') : String(req.params.key);
    // The key is looked up against stored records, never trusted from the URL.
    const record = moderationRepo.messageByAttachmentKey(userId, rawKey);
    if (!record?.attachmentKey) {
      return res.status(404).json({ error: 'Attachment not found.', code: 'NOT_FOUND' });
    }
    const bytes = await communityAttachments.get(record.attachmentKey).catch(() => null);
    if (!bytes) return res.status(404).json({ error: 'Attachment not found.', code: 'NOT_FOUND' });
    res.setHeader('Content-Type', record.attachmentMime ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${record.attachmentName ?? 'attachment'}"`.replace(/"/g, '')
    );
    res.send(bytes);
  });

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // CANONICAL PRODUCTION ROUTES
  //
  //   /            -> the new multilingual Odia SRT application
  //   /admin[/...] -> the secure Admin Dashboard ONLY
  //   anything else-> 404, so no stale/legacy URL can ever render a surface
  //
  // The shared resolver lives in src/routeTarget.ts and is imported by the
  // client entry too, so the server and the browser can never disagree about
  // which surface a URL shows.
  // ---------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    const indexHtml = path.join(distPath, 'index.html');

    // Explicit 404 for known legacy paths — MUST run before static middleware
    // to prevent express.static from serving index.html for these paths.
    app.get('/legacy', (_req, res) => {
      res.status(404).type('text/plain').send('404 Not Found');
    });
    app.get('/old-ui', (_req, res) => {
      res.status(404).type('text/plain').send('404 Not Found');
    });

    // Hashed build assets are safe to cache forever; everything that can change
    // which app you get is revalidated every time. This is what stops a browser
    // from pinning an old UI shell after a redeploy.
    app.use(
      express.static(distPath, {
        index: false,
        etag: true,
        caseSensitive: true,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          }
        },
      }),
    );

    const sendShell = (req: express.Request, res: express.Response) => {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(indexHtml);
    };

    // A dedicated case-sensitive router: Express matches routes
    // case-insensitively by default, which would let `/Admin` serve the admin
    // shell and put the server out of step with the client resolver.
    const uiRouter = express.Router({ caseSensitive: true });

    // `/admin` must never be indexed or prefetched as the transcription app.
    const sendAdminShell = (req: express.Request, res: express.Response) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      sendShell(req, res);
    };
    uiRouter.get('/admin', sendAdminShell);
    uiRouter.get('/admin/*', sendAdminShell);
    uiRouter.get('/', sendShell);
    uiRouter.get('/index.html', sendShell);
    app.use(uiRouter);

    // Everything else is a hard 404. Previously `app.get('*')` returned
    // index.html for every path, which is how a legacy URL could end up
    // displaying the transcription UI.
    app.use((req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.status(404).type('text/plain').send('404 Not Found');
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

  // ---------------------------------------------------------------------
  // STARTUP GUARDS
  //
  // These exist because a stale copy of this project (a non-git export in the
  // Downloads folder) had silently taken port 3000, and the browser kept
  // showing that old build while this server refused to start. Failing loudly
  // and early is the only reliable fix.
  // ---------------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(process.cwd(), 'dist');
    const indexHtml = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      console.error(
        `[Server] REFUSING TO START: no production build at ${indexHtml}.\n` +
          `        Build from the current Git HEAD first:  npm run build`,
      );
      process.exit(1);
    }

    // Refuse to serve a dist/ that predates the current Git HEAD, so an old
    // build folder can never be mistaken for the current application.
    try {
      const head = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      const headDate = new Date(
        execSync('git show -s --format=%cI HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim(),
      );
      const builtAt = fs.statSync(indexHtml).mtime;
      if (head && !Number.isNaN(headDate.getTime()) && builtAt.getTime() < headDate.getTime()) {
        const msg =
          `[Server] REFUSING TO START: dist/ is older than the current Git HEAD.\n` +
          `        HEAD   : ${head} (${headDate.toISOString()})\n` +
          `        built  : ${builtAt.toISOString()}\n` +
          `        Rebuild:  npm run build      (or set ALLOW_STALE_DIST=1 to override)`;
        if (process.env.ALLOW_STALE_DIST === '1') {
          console.warn(`[Server] WARNING: ${msg}`);
        } else {
          console.error(msg);
          process.exit(1);
        }
      } else {
        console.log(`[Server] production build matches Git HEAD ${head || '(unknown)'}`);
      }
    } catch {
      console.warn('[Server] could not verify dist/ against Git HEAD (not a git checkout?)');
    }
  }

  // LOCAL SUBMISSION MODE startup banner. This is deliberately loud: the mode
  // exists only for a temporary academic submission, and it must be impossible
  // to forget that it is switched on after the deadline.
  if (isLocalSubmissionModeEnabled()) {
    console.warn(
      '\n' +
        '='.repeat(72) +
        '\n' +
        '  LOCAL SUBMISSION MODE IS ON\n' +
        '  Transcription will run a LOCAL open-source Odia ASR\n' +
        '  (ai4bharat/indicwav2vec-odia, CPU) instead of Sarvam.\n' +
        '  No paid/cloud ASR API will be called.\n' +
        '  TO RESTORE PRODUCTION: set LOCAL_SUBMISSION_MODE=false (or delete the\n' +
        '  line from .env) and restart. See the LOCAL_SUBMISSION_MODE_BASELINE git\n' +
        '  tag to remove the code entirely.\n' +
        '='.repeat(72) +
        '\n'
    );
  }

  // Initialization is complete: /api/health now falls through to its real
  // handler, and the background work that used to run inside the listen
  // callback runs here because the port is now bound at the top of startServer.
  bootReady = true;

  if (config.enableJobQueue) {
    queue.rehydrate();
    queue.start();
    nestedLog.info('job queue worker started', { provider: getAsrProviderName() });
  } else {
    nestedLog.warn('job queue disabled (ENABLE_JOB_QUEUE=false) job endpoints will not process work');
  }

  // Build Telegram transport if configured (reads from .env at startup).
  const telegramConfig = readTelegramConfig();
  const transports: Record<string, LoginAlertTransport> = {};
  if (telegramConfig) {
    const tg = createTelegramTransport(telegramConfig);
    if (tg) transports.telegram = toLoginAlertTransport(tg);
  }

  // Daily "yesterday's login activity" alert, shortly after IST midnight.
  //
  // This is the SAME single in-process 60s tick as before - not a second
  // scheduler. What changed is the idempotency: instead of reading a guard
  // that could never see a stored row (and therefore re-sent on every tick),
  // the send is gated by a PERSISTED ATOMIC claim in Turso. Restarts,
  // redeploys and multiple instances can no longer produce a second message
  // for an IST date that has already been reported.
  startDailyLoginAlertSchedulerAsync(loginActivity, loginActivityStore, {
    transports,
    onError: (e) => nestedLog.warn('daily login alert tick failed', { message: redact(String(e)) }),
  });
}

// ODIA_SKIP_SERVER=1 lets tests/scripts import the pipeline functions
// (buildMax3WordSegments, applyAudioAnalysisTags) without binding the port.
if (process.env.ODIA_SKIP_SERVER !== '1') {
  startServer().catch((err) => {
    console.error('[Server] FATAL: startup failed before the app was ready.', err);
    process.exit(1);
  });
}
