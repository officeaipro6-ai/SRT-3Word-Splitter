/**
 * End-to-end verification of the FINAL Odia SRT pipeline using the REAL
 * production modules:
 *   - server.ts      -> buildMax3WordSegments + applyAudioAnalysisTags
 *   - srtRules.ts    -> generateSrtContent (the EXACT function the UI preview
 *                       AND the Download SRT button both use)
 *
 * A synthetic 16 kHz mono WAV is built in-memory with this timeline:
 *   0.0–2.0   steady tone (VAD 'noise', no speech)        -> <NOISE></NOISE>
 *   2.0–3.5   syllabic voice (VAD 'speech')                -> plain text
 *   3.5–5.5   steady tone (VAD 'noise') WITH spoken words
 *             underneath                                    -> <NOISE>words</NOISE>
 *   5.5–7.0   syllabic voice (VAD 'speech')                -> plain text
 *   7.0–11.0  digital silence (4.0s)                       -> <SIL></SIL>
 *
 * The 4s digital-silence tail contains no speech-burst bleed so the VAD's
 * calibrated TRUE_SILENCE_PEAK audit keeps it a genuine SILENCE region.
 *
 * Verifies: every spoken word preserved exactly once; max 3 words per subtitle;
 * speech-over-noise -> <NOISE>words</NOISE>; noise-only -> <NOISE></NOISE>;
 * clear speech plain; 2s silence -> <SIL></SIL>; no <MB> replaces real words;
 * and the downloaded/UI SRT carries the same tags.
 */
import { createWavChunk, parseWav, detectSpeechRegions } from '../server/audioAnalysis';
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
const totalSeconds = 11;
const mono = new Float32Array(Math.floor(sampleRate * totalSeconds));

function fillTone(amp: number, from: number, to: number) {
  const start = Math.floor(from * sampleRate);
  const end = Math.min(mono.length, Math.floor(to * sampleRate));
  for (let i = start; i < end; i++) {
    mono[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
  }
}
function fillSpeech(amp: number, from: number, to: number) {
  // 150 ms burst + 50 ms dip -> syllabic rhythm (high modulation) -> VAD 'speech'.
  for (let t = from; t < to; t += 0.2) {
    const burstEnd = Math.min(to, t + 0.15);
    fillTone(amp, t, burstEnd);
    const dipEnd = Math.min(to, t + 0.2);
    fillTone(0.02, burstEnd, dipEnd);
  }
}

fillTone(0.3, 0, 2); // noise-only
fillSpeech(0.7, 2, 3.5); // clear speech #1
fillTone(0.3, 3.5, 5.5); // noise under spoken words
fillSpeech(0.7, 5.5, 6.9); // clear speech #2 (ends exactly on a low dip)
// 6.9-11.0 left as digital silence (4.1s, no bleed)

const wavBuffer = createWavChunk(mono, sampleRate, 0, mono.length);

const parsed = parseWav(wavBuffer);
checkTrue('WAV parses (duration ~11s)', !!parsed && parsed.duration > 10.9, `duration=${parsed?.duration}`);
const regions = parsed ? detectSpeechRegions(parsed.mono, parsed.sampleRate) : [];
console.log(
  '[VAD regions]',
  regions.map((r) => `${r.type}[${r.start.toFixed(2)}-${r.end.toFixed(2)}]`).join(' ')
);

// ---- Real pipeline stage 1: max-3-word segmentation (verbatim words) --------
const rawTranscript = 'ଓଡ଼ିଆ ଖବର ଆସିଛି ସେ ଘରକୁ ଫେରିଲା ଆଜି ବଜାର ବହୁତ';
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
];
let segments: SubtitleSegment[] = buildMax3WordSegments(rawTranscript, totalSeconds, wordTimings);

console.log('\n[STAGE 1] max-3-word speech cues:');
segments.forEach((s) =>
  console.log(`  #${s.id} ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)} [${s.classification}] "${s.text}"`)
);

// ---- Real pipeline stage 2: VAD tagging overlay on the exact audio ----------
segments = await applyAudioAnalysisTags(wavBuffer, 'audio/wav', segments, totalSeconds);

console.log('\n[STAGE 2] fully classified/merged segments:');
const srt = generateSrtContent(segments);
segments.forEach((s) =>
  console.log(`  #${s.id} ${s.startSeconds.toFixed(2)}-${s.endSeconds.toFixed(2)} [${s.classification}] "${s.text}" -> "${s.taggedText}"`)
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

// Req 2 + 4: every spoken word preserved exactly once, none invented/reordered.
const wordCounts = new Map<string, number>();
for (const w of words) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
for (const w of srtWords) wordCounts.set(w, (wordCounts.get(w) ?? 0) - 1);
checkTrue('Req2/4: all 9 spoken words present in final SRT, none missing/added',
  words.length === 9 && srtWords.length === 9 && [...wordCounts.values()].every((c) => c === 0),
  `srtWords=${srtWords.length} mismatch=${JSON.stringify([...wordCounts].filter(([, c]) => c !== 0))}`);

// Req 3: maximum 3 words per subtitle (counting words inside tags).
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
checkTrue('Req3: no subtitle exceeds 3 words', Math.max(...cueLines) <= 3, `max=${Math.max(...cueLines)}`);

// Req 6: speech over noise -> <NOISE>spoken words</NOISE> (never plain, never <MB>).
const noiseSpeech = segments.find((s) => s.text === 'ସେ ଘରକୁ ଫେରିଲା');
checkTrue('Req6: words over BGM classified SPEECH_WITH_NOISE', noiseSpeech?.classification === 'SPEECH_WITH_NOISE');
checkTrue('Req6: <NOISE>spoken words</NOISE> wrapper', srt.includes('<NOISE>ସେ ଘରକୁ ଫେରିଲା</NOISE>'));

// Req 8: clear speech stays plain text (no tags).
const clear1 = segments.find((s) => s.text === 'ଓଡ଼ିଆ ଖବର ଆସିଛି');
const clear2 = segments.find((s) => s.text === 'ଆଜି ବଜାର ବହୁତ');
checkTrue('Req8: clear speech stays CLEAR_SPEECH', clear1?.classification === 'CLEAR_SPEECH' && clear2?.classification === 'CLEAR_SPEECH');
checkTrue('Req8: clear speech plain text', srt.includes('ଓଡ଼ିଆ ଖବର ଆସିଛି') && srt.includes('ଆଜି ବଜାର ବହୁତ'));
checkTrue('Req8: plain-text line has no tags', !/>ଓଡ଼ିଆ/.test(srt) && !/>ଆଜି/.test(srt));

// Req 7: BGM/noise with no speech -> exactly <NOISE></NOISE>.
checkTrue('Req7: noise-only emitted as <NOISE></NOISE>', srt.includes('<NOISE></NOISE>'));

// Req 9: 2s silence -> <SIL></SIL>.
checkTrue('Req9: 2s silence emitted as <SIL></SIL>', srt.includes('<SIL></SIL>'));

// Never replace words with <MB></MB>.
checkTrue('No spoken word replaced by <MB>', !srt.includes('<MB>'));

// Req 10: preview and download both use generateSrtContent(segments) — the SRT
// printed above is that exact content; assert it carries all real tags.
checkTrue('Req10: UI/download SRT contains all real tags',
  srt.includes('<NOISE></NOISE>') &&
    srt.includes('<NOISE>ସେ ଘରକୁ ଫେରିଲା</NOISE>') &&
    srt.includes('<SIL></SIL>') &&
    !srt.includes('<MB>'));

console.log(failed === 0 ? '\nAll final-pipeline checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);