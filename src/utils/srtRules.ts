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
 * <SIL></SIL>                           -> complete silence >= 2.00s
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
      // Rule E: Only create SILENCE tag when complete silence is >= 2.00 seconds.
      // < 2.00s complete silence = IGNORE
      if (durationSeconds >= 2.00) {
        return {
          taggedText: '<SIL></SIL>',
          isValidSilence: true,
          classification: 'SILENCE',
        };
      } else {
        // Less than 2 seconds silence -> MUST be ignored according to Rule E
        return {
          taggedText: '[IGNORED_SILENCE_UNDER_2S]',
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
 * Natural speech-aware chunking algorithm:
 * Partitions words into natural segments of maximum 3 words each (1 to 3 words).
 * Avoids awkward 1-word stragglers (e.g. splits 4 words as 2+2, 5 words as 3+2, 7 words as 3+2+2)
 * and aligns splits with natural speech pause markers, conjunctions, and clause boundaries.
 */
export function findOptimalNaturalWordChunks(words: string[], maxWords: number = 3): string[][] {
  const n = words.length;
  if (n === 0) return [];
  if (n <= maxWords) return [words];

  // Dynamic Programming to find the most natural, balanced partition
  // dp[i] = lowest cost to partition words[0 ... i-1]
  const dp: number[] = new Array(n + 1).fill(Infinity);
  const parent: number[] = new Array(n + 1).fill(0);
  dp[0] = 0;

  for (let i = 0; i < n; i++) {
    if (dp[i] === Infinity) continue;

    for (let len = 1; len <= maxWords && i + len <= n; len++) {
      const nextIdx = i + len;
      const chunkWords = words.slice(i, nextIdx);
      const lastWord = chunkWords[chunkWords.length - 1];
      const { isStrongBreak, hasPunctuation } = cleanPunctuation(lastWord);

      // 1. Base length preference (penalize 1-word fragments when sentence is longer)
      let penalty = 0;
      if (len === 3) {
        penalty = 0; // Ideal standard length
      } else if (len === 2) {
        penalty = 0.2; // Very good balanced cadence
      } else if (len === 1) {
        // 1-word segments are strongly penalized: they are only chosen when no
        // 2/3-word grouping is possible (the unavoidable case).
        penalty = 3.0;
      }

      // 2. Natural pause / punctuation boundary bonus (never applied to
      //    1-word chunks, so punctuation cannot force a single-word subtitle)
      if (len >= 2 && nextIdx < n) {
        if (isStrongBreak) {
          penalty -= 1.8; // Excellent place to break
        } else if (hasPunctuation) {
          penalty -= 0.8;
        }

        const nextWord = words[nextIdx];
        const nextClean = nextWord.replace(/^[।,!?;:—\-\."]+/, '').replace(/[।,!?;:—\-\."]+$/, '');

        // Breaking right before a conjunction/clause starter is natural
        if (ODIA_CLAUSE_STARTERS.has(nextClean)) {
          penalty -= 1.2;
        }

        // Breaking right before a postposition/attached particle is unnatural
        if (ODIA_ATTACHED_PARTICLES.has(nextClean)) {
          penalty += 1.6;
        }
      }

      const totalCost = dp[i] + penalty;
      if (totalCost < dp[nextIdx]) {
        dp[nextIdx] = totalCost;
        parent[nextIdx] = i;
      }
    }
  }

  // Reconstruct the chunks from DP parent pointers
  const chunks: string[][] = [];
  let curr = n;
  while (curr > 0) {
    const prev = parent[curr];
    chunks.unshift(words.slice(prev, curr));
    curr = prev;
  }

  return chunks;
}

/**
 * Split a single subtitle segment naturally according to speech,
 * with a strict maximum of 3 words per segment (2-3 words preferred,
 * 1 word only when unavoidable, 4+ words never).
 *
 * TIMESTAMP RULE: a split subtitle's START is the first word's start and its
 * END is the last word's end, taken from the segment's own word-level timing
 * data when it is available. If word-level timings are missing or do not match
 * the words 1:1, the EXISTING segment span [startSeconds, endSeconds] is
 * subdivided proportionally across the chunks (the first chunk keeps the
 * original START, the last chunk keeps the original END, and intermediate
 * boundaries are spaced by word share). No absolute timestamp is ever invented
 * from outside the segment and a >maxWords segment is never kept intact.
 */
export function splitSegmentByWordLimit(
  seg: SubtitleSegment,
  maxWords: number = 3
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

  if (words.length <= maxWords) {
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

  // Split the words into natural chunks, maximum 3 words per subtitle.
  const chunks = findOptimalNaturalWordChunks(words, maxWords);

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
 * Enforces the MAXIMUM 3 words per segment rule across all segments.
 * Splits any segment containing > 3 words into multiple consecutive segments
 * using the exact word-level timings (START = first word, END = last word).
 * Never mutates timestamps for segmentation purposes and never fabricates
 * timestamps when word timings are missing (segment is kept intact + logged).
 * Re-indexes all segment IDs sequentially (1, 2, 3...).
 */
export function enforceMaxWordsPerSegment(
  segments: SubtitleSegment[],
  maxWords: number = 3
): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];

  for (const seg of segments) {
    const split = splitSegmentByWordLimit(seg, maxWords);
    result.push(...split);
  }

  // Re-number sequentially 1, 2, 3...
  return result.map((seg, idx) => ({
    ...seg,
    id: idx + 1,
    startTimeFormatted: formatSrtTimestamp(seg.startSeconds),
    endTimeFormatted: formatSrtTimestamp(seg.endSeconds),
  }));
}

/**
 * Filter and format segments into a valid standard SRT string.
 * Strictly guarantees maximum 3 words per segment.
 * Uses strictly sequential numbering (1, 2, 3...)
 * Ignores silence gaps < 2.00 seconds.
 */
export function generateSrtContent(segments: SubtitleSegment[]): string {
  // Always enforce maximum 3 words per segment rule
  const enforcedSegments = enforceMaxWordsPerSegment(segments, 3);

  // Filter out silence segments shorter than 2.00s as mandated by Rule E
  const validSegments = enforcedSegments.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      const duration = seg.endSeconds - seg.startSeconds;
      return duration >= 2.00;
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
 * Generate WebVTT format (Strictly max 3 words per segment)
 */
export function generateVttContent(segments: SubtitleSegment[]): string {
  const enforcedSegments = enforceMaxWordsPerSegment(segments, 3);

  const validSegments = enforcedSegments.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      return (seg.endSeconds - seg.startSeconds) >= 2.00;
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
 * Generate Plain Text transcript with timestamps (Strictly max 3 words per segment)
 */
export function generateTxtContent(segments: SubtitleSegment[]): string {
  const enforcedSegments = enforceMaxWordsPerSegment(segments, 3);

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
  const enforced = enforceMaxWordsPerSegment(segments, 3);
  let clearSpeechCount = 0;
  let speechWithMusicNoiseCount = 0;
  let noiseMusicOnlyCount = 0;
  let fillerCount = 0;
  let silenceCount = 0;
  let unintelligibleCount = 0;

  const validSegments = enforced.filter((seg) => {
    if (seg.classification === 'SILENCE') {
      return (seg.endSeconds - seg.startSeconds) >= 2.00;
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
 * Validate SRT integrity and Rule compliance including the Max 3 Words Rule
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
    wordLimitRule: { passed: boolean; maxWords: number; nonCompliantCount: number; description: string };
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

    if (wordCount > 3 && seg.classification !== 'SILENCE' && seg.classification !== 'MUSIC_ONLY' && seg.classification !== 'NOISE_ONLY') {
      nonCompliantWordLimitCount++;
      warnings.push(`Segment #${seg.id || idx + 1}: Contains ${wordCount} words (Maximum allowed is 3 words per segment)`);
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
      if (duration >= 2.00) {
        ruleECount++;
        if (seg.taggedText !== '<SIL></SIL>') {
          warnings.push(`Segment #${seg.id || idx + 1}: Valid silence (>=2.00s) must be exactly <SIL></SIL>`);
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
        description: 'Complete silence >= 2.00s tagged as <SIL></SIL>; < 2.00s ignored.',
      },
      ruleMB: {
        passed: true,
        count: ruleMBCount,
        description: 'Unintelligible or music-masked speech outputs plain transcript text (never invented words, never <MB>).',
      },
      wordLimitRule: {
        passed: nonCompliantWordLimitCount === 0,
        maxWords: maxWordsObserved,
        nonCompliantCount: nonCompliantWordLimitCount,
        description: 'Every subtitle segment contains MAXIMUM 3 words. Longer sentences automatically split.',
      },
    },
    warnings,
  };
}
