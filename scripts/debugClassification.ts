/**
 * Debug script: trace the pipeline for 28–40s region.
 * Reads the already-processed JSON result, inspects the raw Gemini
 * response, VAD regions, gating, coverage, and final SRT output.
 */
import { readFileSync } from 'fs';
import { parse } from 'path';
import { detectSpeechRegions, parseWav } from '../server/audioAnalysis';

const WAV_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k-mono.wav';
const RESULT_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/real-odia-result.json';
const REF_SRT_PATH = 'C:/Users/sures/Downloads/ODIA_MP3-3.mp3.srt';

const T_START = 10.0;
const T_END = 45.0;

// --- Load WAV and run VAD ---
const wavBuf = readFileSync(WAV_PATH);
const parsed = parseWav(wavBuf);
if (!parsed) { console.error('WAV parse failed'); process.exit(1); }
const regions = detectSpeechRegions(parsed.mono, parsed.sampleRate);

console.log('\n=== VAD REGIONS (10s–45s) ===');
console.log('Time(s)       Type      Duration');
for (const r of regions) {
  if (r.end < T_START || r.start > T_END) continue;
  const dur = (r.end - r.start).toFixed(3);
  console.log(`${r.start.toFixed(3)}–${r.end.toFixed(3)}   ${r.type.padEnd(8)} ${dur}s`);
}

// --- Load pipeline result JSON ---
const result = JSON.parse(readFileSync(RESULT_PATH, 'utf8'));

console.log('\n=== PIPELINE SEGMENTS (10s–45s) ===');
console.log('id   Time(s)              Class                Text');
for (const s of result.segments) {
  if (s.endSeconds < T_START || s.startSeconds > T_END) continue;
  const time = `${s.startSeconds.toFixed(3)}–${s.endSeconds.toFixed(3)}`.padEnd(18);
  const cls = (s.classification || '').padEnd(20);
  const text = (s.text || s.taggedText || '').slice(0, 40);
  console.log(`${String(s.id).padStart(3)}  ${time} ${cls} ${text}`);
}

// --- Reference SRT for 10s-45s ---
console.log('\n=== REFERENCE SRT (10s–45s) ===');
const refContent = readFileSync(REF_SRT_PATH, 'utf8');
const blocks = refContent.trim().split(/\n\n+/);
for (const block of blocks) {
  const lines = block.trim().split('\n');
  if (lines.length < 3) continue;
  const timeLine = lines[1];
  const m = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
  if (!m) continue;
  const toSec = (ts: string) => {
    const [h, min, rest] = ts.split(':');
    const [s, ms] = rest.split(',');
    return parseInt(h) * 3600 + parseInt(min) * 60 + parseInt(s) + parseInt(ms) / 1000;
  };
  const start = toSec(m[1]);
  const end = toSec(m[2]);
  if (end < T_START || start > T_END) continue;
  const text = lines.slice(2).join(' ');
  console.log(`${m[1]}–${m[2]}  ${text}`);
}

// --- ANALYSIS: find NOISE segments between speech segments ---
console.log('\n=== GAP ANALYSIS: NOISE/SIL between speech in pipeline output (10s–45s) ===');
const segs = result.segments.filter((s: any) => s.startSeconds >= T_START && s.endSeconds <= T_END);
for (let i = 0; i < segs.length; i++) {
  const s = segs[i];
  if (s.classification !== 'NOISE_ONLY' && s.classification !== 'SILENCE' && s.classification !== 'MUSIC_ONLY') continue;
  // Check if surrounded by speech
  const prev = i > 0 ? segs[i - 1] : null;
  const next = i < segs.length - 1 ? segs[i + 1] : null;
  const prevIsSpeech = prev && (prev.classification === 'CLEAR_SPEECH' || prev.classification === 'SPEECH_WITH_NOISE' || prev.classification === 'SPEECH_WITH_MUSIC');
  const nextIsSpeech = next && (next.classification === 'CLEAR_SPEECH' || next.classification === 'SPEECH_WITH_NOISE' || next.classification === 'SPEECH_WITH_MUSIC');
  if (prevIsSpeech && nextIsSpeech) {
    const gapDur = (s.endSeconds - s.startSeconds).toFixed(3);
    console.log(`GAP #${s.id}: ${s.startSeconds.toFixed(3)}–${s.endSeconds.toFixed(3)} (${gapDur}s) [${s.classification}]`);
    console.log(`  PREV: "${prev.text || prev.taggedText}" (${prev.classification})`);
    console.log(`  NEXT: "${next.text || next.taggedText}" (${next.classification})`);
    // Check what VAD says about this gap
    const gapMid = (s.startSeconds + s.endSeconds) / 2;
    for (const r of regions) {
      if (gapMid >= r.start && gapMid < r.end) {
        console.log(`  VAD says: ${r.type} (${r.start.toFixed(3)}–${r.end.toFixed(3)})`);
      }
    }
  }
}

// --- ANALYSIS: what VAD says about speech segments ---
console.log('\n=== SPEECH SEGMENTS vs VAD (10s–45s) ===');
const speechSegs = segs.filter((s: any) => s.classification === 'CLEAR_SPEECH' || s.classification === 'SPEECH_WITH_NOISE');
for (const s of speechSegs) {
  const segMid = (s.startSeconds + s.endSeconds) / 2;
  let vadType = 'unknown';
  for (const r of regions) {
    if (segMid >= r.start && segMid < r.end) {
      vadType = r.type;
      break;
    }
  }
  console.log(`${s.startSeconds.toFixed(3)}–${s.endSeconds.toFixed(3)} VAD=${vadType} cls=${s.classification} "${s.text}"`);
}

// --- Check for reference speech not in pipeline output ---
console.log('\n=== SPEECH in reference but missing/NOISE in pipeline ===');
for (const block of blocks) {
  const lines = block.trim().split('\n');
  if (lines.length < 3) continue;
  const timeLine = lines[1];
  const m = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
  if (!m) continue;
  const toSec = (ts: string) => {
    const [h, min, rest] = ts.split(':');
    const [s, ms] = rest.split(',');
    return parseInt(h) * 3600 + parseInt(min) * 60 + parseInt(s) + parseInt(ms) / 1000;
  };
  const start = toSec(m[1]);
  const end = toSec(m[2]);
  if (end < T_START || start > T_END) continue;
  const text = lines.slice(2).join(' ');
  if (text.includes('<NOISE>') && text !== '<NOISE></NOISE>') {
    console.log(`${m[1]}–${m[2]}  ${text}`);
    // Find corresponding pipeline segment at this time
    const mid = (start + end) / 2;
    const pipSeg = result.segments.find((s: any) => s.startSeconds <= mid && s.endSeconds >= mid);
    if (pipSeg) {
      console.log(`  -> Pipeline: [${pipSeg.classification}] "${pipSeg.text || pipSeg.taggedText}"`);
    } else {
      console.log(`  -> Pipeline: NO SEGMENT at this time`);
    }
  }
}
