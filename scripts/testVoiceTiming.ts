/**
 * Voice-aligned timing tests for the isolated post-processing step
 * server/voiceTiming.ts  (alignSegmentsToSpeechRegions + computeSpeechRegions).
 *
 * Verifies the alignment behavior REQUIRED for the real track:
 *   - a spoken cue snaps to the actual voice region (start = first overlapping
 *     voice onset, end = last overlapping voice offset), so the subtitle sits
 *     ONLY over real speech - exactly the reference example 00:00:00,000 -->
 *     00:00:01,206 <NOISE>ଗୋଟିଏ ଗାଁରେ</NOISE> becoming 00:00:00,087 -->
 *     00:00:01,523 <NOISE>ଗୋଟିଏ ଗାଁରେ</NOISE>
 *   - leading silence is trimmed (start moves later), trailing speech keeps the
 *     cue open (end follows the voice), trailing silence is trimmed
 *   - voice+BGM words stay wrapped <NOISE>words</NOISE>, nothing re-invented
 *   - no subtitle is generated for BGM-only regions and their (empty) cues stay
 *     untouched
 *   - contiguous narration keeps inner cues unchanged while outer edges snap to
 *     the voice region
 *   - short/edge cases and the min-duration guard keep valid cues
 *   - cues never overlap neighbors (clamped), never start >= end
 *   - every spoken word is preserved exactly once, max 3 words per cue, tags
 *     and classifications never modified
 *   - formatted timestamps are recomputed from the aligned values
 */
import { formatSrtTimestamp } from '../src/utils/srtRules';
import type { SubtitleSegment } from '../src/types';
import {
  alignSegmentsToSpeechRegions,
  computeSpeechRegions,
} from '../server/voiceTiming';
import { createWavChunk } from '../server/audioAnalysis';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`
  );
}
function checkTrue(name: string, cond: boolean, detail?: string) {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` :: ${detail ?? ''}`}`);
}

function mkSeg(
  id: number,
  start: number,
  end: number,
  text: string,
  classification: SubtitleSegment['classification']
): SubtitleSegment {
  return {
    id,
    startSeconds: start,
    endSeconds: end,
    startTimeFormatted: formatSrtTimestamp(start),
    endTimeFormatted: formatSrtTimestamp(end),
    text,
    taggedText: text,
    classification,
    confidence: 0.95,
  };
}

function align(segs: SubtitleSegment[], regions: Array<{ start: number; end: number; type: string }>) {
  return alignSegmentsToSpeechRegions(segs, regions as any);
}

console.log('===== Voice-aligned subtitle timing =====\n');

// --- 1. User's EXACT real-track example -------------------------------------
// Cue [0.000, 1.206] '<NOISE>ଗୋଟିଏ ଗାଁରେ</NOISE>', voice region [0.087, 1.523].
{
  const input = [mkSeg(1, 0.0, 1.206, 'ଗୋଟିଏ ଗାଁରେ', 'SPEECH_WITH_NOISE')];
  const out = align(input, [
    { start: 0.0, end: 0.087, type: 'noise' },
    { start: 0.087, end: 1.523, type: 'speech' },
    { start: 1.523, end: 2.0, type: 'noise' },
  ]);
  check('1. start snaps to voice onset (leading silence trimmed)', out[0].startSeconds, 0.087);
  check('1. end snaps to voice offset (speech kept open)', out[0].endSeconds, 1.523);
  check('1. formatted start "00:00:00,087"', out[0].startTimeFormatted, '00:00:00,087');
  check('1. formatted end "00:00:01,523"', out[0].endTimeFormatted, '00:00:01,523');
  check('1. words preserved', out[0].text, 'ଗୋଟିଏ ଗାଁରେ');
  check('1. voice+BGM tag preserved', out[0].taggedText, 'ଗୋଟିଏ ଗାଁରେ');
}

// --- 2. Leading AND trailing silence both trimmed ----------------------------
{
  const input = [mkSeg(1, 2.0, 3.4, 'ଖବର ଆସିଛି', 'CLEAR_SPEECH')];
  const out = align(input, [
    { start: 2.0, end: 2.2, type: 'noise' },
    { start: 2.2, end: 3.0, type: 'speech' },
    { start: 3.0, end: 3.4, type: 'noise' },
  ]);
  check('2. start trimmed to voice onset', out[0].startSeconds, 2.2);
  check('2. end trimmed to voice offset', out[0].endSeconds, 3.0);
}

// --- 3. Voice + BGM: words keep the <NOISE> wrapper, span follows voice ------
{
  const input = [mkSeg(1, 4.5, 5.9, 'ସେ ଘରକୁ ଫେରିଲା', 'SPEECH_WITH_NOISE')];
  const out = align(input, [
    { start: 4.0, end: 4.6, type: 'noise' },
    { start: 4.6, end: 6.1, type: 'speech' },
    { start: 6.1, end: 7.0, type: 'noise' },
  ]);
  check('3. alignment still applies over voice+BGM', out[0].startSeconds, 4.6);
  check('3. end follows the voice region', out[0].endSeconds, 6.1);
  check('3. classification kept SPEECH_WITH_NOISE', out[0].classification, 'SPEECH_WITH_NOISE');
  check('3. taggedText preserved', out[0].taggedText, 'ସେ ଘରକୁ ଫେରିଲା');
}

