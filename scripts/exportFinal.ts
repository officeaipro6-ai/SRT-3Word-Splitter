import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { runOdiaPipeline } from '../server/geminiOdiaPipeline';
import { parseWav } from '../server/audioAnalysis';

const SRT_PATH = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const WAV_PATH = 'C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k.wav';
const MP3_PATH = 'C:/Users/sures/Downloads/ODIA_MP3-3.mp3.mpeg';

const FFmpeg =
  'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';

interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
  tagged: string;
  cls: string;
}

function parseSrt(raw: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const id = parseInt(lines[0], 10);
    const m = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const toSec = (a: string[]) =>
      Number(a[0]) * 3600 + Number(a[1]) * 60 + Number(a[2]) + Number(a[3]) / 1000;
    const start = toSec([m[1], m[2], m[3], m[4]]);
    const end = toSec([m[5], m[6], m[7], m[8]]);
    const tagBlock = lines.slice(2).join('\n');
    cues.push({ id, start, end, text: tagBlock, tagged: tagBlock, cls: '' });
  }
  return cues;
}

function classify(t: string): string {
  if (t.startsWith('<NOISE>')) return 'NOISE';
  if (t.startsWith('<SIL>') || t === '<SIL></SIL>') return 'SIL';
  if (t.startsWith('<MB>')) return 'MB';
  if (t.startsWith('<FIL>')) return 'FIL';
  if (t.includes('<')) return 'TAGGED';
  return 'CLEAR';
}

async function main() {
  const buf = readFileSync(WAV_PATH);
  const audioBase64 = buf.toString('base64');

  const started = Date.now();
  const result = await runOdiaPipeline({
    audioBase64,
    mimeType: 'audio/wav',
    fileName: 'ODIA_MP3-3.wav',
    fileDuration: 203.84,
  });
  console.log(`Pipeline took ${(Date.now() - started) / 1000}s`);
  console.log('Duration:', result.durationSeconds.toFixed(2));

  writeFileSync(SRT_PATH, result.rawSrt, 'utf8');
  console.log('WROTE:', SRT_PATH, result.rawSrt.split(/\r?\n\r?\n/).length, 'cues');

  const cues = parseSrt(result.rawSrt);
  const d = result.durationSeconds;

  // ----- actual-audio ground truth (independent, from the source MP3) -----
  const audioWav = 'C:/Users/sures/AppData/Local/Temp/opencode/spot-16k.wav';
  execSync(`"${FFmpeg}" -i "${MP3_PATH}" -ar 16000 -ac 1 "${audioWav}" -y 2>&1`, { stdio: 'pipe' });
  const wav = parseWav(readFileSync(audioWav));
  if (!wav) throw new Error('no wav');
  const mono = wav.mono, sr = wav.sampleRate;
  const fms = 25;
  const fsz = Math.round((sr * fms) / 1000);
  const nf = Math.floor(mono.length / fsz);
  const rms = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const off = f * fsz;
    let s = 0;
    for (let i = 0; i < fsz; i++) s += mono[off + i] * mono[off + i];
    rms[f] = Math.sqrt(s / fsz);
  }
  // Regions of genuine voice: any 0.25s where max noise-level stays low vs voice.
  // ground-truth tiers: SEL<0.008, BKG 0.008-0.05, VOICE>=0.05
  function frac(t0: number, t1: number): { vPct: number; sPct: number; max: number } {
    const f0 = Math.max(0, Math.floor((t0 * 1000) / fms));
    const f1 = Math.min(nf - 1, Math.floor((t1 * 1000) / fms));
    let v = 0, s = 0, n = 0, mx = 0;
    for (let f = f0; f <= f1; f++) {
      if (rms[f] >= 0.05) v++;
      else if (rms[f] < 0.008) s++;
      n++;
      if (rms[f] > mx) mx = rms[f];
    }
    return { vPct: (100 * v) / (n || 1), sPct: (100 * s) / (n || 1), max: mx };
  }

  const problems: string[] = [];
  const tagCount: Record<string, number> = { NOISE: 0, SIL: 0, MB: 0, FIL: 0, CLEAR: 0, TAGGED: 0 };
  let prevEnd = -Infinity;
  let gaps = 0;
  const nonSpeechCheck = [];
  const clearCheck = [];
  for (const c of cues) {
    const k = classify(c.tagged);
    tagCount[k]++;
    if (c.tagged.startsWith('<NOISE>') && c.tagged !== '<NOISE></NOISE>')
      problems.push(`NOISE cue #${c.id} has text`);
    if (c.tagged !== '<SIL></SIL>' && c.tagged.startsWith('<SIL>'))
      problems.push(`SIL cue #${c.id} has text: "${c.tagged}"`);
    if (c.start < prevEnd - 0.001) problems.push(`OVERLAP: #${c.id}`);
    if (c.end <= c.start) problems.push(`BAD RANGE: #${c.id}`);
    if (c.start > prevEnd + 0.001) { gaps++; problems.push(`GAP: #${c.id}`); }
    prevEnd = Math.max(prevEnd, c.end);

    const g = frac(c.start, c.end);
    if (k === 'NOISE' || k === 'SIL') {
      nonSpeechCheck.push({ id: c.id, start: c.start, end: c.end, k, vPct: g.vPct, max: g.max });
      if (g.vPct >= 15) problems.push(`NON-SPEECH cue #${c.id} has voice (V=${g.vPct.toFixed(0)}%, max=${g.max.toFixed(3)})`);
    } else if (k === 'CLEAR') {
      clearCheck.push({ id: c.id, start: c.start, end: c.end, vPct: g.vPct, sPct: g.sPct });
      if (g.vPct < 15 && g.max < 0.05)
        problems.push(`CLEAR cue #${c.id} appears non-speech (V=${g.vPct.toFixed(0)}%, max=${g.max.toFixed(3)})`);
    }
  }

  const firstStart = cues.length ? Math.min(...cues.map((c) => c.start)) : 0;
  const lastEnd = cues.length ? Math.max(...cues.map((c) => c.end)) : 0;
  const coveragePct = ((lastEnd - firstStart) / (d - firstStart)) * 100;

  console.log('\n=== TAG COUNTS ===', tagCount);
  console.log('=== TIMELINE ===');
  console.log(`  first: ${firstStart.toFixed(3)}s last: ${lastEnd.toFixed(3)}s dur: ${d.toFixed(3)}s coverage: ${coveragePct.toFixed(1)}%`);
  console.log(`  gaps: ${gaps}  overlaps: ${problems.filter((p) => p.startsWith('OVERLAP')).length}`);
  console.log('\n=== NON-SPEECH CUES vs ACTUAL AUDIO ===');
  for (const n of nonSpeechCheck) {
    console.log(`  #${n.id} ${n.start.toFixed(2)}-${n.end.toFixed(2)} ${n.k}  voiceFrac=${n.vPct.toFixed(0)}%  maxRMS=${n.max.toFixed(3)}`);
  }
  console.log('\n=== CLEAR SPEECH (min voice%) ===');
  const lowClear = [...clearCheck].sort((a, b) => a.vPct - b.vPct).slice(0, 5);
  for (const c of lowClear) console.log(`  #${c.id} ${c.start.toFixed(2)}-${c.end.toFixed(2)} voice=${c.vPct.toFixed(0)}% silent=${c.sPct.toFixed(0)}%`);
  console.log('\n=== PROBLEMS ===', problems.length ? problems : 'NONE');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
