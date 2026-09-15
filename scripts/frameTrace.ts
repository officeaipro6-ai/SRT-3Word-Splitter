import * as fs from 'fs';
import { execSync } from 'child_process';
import { parseWav } from '../server/audioAnalysis';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';
const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\frame-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const buf = fs.readFileSync(wavPath);
const wav = parseWav(buf);
if (!wav) { console.log('no wav'); process.exit(); }

// Reproduce detectSpeechRegions frame labeling.
const mono = wav.mono, sr = wav.sampleRate;
const frameMs = 25;
const frameSize = Math.max(1, Math.round((sr * frameMs) / 1000));
const numFrames = Math.floor(mono.length / frameSize);
const rms = new Float32Array(numFrames);
const zcr = new Float32Array(numFrames);
for (let f = 0; f < numFrames; f++) {
  const off = f * frameSize;
  let sum = 0, crossings = 0, prev = mono[off];
  for (let i = 0; i < frameSize; i++) {
    const v = mono[off + i];
    sum += v * v;
    if (i > 0 && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) crossings++;
    prev = v;
  }
  rms[f] = Math.sqrt(sum / frameSize);
  zcr[f] = crossings / frameSize;
}
const sorted = Array.from(rms).sort((a, b) => a - b);
const noiseFloor = sorted[Math.floor(sorted.length * 0.35)] || 0;
const silenceFloor = Math.max(noiseFloor * 2.0, 0.003);
console.log(`noiseFloor=${noiseFloor.toFixed(5)} silenceFloor=${silenceFloor.toFixed(5)}`);

const modWin = Math.max(4, Math.round(0.5 / (frameMs / 1000)));
const labels: string[] = new Array(numFrames).fill('noise');
for (let f = 0; f < numFrames; f++) {
  if (rms[f] < silenceFloor) { labels[f] = 'silence'; continue; }
  const s = Math.max(0, f - modWin), e = Math.min(numFrames - 1, f + modWin);
  let mean = 0;
  for (let j = s; j <= e; j++) mean += rms[j];
  mean /= (e - s + 1);
  let vari = 0;
  for (let j = s; j <= e; j++) { const d = rms[j] - mean; vari += d * d; }
  const modRatio = mean > 1e-6 ? Math.sqrt(vari / (e - s + 1)) / mean : 0;
  const z = zcr[f];
  const isSpeech = z >= 0.012 && z <= 0.45 && (modRatio >= 0.08 || z >= 0.1);
  labels[f] = isSpeech ? 'speech' : 'noise';
}

function fmt(s: number) {
  const H = Math.floor(s / 3600), M = Math.floor((s % 3600) / 60), S = Math.floor(s % 60);
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}:${String(S).padStart(2, '0')}`;
}

console.log('\nRegion 168-204s frame-by-frame (0.25s) label + rms:');
const step = Math.round(0.25 / (frameMs / 1000)); // 10 frames
for (let f = Math.floor(168 * 1000 / frameMs); f < Math.floor(204 * 1000 / frameMs); f += step) {
  const t = f * frameMs / 1000;
  // majority label over step frames
  const counts: Record<string, number> = { speech: 0, noise: 0, silence: 0 };
  let maxRms = 0;
  for (let j = f; j < Math.min(numFrames, f + step); j++) { counts[labels[j]]++; if (rms[j] > maxRms) maxRms = rms[j]; }
  let best = 'noise', bc = -1;
  for (const t of ['speech', 'noise', 'silence']) if (counts[t] > bc) { bc = counts[t]; best = t; }
  const bar = '#'.repeat(Math.round((maxRms / 0.12) * 30));
  console.log(`${fmt(t)}  ${t.toFixed(2).padStart(7)}s  ${best.padEnd(7)}  ${counts.speech}/${counts.noise}/${counts.silence}  rms=${maxRms.toFixed(4)}  ${bar}`);
}
