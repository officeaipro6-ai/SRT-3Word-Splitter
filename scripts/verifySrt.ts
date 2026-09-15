import * as fs from 'fs';

const srt = fs.readFileSync('E:/Odia-SRT-App/ODIA_MP3-3.tagged.srt', 'utf8');

// bad tokens we must NOT find (as codepoint sequences of the decoded chars)
const badTokens = [
  'ଲଖ୍ମୀ',          // uncorrected lakshmi
  'ଲଖମୀ',          // uncorrected lakshmi variant
  'ଟାଉ',            // ଟ-for-ଯ bug
  'ଟିବା',           // ଟ-for-ଯ bug
  'ସମଯ',            // ya-identity bug (should be ସମୟ)
  'ସଦସ୍ଯ',          // ya-identity bug
  'ମଧ୍ଯ',            // should be ମଧ୍ୟ
];

function has(s: string, sub: string): boolean {
  return s.includes(sub);
}

let problems = 0;
for (const t of badTokens) {
  // only meaningful if the "correct" form also resolves; just report occurrences
  const n = srt.split(t).length - 1;
  if (n > 0) { problems++; console.log(`PRESENT(bad) count=${n}: ${Array.from(t).map(c=>'U+'+c.codePointAt(0)!.toString(16).toUpperCase()).join(' ')}`); }
}

// Confirm correct forms present
const goodTokens = ['ଲକ୍ଷ୍ମୀ','ଖେଚୁଡ଼ି','ଯାଉ','ଯିବା','ଯେ','ସମୟ','ସଦସ୍ୟ','ମଧ୍ୟ','ଜଣେ','କରି','ସାଧବ','ଥିବାରୁ','ପହଞ୍ଚିବ'];
console.log('\n--- CORRECT FORMS COUNTS ---');
for (const t of goodTokens) {
  console.log(`${Array.from(t).map(c=>c.codePointAt(0)!.toString(16).toUpperCase()).join(' ')} : ${srt.split(t).length - 1}`);
}

// scan full SRT for ANY codepoint outside Odia block / ASCII (CR LF tab space)
const badChars = new Set<number>();
for (const ch of srt) {
  const c = ch.codePointAt(0)!;
  const isOdia = c >= 0x0B00 && c <= 0x0B7F;
  const isAscii = c < 0x80;
  const isDevanagari = c >= 0x0900 && c <= 0x097F;
  const isTamil = c >= 0x0B80 && c <= 0x0BFF;
  const isNative = isOdia || isAscii;
  if (!isNative) badChars.add(c);
}
console.log('\nNon-Odia/non-ASCII chars in SRT:');
for (const c of badChars) console.log(`  U+${c.toString(16).toUpperCase()} ${String.fromCodePoint(c)}`);

process.exit(problems === 0 ? 0 : 1);
