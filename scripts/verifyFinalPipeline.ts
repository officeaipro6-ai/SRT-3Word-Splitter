/**
 * End-to-end verification of the FINAL Odia SRT pipeline using the REAL
 * production modules:
 *   - server.ts      -> buildMax3WordSegments + applyAudioAnalysisTags
 *   - srtRules.ts    -> generateSrtContent (the EXACT function the UI preview
 *                       AND the Download SRT button both use)
 *
 * A synthetic 16 kHz mono WAV is built in-memory with this timeline:
 *   0.0-2.0   steady tone ONLY (VAD 'noise', no speech)  -> NO subtitle
 *             (standalone BGM-only region: no spoken cue covers it, so the
 *             rev-2 intro split does NOT fire; rule C only splits a spoken
 *             cue's BGM-only intro head)
 *   2.0-3.5   syllabic voice, near-quiet dips (VAD 'speech') -> plain text
 *   3.5-5.5   LOUD steady tone WITH spoken words underneath (VAD 'noise')
 *             -> <NOISE>spoken words</NOISE>
 *   5.5-6.9   syllabic voice, near-quiet dips (VAD 'speech') -> plain text
 *   6.9-11.0  digital silence (4.1s)                     -> NO <SIL> (rule 5)
 *   10.9-13.5 LOW-AMPLITUDE steady tone (0.03, hidden BELOW voiceFloor) +
 *             voice 11.0-12.5. The tone is invisible to the VAD (classified
 *             'speech'), so this exercises the ADDITIVE BGM-under-voice
 *             detector -> <NOISE>spoken words</NOISE>
 *
 * Verifies: every spoken word preserved exactly once; max 3 words per subtitle;
 * word cues over BGM (loud AND hidden-under-voice) -> <NOISE>words</NOISE>;
 * clear speech plain; standalone BGM-only regions (no spoken cue) -> no cue and
 * no <NOISE></NOISE>; NO <SIL> (rule 5); no <MB> (rule 6); no silent/un-
 * intelligible cues generated. The rev-2 intro split (BGM-only head of the
 * first spoken cue -> its own <NOISE></NOISE>) is asserted against the REAL
 * audio in scripts/verifyBgmTagReal.ts.
 */
import { createWavChunk, parseWav, detectSpeechRegions, detectBgmUnderVoiceIntervals } from '../server/audioAnalysis';
import { generateSrtContent } from '../src/utils/srtRules';
import type { SubtitleSegment } from '../src/types';

// Import server.ts without binding the listener (port 3000).
process.env.ODIA_SKIP_SERVER = '1';
const { buildMax3WordSegments, applyAudioAnalysisTags } = await import('../server');

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

// ---- Build the synthetic WAV ------------------------------------------------
const sampleRate = 16000;
const totalSeconds = 13.5;
const mono = new Float32Array(Math.floor(sampleRate * totalSeconds));

