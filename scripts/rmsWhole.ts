import * as fs from 'fs';
import { execSync } from 'child_process';
import { parseWav } from '../server/audioAnalysis';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';
const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\whole-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const buf = fs.readFileSync(wavPath);
const wav = parseWav(buf);
if (!wav) { console.log('no wav'); process.exit(); }

function rms(t0: number, t1: number) {
  const f0 = Math.floor(t0 * wav.sampleRate), f1 = Math.min(Math.floor(t1 * wav.sampleRate), wav.mono.length);
  let s = 0, n = 0;
  for (let i = f0; i < f1; i++) { s += wav.mono[i] * wav.mono[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

const targets: Array<[number, number, string]> = [
  [0, 2.8, '00:00:00-02.8'],
  [2.8, 11.25, 'SIL cue 2 (2.8-11.25)'],
  [11.25, 14.0, 'speech after SIL'],
  [30, 60, 'general speech'],
  [60, 90, 'general speech 2'],
  [90, 120, 'general speech 3'],
  [120, 150, 'general speech 4'],
  [150, 168, 'general speech 5'],
  [170, 175, '168-175 voiced'],
  [196, 204, 'trailing SIL (196-204)'],
];
for (const [a, b, label] of targets) {
  console.log(`${label}: rms=${rms(a, b).toFixed(4)}`);
}
