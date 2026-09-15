import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { runOdiaPipeline } from '../server/geminiOdiaPipeline';
import { parseWav, detectSpeechRegions } from '../server/audioAnalysis';

async function main() {
  const wavPath = 'C:/Users/sures/AppData/Local/Temp/opencode/test-audio-2m28s.wav';
  const buf = readFileSync(wavPath);
  const audioBase64 = buf.toString('base64');

  const parsed = parseWav(buf);
  if (parsed) {
    const regions = detectSpeechRegions(parsed.mono, parsed.sampleRate);
    console.log('=== VAD REGIONS ===');
    for (const r of regions) {
      console.log(
        `  ${r.type.padEnd(7)} ${r.start.toFixed(2)}s -> ${r.end.toFixed(2)}s (${(r.end - r.start).toFixed(2)}s)`
      );
    }
  }

  if (process.argv.includes('--vad-only')) {
    console.log('\nVAD-only check complete.');
    return;
  }

  console.log('\n=== RUNNING PIPELINE ===');
  const started = Date.now();
  const result = await runOdiaPipeline({
    audioBase64,
    mimeType: 'audio/wav',
    fileName: 'test-audio-2m28s.wav',
    fileDuration: 148,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nPipeline took ${elapsed}s`);
  console.log('Detected language:', result.detectedLanguage, 'isOdia:', result.isOdia);
  console.log('Duration:', result.durationSeconds.toFixed(2), 's');
  console.log('Stats:', JSON.stringify(result.stats, null, 2));
  if (result.notes) {
    console.log('Notes:');
    for (const n of result.notes) console.log('  -', n);
  }

  console.log('\n=== SRT OUTPUT ===');
  console.log(result.rawSrt);

  // Validation checks
  console.log('\n=== VALIDATION ===');
  const segs = result.segments;
  console.log('Total segments:', segs.length);
  let prevEnd = -Infinity;
  let issues = 0;
  const tags = { noise: 0, noiseEmpty: 0, fil: 0, sil: 0, mb: 0, clear: 0 };
  for (const s of segs) {
    if (s.startSeconds < prevEnd) {
      console.log(`OVERLAP: seg #${s.id} start=${s.startSeconds} < prev end=${prevEnd}`);
      issues++;
    }
    if (s.endSeconds <= s.startSeconds) {
      console.log(`INVALID TIME: seg #${s.id}`);
      issues++;
    }
    if (s.endSeconds > result.durationSeconds + 0.05) {
      console.log(`EXCEEDS DURATION: seg #${s.id} end=${s.endSeconds}`);
      issues++;
    }
    prevEnd = s.endSeconds;
    if (s.taggedText.includes('<NOISE></NOISE>')) tags.noiseEmpty++;
    else if (s.taggedText.startsWith('<NOISE>')) tags.noise++;
    else if (s.taggedText.includes('<FIL>')) tags.fil++;
    else if (s.taggedText === '<SIL></SIL>') tags.sil++;
    else if (s.taggedText === '<MB></MB>') tags.mb++;
    else tags.clear++;
  }
  console.log('Tag counts:', tags);
  console.log('Issues found:', issues);
}

main().catch((err) => {
  console.error('PIPELINE FAILED:', err);
  process.exit(1);
});