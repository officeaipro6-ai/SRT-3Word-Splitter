import { AudioClassification, SubtitleSegment, TranscriptionStats } from '../types';

/**
 * Format seconds into standard SRT timestamp: "00:00:02,514"
 */
export function formatSrtTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalMs = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  const pad = (n: number, z: number = 2) => String(n).padStart(z, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

/**
 * Parse SRT timestamp "00:00:02,514" or "00:00:02.514" into seconds
 */
export function parseSrtTimestamp(timestamp: string): number {
  if (!timestamp) return 0;
  const cleaned = timestamp.trim().replace('.', ',');
  const parts = cleaned.split(':');
  if (parts.length < 2) return 0;

  let hrs = 0;
  let mins = 0;
  let secMs = '0,000';

  if (parts.length === 3) {
    hrs = parseInt(parts[0], 10) || 0;
    mins = parseInt(parts[1], 10) || 0;
    secMs = parts[2];
  } else if (parts.length === 2) {
    mins = parseInt(parts[0], 10) || 0;
    secMs = parts[1];
  }

  const [secsPart, msPart] = secMs.split(',');
  const secs = parseInt(secsPart, 10) || 0;
  const ms = parseInt(msPart ? msPart.padEnd(3, '0').slice(0, 3) : '0', 10) || 0;

  return hrs * 3600 + mins * 60 + secs + ms / 1000;
}

/**
 * Count actual words in subtitle text, ignoring XML-style tags (<NOISE>, <FIL>, <SIL>, <MB>)
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const clean = text.replace(/<[^>]+>/g, ' ').trim();
  if (!clean) return 0;
  return clean.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Extract clean words from text without XML tags
 */
export function extractWords(text: string): string[] {
  if (!text) return [];
  const clean = text.replace(/<[^>]+>/g, ' ').trim();
  if (!clean) return [];
  return clean.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Apply the Strict Tagging Rules with EXACT tag formats:
 *
 * <NOISE></NOISE>                       -> background noise/music, NO human speech
 * <NOISE>actual spoken words</NOISE>    -> background noise/music AND speech
 * <FIL>filler words</FIL>               -> vocal filler / laugh
 * <SIL></SIL>                           -> complete silence >= 1.00s
 *
 * RULE A: CLEAR_SPEECH       -> Unchanged text (no tags)
 * RULE B: SPEECH + NOISE     -> <NOISE>spoken text</NOISE>
 * RULE C: MUSIC/NOISE ONLY   -> <NOISE></NOISE>
 * RULE D: FILLER / LAUGH     -> <FIL>...</FIL> (no minimum duration)
 * RULE E: COMPLETE SILENCE   -> >= 2.00s: <SIL></SIL>. < 2.00s: ignored.
 * RULE F: UNINTELLIGIBLE / MUSIC-MASKED SPEECH -> plain transcript text.
 *         <MB></MB> output is DISABLED: no <MB> tags are ever generated, and
 *         previously MB-classified cues output their actual existing text as
 *         plain text (never inventing missing words).
 */
export function applyTaggingRule(
  text: string,
  classification: AudioClassification,
  durationSeconds: number
): { taggedText: string; isValidSilence: boolean; classification: AudioClassification } {
  const rawText = (text || '').trim();

  switch (classification) {
    case 'CLEAR_SPEECH':
      // Rule A: Output speech unchanged. DO NOT add any tag.
      // Strip any XML tags if user edited text
      const cleanClearText = rawText.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ');
      return {
        taggedText: cleanClearText,
        isValidSilence: true,
        classification: 'CLEAR_SPEECH',
      };

    case 'SPEECH_WITH_MUSIC':
      // Rule F: MB tagging is disabled. Output the actual existing transcript
      // text as plain text; never invent missing words, never emit <MB>.
      const cleanMusicText = rawText.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ');
      return {
        taggedText: cleanMusicText,
        isValidSilence: true,
        classification,
      };

    case 'SPEECH_WITH_NOISE':
      // Rule B: Speech is present AND intelligible, but BGM/noise plays
      // underneath it. Preserve the actual spoken words and wrap them in
      // <NOISE>...</NOISE>. Never drop the words, never output plain text, and
      // never replace intelligible speech with <MB>.
      const cleanNoiseText = rawText.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ');
      return {
        taggedText: `<NOISE>${cleanNoiseText}</NOISE>`,
        isValidSilence: true,
        classification,
      };

    case 'MUSIC_ONLY':
    case 'NOISE_ONLY':
      // Rule C: Output exactly <NOISE></NOISE>
      return {
        taggedText: '<NOISE></NOISE>',
        isValidSilence: true,
        classification,
      };

    case 'FILLER':
    case 'LAUGH':
      // Rule D: Wrap filler/laugh inside <FIL>...</FIL>
      // No minimum duration (even 100ms or 2s)
      const cleanFillerText = rawText.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ') || (classification === 'LAUGH' ? 'haha' : 'hmm');
      return {
        taggedText: `<FIL>${cleanFillerText}</FIL>`,
        isValidSilence: true,
        classification,
      };

    case 'UNINTELLIGIBLE_SPEECH':
      // Rule F: MB tagging is disabled. Output the actual existing transcript
      // text as plain text; never invent missing words, never emit <MB>.
      const cleanUnintelligibleText = rawText.replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, ' ');
      return {
        taggedText: cleanUnintelligibleText,
        isValidSilence: true,
        classification,
      };

    case 'SILENCE':
      // Rule E: Only create SILENCE tag when complete silence is >= 1.00 seconds.
      // < 1.00s complete silence = IGNORE
      if (durationSeconds >= 1.00) {
        return {
          taggedText: '<SIL></SIL>',
          isValidSilence: true,
          classification: 'SILENCE',
        };
      } else {
        // Less than 1 second silence -> MUST be ignored according to Rule E
        return {
          taggedText: '[IGNORED_SILENCE_UNDER_1S]',
          isValidSilence: false,
          classification: 'SILENCE',
        };
      }

    default:
      return {
        taggedText: rawText.replace(/<[^>]+>/g, ' ').trim(),
        isValidSilence: true,
        classification: 'CLEAR_SPEECH',
      };
  }
}

/**
 * FROZEN production segmentation constant: the maximum number of SPOKEN words a
 * normal subtitle segment may contain. Word count is the PRIMARY segmentation
 * constraint (duration follows natural speech timing).
 */
export const MAX_SPOKEN_WORDS_PER_SEGMENT = 3;

/**
 * Exact, non-overlapping partition of `words` into consecutive groups of at most
 * `maxWords`.
 *
 * This is the single place subtitle words are grouped, so the guarantees that
 * the frozen rules depend on are enforced here once:
 *   - every input word is emitted EXACTLY ONCE (no loss, no duplication)
 *   - words keep their original order
 *   - no word is ever split down the middle (splitting is on whole array items)
 *   - no word is invented, reordered or rewritten
 *
 * The step size MUST equal the slice width. Using a smaller stride than the
 * slice width re-emits the boundary word in the next chunk, which is how
 * "word X" previously appeared at the end of one segment AND at the start of
 * the next.
 */
export function chunkWordsByCount(
  words: string[],
  maxWords: number = MAX_SPOKEN_WORDS_PER_SEGMENT
): string[][] {
  const limit = Math.max(1, Math.floor(maxWords));
  if (words.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < words.length; i += limit) {
    chunks.push(words.slice(i, i + limit));
  }
  return chunks;
}

/**
 * Group consecutive spoken words into segments of at most `maxWords` words.
 * Honours the requested limit (this function previously discarded `maxWords`
 * and always returned 7-8 word groups).
 */
export function findOptimalNaturalWordChunks(
  words: string[],
  maxWords: number = MAX_SPOKEN_WORDS_PER_SEGMENT
): string[][] {
  return chunkWordsByCount(words, maxWords);
}

/**
 * Split any spoken segment that exceeds `maxWords` spoken words into consecutive
 * parts of at most `maxWords` words.
 *
 * Timing is NOT changed by the frozen rule, so an oversized segment is divided
 * proportionally across its own existing [startSeconds, endSeconds] span: the
 * first part keeps the original start, the last part keeps the original end.
 * No absolute timestamp is ever invented from outside the segment.
 *
 * Tags are re-applied through the exact same `applyTaggingRule` used by
 * `generateSrtContent`, so a `<NOISE>spoken text</NOISE>` segment keeps its
 * tag on every part, and `<SIL></SIL>` / `<FIL>...</FIL>` are never split
 * inside a tag. Non-spoken cues carry no spoken words and are passed through.
 */
export function enforceMaxWordsPerSegment(
  segments: SubtitleSegment[],
  maxWords: number = MAX_SPOKEN_WORDS_PER_SEGMENT
): SubtitleSegment[] {
  const limit = Math.max(1, Math.floor(maxWords));
  const out: SubtitleSegment[] = [];

  for (const seg of segments) {
    const words = extractWords(seg.text || seg.taggedText);
    if (words.length <= limit) {
      out.push(seg);
      continue;
    }

    const span = seg.endSeconds - seg.startSeconds;
    let offset = 0;
    for (const chunk of chunkWordsByCount(words, limit)) {
      const start = Number(
        (seg.startSeconds + (offset / words.length) * span).toFixed(3)
      );
      const end = Number(
        (seg.startSeconds + ((offset + chunk.length) / words.length) * span).toFixed(3)
      );

      const text = chunk.join(' ');
      const { taggedText } = applyTaggingRule(
        text,
        seg.classification,
        end > start ? end - start : 0.001
      );

      out.push({
        ...seg,
        startSeconds: start,
        endSeconds: end > start ? end : start + 0.001,
        text,
        taggedText,
        wordTimings: undefined,
      });

      offset += chunk.length;
    }
  }

  return out.map((seg, idx) => ({
    ...seg,
    id: idx + 1,
    startTimeFormatted: formatSrtTimestamp(seg.startSeconds),
    endTimeFormatted: formatSrtTimestamp(seg.endSeconds),
  }));
}

/**
 * Common Odia clause starters, coordinators, and conjunctions that make natural segment beginnings
 */
const ODIA_CLAUSE_STARTERS = new Set([
  'ଓ', 'ଏବଂ', 'କିନ୍ତୁ', 'କିମ୍ବା', 'ଅଥବା', 'ତଥା', 'କାରଣ', 'ଯେଉଁ', 'ଯଦି', 'ତେବେ', 'ଯେତେବେଳେ',
  'ସେତେବେଳେ', 'କାହିଁକିନା', 'ଅଥଚ', 'ପରନ୍ତୁ', 'ବା', 'ଆଉ', 'ତେଣୁ', 'ଫଳରେ', 'ଯେପରି', 'ଏଣୁ'
]);

/**
 * Common Odia postpositions/particles that naturally attach to the preceding word
 */
const ODIA_ATTACHED_PARTICLES = new Set([
  'ପାଇଁ', 'ଠାରେ', 'ଠାରୁ', 'ମଧ୍ୟ', 'ସହ', 'ସହିତ', 'ଦ୍ୱାରା', 'ପରି', 'ଭଳି', 'ପରେ', 'ପୂର୍ବରୁ',
  'ଯାଏଁ', 'ପର୍ଯ୍ୟନ୍ତ', 'ବାବଦରେ', 'ବିଷୟରେ', 'ତଳେ', 'ଉପରେ', 'ଭିତରେ', 'ବାହାରେ'
]);

/**
 * Clean trailing punctuation from a word to inspect its root
 */
function cleanPunctuation(word: string): { root: string; hasPunctuation: boolean; isStrongBreak: boolean } {
  const match = word.match(/[।,!?;:—\-\."]+$/);
  const root = word.replace(/[।,!?;:—\-\."]+$/, '');
  const hasPunctuation = !!match;
  const isStrongBreak = hasPunctuation && /[।,!?;:]/.test(match ? match[0] : '');
  return { root, hasPunctuation, isStrongBreak };
}

/**
 * Segment chunking entry point.
 *
 * The FROZEN production rule is a maximum of MAX_SPOKEN_WORDS_PER_SEGMENT
 * spoken words per normal segment (2-3 preferred); duration follows natural
 * speech timing. Per-word timings are still honoured when they line up 1:1,
 * but the word-count ceiling is what is actually enforced downstream, so the
 * no-timing fallback partitions by word count instead of guessing durations.
 */
export function findOptimalTimeChunks(
  words: string[],
  wordTimings: Array<{ word: string; startSeconds: number; endSeconds: number }> | undefined,
  minDuration: number = 2.0,
  maxDuration: number = 4.0
): string[][] {
  const n = words.length;
  if (n === 0) return [];
  if (n <= 1) return [words];

  // If we have word timings, use them for timing-based segmentation
  if (wordTimings && wordTimings.length === words.length) {
    return findTimeBasedChunks(words, wordTimings);
  }

  // Fallback: no usable per-word timing, so fall back to the frozen word-count
  // rule rather than inventing duration-based groups.
  return chunkWordsByCount(words, MAX_SPOKEN_WORDS_PER_SEGMENT);
}

/**
 * Time-based chunking using actual word timings.
 * Groups consecutive words into natural speech windows, but the frozen
 * word-count rule stays primary: a chunk never holds more than
 * MAX_SPOKEN_WORDS_PER_SEGMENT spoken words, even when the audio is slow.
 */
function findTimeBasedChunks(
  words: string[],
  wordTimings: Array<{ word: string; startSeconds: number; endSeconds: number }>
): string[][] {
  const n = words.length;
  if (n <= 1) return [words];

  const chunks: string[][] = [];
  let chunkStart = 0;

  for (let i = 0; i < n; i++) {
    const chunkStartTime = wordTimings[chunkStart].startSeconds;
    const chunkDuration = wordTimings[i].endSeconds - chunkStartTime;

    // Cut BEFORE this word when the current window already ran past 4s.
    const wouldExceedMaxDuration = chunkDuration > 4.0;
    const isAtLeastMinDuration = chunkDuration >= 2.0;

    // Natural break points (punctuation, clause boundaries) between words.
    const isNaturalBreak = i < n - 1 && isNaturalBreakPoint(i);
    const isLastWord = i === n - 1;

    // PRIMARY RULE: never let the chunk exceed the spoken-word maximum.
    const chunkWordCount = i - chunkStart + 1;
    const wouldBreakMaxWords =
      chunkWordCount >= MAX_SPOKEN_WORDS_PER_SEGMENT && i > chunkStart;

    const shouldBreak =
      isLastWord ||
      wouldBreakMaxWords ||
      (i > chunkStart && wouldExceedMaxDuration) ||
      (i > chunkStart && isAtLeastMinDuration && isNaturalBreak);

    if (shouldBreak && i > chunkStart) {
      chunks.push(words.slice(chunkStart, i + 1));
      chunkStart = i + 1;
    }
  }

  // Handle any remaining words
  if (chunkStart < n) {
    chunks.push(words.slice(chunkStart));
  }

  return chunks.length > 0 ? chunks : [words];
}

/**
 * Check if position i is a natural break point (punctuation, clause boundary)
 */
function isNaturalBreakPoint(index: number): boolean {
  // This would need access to words array - simplified for now
  // In practice, this checks punctuation, clause boundaries, etc.
  return false; // Simplified - will be enhanced with actual word access
}

/**
 * Split a single subtitle segment that is too long in DURATION.
 *
 * The frozen production rule is a maximum of MAX_SPOKEN_WORDS_PER_SEGMENT
 * spoken words, so the split is always taken at a whole-word boundary and the
 * result never exceeds that word maximum.
 *
 * TIMESTAMP RULE: a split subtitle's START is the first word's start and its
 * END is the last word's end, taken from the segment's own word-level timing
 * data when it is available. If word-level timings are missing or do not match
 * the words 1:1, the EXISTING segment span [startSeconds, endSeconds] is
 * subdivided proportionally across the chunks (the first chunk keeps the
 * original START, the last chunk keeps the original END, and intermediate
 * boundaries are spaced by word share). No absolute timestamp is ever invented
 * from outside the segment.
 */
export function splitSegmentByTimeLimit(
  seg: SubtitleSegment,
  minDuration: number = 2.0,
  maxDuration: number = 4.0
): SubtitleSegment[] {
  // Non-speech / silence / unintelligible: don't split
  if (
    seg.classification === 'MUSIC_ONLY' ||
    seg.classification === 'NOISE_ONLY' ||
    seg.classification === 'SILENCE' ||
    seg.classification === 'UNINTELLIGIBLE_SPEECH'
  ) {
    return [seg];
  }

  const words = extractWords(seg.text || seg.taggedText);

  if (words.length <= 1) {
    const duration = seg.endSeconds - seg.startSeconds;
    const cleanWordText = words.join(' ');

    const { taggedText } = applyTaggingRule(
      cleanWordText || seg.text,
      seg.classification,
      duration
    );

    return [
      {
        ...seg,
        text: cleanWordText || seg.text,
        taggedText,
      },
    ];
  }

  const wordTimings = Array.isArray(seg.wordTimings) ? seg.wordTimings : [];
  // Only trust word-level timings when they align 1:1 with the words AND are
  // all finite (they can go stale after manual text edits). Otherwise the
  // existing span is subdivided instead.
  const hasMatchingWordTimings =
    wordTimings.length === words.length &&
    wordTimings.every((w) => Number.isFinite(w?.startSeconds) && Number.isFinite(w?.endSeconds));

// Split the words at whole-word boundaries (maximum 3 spoken words).
    const chunks = findOptimalTimeChunks(words, wordTimings);

  if (chunks.length === 0) {
    return [seg];
  }

  let wordCursor = 0;

  return chunks.map((chunkWords) => {
    let chunkStart: number;
    let chunkEnd: number;
    let chunkWordTimings:
      | Array<{ word: string; startSeconds: number; endSeconds: number }>
      | undefined;

    if (hasMatchingWordTimings) {
      const firstWordTiming = wordTimings[wordCursor];
      const lastWordIndex = Math.min(
        wordCursor + chunkWords.length - 1,
        wordTimings.length - 1
      );
      const lastWordTiming = wordTimings[lastWordIndex];

      chunkStart = Number(firstWordTiming?.startSeconds) ?? seg.startSeconds;
      chunkEnd = Number(lastWordTiming?.endSeconds) ?? seg.endSeconds;
      chunkWordTimings = wordTimings.slice(wordCursor, wordCursor + chunkWords.length);
    } else {
      // Word-level timings unavailable or stale: subdivide the segment's OWN
      // existing span [startSeconds, endSeconds] proportionally by word share.
      const span = seg.endSeconds - seg.startSeconds;
      const prevWeight = wordCursor / words.length;
      const chunkWeight = (wordCursor + chunkWords.length) / words.length;
      chunkStart = seg.startSeconds + span * prevWeight;
      chunkEnd = seg.startSeconds + span * chunkWeight;
      chunkWordTimings = undefined;
    }

    if (!Number.isFinite(chunkStart) || !Number.isFinite(chunkEnd)) {
      return seg;
    }

    // START = first word's start, END = last word's end (exact word timings),
    // or the subdivided original span when real word timings are unavailable.
    if (chunkEnd <= chunkStart) {
      chunkEnd = chunkStart + 0.001;
    }

    wordCursor += chunkWords.length;

    const chunkText = chunkWords.join(' ');

    const { taggedText } = applyTaggingRule(
      chunkText,
      seg.classification,
      chunkEnd - chunkStart
    );

    return {
      id: seg.id,
      startSeconds: Number(chunkStart.toFixed(3)),
      endSeconds: Number(chunkEnd.toFixed(3)),
      startTimeFormatted: formatSrtTimestamp(chunkStart),
      endTimeFormatted: formatSrtTimestamp(chunkEnd),
      text: chunkText,
      classification: seg.classification,
      taggedText,
      acousticNote: seg.acousticNote,
      confidence: seg.confidence ?? 0.95,
      wordTimings: chunkWordTimings,
    };
  });
}

/**
 * @deprecated Use splitSegmentByTimeLimit instead. Kept for backward compatibility.
 */
export function splitSegmentByWordLimit(
  seg: SubtitleSegment,
  maxWords: number = 3
): SubtitleSegment[] {
  // Delegate to the new time-based function with default 2-4s limits
  return splitSegmentByTimeLimit(seg, 2.0, 4.0);
}

/**
 * Enforces the segment length limits across all segments: splits segments that
 * exceed `maxDuration` in seconds, and merges adjacent same-classification
 * segments shorter than `minDuration` **only when the merged result still
 * respects MAX_SPOKEN_WORDS_PER_SEGMENT spoken words**.
 * Re-indexes all segment IDs sequentially (1, 2, 3...).
 */
export function enforceTimeLimitsPerSegment(
  segments: SubtitleSegment[],
  minDuration: number = 2.0,
  maxDuration: number = 4.0
): SubtitleSegment[] {
  // First pass: split segments that exceed maxDuration
  const splitResult: SubtitleSegment[] = [];
  
  for (const seg of segments) {
    const duration = seg.endSeconds - seg.startSeconds;
    
    if (duration <= maxDuration) {
      splitResult.push(seg);
    } else {
      // Split this segment - it's too long
      const splits = splitSegmentByTimeLimit(seg, 2.0, 4.0);
      splitResult.push(...splits);
    }
  }

  // Second pass: merge adjacent segments that are too short (< 2 seconds)
  // but only if they're the same classification and adjacent
  const merged: SubtitleSegment[] = [];
  for (const seg of splitResult) {
    const duration = seg.endSeconds - seg.startSeconds;
    
    if (duration < 2.0 && merged.length > 0) {
      const prev = merged[merged.length - 1];
      // Only merge if same classification and adjacent
      if (
        prev.classification === seg.classification &&
        seg.startSeconds - prev.endSeconds < 0.5 &&
        // The frozen rule caps spoken words per segment at 3, so never merge
        // two short cues into one that would exceed that maximum.
        countWords(prev.text || prev.taggedText) +
          countWords(seg.text || seg.taggedText) <=
          MAX_SPOKEN_WORDS_PER_SEGMENT
      ) {
        // Merge with previous
        merged[merged.length - 1] = {
          ...prev,
          endSeconds: seg.endSeconds,
          endTimeFormatted: formatSrtTimestamp(seg.endSeconds),
          text: prev.text + ' ' + seg.text,
          wordTimings: prev.wordTimings
            ? [...prev.wordTimings, ...(seg.wordTimings || [])]
            : undefined,
        };
        continue;
      }
    }
    merged.push(seg);
  }

  // Re-number sequentially 1, 2, 3...
  return merged.map((seg, idx) => ({
    ...seg,
    id: idx + 1,
    startTimeFormatted: formatSrtTimestamp(seg.startSeconds),
    endTimeFormatted: formatSrtTimestamp(seg.endSeconds),
  }));
}

/**
 * Filter and format segments into a valid standard SRT string.
 * Enforces 2-4 second duration limits per segment.
 * Uses strictly sequential numbering (1, 2, 3...)
 * Ignores silence gaps < 1.00 seconds (changed from 2.00 to 1.00 per new rule).
 */
export function generateSrtContent(segments: SubtitleSegment[]): string {
  // Enforce 2-4 second duration limits per segment
  const timeLimited = enforceTimeLimitsPerSegment(segments, 1.0, 4.0);

  // Word count is the PRIMARY rule, so re-apply it AFTER the time-based split:
  // the time splitter groups words by speech duration and can otherwise leave a
  // cue holding more than the maximum when 1:1 word timings are present.
  const enforcedSegments = enforceMaxWordsPerSegment(timeLimited, MAX_SPOKEN_WORDS_PER_SEGMENT);

  // Filter out silence segments shorter than 1.00s as mandated by Rule E
  const validSegments = enforcedSegments.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      const duration = seg.endSeconds - seg.startSeconds;
      return duration >= 1.00;
    }
    return true;
  });

  return validSegments
    .map((seg, index) => {
      const srtNumber = index + 1; // Strict sequential numbering 1, 2, 3...
      const start = seg.startTimeFormatted || formatSrtTimestamp(seg.startSeconds);
      const end = seg.endTimeFormatted || formatSrtTimestamp(seg.endSeconds);
      
      // Ensure tagged text is properly resolved
      const { taggedText } = applyTaggingRule(seg.text, seg.classification, seg.endSeconds - seg.startSeconds);
      
      return `${srtNumber}\n${start} --> ${end}\n${taggedText}\n`;
    })
    .join('\n');
}

/**
 * Generate WebVTT format with 2-4 second segment timing limits.
 */
export function generateVttContent(segments: SubtitleSegment[]): string {
  const enforcedSegments = enforceMaxWordsPerSegment(
    enforceTimeLimitsPerSegment(segments, 1.0, 4.0),
    MAX_SPOKEN_WORDS_PER_SEGMENT
  );

  const validSegments = enforcedSegments.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      return (seg.endSeconds - seg.startSeconds) >= 1.0;
    }
    return true;
  });

  const header = "WEBVTT\n\n";
  const body = validSegments
    .map((seg, index) => {
      const start = (seg.startTimeFormatted || formatSrtTimestamp(seg.startSeconds)).replace(',', '.');
      const end = (seg.endTimeFormatted || formatSrtTimestamp(seg.endSeconds)).replace(',', '.');
      const { taggedText } = applyTaggingRule(seg.text, seg.classification, seg.endSeconds - seg.startSeconds);
      return `${index + 1}\n${start} --> ${end}\n${taggedText}\n`;
    })
    .join('\n');

  return header + body;
}

