import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const audioPath = String.raw`C:\Users\sures\Downloads\ODIA_MP3-3.mp3.mpeg`;
const audioBase64 = fs.readFileSync(audioPath).toString('base64');

async function main() {
  console.log(`Sending ${(audioBase64.length * 0.75 / 1024 / 1024).toFixed(1)} MB to server...`);
  const t0 = Date.now();
  const res = await fetch('http://localhost:3000/api/process-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType: 'audio/mpeg' }),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const json = await res.json() as any;

  if (json.error) {
    console.error('ERROR:', json.error);
    process.exit(1);
  }

  console.log(`\ntotalSegments=${json.segments.length} duration=${json.durationSeconds?.toFixed(1)}s time=${elapsed}s`);

  // Classification stats
  const stats: Record<string, number> = {};
  for (const seg of json.segments) {
    stats[seg.classification] = (stats[seg.classification] || 0) + 1;
  }
  console.log('\n=== CLASSIFICATION STATS ===');
  for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Show first 30 segments
  console.log('\n=== FIRST 30 SEGMENTS ===');
  for (const seg of json.segments.slice(0, 30)) {
    const start = seg.startTimeFormatted || seg.startFormatted || seg.startSeconds?.toFixed(2);
    const end = seg.endTimeFormatted || seg.endFormatted || seg.endSeconds?.toFixed(2);
    const tag = seg.taggedText?.slice(0, 70) || '';
    console.log(`${start} -> ${end} [${seg.classification}] ${tag}`);
  }

  // Save SRT
  if (json.rawSrt) {
    const srtPath = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\groq-pipeline-output.srt`;
    fs.writeFileSync(srtPath, json.rawSrt);
    console.log(`\nSRT saved (${json.srtLines || '?'} lines): ${srtPath}`);
  }

  // Pipeline stats
  if (json.stats) {
    console.log('\n=== PIPELINE STATS ===');
    console.log(JSON.stringify(json.stats, null, 2));
  }
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
