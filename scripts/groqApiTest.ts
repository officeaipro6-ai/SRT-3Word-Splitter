import Groq from 'groq-sdk';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const clipPath = String.raw`C:\Users\sures\AppData\Local\Temp\opencode\speech-clip.wav`;
const smallChunk = fs.readFileSync(clipPath);

async function main() {
  // Test 1: with language=hi + word timestamps
  console.log('=== TEST 1: language=hi, timestamp_granularities=[word] ===');
  const file1 = new File([smallChunk], 'test.wav', { type: 'audio/wav' });
  const r1 = await groq.audio.transcriptions.create({
    file: file1,
    model: 'whisper-large-v3-turbo',
    language: 'hi',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });
  const v1 = r1 as any;
  console.log('Text:', v1.text?.slice(0, 100));
  console.log('Segments:', v1.segments?.length || 0);
  if (v1.segments) {
    for (const seg of v1.segments) {
      console.log(`  [${seg.start}-${seg.end}] "${seg.text}" words=${seg.words?.length || 0}`);
      if (seg.words && seg.words.length > 0) {
        console.log(`    Words:`, JSON.stringify(seg.words.slice(0, 5)));
      }
    }
  }

  // Test 2: no language hint
  console.log('\n=== TEST 2: no language, timestamp_granularities=[word] ===');
  const file2 = new File([smallChunk], 'test.wav', { type: 'audio/wav' });
  const r2 = await groq.audio.transcriptions.create({
    file: file2,
    model: 'whisper-large-v3-turbo',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });
  const v2 = r2 as any;
  console.log('Text:', v2.text?.slice(0, 100));
  console.log('Segments:', v2.segments?.length || 0);
  if (v2.segments) {
    for (const seg of v2.segments) {
      console.log(`  [${seg.start}-${seg.end}] "${seg.text}" words=${seg.words?.length || 0}`);
      if (seg.words && seg.words.length > 0) {
        console.log(`    Words:`, JSON.stringify(seg.words.slice(0, 5)));
      }
    }
  }

  // Test 4: whisper-large-v3 (not turbo) with word timestamps
  console.log('\n=== TEST 4: whisper-large-v3, language=hi, word+segment ===');
  const file4 = new File([smallChunk], 'test.wav', { type: 'audio/wav' });
  const r4 = await groq.audio.transcriptions.create({
    file: file4,
    model: 'whisper-large-v3',
    language: 'hi',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  });
  const v4 = r4 as any;
  console.log('Text:', v4.text?.slice(0, 100));
  console.log('Segments:', v4.segments?.length || 0);
  if (v4.segments) {
    for (const seg of v4.segments) {
      console.log(`  [${seg.start}-${seg.end}] "${seg.text}" words=${seg.words?.length || 0}`);
      if (seg.words && seg.words.length > 0) {
        console.log(`    Words:`, JSON.stringify(seg.words.slice(0, 5)));
      }
    }
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
