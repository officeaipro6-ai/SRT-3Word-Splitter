import { correctOdiaSpelling } from '../server/groqTranscriber';

const ODIA_BLOCK_RE = /^[\u0B00-\u0B7F]+$/;

const tests: Array<[string, string]> = [
  ['\u0B16\u0B47\u0B1A\u0B42\u0B21\u0B3F', 'ଖେଚୁଡ଼ି'],
  ['\u0B16\u0B47\u0B1A\u0B42\u0B21\u0B3F\u0B30\u0B40', 'ଖେଚୁଡ଼ିରେ'],
  ['\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B40', 'ଖେଚୁଡ଼ି'],
  ['ଲଖ୍ମୀ', 'ଲକ୍ଷ୍ମୀ'],
  ['ଜନେ', 'ଜଣେ'],
  ['କରୀ', 'କରି'],
  ['ଚାଲୀ', 'ଚାଲି'],
  ['ସମଯ', 'ସମୟ'],
  ['ସଦସ୍ଯ', 'ସଦସ୍ୟ'],
  ['ତାଂକା', 'ତାଂକ'],
  ['ତାଂକୋ', 'ତାଂକୁ'],
  ['ଜାଵ', 'ଯାଉ'],
  ['ଜାଓ', 'ଯାଉଛ'],
  ['ଜୀଵା', 'ଯିବା'],
  ['ଜେ', 'ଯେ'],
  ['ସାଧାଵ', 'ସାଧବ'],
  ['ସାଧାଵଂଗା', 'ସାଧବ'],
  ['ନଵ', 'ନ'],
  ['ଥିଵାରୂ', 'ଥିବାରୁ'],
  ['ନିସ୍ପତୀ', 'ନିଷ୍ପତ୍ତି'],
  ['ବୁଝୀ', 'ବୁଝି'],
  ['ଆଶୀ', 'ଆସି'],
  ['ଜେଉଠୀ', 'ଯେଉଁଠି'],
  ['\u0B2A\u0B4D\u0B30\u0B38\u0B28\u0B4D\u0B28\u0B4D\u0B4B\u0B02', 'ପ୍ରସନ୍ନ'],
  ['ପହନ', 'ପହଞ୍ଚିବ'],
  ['ମତ୍ଯୋଂ', 'ମଧ୍ୟ'],
  ['ସଂଧ୍ଯାରୈ', 'ସନ୍ଧ୍ୟାରେ'],
  ['ଆଵସ୍ଯ', 'ଆବଶ୍ୟକ'],
  // ---- corrections found in the 133-cue canonical SRT (incl. cues 126-132) ----
  ['ତାଂକ', 'ତାଙ୍କ'],
  ['ତାଂକୁ', 'ତାଙ୍କୁ'],
  ['ପହଂଚି', 'ପହଞ୍ଚି'],
  ['ହୋଈ', 'ହୋଇ'],
  ['ପକାଈ', 'ପକାଇ'],
  ['ପକାଈଲେ', 'ପକାଇଲେ'],
  ['ସଂଧ୍ଯାରେ', 'ସନ୍ଧ୍ୟାରେ'],
  ['ଆସୀଲେ', 'ଆସିଲେ'],
  ['ଆଶୀଲେ', 'ଆସିଲେ'],
  ['ଖୋଲୀ', 'ଖୋଲି'],
  ['କାହିଇଁକି', 'କାହିଁକି'],
  ['ଅମ଎ଗଳ', 'ଅମଙ୍ଗଳ'],
  ['ଆସୀବ', 'ଆସିବ'],
  ['ଦୁହ୍ଖ', 'ଦୁଃଖ'],
  ['ଖୁଶୀଖୁଶୀ', 'ଖୁସିଖୁସି'],
  ['ବୁଦ୍ଧିଯା', 'ବୁଦ୍ଧିଆ'],
  ['ବେଶୀ', 'ବେଶି'],
  ['ନାହିଂ', 'ନାହିଁ'],
];

let pass = 0;
let fail = 0;

for (const [input, expected] of tests) {
  const out = correctOdiaSpelling(input);
  const ok = out === expected;
  if (ok) pass++;
  else {
    fail++;
    const hexOut = Array.from(out).map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
    const hexExp = Array.from(expected).map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
    console.log(`FAIL: ${input} -> ${out} (want ${expected})`);
    console.log(`  OUT: ${hexOut}`);
    console.log(`  EXP: ${hexExp}`);
  }
  if (!ODIA_BLOCK_RE.test(out)) {
    fail++;
    console.log(`FAIL(badchar): ${input} produced non-Odia chars`);
  }
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