/**
 * Generate Plain Text transcript with timestamps (2-4 second segment timing limits)
 */
export function generateTxtContent(segments: SubtitleSegment[]): string {
  const enforcedSegments = enforceTimeLimitsPerSegment(segments, 1.0, 4.0);

  return enforcedSegments
    .map((seg, index) => {
      const start = seg.startTimeFormatted || formatSrtTimestamp(seg.startSeconds);
      const end = seg.endTimeFormatted || formatSrtTimestamp(seg.endSeconds);
      const { taggedText } = applyTaggingRule(seg.text, seg.classification, seg.endSeconds - seg.startSeconds);
      return `[${index + 1}] [${start} - ${end}] [${seg.classification}] ${taggedText}`;
    })
    .join('\n');
}

/**
 * MB tagging is disabled app-wide: applyTaggingRule never returns <MB></MB>,
 * so no cue resolves to the MB marker and exports never contain it. This
 * helper is retained for compatibility and is now a passthrough (it strips any
 * cue whose resolved tag would still be <MB></MB>, which can no longer happen).
 */
export function stripMbCues(segments: SubtitleSegment[]): SubtitleSegment[] {
  return segments.filter((seg) => {
    const { taggedText } = applyTaggingRule(seg.text, seg.classification, seg.endSeconds - seg.startSeconds);
    return taggedText !== '<MB></MB>';
  });
}

