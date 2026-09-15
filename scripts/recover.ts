import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseWav, createWavChunk } from '../server/audioAnalysis';
import { transcribeWithWhisper } from '../server/groqTranscriber';

const SRT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const WAV_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k.wav';
const OUT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';

const SPAN_START = 87.325;
const SPAN_END = 221.542;
const DO_WRITE = process.argv.includes('--write');

interface Cue { id: number; start: number; end: number; text: string; cls: string; tag: string; inner: string }

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
    let tag = '', inner = text;
    const nt = text.match(/^<([A-Z]+)>/);
    if (nt) { tag = nt[1]; inner = text.slice(nt[0].length).replace(/<\/?[A-Z]+>/g, '').trim(); }
    else if (text.includes('<')) { tag = 'TAGGED'; inner = text.replace(/<\/?[A-Z]+>/g, '').trim(); }
    cues.push({ id, start, end, text, cls: tag, tag, inner });
  }
  return cues;
}

const raw = readFileSync(SRT_PATH, 'utf8');
const cues = parseSrt(raw);
const wav = parseWav(readFileSync(WAV_PATH))!;
const endCap = Math.min(SPAN_END, wav.duration);

function isBlank(c: Cue): boolean {
  const t = c.inner.replace(/silence/gi, '').trim();
  return t.length === 0;
}

const targets = cues.filter(
  (c) =>
    c.start >= SPAN_START - 0.001 &&
    c.start < endCap &&
    c.id !== 133 && // genuine tail SIL, keep unchanged
    (c.cls === 'NOISE' || c.cls === 'SIL') &&
    isBlank(c)
);

// Words-only strip: keep Odia (0B00-0B7F) + Devanagari (0900-097F) + space; drop all punctuation/symbols
function stripNonWords(t: string): string {
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x20) { out += ' '; continue; }
    if ((cp >= 0x0b00 && cp <= 0x0b7f) || (cp >= 0x0900 && cp <= 0x097f)) { out += ch; continue; }
  }
  return out.replace(/\s+/g, ' ').trim();
}

const CACHE_PATH = 'E:/Odia-SRT-App/scripts/.recover-cache.json';
let results: Record<number, { words: string; timing: string }> = {};
if (process.argv.includes('--useCache') && existsSync(CACHE_PATH)) {
  results = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  console.log('Loaded recovered words from cache.');
} else {
  results = {};
}

console.log(`Audio duration: ${wav.duration.toFixed(2)}s; probing ${targets.length} empty non-speech cue(s) in [${SPAN_START}, ${endCap.toFixed(2)})`);
console.log('');

for (const c of targets) {
  const sr = Math.round(c.start * wav.sampleRate);
  const er = Math.round(c.end * wav.sampleRate);
  const wavBuf = createWavChunk(wav.mono, wav.sampleRate, sr, er);
  const t0 = Date.now();
  try {
    const res = await transcribeWithWhisper(wavBuf, 'audio/wav', 'or', c.start);
    const words: string[] = [];
    const timing: string[] = [];
    for (const seg of res.segments) {
      if (seg.words && seg.words.length) {
        for (const w of seg.words) { words.push(w.word); timing.push(`${fmt(w.startSeconds)}-${fmt(w.endSeconds)}`); }
      } else if (seg.text.trim()) {
        words.push(...seg.text.trim().split(/\s+/));
      }
    }
    const clean = stripNonWords(words.join(' '));
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`cue ${c.id}  ${fmt(c.start)} --> ${fmt(c.end)}  (${(c.end - c.start).toFixed(2)}s)  ${dt}s`);
    console.log(`    RAW segments: ${JSON.stringify(res.segments.map((s) => s.text))}`);
    console.log(`    WORDS[${words.length}]: ${JSON.stringify(clean)}`);
    if (timing.length) console.log(`    TIMING: ${timing.join(' | ')}`);
    results[c.id] = { words: clean, timing: timing.join(' | ') };
  } catch (e: any) {
    console.log(`cue ${c.id} ERROR: ${e?.message}`);
  }
  console.log('');
}

if (Object.keys(results).length && !process.argv.includes('--useCache')) {
  writeFileSync(CACHE_PATH, JSON.stringify(results, null, 2), 'utf8');
  console.log('Saved recovered words to cache:', CACHE_PATH);
}

if (DO_WRITE) {
  let out = '';
  const blockRe = /\r?\n\r?\n/;
  const blocks = raw.split(blockRe);
  let newTexts: Record<number, string> = {};
  for (const idStr of Object.keys(results)) {
    const id = Number(idStr);
    const words = results[id].words;
    if (!words) { newTexts[id] = ''; continue; }
    const cue = cues.find((c) => c.id === id)!;
    if (cue.tag === 'NOISE' || cue.tag === 'SIL') {
      // Keep same tag; NOISE stays NOISE (speech over music bed). SIL with recovered words -> NOISE.
      const tag = cue.tag === 'SIL' ? 'NOISE' : cue.tag;
      newTexts[id] = `<${tag}>${words}</${tag}>`;
    } else {
      newTexts[id] = '';
    }
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const outBlocks: string[] = [];
  for (const b of blocks) {
    let lines = b.split(eol).filter((l) => l.trim().length > 0);
    if (lines.length < 2) { if (b.trim()) outBlocks.push(b); continue; }
    const id = parseInt(lines[0], 10);
    if (newTexts[id] !== undefined && newTexts[id]) {
      // Replace the text line (idx 2); keep id + timecode lines exactly.
      while (lines.length < 3) lines.push('');
      lines[2] = newTexts[id];
      lines = lines.slice(0, 3);
    }
    outBlocks.push(lines.join(eol));
  }
  out = outBlocks.join(eol + eol) + eol;
  writeFileSync(OUT_PATH, out, 'utf8');
  console.log(`\nWROTE ${OUT_PATH}`);
}

function fmt(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
