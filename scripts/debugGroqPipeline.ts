/**
 * FULL DIAGNOSTIC: VAD regions vs pipeline output for 10–36s window.
 * Uses cached Gemini result + VAD data from the WAV file.
 * No Groq API call needed.
 */
import * as fs from 'fs';
import { parseWav, detectSpeechRegions, SpeechRegion } from '../server/audioAnalysis';

const WAV_PATH = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\ODIA_MP3-3-16k-mono.wav`;
const RESULT_PATH = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\real-odia-result.json`;
const WINDOW_START = 10;
const WINDOW_END = 40;

function fmt(n: number) { return n.toFixed(3); }

const audioBuffer = fs.readFileSync(WAV_PATH);
const parsed = parseWav(audioBuffer)!;
const regions = detectSpeechRegions(parsed.mono, parsed.sampleRate);
const cached = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));

// ─── VAD REGIONS 10–40s ──────────────────────────────────────
const windowRegions = regions.filter(r => r.end > WINDOW_START && r.start < WINDOW_END);
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  VAD REGIONS (10–40s)                                          ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
for (const r of windowRegions) {
  const bar = r.type === 'speech' ? '█'.repeat(Math.round((r.end - r.start) * 10))
    : r.type === 'noise' ? '░'.repeat(Math.round((r.end - r.start) * 10))
    : '·'.repeat(Math.round((r.end - r.start) * 10));
  console.log(`  ${fmt(r.start)}→${fmt(r.end)}  [${r.type.padEnd(7)}] ${(r.end - r.start).toFixed(2)}s  ${bar}`);
}

// ─── SPEECH FRACTION ANALYSIS ────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  CRITICAL: VAD speech region fragmentation                       ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');

const speechRegions = windowRegions.filter(r => r.type === 'speech');
const totalSpeechDur = speechRegions.reduce((sum, r) => sum + (r.end - r.start), 0);
const totalWindowDur = WINDOW_END - WINDOW_START;
console.log(`  Total window duration: ${totalWindowDur}s`);
console.log(`  Total speech in VAD: ${totalSpeechDur.toFixed(2)}s (${(totalSpeechDur / totalWindowDur * 100).toFixed(1)}%)`);
console.log(`  Number of speech regions: ${speechRegions.length}`);
console.log(`  Average speech region length: ${(totalSpeechDur / speechRegions.length).toFixed(3)}s`);
console.log(`  WARNING: Most speech regions are < 1.0s!`);
console.log(`  Whisper returns BROAD sentence-level segments.`);
console.log(`  A single Whisper segment may span 5–15s covering many tiny VAD regions.`);

// ─── CACHED GEMINI RESULT ANALYSIS ──────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  CACHED GEMINI RESULT (10–40s) — classification breakdown        ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');

const cachedSegs = cached.segments.filter((s: any) => s.startSeconds >= WINDOW_START && s.startSeconds < WINDOW_END);
let speechCount = 0, mbCount = 0, noiseCount = 0;
for (const s of cachedSegs) {
  if (s.classification === 'CLEAR_SPEECH' || s.classification === 'SPEECH_WITH_NOISE') speechCount++;
  else if (s.classification === 'SPEECH_WITH_MUSIC') mbCount++;
  else if (s.classification === 'NOISE_ONLY') noiseCount++;
}
console.log(`  CLEAR_SPEECH/SPEECH_WITH_NOISE (plain text): ${speechCount}`);
  console.log(`  SPEECH_WITH_MUSIC (-> <MB></MB>):              ${mbCount}`);
  console.log(`  NOISE_ONLY (-> <NOISE></NOISE>):               ${noiseCount}`);

// ─── SIMULATE WHAT GROQ WOULD DO ─────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║  SIMULATED GROQ PIPELINE: classifyWhisperSegments behavior      ║');
console.log('║  (Using Gemini word timestamps as Whisper proxy)                ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');

const longSilences = regions.filter(r => r.type === 'silence' && r.end - r.start >= 2.0);