function fillTone(amp: number, from: number, to: number) {
  const start = Math.floor(from * sampleRate);
  const end = Math.min(mono.length, Math.floor(to * sampleRate));
  for (let i = start; i < end; i++) {
    mono[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
}
// Superimpose (ADD) a steady tone onto existing samples — used to place low-
// amplitude BGM UNDER the narrator's voice without clobbering the speech.
function fillToneUnder(amp: number, from: number, to: number) {
  const start = Math.floor(from * sampleRate);
  const end = Math.min(mono.length, Math.floor(to * sampleRate));
  for (let i = start; i < end; i++) {
    mono[i] += amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
}
// Syllabic voice: 150ms burst + 50ms NEAR-QUIET dip (0.008) -> high modulation
// (VAD 'speech') WITHOUT an audible backdrop band in the inter-word gaps, so
// the BGM-under-voice detector must NOT flag it.
function fillSpeech(amp: number, from: number, to: number) {
  for (let t = from; t < to; t += 0.2) {
    const burstEnd = Math.min(to, t + 0.15);
    fillTone(amp, t, burstEnd);
    const dipEnd = Math.min(to, t + 0.2);
    fillTone(0.008, burstEnd, dipEnd);
  }
}

fillTone(0.3, 0, 2); // BGM-only (loud) -> no subtitle
fillSpeech(0.7, 2, 3.5); // clear speech #1
fillTone(0.3, 3.5, 5.5); // LOUD noise under spoken words
fillSpeech(0.7, 5.5, 6.9); // clear speech #2
// 6.9-11.0 digital silence (4.1s) -> no <SIL>
fillSpeech(0.7, 11, 12.5); // voice with NEAR-QUIET dips...
fillToneUnder(0.03, 10.9, 13.5); // ...superimposed with HIDDEN BGM below voiceFloor
// (the defect the fix targets: VAD sees the window as 'speech', so the OLD code
//  emitted plain text; the additive detector must now tag it)

const wavBuffer = createWavChunk(mono, sampleRate, 0, mono.length);

const parsed = parseWav(wavBuffer);
checkTrue('WAV parses (duration ~13.5s)', !!parsed && parsed.duration > 13.4, `duration=${parsed?.duration}`);
const regions = parsed ? detectSpeechRegions(parsed.mono, parsed.sampleRate) : [];
console.log(
  '[VAD regions]',
  regions.map((r) => `${r.type}[${r.start.toFixed(2)}-${r.end.toFixed(2)}]`).join(' ')
);
const bgmIntervals = parsed ? detectBgmUnderVoiceIntervals(parsed.mono, parsed.sampleRate) : [];
console.log(
  '[BGM-under-voice intervals]',
  bgmIntervals.map((r) => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(' ') || '(none)'
);
checkTrue('BGM-under-voice detector finds the hidden BGM section (10.9-12.7)',
  bgmIntervals.some((r) => overlap(r, 10.9, 12.7) >= 0.5),
  JSON.stringify(bgmIntervals));
checkTrue('BGM-under-voice detector does NOT flag clear speech (2-3.5 / 5.5-6.9)',
  !bgmIntervals.some((r) => overlap(r, 2, 3.5) >= 0.5) &&
    !bgmIntervals.some((r) => overlap(r, 5.5, 6.9) >= 0.5),
  JSON.stringify(bgmIntervals));

function overlap(a: { start: number; end: number }, s: number, e: number) {
  return Math.min(e, a.end) - Math.max(s, a.start);
}

// ---- Real pipeline stage 1: max-3-word segmentation (verbatim words) --------
const rawTranscript = 'ଓଡ଼ିଆ ଖବର ଆସିଛି ସେ ଘରକୁ ଫେରିଲା ଆଜି ବଜାର ବହୁତ ଗାଁ ପହଞ୍ଚିଲା ଆଜି';
const wordTimings = [
  { text: 'ଓଡ଼ିଆ', startSeconds: 2.0, endSeconds: 2.4 },
  { text: 'ଖବର', startSeconds: 2.4, endSeconds: 2.9 },
  { text: 'ଆସିଛି', startSeconds: 2.9, endSeconds: 3.5 },
  { text: 'ସେ', startSeconds: 3.5, endSeconds: 3.8 },
  { text: 'ଘରକୁ', startSeconds: 3.8, endSeconds: 4.1 },
  { text: 'ଫେରିଲା', startSeconds: 4.1, endSeconds: 4.6 },
  { text: 'ଆଜି', startSeconds: 5.6, endSeconds: 6.1 },
  { text: 'ବଜାର', startSeconds: 6.1, endSeconds: 6.4 },
  { text: 'ବହୁତ', startSeconds: 6.4, endSeconds: 6.8 },
  { text: 'ଗାଁ', startSeconds: 11.0, endSeconds: 11.4 },
  { text: 'ପହଞ୍ଚିଲା', startSeconds: 11.4, endSeconds: 12.0 },
  { text: 'ଆଜି', startSeconds: 12.0, endSeconds: 12.4 },
];
let segments: SubtitleSegment[] = buildMax3WordSegments(rawTranscript, totalSeconds, wordTimings);

console.log('\n[STAGE 1] max-3-word speech cues:');
segments.forEach((s) =>
  console.log(`  #${s.id} ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)} [${s.classification}] "${s.text}"`)
);

// ---- Real pipeline stage 2: VAD tagging overlay on the exact audio ----------
segments = await applyAudioAnalysisTags(wavBuffer, 'audio/wav', segments, totalSeconds);

console.log('\n[STAGE 2] fully classified segments:');
const srt = generateSrtContent(segments);
segments.forEach((s) =>
  console.log(`  #${s.id} ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)} [${s.classification}] "${s.text}"`)
);

console.log('\n===== Generated SRT (identical for UI preview AND Download SRT) =====');
console.log(srt);
console.log('===================================================================\n');

// ---- Assertions per requirements --------------------------------------------
const words = rawTranscript.split(/\s+/);
// Count ONLY the cue text lines (exclude SRT numbering + timestamps).
const srtWords = srt
  .split('\n')
  .filter((l) => l.length > 0 && !/^\d+$/.test(l) && !/-->/.test(l))
  .map((l) => l.replace(/<[^>]+>/g, ' '))
  .join(' ')
  .split(/\s+/)
  .filter(Boolean);

// Rule: every spoken word preserved exactly once, none invented/reordered.
const wordCounts = new Map<string, number>();
for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
for (const w of srtWords) wordCounts.set(w, (wordCounts.get(w) ?? 0) - 1);
checkTrue('Req: all 12 spoken words present in final SRT, none missing/added',
  words.length === 12 && srtWords.length === 12 && [...wordCounts.values()].every((c) => c === 0),
  `srtWords=${srtWords.length} mismatch=${JSON.stringify([...wordCounts].filter(([, c]) => c !== 0))}`);

// Req: maximum 3 words per subtitle (counting words inside tags).
const cueLines = srt
  .split('\n\n')
  .filter(Boolean)
  .map((block) => {
    const lines = block.split('\n').filter((l) => l.length > 0);
    const textLines = lines.filter((l) => !/^\d+$/.test(l) && !/-->/.test(l));
    if (textLines.length === 0) return 0;
    const t = textLines.join(' ').replace(/<[^>]+>/g, ' ');
    return t.trim().split(/\s+/).filter(Boolean).length;
  });
checkTrue('Req: no subtitle exceeds 3 words', cueLines.length > 0 && Math.max(...cueLines) <= 3, `max=${Math.max(...cueLines)}`);

// Req 6: loud noise under speech -> <NOISE>spoken words</NOISE> (never plain, never <MB>).
const loudOverNoise = segments.find((s) => s.text === 'ସେ ଘରକୁ ଫେରିଲା');
checkTrue('Req6: words over loud noise classified SPEECH_WITH_NOISE', loudOverNoise?.classification === 'SPEECH_WITH_NOISE');
checkTrue('Req6: <NOISE>spoken words</NOISE> wrapper', srt.includes('<NOISE>ସେ ଘରକୁ ଫେରିଲା</NOISE>'));

// Req 6b (NEW additive detector): hidden low-amplitude BGM under voice that the
// VAD sees as 'speech' must now become SPEECH_WITH_NOISE (was plain text).
const hiddenBgm = segments.find((s) => s.text === 'ଗାଁ ପହଞ୍ଚିଲା ଆଜି');
checkTrue('Req6b: hidden-BGM words classified SPEECH_WITH_NOISE', hiddenBgm?.classification === 'SPEECH_WITH_NOISE',
  `got=${hiddenBgm?.classification}`);
checkTrue('Req6b: <NOISE>spoken words</NOISE> wrapper for hidden BGM', srt.includes('<NOISE>ଗାଁ ପହଞ୍ଚିଲା ଆଜି</NOISE>'));

// Req 8: clear speech stays plain text (no tags) — including no false BGM flag.
const clear1 = segments.find((s) => s.text === 'ଓଡ଼ିଆ ଖବର ଆସିଛି');
const clear2 = segments.find((s) => s.text === 'ଆଜି ବଜାର ବହୁତ');
checkTrue('Req8: clear speech stays CLEAR_SPEECH', clear1?.classification === 'CLEAR_SPEECH' && clear2?.classification === 'CLEAR_SPEECH');
checkTrue('Req8: clear speech plain text', srt.includes('ଓଡ଼ିଆ ଖବର ଆସିଛି') && srt.includes('ଆଜି ବଜାର ବହୁତ'));
checkTrue('Req8: plain-text line has no tags', !/>ଓଡ଼ିଆ/.test(srt) && !/>ଆଜି ବଜା/.test(srt));

// Rev-2 intro split (Rule C): the BGM-only head of the FIRST spoken cue — the
// audio between the VAD speech-region onset (1.68) and the first Sarvam word
// anchor (2.0) — is preserved as its own NOISE_ONLY cue emitting exactly
// <NOISE></NOISE>. Standalone BGM-only regions with NO spoken cue over them
// still produce no subtitle (e.g. the 6.75-10.98 silence/noise stretch).
const noiseOnly = segments.filter((s) => s.classification === 'NOISE_ONLY');
const firstSpoken = segments.find(
  (s) => s.classification === 'CLEAR_SPEECH' || s.classification === 'SPEECH_WITH_NOISE'
);
checkTrue('RuleC/intro: BGM-only intro head emitted as exactly one <NOISE></NOISE>',
  noiseOnly.length === 1 &&
    noiseOnly[0].taggedText === '<NOISE></NOISE>' &&
    noiseOnly[0].endSeconds <= (firstSpoken?.startSeconds ?? 0) + 0.001,
  `noiseOnly=${noiseOnly.length} spans=${noiseOnly.map((s) => `${s.startSeconds}-${s.endSeconds}`).join(',')} firstSpoken=${firstSpoken?.startSeconds}`);
checkTrue('RuleC/intro: SRT contains exactly one <NOISE></NOISE>',
  srt.split('<NOISE></NOISE>').length - 1 === 1,
  `count=${srt.split('<NOISE></NOISE>').length - 1}`);
checkTrue('RuleC: spoken cues start at >= 2.0 (Sarvam anchor, never rewound into the BGM head)',
  !!firstSpoken && firstSpoken.startSeconds >= 2.0,
  `firstSpoken=${firstSpoken?.startSeconds}`);

// Rule 5: <SIL> must NOT be auto-generated, even for the 4.1s digital silence.
checkTrue('Rule5: no <SIL> in SRT', !srt.includes('<SIL>'));

// Rule 6: <MB> must never be generated.
checkTrue('Rule6: no <MB> in SRT', !srt.includes('<MB>'));

// Rule 3 breadth: the ONLY non-speech cue is the intro NOISE_ONLY head.
checkTrue('Rule3: only the intro NOISE_ONLY head plus spoken cues are generated',
  segments.every(
    (s) => s.classification === 'CLEAR_SPEECH' ||
      s.classification === 'SPEECH_WITH_NOISE' ||
      (noiseOnly.includes(s) && s.classification === 'NOISE_ONLY')
  ),
  segments.map((s) => s.classification).join(','));

// Standalone BGM-only regions with no spoken cue over them produce NO subtitle.
checkTrue('Rule3: no cue covers the standalone 6.9-10.98 BGM/silence stretch',
  segments.every((s) => !(s.startSeconds >= 6.0 && s.endSeconds <= 11.0)),
  segments.map((s) => `${s.startSeconds.toFixed(1)}-${s.endSeconds.toFixed(1)}`).join(','));

// Req: preview/download SRT carries all real tags and no forbidden ones.
checkTrue('Req: UI/download SRT tags are consistent',
  srt.includes('<NOISE>ସେ ଘରକୁ ଫେରିଲା</NOISE>') &&
    srt.includes('<NOISE>ଗାଁ ପହଞ୍ଚିଲା ଆଜି</NOISE>') &&
    srt.includes('<NOISE></NOISE>') &&
    !srt.includes('<SIL>') &&
    !srt.includes('<MB>'));

console.log(failed === 0 ? '\nAll final-pipeline checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);