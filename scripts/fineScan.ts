import * as fs from 'fs';
import { execSync } from 'child_process';
import { parseWav } from '../server/audioAnalysis';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';
const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\fine-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const buf = fs.readFileSync(wavPath);
const wav = parseWav(buf);
if (!wav) { console.log('no wav'); process.exit(); }
const mono = wav.mono, sr = wav.sampleRate;
const frameMs = 25;
const frameSize = Math.round((sr * frameMs) / 1000);
const numFrames = Math.floor(mono.length / frameSize);
const rms = new Float32Array(numFrames);
const zcr = new Float32Array(numFrames);
for (let f = 0; f < numFrames; f++) {
  const off = f * frameSize;
  let sum = 0, cross = 0, prev = mono[off];
  for (let i = 0; i < frameSize; i++) {
    const v = mono[off + i];
    sum += v * v;
    if (i > 0 && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) cross++;
    prev = v;
  }
  rms[f] = Math.sqrt(sum / frameSize);
  zcr[f] = cross / frameSize;
}

// fine scan 0.125s across a window, printing per-frame RMS
function scan(t0: number, t1: number, label: string) {
  console.log(`\n===== ${label} (${t0}-${t1}s) =====`);
  const step = Math.round(0.125 * 1000 / frameMs);
  for (let f = Math.floor(t0 * 1000 / frameMs); f <= Math.floor(t1 * 1000 / frameMs); f += step) {
    const r = rms[f];
    const cat = r < 0.008 ? 'SEL ' : r < 0.03 ? 'BKG ' : r < 0.05 ? 'bg   ' : 'VOICE';
    console.log(`${(f*frameMs/1000).toFixed(3).padStart(8)}  rms=${r.toFixed(4)}  ${cat}`);
  }
}

// The two SIL/NOISE cues + surroundings
scan(7.9, 11.9, 'AROUND SIL cue #4 (8.44-11.25)');
scan(160.6, 164.6, 'AROUND NOISE cue #76 (161.60-163.65)');
// A CLEAR cue with low voice% (suspect non-speech text)
scan(181.8, 185.8, 'CLEAR cue #86 (182.59-185.03) V=20%');
scan(5.0, 9.0, 'CLEAR cue #3 (5.63-8.44) B=64%');
