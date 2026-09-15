import * as fs from 'fs';
import { execSync } from 'child_process';
import { parseWav } from '../server/audioAnalysis';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';
const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\fineb-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const wav = parseWav(fs.readFileSync(wavPath));
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
function scan(t0: number, t1: number, label: string) {
  console.log(`\n===== ${label} (${t0}-${t1}s) =====`);
  const step = Math.round(0.125 * 1000 / frameMs);
  let v = 0, n = 0;
  for (let f = Math.floor(t0 * 1000 / frameMs); f <= Math.floor(t1 * 1000 / frameMs); f += step) {
    const r = rms[f];
    const cat = r < 0.008 ? 'SEL ' : r < 0.03 ? 'BKG ' : r < 0.05 ? 'bg   ' : 'VOICE';
    if (r >= 0.05) v++;
    n++;
    console.log(`${(f*frameMs/1000).toFixed(3).padStart(8)}  rms=${r.toFixed(4)}  ${cat}`);
  }
  console.log(`  -> voice frames: ${v}/${n}`);
}
scan(82.4, 84.3, 'CLEAR #43 (82.67-84.00) V=20%');
scan(105.8, 107.9, 'CLEAR #58 (106.11-107.68) V=33%');
scan(146.9, 149.3, 'CLEAR #68 (147.20-149.00) V=29%');
scan(165.0, 167.2, 'CLEAR #78 (165.20-167.00) V=29%');
scan(170.2, 173.0, 'CLEAR #81 (170.43-172.87) V=30%');
scan(194.5, 196.2, 'CLEAR #91 (194.76-196.00) V=40%');
