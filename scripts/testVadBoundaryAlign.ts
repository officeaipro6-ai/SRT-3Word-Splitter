import { alignSpeechBoundariesToVad } from '../server/geminiOdiaPipeline';
import type { SubtitleSegment } from '../src/types';
import type { SpeechRegion } from '../server/audioAnalysis';

let failed = 0;
function check(name: string, actual: any, expected: any) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `00:0${m}:${String(s.toFixed(3)).padStart(6, '0').replace('.', ',')}`;
};

function seg(id: number, text: string, cls: string, start: number, end: number, wordTimings?: SubtitleSegment['wordTimings']): SubtitleSegment {
  return {
    id,
    startSeconds: start,
    endSeconds: end,
    startTimeFormatted: fmt(start),
    endTimeFormatted: fmt(end),
    text,
    classification: cls as any,
    taggedText: text,
    acousticNote: '',
    confidence: 0.95,
    wordTimings,
  };
}

// Timeline:
//   [0.0, 0.8) NOISE        <- noise cue
//   [0.8, 3.0) SPEECH       <- speech region A (first cue starts early @0.70)
//   [3.0, 4.2) NOISE        <- noise cue
//   [4.2, 7.0) SPEECH       <- speech region B (last cue ends early @6.35, should extend to 7.0)
//   [7.0, 8.5) NOISE
//   [8.5, 12.0) SPEECH      <- region C with TWO cues (only the last may extend)
//   [12.0, 14.0) NOISE
//   [14.0, 16.0) SILENCE (2s)
const regions: SpeechRegion[] = [
  { start: 0.0, end: 0.8, type: 'noise' },
  { start: 0.8, end: 3.0, type: 'speech' },
  { start: 3.0, end: 4.2, type: 'noise' },
  { start: 4.2, end: 7.0, type: 'speech' },
  { start: 7.0, end: 8.5, type: 'noise' },
  { start: 8.5, end: 12.0, type: 'speech' },
  { start: 12.0, end: 14.0, type: 'noise' },
  { start: 14.0, end: 16.0, type: 'silence' },
];

const segments: SubtitleSegment[] = [
  seg(1, '', 'NOISE_ONLY', 0.0, 0.70),                                                          // noise before speech (adjacent to cue 2)
  seg(2, 'ଭକ୍ତି ପ୍ରସନ୍ନ', 'CLEAR_SPEECH', 0.70, 2.20, [{ word: 'ଭକ୍ତି', startSeconds: 0.82, endSeconds: 1.40 }, { word: 'ପ୍ରସନ୍ନ', startSeconds: 1.45, endSeconds: 2.20 }]), // starts inside noise @0.70, speech @0.8
  seg(3, '', 'NOISE_ONLY', 3.00, 4.20),
  seg(4, 'ମନ ହରଣ', 'CLEAR_SPEECH', 4.40, 6.35, [{ word: 'ମନ', startSeconds: 4.40, endSeconds: 5.30 }, { word: 'ହରଣ', startSeconds: 5.40, endSeconds: 6.35 }]), // ends inside speech region B @6.35 -> extend to 7.0
  seg(5, '', 'NOISE_ONLY', 7.00, 8.50),
  seg(6, 'ଗୋଟିଏ କଥା', 'CLEAR_SPEECH', 8.60, 10.0, [{ word: 'ଗୋଟିଏ', startSeconds: 8.60, endSeconds: 9.30 }, { word: 'କଥା', startSeconds: 9.40, endSeconds: 10.0 }]), // first of two in region C
  seg(7, 'ଶୁଣିବା', 'CLEAR_SPEECH', 10.4, 11.5, [{ word: 'ଶୁଣିବା', startSeconds: 10.4, endSeconds: 11.5 }]),                                                // last in region C -> extend to 12.0
  seg(8, '', 'NOISE_ONLY', 12.00, 14.00),
  seg(9, '', 'SILENCE', 14.00, 16.00),
];

const out = alignSpeechBoundariesToVad(segments, regions, 16.0);

const s2 = out.find((s) => s.id === 2)!;
const s1 = out.find((s) => s.id === 1)!;
const s4 = out.find((s) => s.id === 4)!;
const s6 = out.find((s) => s.id === 6)!;
const s7 = out.find((s) => s.id === 7)!;
const s9 = out.find((s) => s.id === 9)!;

// START alignment
check('cue2 start pulled out of noise to 0.80', Math.abs(s2.startSeconds - 0.80) < 1e-6, true);
check('cue2 start never earlier than original', s2.startSeconds >= 0.70, true);
check('preceding noise cue clipped to new speech start', Math.abs(s1.endSeconds - 0.80) < 1e-6, true);

// END alignment (capped at next cue start - 1ms)
check('cue4 end extended toward region end (6.999)', Math.abs(s4.endSeconds - 6.999) < 1e-6, true);
check('cue4 end never earlier than original', s4.endSeconds >= 6.35, true);
check('cue6 (NOT last in region C) not extended', Math.abs(s6.endSeconds - 10.0) < 1e-6, true);
check('cue7 (last in region C) extended (11.999)', Math.abs(s7.endSeconds - 11.999) < 1e-6, true);

// Non-speech / silence untouched
check('noise cue8 untouched', Math.abs(out.find((s) => s.id === 8)!.endSeconds - 14.0) < 1e-6, true);
check('silence cue9 untouched', Math.abs(s9.endSeconds - 16.0) < 1e-6, true);

// Chronological after alignment
const times = out.map((s) => s.startSeconds);
const sorted = times.every((t, i) => i === 0 || t >= times[i - 1]);
check('timestamps remain chronological', sorted, true);

// Monotonicity: no cue moved earlier on start or end
const mono = out.every((s, i) => {
  const orig = segments.find((o) => o.id === s.id)!;
  return s.startSeconds >= orig.startSeconds - 1e-9 && s.endSeconds >= orig.endSeconds - 1e-9;
});
check('no cue moved earlier (start or end)', mono, true);

// Word timings untouched
check('cue2 wordTimings unchanged', JSON.stringify(s2.wordTimings) === JSON.stringify(segments.find((o) => o.id === 2)!.wordTimings), true);
check('cue4 wordTimings unchanged', JSON.stringify(s4.wordTimings) === JSON.stringify(segments.find((o) => o.id === 4)!.wordTimings), true);

// Correct cues that already start inside speech and are not region-final are untouched
const noMovePair = alignSpeechBoundariesToVad([segments[5], segments[6]], regions, 16.0);
check('cue starting inside speech & not region-final unchanged', noMovePair[0].startSeconds === 8.60 && noMovePair[0].endSeconds === 10.0, true);

// Empty regions -> passthrough
const noRegions = alignSpeechBoundariesToVad(segments, [], 16.0);
check('empty regions passthrough (same segment count)', noRegions.length === segments.length, true);

console.log(failed === 0 ? '\nAll VAD boundary alignment tests passed.' : `\n${failed} test(s) FAILED.`);