/**
 * Compute detailed statistics on the transcription segments
 */
export function calculateTranscriptionStats(segments: SubtitleSegment[]): TranscriptionStats {
  const enforced = enforceTimeLimitsPerSegment(segments, 1.0, 4.0);
  let clearSpeechCount = 0;
  let speechWithMusicNoiseCount = 0;
  let noiseMusicOnlyCount = 0;
  let fillerCount = 0;
  let silenceCount = 0;
  let unintelligibleCount = 0;

  const validSegments = enforced.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      return (seg.endSeconds - seg.startSeconds) >= 1.0;
    }
    return true;
  });

  for (const seg of validSegments) {
    if (seg.classification === 'CLEAR_SPEECH') clearSpeechCount++;
    else if (seg.classification === 'SPEECH_WITH_MUSIC' || seg.classification === 'SPEECH_WITH_NOISE') speechWithMusicNoiseCount++;
    else if (seg.classification === 'MUSIC_ONLY' || seg.classification === 'NOISE_ONLY') noiseMusicOnlyCount++;
    else if (seg.classification === 'FILLER' || seg.classification === 'LAUGH') fillerCount++;
    else if (seg.classification === 'SILENCE') silenceCount++;
    else if (seg.classification === 'UNINTELLIGIBLE_SPEECH') unintelligibleCount++;
  }

  const maxEnd = enforced.reduce((max, s) => Math.max(max, s.endSeconds), 0);

  return {
    totalSegments: validSegments.length,
    clearSpeechCount,
    speechWithMusicNoiseCount,
    noiseMusicOnlyCount,
    fillerCount,
    silenceCount,
    unintelligibleCount,
    totalDurationSeconds: maxEnd,
    totalDurationFormatted: formatSrtTimestamp(maxEnd),
  };
}

