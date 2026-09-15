import * as fs from 'fs';
import { execSync } from 'child_process';
import { parseWav } from '../server/audioAnalysis';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';
const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\diag-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const buf = fs.readFileSync(wavPath);
const wav = parseWav(buf);
if (!wav) { console.log('no wav'); process.exit(); }
const mono = wav.mono, sr = wav.sampleRate;

const frameMs = 25;
const frameSize = Math.round((sr * frameMs) / 1000);
const numFrames = Math.floor(mono.length / frameSize);
const rms = new Float32Array(numFrames);

for (let f = 0; f < numFrames; f++) {
  const off = f * frameSize;
  let sum = 0;
  for (let i = 0; i < frameSize; i++) sum += mono[off + i] * mono[off + i];
  rms[f] = Math.sqrt(sum / frameSize);
}

// ground-truth *independent* tiers (documented): quiet <0.01, bkg 0.01-0.05, voice >=0.05
function tierAt(t: number): { tier: string; rms: number } {
  const f = Math.max(0, Math.min(numFrames - 1, Math.floor((t * 1000) / frameMs)));
  const r = rms[f];
  const tier = r < 0.01 ? 'S' : r < 0.05 ? 'B' : 'V';
  return { tier, rms: r };
}

// max rms over a window
function windowEnergy(t0: number, t1: number): { max: number; mean: number } {
  const f0 = Math.max(0, Math.floor((t0 * 1000) / frameMs));
  const f1 = Math.min(numFrames - 1, Math.floor((t1 * 1000) / frameMs));
  let sum = 0, mx = 0, n = 0;
  for (let f = f0; f <= f1; f++) { sum += rms[f]; if (rms[f] > mx) mx = rms[f]; n++; }
  return { max: mx, mean: sum / (n || 1) };
}

// ---- Parse exported SRT ----
const srtPath = 'E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt';
const raw = fs.readFileSync(srtPath, 'utf8');
const blocks = raw.split(/\r?\n\r?\n/);
const cues: { id: number; start: number; end: number; body: string }[] = [];
for (const b of blocks) {
  const lines = b.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) continue;
  const id = parseInt(lines[0], 10);
  const m = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) continue;
  const s = (a: number[]) => a[0] * 3600 + a[1] * 60 + a[2] + a[3] / 1000;
  const start = s([+m[1], +m[2], +m[3], +m[4]]);
  const end = s([+m[5], +m[6], +m[7], +m[8]]);
  cues.push({ id, start, end, body: lines.slice(2).join(' ') });
}

function cls(body: string): string {
  if (body.startsWith('<SIL>')) return 'SIL';
  if (body.startsWith('<NOISE>')) return 'NOISE';
  if (body.startsWith('<MB>')) return 'MB';
  if (body.includes('<')) return 'TAGGED';
  return 'CLEAR';
}

console.log('sr=', sr, 'frames=', numFrames, 'frameSec=', frameMs / 1000);
console.log('TOTAL CUES:', cues.length);
console.log('\n=== ALL CUES vs ACTUAL AUDIO (0.25s sampled) ===');
for (const c of cues) {
  const k = cls(c.body);
  // sample the cue's interior at 0.25s
  const samples: string[] = [];
  const mean = windowEnergy(c.start, c.end).mean;
  const max = windowEnergy(c.start, c.end).max;
  for (let t = c.start + 0.1; t < c.end - 0.05 && t < c.end; t += 0.25) {
    samples.push(tierAt(t).tier);
  }
  const counts = { S: 0, B: 0, V: 0 };
  for (const s0 of samples) counts[s0]++;
  const n = samples.length || 1;
  const vPct = (100 * counts.V / n).toFixed(0);
  const sPct = (100 * counts.S / n).toFixed(0);
  const note = k === 'SIL' || k === 'NOISE' ? '  <-- NON-SPEECH CUE' : '';
  console.log(
    `#${String(c.id).padStart(3)} ${c.start.toFixed(2).padStart(7)}-${c.end.toFixed(2).padStart(7)} ` +
      `${k.padEnd(6)} mean=${mean.toFixed(3)} max=${max.toFixed(3)} V=${vPct}% B=${(100*counts.B/n).toFixed(0)}% S=${sPct}%${note}`
  );
}
