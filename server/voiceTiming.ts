import type { SubtitleSegment } from '../src/types';
import { formatSrtTimestamp } from '../src/utils/srtRules';
import {
  parseWav,
  convertToWav,
  detectSpeechRegions,
  type SpeechRegion,
} from './audioAnalysis';

const MIN_RETAINED_SECONDS = 0.06;
const EDGE_TOLERANCE_SECONDS = 0.001;

const SPOKEN_CLASSIFICATIONS = new Set<string>([
  'CLEAR_SPEECH',
  'SPEECH_WITH_MUSIC',
  'SPEECH_WITH_NOISE',
  'FILLER',
  'LAUGH',
  'UNINTELLIGIBLE_SPEECH',
]);

export async function computeSpeechRegions(
  audioBuffer: Buffer,
  mimeType: string
): Promise<SpeechRegion[]> {
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
  return parsed && parsed.duration > 0
    ? detectSpeechRegions(parsed.mono, parsed.sampleRate)
    : [];
}

export function alignSegmentsToSpeechRegions(
  segments: SubtitleSegment[],
  speechRegions: SpeechRegion[]
): SubtitleSegment[] {
  if (segments.length === 0) return [];

  const speech = speechRegions
    .filter((r) => r.type === 'speech')
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (speech.length === 0) return segments.map((s) => ({ ...s }));

  const sorted = [...segments].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds
  );

  const alignedCues: SubtitleSegment[] = [];
  for (let idx = 0; idx < sorted.length; idx++) {
    const seg = sorted[idx];
    const spansSpeech =
      seg.text.trim().length > 0 && SPOKEN_CLASSIFICATIONS.has(seg.classification);
    if (!spansSpeech) {
      alignedCues.push({ ...seg });
      continue;
    }

    const overlaps = speech.filter(
      (r) =>
        r.start < seg.endSeconds + EDGE_TOLERANCE_SECONDS &&
        r.end > seg.startSeconds - EDGE_TOLERANCE_SECONDS
    );
    if (overlaps.length === 0) {
      alignedCues.push({ ...seg });
      continue;
    }

    let regionStart = overlaps[0].start;
    let regionEnd = overlaps[overlaps.length - 1].end;
    for (const r of overlaps) {
      if (r.start < regionStart) regionStart = r.start;
      if (r.end > regionEnd) regionEnd = r.end;
    }

    const prevEnd = idx > 0 ? alignedCues[idx - 1].endSeconds : 0;
    const nextStart = idx < sorted.length - 1 ? sorted[idx + 1].startSeconds : Infinity;

    const newStart = Math.max(regionStart, prevEnd);
    const newEnd = Math.min(regionEnd, nextStart);

    const changed =
      Math.abs(newStart - seg.startSeconds) > EDGE_TOLERANCE_SECONDS ||
      Math.abs(newEnd - seg.endSeconds) > EDGE_TOLERANCE_SECONDS;

    if (!changed || newEnd - newStart < MIN_RETAINED_SECONDS) {
      alignedCues.push({ ...seg });
      continue;
    }

    const startSeconds = Number(newStart.toFixed(3));
    const endSeconds = Number(newEnd.toFixed(3));
    alignedCues.push({
      ...seg,
      startSeconds,
      endSeconds,
      startTimeFormatted: formatSrtTimestamp(startSeconds),
      endTimeFormatted: formatSrtTimestamp(endSeconds),
    });
  }
  return alignedCues;
}