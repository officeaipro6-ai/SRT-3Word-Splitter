import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseWav } from '../server/audioAnalysis';
import { runOdiaPipeline } from '../server/geminiOdiaPipeline';

const SRT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const WAV_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k.wav';
const OUT = 'C:/Users/sures/AppData/Local/Temp/opencode/pipeline-repro-report.json';

interface Cue { id: number; start: string; end: string; text: string; tag: string; inner: string }

function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];
  for (const b of raw.split(/\r?\n\r?\n/)) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const id = parseInt(lines[0], 10);
    const m = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const text = lines.slice(2).join('\n');
    let tag = '', inner = text;
    const nt = text.match(/^<([A-Z]+)>/);
    if (nt) { tag = nt[1]; inner = text.slice(nt[0].length).replace(/<\/?[A-Z]+>/g, '').trim(); }
    cues.push({ id, start: `${m[1]}:${m[2]}:${m[3]},${m[4]}`, end: `${m[5]}:${m[6]}:${m[7]},${m[8]}`, text, tag, inner });
  }
  return cues;
}

function hasForeign(inner: string): boolean {
  for (const ch of inner) {
    const cp = ch.codePointAt(0) || 0;
    if (cp >= 0x0a80 && cp <= 0x0aff) return true;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return true;
  }
  return false;
}
const PUNCT = /[.,\-'"';:?!*&^%#₹()\[\]{}<>_\/=]/;

const verified = parseSrt(readFileSync(SRT_PATH, 'utf8'));

async function main() {
  const buf = readFileSync(WAV_PATH);
  const t0 = Date.now();
  const result = await runOdiaPipeline({
    audioBase64: buf.toString('base64'),
    mimeType: 'audio/wav',
    fileName: 'ODIA_MP3-3.wav',
    fileDuration: 203.85,
  });
  const fresh = parseSrt(result.rawSrt);

  const tagCount = (cues: Cue[]) => {
    const m: Record<string, number> = {};
    for (const c of cues) m[c.tag || 'CLEAR'] = (m[c.tag || 'CLEAR'] || 0) + 1;
    return m;
  };

  // structural: cue count, ids sequential, first/last start, tag counts, gaps, overlaps
  let prevEnd = -1; let gaps = 0; let overlaps = 0; const idsSeq = fresh.every((c, i) => c.id === i + 1);
  const toMs = (s: string) => { const p = s.split(/[:,]/).map(Number); return p[0]*3600000 + p[1]*60000 + p[2]*1000 + p[3]; };
  for (const c of fresh) {
    const s = toMs(c.start), e = toMs(c.end);
    if (s < prevEnd - 1) overlaps++;
    if (s > prevEnd + 1) gaps++;
    prevEnd = Math.max(prevEnd, e);
  }

  const foreign = fresh.filter((c) => hasForeign(c.inner)).map((c) => c.id);
  const punct = fresh.filter((c) => PUNCT.test(c.inner)).map((c) => c.id);
  const emptyNOISE = fresh.filter((c) => c.tag === 'NOISE' && c.inner === '').map((c) => c.id);

  // recovery windows expected filled
  const recoveryWindowStarts = new Set([
    '00:01:29,775','00:01:32,700','00:01:45,975','00:01:49,000','00:02:00,275','00:02:03,200','00:02:05,525',
    '00:02:34,800','00:02:37,725','00:02:46,100','00:02:58,950','00:03:06,575','00:03:08,150','00:03:13,975',
  ]);
  const filledRecovery = fresh.filter((c) => recoveryWindowStarts.has(c.start) && c.inner !== '').map((c) => c.start);

  const report = {
    pipelineSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    verifiedCues: verified.length,
    freshCues: fresh.length,
    verifiedTags: tagCount(verified),
    freshTags: tagCount(fresh),
    idsSequential: idsSeq,
    gaps,
    overlaps,
    firstStart: fresh[0]?.start,
    lastEnd: fresh[fresh.length - 1]?.end,
    foreignCueIds: foreign,
    punctuationCueIds: punct,
    emptyNOISECueIds: emptyNOISE,
    recoveryWindowsFilled: filledRecovery.length,
    recoveryWindowsExpected: recoveryWindowStarts.size,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.error('report written');
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