/**
 * Validate SRT integrity and Rule compliance, including the frozen maximum of
 * MAX_SPOKEN_WORDS_PER_SEGMENT spoken words per segment.
 */
export function auditRuleCompliance(segments: SubtitleSegment[]): {
  isFullyCompliant: boolean;
  ruleChecks: {
    ruleA: { passed: boolean; count: number; description: string };
    ruleB: { passed: boolean; count: number; description: string };
    ruleC: { passed: boolean; count: number; description: string };
    ruleD: { passed: boolean; count: number; description: string };
    ruleE: { passed: boolean; count: number; description: string; ignoredCount: number };
    ruleMB: { passed: boolean; count: number; description: string };
    timingRule: {
      passed: boolean;
      maxWords: number;
      maxWordsObserved: number;
      nonCompliantCount: number;
      description: string;
    };
  };
  warnings: string[];
} {
  const warnings: string[] = [];
  let ruleACount = 0;
  let ruleBCount = 0;
  let ruleCCount = 0;
  let ruleDCount = 0;
  let ruleECount = 0;
  let ruleMBCount = 0;
  let ignoredSilenceCount = 0;
  let maxWordsObserved = 0;
  let nonCompliantWordLimitCount = 0;

  segments.forEach((seg, idx) => {
    const duration = seg.endSeconds - seg.startSeconds;
    const wordCount = countWords(seg.text || seg.taggedText);
    if (wordCount > maxWordsObserved) {
      maxWordsObserved = wordCount;
    }

    // FROZEN segmentation rule: a normal spoken segment holds at most
    // MAX_SPOKEN_WORDS_PER_SEGMENT spoken words (2-3 preferred). Duration is
    // NOT a rule - natural speech timing is allowed to vary.
    const isSpokenCue =
      seg.classification !== 'SILENCE' &&
      seg.classification !== 'MUSIC_ONLY' &&
      seg.classification !== 'NOISE_ONLY';
    if (isSpokenCue && wordCount > MAX_SPOKEN_WORDS_PER_SEGMENT) {
      nonCompliantWordLimitCount++;
      warnings.push(
        `Segment #${seg.id || idx + 1}: ${wordCount} spoken words exceeds the maximum of ${MAX_SPOKEN_WORDS_PER_SEGMENT} spoken words per segment`
      );
    }
    
    // Check start < end
    if (seg.startSeconds >= seg.endSeconds) {
      warnings.push(`Segment #${seg.id || idx + 1}: Start time (${seg.startTimeFormatted}) must be before end time (${seg.endTimeFormatted})`);
    }

    if (seg.classification === 'CLEAR_SPEECH') {
      ruleACount++;
      if (seg.taggedText.includes('<NOISE>') || seg.taggedText.includes('<SIL>') || seg.taggedText.includes('<FIL>') || seg.taggedText.includes('<MB>')) {
        warnings.push(`Segment #${seg.id || idx + 1}: Clear speech must not have noise, silence, filler, or unintelligible tags`);
      }
    } else if (seg.classification === 'SPEECH_WITH_NOISE') {
      ruleBCount++;
      if (!seg.taggedText.startsWith('<NOISE>') || !seg.taggedText.endsWith('</NOISE>')) {
        warnings.push(`Segment #${seg.id || idx + 1}: Speech with background noise must be enclosed in <NOISE>...</NOISE>`);
      }
    } else if (seg.classification === 'MUSIC_ONLY' || seg.classification === 'NOISE_ONLY') {
      ruleCCount++;
      if (seg.taggedText !== '<NOISE></NOISE>') {
        warnings.push(`Segment #${seg.id || idx + 1}: Music/Noise-only must be exactly <NOISE></NOISE> (no <MUSIC>)`);
      }
    } else if (seg.classification === 'FILLER' || seg.classification === 'LAUGH') {
      ruleDCount++;
      if (!seg.taggedText.includes('<FIL>')) {
        warnings.push(`Segment #${seg.id || idx + 1}: Filler/Laugh must be enclosed in <FIL>...</FIL>`);
      }
    } else if (seg.classification === 'SILENCE') {
      if (duration >= 1.00) {
        ruleECount++;
        if (seg.taggedText !== '<SIL></SIL>') {
          warnings.push(`Segment #${seg.id || idx + 1}: Valid silence (>=1.00s) must be exactly <SIL></SIL>`);
        }
      } else {
        ignoredSilenceCount++;
      }
    } else if (seg.classification === 'UNINTELLIGIBLE_SPEECH' || seg.classification === 'SPEECH_WITH_MUSIC') {
      ruleMBCount++;
      if (seg.taggedText.includes('<MB>') || seg.taggedText.includes('</MB>')) {
        warnings.push(`Segment #${seg.id || idx + 1}: MB tagging is disabled. ${seg.classification === 'SPEECH_WITH_MUSIC' ? 'Speech masked by music' : 'Unintelligible speech'} must output its plain transcript text, never <MB>`);
      }
    }
  });

  return {
    isFullyCompliant: warnings.length === 0,
    ruleChecks: {
      ruleA: {
        passed: true,
        count: ruleACount,
        description: 'Clear speech output unchanged without tags.',
      },
      ruleB: {
        passed: true,
        count: ruleBCount,
        description: 'Speech with background noise wrapped in <NOISE>speech</NOISE>.',
      },
      ruleC: {
        passed: true,
        count: ruleCCount,
        description: 'Music/Noise-only without speech output as <NOISE></NOISE>.',
      },
      ruleD: {
        passed: true,
        count: ruleDCount,
        description: 'Fillers and laughs wrapped in <FIL>...</FIL> (no min duration).',
      },
      ruleE: {
        passed: true,
        count: ruleECount,
        ignoredCount: ignoredSilenceCount,
        description: 'Complete silence >= 1.00s tagged as <SIL></SIL>; < 1.00s ignored.',
      },
      ruleMB: {
        passed: true,
        count: ruleMBCount,
        description: 'Unintelligible or music-masked speech outputs plain transcript text (never invented words, never <MB>).',
      },
      timingRule: {
        passed: nonCompliantWordLimitCount === 0,
        maxWords: MAX_SPOKEN_WORDS_PER_SEGMENT,
        maxWordsObserved,
        nonCompliantCount: nonCompliantWordLimitCount,
        description: `Maximum ${MAX_SPOKEN_WORDS_PER_SEGMENT} spoken words per normal subtitle segment (2-3 words preferred). Duration follows natural speech timing and is not itself a rule.`,
      },
    },
    warnings,
  };
}
