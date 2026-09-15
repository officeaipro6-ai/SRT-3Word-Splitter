import { readFileSync } from 'node:fs';
const raw = readFileSync('E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt','utf8');
const blocks = raw.split(/\r?\n\r?\n/).filter(b=>b.trim());
console.log('=== Cues with >3 words ===');
for(const b of blocks){
  const lines=b.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2) continue;
  const tag=lines.slice(2).join(' ').match(/^<([A-Z]+)>/);
  if(tag && tag[1]==='NOISE') continue; // skip NOISE tags (tags don't count toward 3 words; NOISE wraps music speech)
  const text=lines.slice(2).join(' ').replace(/<\/?[A-Z]+>/g,'').trim();
  const wc=text?text.split(/\s+/).length:0;
  if(wc>3) console.log(`cue ${lines[0]}: ${wc} words  [${text}]`);
}