for (const s of cachedSegs) {
  if (s.classification === 'NOISE_ONLY') continue; // skip noise-only gaps

  const segStart = s.startSeconds;
  const segEnd = s.endSeconds;
  const segDur = segEnd - segStart;

  // Calculate speech/noise overlap for the full segment
  let speechOverlap = 0, noiseOverlap = 0;
  for (const r of regions) {
    const rs = Math.max(segStart, r.start);
    const re = Math.min(segEnd, r.end);
    if (re <= rs) continue;
    if (r.type === 'speech') speechOverlap += (re - rs);
    else if (r.type === 'noise') noiseOverlap += (re - rs);
  }
  const speechFrac = segDur > 0 ? speechOverlap / segDur : 0;
  const noiseFrac = segDur > 0 ? noiseOverlap / segDur : 0;

  // classifyWhisperSegments result
  let classifyResult: string;
  if (s.text && s.text.trim().length > 0) {
    if (speechFrac >= 0.5) {
      classifyResult = noiseFrac > 0.3 ? 'SPEECH_WITH_NOISE' : 'CLEAR_SPEECH';
    } else {
      classifyResult = 'CLEAR_SPEECH'; // Whisper transcribed it, trust Whisper
    }
  } else {
    classifyResult = 'NOISE_ONLY';
  }

  // toAtom: word timings adjust boundaries
  let atomStart = segStart, atomEnd = segEnd;
  if (s.wordTimings && s.wordTimings.length > 0 && classifyResult !== 'NOISE_ONLY') {
    atomStart = Math.min(...s.wordTimings.map((w: any) => w.startSeconds));
    atomEnd = Math.max(...s.wordTimings.map((w: any) => w.endSeconds));
  }

  // applyGating: recalculate speechFrac on atom boundaries
  let gateSpeechOverlap = 0;
  for (const r of regions) {
    if (r.type !== 'speech') continue;
    const rs = Math.max(atomStart, r.start);
    const re = Math.min(atomEnd, r.end);
    if (re > rs) gateSpeechOverlap += (re - rs);
  }
  const gateSpeechFrac = (atomEnd - atomStart) > 0 ? gateSpeechOverlap / (atomEnd - atomStart) : 0;

  let finalClass = classifyResult;
  let finalText = s.text;
  if (['CLEAR_SPEECH', 'SPEECH_WITH_NOISE', 'SPEECH_WITH_MUSIC'].includes(classifyResult)) {
    if (s.text && s.text.trim().length > 0) {
      if (gateSpeechFrac < 0.4) {
        finalClass = 'NOISE_ONLY';
        finalText = '';
      }
    }
  }

  // Apply tagging rule
  let taggedText: string;
  if (finalClass === 'CLEAR_SPEECH') taggedText = finalText;
  else if (finalClass === 'SPEECH_WITH_NOISE') taggedText = finalText;
  else if (finalClass === 'SPEECH_WITH_MUSIC') taggedText = '<MB></MB>';
  else if (finalClass === 'NOISE_ONLY') taggedText = '<NOISE></NOISE>';

  const changed = finalClass !== classifyResult;
  const flag = changed ? '!!! DOWNGRADED' : 'OK';
  console.log(`  ${fmt(segStart)}->${fmt(segEnd)} text="${(s.text||'').slice(0,25)}"`);
  console.log(`    VAD speechFrac=${speechFrac.toFixed(2)} noiseFrac=${noiseFrac.toFixed(2)}`);
  console.log(`    classifyWhisperSegments -> ${classifyResult}`);
  console.log(`    atom boundaries: ${fmt(atomStart)}->${fmt(atomEnd)} gateSpeechFrac=${gateSpeechFrac.toFixed(3)}`);
  console.log(`    applyGating -> ${finalClass} ${flag} | SRT output: ${changed ? '<NOISE></NOISE>' : taggedText.slice(0, 40)}`);
  console.log('');
}

// ─── ROOT CAUSE ──────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  ROOT CAUSE ANALYSIS                                            ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log('');
console.log('PROBLEM 1: applyGating downgrades CLEAR_SPEECH to NOISE_ONLY');
console.log('  When a Whisper segment spans multiple tiny VAD regions (speech+noise),');
console.log('  word timings extend the atom boundaries across noise gaps.');
console.log('  applyGating recalculates speechFrac on the WIDER atom boundaries.');
console.log('  If speechFrac < 0.4 → classification becomes NOISE_ONLY, text cleared.');
console.log('');
console.log('PROBLEM 2: apostrophes — stripApostrophes() IS applied in toAtom(),');
console.log('  but Whisper itself may be adding apostrophes to Odia words.');
console.log('  We need to verify the Groq Whisper response contains apostrophes.');
console.log('');
console.log('PROBLEM 3: timestamps — the cached word timings show very precise');
console.log('  values (12.35-12.78, 13.33-13.85). These are NOT artificially regular.');
console.log('  But with the Groq API we need to confirm it returns word-level timestamps.');
console.log('');
console.log('PROBLEM 4: NO code path produces "<NOISE>text</NOISE>" (text inside NOISE).');
console.log('  applyTaggingRule(NOISE_ONLY) always returns "<NOISE></NOISE>" (empty).');
console.log('  The user may be seeing the old Gemini output or describing');
console.log('  alternating NOISE/SPEECH cues as "noise wrapping speech".');
