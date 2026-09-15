import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseWav, createWavChunk } from '../server/audioAnalysis';
import { transcribeWithWhisper } from '../server/groqTranscriber';

const wav = parseWav(readFileSync('C:/Users/sures/AppData/Local/Temp/opencode/ODIA_MP3-3-16k.wav'))!;
const targets: { label: string; start: number; end: number }[] = [
  { label: 'cue68(92.7-94.325)', start: 92.7, end: 94.325 },
  { label: 'cue108(157.725-163.65)', start: 157.725, end: 163.65 },
];
for (const c of targets) {
  const buf = createWavChunk(wav.mono, wav.sampleRate, Math.round(c.start * wav.sampleRate), Math.round(c.end * wav.sampleRate));
  console.log(`\n=== ${c.label} ===`);
  try {
    const res = await transcribeWithWhisper(buf, 'audio/wav', 'or', c.start);
    for (const s of res.segments) {
      console.log('  seg text:', JSON.stringify(s.text));
      console.log('  words:', JSON.stringify((s.words || []).map((x) => `${x.word}[${x.startSeconds.toFixed(2)}-${x.endSeconds.toFixed(2)}]`)));
    }
  } catch (e: any) {
    console.log('  ERROR:', e?.message);
  }
}