// --- 4. BGM-only region: no spoken cue created, empty cue untouched ----------
{
  const bgm = mkSeg(1, 5.0, 6.0, '', 'NOISE_ONLY');
  const out = align([bgm], [
    { start: 3.0, end: 5.0, type: 'speech' },
    { start: 5.0, end: 6.0, type: 'noise' },
  ]);
  check('4. no cue created for BGM-only region', out.length, 1);
  check('4. empty cue start untouched', out[0].startSeconds, 5.0);
  check('4. empty cue end untouched', out[0].endSeconds, 6.0);
  check('4. empty cue kept no text', out[0].text, '');
}

// --- 5. Contiguous narration: inner cues unchanged, outer edges snap ---------
{
  const input = [
    mkSeg(1, 10.4, 12.0, 'ଏକ ଦୁଇ', 'CLEAR_SPEECH'),
    mkSeg(2, 12.0, 14.2, 'ତିନି ଚାରି ପାଞ୍ଚ', 'CLEAR_SPEECH'),
    mkSeg(3, 14.2, 15.6, 'ଛଅ ସାତ', 'CLEAR_SPEECH'),
  ];
  const out = align(input, [{ start: 10.0, end: 16.0, type: 'speech' }]);
  check('5. first cue start snaps to voice onset', out[0].startSeconds, 10.0);
  check('5. first cue end stays (clamped by next cue)', out[0].endSeconds, 12.0);
  check('5. middle cue start unchanged', out[1].startSeconds, 12.0);
  check('5. middle cue end unchanged', out[1].endSeconds, 14.2);
  check('5. last cue start unchanged', out[2].startSeconds, 14.2);
  check('5. last cue end snaps to voice offset', out[2].endSeconds, 16.0);
}

// --- 6. Min-duration guard: degenerate snap keeps the original cue ----------
{
  const input = [mkSeg(1, 30.0, 30.6, 'ପରେ', 'CLEAR_SPEECH')];
  const out = align(input, [
    { start: 30.0, end: 30.5, type: 'noise' },
    { start: 30.5, end: 30.55, type: 'speech' },
    { start: 30.55, end: 31.0, type: 'noise' },
  ]);
  check('6. too-short overlap keeps original start', out[0].startSeconds, 30.0);
  check('6. too-short overlap keeps original end', out[0].endSeconds, 30.6);
}

// --- 7. Clamped: spoken cue does NOT swallow neighboring BGM/empty cues ------
{
  const prev = mkSeg(1, 39.0, 40.0, '', 'NOISE_ONLY');
  const spoken = mkSeg(2, 40.0, 41.0, 'କଥା', 'SPEECH_WITH_NOISE');
  const next = mkSeg(3, 41.0, 43.0, '', 'MUSIC_ONLY');
  const out = align([prev, spoken, next], [
    { start: 38.0, end: 39.0, type: 'noise' },
    { start: 39.0, end: 42.0, type: 'speech' },
    { start: 42.0, end: 43.0, type: 'noise' },
  ]);
  check('7. spoken cue does not expand over prev empty cue', out[1].startSeconds, 40.0);
  check('7. spoken cue does not expand over next empty cue', out[1].endSeconds, 41.0);
  check('7. prev empty cue untouched', out[0].startSeconds, 39.0);
  check('7. next empty cue untouched', out[2].endSeconds, 43.0);
}

// --- 8. No speech regions at all -> timing untouched -------------------------
{
  const input = [mkSeg(1, 1.0, 2.0, 'ଏବଂ', 'CLEAR_SPEECH')];
  const out = align(input, [{ start: 0.0, end: 3.0, type: 'noise' }]);
  check('8. no speech -> start kept', out[0].startSeconds, 1.0);
  check('8. no speech -> end kept', out[0].endSeconds, 2.0);
}

// --- 9. Empty segments input -> empty output ---------------------------------
{
  check('9. empty input -> empty output', align([], []).length, 0);
}

// --- 10. 1/2/3-word cues preserved; max-3 rule intact -------------------------
{
  const input = [
    mkSeg(1, 20.0, 20.5, 'ହେଁ', 'FILLER'), // 1 word
    mkSeg(2, 21.0, 21.9, 'ସେଠାରେ ଥିଲା', 'CLEAR_SPEECH'), // 2 words
    mkSeg(3, 22.0, 23.4, 'ଘରକୁ ଫେରିବା ପାଇଁ', 'CLEAR_SPEECH'), // 3 words
  ];
  const out = align(input, [
    { start: 20.0, end: 20.6, type: 'speech' },
    { start: 20.6, end: 21.0, type: 'noise' },
    { start: 21.0, end: 23.5, type: 'speech' },
  ]);
  check('10. filler kept 1 word', out[0].text, 'ହେଁ');
  check('10. 2-word cue kept', out[1].text, 'ସେଠାରେ ଥିଲା');
  check('10. 3-word cue kept', out[2].text, 'ଘରକୁ ଫେରିବା ପାଇଁ');
  checkTrue(
    '10. no cue exceeds 3 words',
    out.every((s) => s.text.split(/\s+/).filter(Boolean).length <= 3)
  );
}

