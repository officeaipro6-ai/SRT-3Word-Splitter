import 'dotenv/config';
import { runOdiaPipeline } from '../server/geminiOdiaPipeline';
import * as fs from 'fs';
import { execSync } from 'child_process';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';

function fmt(s: number) {
  const H = Math.floor(s / 3600), M = Math.floor((s % 3600) / 60), S = Math.floor(s % 60);
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}:${String(S).padStart(2, '0')}`;
}

const wavPath = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\before-16k.wav';
execSync(`"${FFmpeg}" -i "${mp3}" -ar 16000 -ac 1 "${wavPath}" -y 2>&1`, { stdio: 'pipe' });
const buf = fs.readFileSync(wavPath);

const result = await runOdiaPipeline({
  audioBase64: buf.toString('base64'),
  mimeType: 'audio/wav',
  fileName: 'test.mp3',
  fileDuration: 203.8,
  onProgressMessage: () => {},
});

console.log('\n\n=== FINAL SEGMENTS 174-204s ===');
for (const s of result.segments) {
  if (s.startSeconds >= 174 && s.startSeconds <= 204) {
    console.log(`  ${String(s.id).padStart(2)}  ${fmt(s.startSeconds)} -> ${fmt(s.endSeconds)}  [${s.classification}] "${s.taggedText}"`);
  }
}
