import { readFileSync } from 'node:fs';

const SRT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const raw = readFileSync(SRT_PATH, 'utf8');
const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);

interface Cue { id: number; start: number; end: number; text: string; tag: string; inner: string; line: string }

const cues: Cue[] = [];
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
  cues.push({ id, start, end, text, tag, inner, line: `${lines[0]}\n${lines[1]}\n${lines.slice(2).join('\n')}` });
}

// 1. cue count & sequence
let seqOk = true;
for (let i = 0; i < cues.length; i++) if (cues[i].id !== i + 1) { seqOk = false; console.log(`SEQ ERR at idx ${i}: id=${cues[i].id}`); }
console.log(`Total cues: ${cues.length} (sequential ids: ${seqOk})`);

// 2. tag counts
const counts: Record<string, number> = {};
for (const c of cues) counts[c.tag] = (counts[c.tag] || 0) + 1;
console.log('Tag counts:', JSON.stringify(counts));

// 3. empty non-speech remaining in target span
const SPAN_START = 87.325, SPAN_END = 221.542;
const emptyNonSpeech = cues.filter((c) => c.start >= SPAN_START - 0.001 && c.start < 203.85 && (c.tag === 'NOISE' || c.tag === 'SIL') && c.inner.replace(/silence/gi, '').trim().length === 0);
console.log(`Empty non-speech cues remaining in target span: ${emptyNonSpeech.map((c) => c.id).join(',') || 'NONE'}`);

// 4. punctuation/symbols in inner text (words-only rule) — forbid all listed symbols
const forbidden = ['.', ',', '-', '\'', '"', ':', ';', '?', '!', '*', '&', '^', '%', '#', '₹', '(', ')', ']', '>', '<', '_', '/', '=', '[', '{', '}'];
let symbolHits = 0;
for (const c of cues) {
  for (const ch of c.inner) {
    if (forbidden.includes(ch)) { symbolHits++; console.log(`cue ${c.id} has symbol '${ch}': [${c.inner}]`); break; }
  }
}
// also check non-Odia/non-ASCII chars in inner
let foreign = 0;
for (const c of cues) {
  for (const ch of c.inner) {
    const cp = ch.codePointAt(0)!;
    const ok = cp === 0x20 || (cp >= 0x0b00 && cp <= 0x0b7f) || (cp >= 0x0900 && cp <= 0x097f);
    if (!ok) { foreign++; console.log(`cue ${c.id} foreign char U+${cp.toString(16)}: [${c.inner}]`); break; }
  }
}
console.log(`Cues with forbidden punctuation: ${symbolHits}`);
console.log(`Cues with foreign/non-Odia chars: ${foreign}`);

// 5. structure: overlaps and uncovered gaps
let overlaps = 0;
for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end - 0.001) { overlaps++; console.log(`OVERLAP cue ${cues[i - 1].id}<->${cues[i].id}: ${cues[i - 1].start}-${cues[i - 1].end} / ${cues[i].start}-${cues[i].end}`); }
console.log(`Overlaps: ${overlaps}`);
let gapCount = 0;
for (let i = 1; i < cues.length; i++) {
  const gap = cues[i].start - cues[i - 1].end;
  if (gap > 0.05) { gapCount++; console.log(`GAP (${gap.toFixed(3)}s) between cue ${cues[i - 1].id} and ${cues[i].id}`); }
}
console.log(`Uncovered gaps (>50ms): ${gapCount}`);
console.log('First cue start:', cues[0].start.toFixed(3), ' Last cue end:', cues[cues.length - 1].end.toFixed(3));

// 6. confirm filled cues content
console.log('\n=== filled cues ===');
for (const id of [66, 68, 81, 84, 87, 89, 91, 106, 108, 112, 120, 124, 126, 130]) {
  const c = cues.find((x) => x.id === id)!;
  console.log(`cue ${c.id}  ${c.tag}  [${c.inner}]`);
}
