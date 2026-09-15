import { readFileSync } from 'node:fs';
const raw = readFileSync('E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt','utf8');
const blocks = raw.split(/\r?\n\r?\n/).filter(b=>b.trim());
let max=0, maxCues=[];
for(const b of blocks){
  const lines=b.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2) continue;
  const text=lines.slice(2).join(' ').replace(/<\/?[A-Z]+>/g,'').trim();
  const wc=text?text.split(/\s+/).length:0;
  if(wc>max){max=wc;maxCues=[`cue ${lines[0]}: ${wc}w [${text}]`];}
  else if(wc===max && wc>=3){maxCues.push(`cue ${lines[0]}: ${wc}w [${text}]`);}
}
console.log('Max words per cue:', max);
console.log(maxCues.join('\n'));