// --- 11. No cue overlaps its neighbor after alignment ------------------------
{
  const input = [
    mkSeg(1, 50.0, 51.0, 'ପ୍ରଥମ ବାକ୍ୟ', 'CLEAR_SPEECH'),
    mkSeg(2, 51.0, 52.0, '', 'NOISE_ONLY'),
    mkSeg(3, 52.0, 53.2, 'ଦ୍ୱିତୀୟ ବାକ୍ୟ', 'CLEAR_SPEECH'),
  ];
  const out = align(input, [
    { start: 49.5, end: 51.05, type: 'speech' },
    { start: 51.05, end: 52.0, type: 'noise' },
    { start: 52.0, end: 53.3, type: 'speech' },
  ]);
  let overlap = false;
  for (let i = 1; i < out.length; i++) {
    if (out[i].startSeconds < out[i - 1].endSeconds - 1e-6) overlap = true;
  }
  checkTrue('11. no adjacent cue overlaps', !overlap);
  checkTrue('11. no cue starts >= its end', out.every((s) => s.startSeconds < s.endSeconds));
}

// --- 12. ids preserved AND formatted timestamps recomputed --------------------
{
  const input = [mkSeg(7, 60.0, 61.0, 'ତୁମେ', 'CLEAR_SPEECH')];
  const out = align(input, [{ start: 60.2, end: 60.9, type: 'speech' }]);
  check('12. id preserved', out[0].id, 7);
  check('12. formatted start recomputed', out[0].startTimeFormatted, formatSrtTimestamp(60.2));
  check('12. formatted end recomputed', out[0].endTimeFormatted, formatSrtTimestamp(60.9));
}

// --- 13. End-to-end on real synthetic WAV: spoken cues snap to the voice -----
{
  // Two genuine voice bursts separated by a SUSTAINED noise bridge (> 1.25 s,
  // so VAD keeps them as separate speech regions - like the real track where
  // the music intro is a long bridge, never a sub-1.25s gap that VAD absorbs).
  const sampleRate = 16000;
  const totalSeconds = 8.5;
  const mono = new Float32Array(Math.floor(sampleRate * totalSeconds));
  const fillTone = (amp: number, from: number, to: number) => {
    const start = Math.floor(from * sampleRate);
    const end = Math.min(mono.length, Math.floor(to * sampleRate));
    for (let i = start; i < end; i++) mono[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  };
  const fillSpeech = (amp: number, from: number, to: number) => {
    for (let t = from; t < to; t += 0.2) {
      fillTone(amp, t, Math.min(to, t + 0.15));
      fillTone(0.02, Math.min(to, t + 0.15), Math.min(to, t + 0.2));
    }
  };
  fillTone(0.3, 0, 2); // noise only (intro)
  fillSpeech(0.7, 2, 4); // speech #1
  fillTone(0.3, 4, 5.5); // noise bridge (kept as its own noise region)
  fillSpeech(0.7, 5.5, 7); // speech #2
  const wavBuffer = createWavChunk(mono, sampleRate, 0, mono.length);

  const regions = await computeSpeechRegions(wavBuffer, 'audio/wav');
  const voice = regions.filter((r) => r.type === 'speech');
  checkTrue('13. VAD detects 2 separate voice regions on synthetic audio', voice.length >= 2, JSON.stringify(regions));

  const raw = [
    mkSeg(1, 2.1, 2.6, 'ଏକ ଦୁଇ ତିନି', 'CLEAR_SPEECH'),
    mkSeg(2, 5.9, 6.15, 'ଚାରି ପାଞ୍ଚ', 'CLEAR_SPEECH'),
    mkSeg(3, 6.2, 6.5, 'ଛଅ ସାତ', 'CLEAR_SPEECH'),
  ];
  const out = align(raw, regions);
  const inside = out.map((s) =>
    voice.some((v) => v.start - 0.08 <= s.startSeconds && v.end + 0.08 >= s.endSeconds)
  );
  checkTrue('13. every spoken cue snaps inside a VAD voice region', inside.every(Boolean));
  checkTrue('13. alignment changed at least one boundary', out.some((s, i) => s.startSeconds !== raw[i].startSeconds || s.endSeconds !== raw[i].endSeconds));
  checkTrue('13. words preserved exactly', out.every((s, i) => s.text === raw[i].text));
  checkTrue('13. no adjacent cue overlaps', out.every((s, i) => i === 0 || s.startSeconds >= out[i - 1].endSeconds - 1e-6));
}

console.log(failed === 0 ? '\nAll voice-timing checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);