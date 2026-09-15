import * as fs from 'fs';

const resultFile = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\real-odia-result.json`;
const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const segs = r.segments.filter((s: any) => s.startSeconds >= 10 && s.startSeconds <= 36);

console.log('=== CACHED PIPELINE RESULT (10–36s) ===\n');
for (const s of segs) {
  const words = (s.wordTimings || []).map((w: any) => `"${w.word}" ${w.startSeconds.toFixed(2)}-${w.endSeconds.toFixed(2)}`).join(', ');
  console.log(`[${s.startTimeFormatted} -> ${s.endTimeFormatted}] [${s.classification}]`);
  console.log(`  taggedText = ${JSON.stringify(s.taggedText)}`);
  console.log(`  text       = ${JSON.stringify(s.text)}`);
  console.log(`  words      = [${words}]`);
  console.log();
}
