import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseWav } from '../server/audioAnalysis';

const SRT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const WAV_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k.wav';

interface Cue { id: number; start: number; end: number; text: string; cls: string }

function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const id = parseInt(lines[0], 10);
    const m = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const toSec = (a: string[]) => Number(a[0]) * 3600 + Number(a[1]) * 60 + Number(a[2]) + Number(a[3]) / 1000;
    const start = toSec([m[1], m[2], m[3], m[4]]);
    const end = toSec([m[5], m[6], m[7], m[8]]);
    const text = lines.slice(2).join('\n');
    cues.push({ id, start, end, text, cls: text.startsWith('<NOISE>') ? 'NOISE' : text.startsWith('<SIL>') ? 'SIL' : 'CLEAR' });
  }
  return cues;
}

const raw = readFileSync(SRT_PATH, 'utf8');
const cues = parseSrt(raw);

const SPAN_START = 87.325;   // 00:01:27.325
const SPAN_END = 221.542;    // 00:03:41.542

function isEmptyNonSpeech(c: Cue): boolean {
  if (c.cls === 'CLEAR') return false;
  const inner = c.text.replace(/<\/?NOISE>/g, '').replace(/<\/?SIL>/g, '').replace(/silence/g, '').trim();
  return inner.length === 0;
}

console.log('Duration of WAV:', parseWav(readFileSync(WAV_PATH))!.duration.toFixed(2), 's');
console.log('Target span:', SPAN_START, '-', SPAN_END, '(audio ends', (parseWav(readFileSync(WAV_PATH))!.duration).toFixed(2), ')');
console.log('');
console.log('=== Empty non-speech cues within target span ===');
for (const c of cues) {
  if (c.start >= SPAN_START && c.end <= SPAN_END && isEmptyNonSpeech(c)) {
    console.log(`cue ${c.id}  ${fmt(c.start)} --> ${fmt(c.end)}  [${c.cls}]  dur=${(c.end - c.start).toFixed(3)}s`);
  }
}
console.log('');
console.log('=== ALL cues with any gap (uncovered time) in target span ===');
let prevEnd = SPAN_START;
for (const c of cues) {
  if (c.end < SPAN_START) continue;
  if (c.start > SPAN_END) break;
  if (c.start > prevEnd + 0.05) {
    console.log(`GAP ${fmt(prevEnd)} --> ${fmt(c.start)}  |  before cue ${c.id}`);
  }
  const e = Math.min(c.end, SPAN_END);
  if (e > prevEnd) prevEnd = e;
}

function fmt(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
