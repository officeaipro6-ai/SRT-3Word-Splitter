import 'dotenv/config';
import { transcribeWithWhisper } from '../server/groqTranscriber';
import * as fs from 'fs';
import { execSync } from 'child_process';

const FFmpeg = 'C:\\Users\\sures\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const mp3 = 'C:\\Users\\sures\\Downloads\\ODIA_MP3-3.mp3.mpeg';

async function main() {
  // Extract chunk 5 (112-148s) which is the problematic region
  const chunk5Path = 'C:\\Users\\sures\\AppData\\Local\\Temp\\opencode\\test-chunk5.wav';
  execSync(`"${FFmpeg}" -i "${mp3}" -ss 112 -to 148 -ar 16000 -ac 1 "${chunk5Path}" -y`);
  const chunk5Buf = fs.readFileSync(chunk5Path);

  console.log('=== Chunk 5 (112-148s) transcription ===');
  const t1 = Date.now();
  const result5 = await transcribeWithWhisper(chunk5Buf, 'audio/wav', 'or', 112);
  const elapsed5 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`  Time: ${elapsed5}s`);
  console.log(`  Segments: ${result5.segments.length}`);
  const totalWords = result5.segments.reduce((n, s) => n + s.words.length, 0);
  const audioDur = result5.durationSeconds - 112;
  console.log(`  Words: ${totalWords}, Audio duration: ${audioDur.toFixed(1)}s, Density: ${(totalWords / audioDur).toFixed(2)} words/s`);
  for (const seg of result5.segments) {
    console.log(`  [${seg.startSeconds.toFixed(2)}-${seg.endSeconds.toFixed(2)}] words=${seg.words.length} "${seg.text}"`);
  }
}

main().catch(console.error);
