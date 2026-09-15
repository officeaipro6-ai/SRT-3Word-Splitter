
// Verify Devanagari → Odia mapping by comparing with reference SRT text.
// Reference: "ଦିନେ ମାଲକ୍ଷ୍ମୀ ଜଣେ ସାଧବଙ୍କ ଉପରେ"
// Groq output: "दिने मा लख्मी जने साधाबंगा उपरे"

function devanagariToOdia(text: string): string {
  return text.replace(/[\u0900-\u097F]/g, (ch) => {
    const code = ch.charCodeAt(0);
    // Offset mapping: Devanagari block (U+0900) → Odia block (U+0B00)
    return String.fromCharCode(code + 0x0200);
  });
}

// Test cases from actual Groq output
const groq = 'दिने मा लख्मी जने साधाबंगा उपरे अभिमान करी तांका घर छाड़ी चाली जाव देले';
const converted = devanagariToOdia(groq);
console.log('Groq (Devanagari):', groq);
console.log('Converted (Odia): ', converted);

// Expected Odia from reference SRT (line 11, 19, 27):
// ଦିନେ ମା ଲକ୍ଷ୍ମୀ ଜଣେ ସାଧବଙ୍କ ଉପରେ
// Our conversion won't match exactly because Groq word-splits differently,
// but individual characters should match the Odia block.
const refChar = 'ଦ'; // U+0B26
const groqChar = 'द'; // U+0926
const mappedChar = devanagariToOdia(groqChar);
console.log(`\nCharacter check: '${groqChar}' (U+${groqChar.charCodeAt(0).toString(16)}) → '${mappedChar}' (U+${mappedChar.charCodeAt(0).toString(16)})`);
console.log(`Expected Odia:   '${refChar}' (U+${refChar.charCodeAt(0).toString(16)})`);
console.log(`Match: ${mappedChar === refChar}`);

// Verify key characters
const pairs: [string, string][] = [
  ['द', 'ଦ'],   // d
  ['न', 'ନ'],   // n
  ['म', 'ମ'],   // m
  ['ल', 'ଲ'],   // l
  ['ख', 'ଖ'],   // kh
  ['ज', 'ଜ'],   // j
  ['स', 'ସ'],   // s
  ['ब', 'ବ'],   // b
  ['ग', 'ଗ'],   // g
  ['प', 'ପ'],   // p
  ['र', 'ର'],   // r
  ['क', 'କ'],   // k
  ['त', 'ତ'],   // t
  ['घ', 'ଘ'],   // gh
  ['छ', 'ଛ'],   // ch
  ['अ', 'ଅ'],   // a
  ['भ', 'ଭ'],   // bha
  ['ह', 'ହ'],   // h
  ['च', 'ଚ'],   // cha
  ['ध', 'ଧ'],   // dha
  ['श', 'ଶ'],   // sha
  ['ष', 'ଷ'],   // sha (retroflex)
  ['य', 'ଯ'],   // ya
  ['व', 'ଵ'],   // va
  ['ड', 'ଡ'],   // da (retroflex)
  ['ण', 'ଣ'],   // na (retroflex)
  ['फ', 'ଫ'],   // pha
  ['ठ', 'ଠ'],   // tha (retroflex)
  ['ट', 'ଟ'],   // ta (retroflex)
  ['थ', 'ଥ'],   // tha
  ['झ', 'ଝ'],   // jha
  ['ञ', 'ଞ'],   // nya
  ['ङ', 'ଙ'],   // nga
  ['उ', 'ଉ'],   // u
  ['ऊ', 'ଊ'],   // uu
  ['ऋ', 'ଋ'],   // ru
  ['ए', 'ଏ'],   // e
  ['ऐ', 'ଐ'],   // ai
  ['ओ', 'ଓ'],   // o
  ['औ', 'ଔ'],   // au
  // Matras
  ['ा', 'ା'],   // aa matra
  ['ि', 'ି'],   // i matra
  ['ी', 'ୀ'],   // ii matra
  ['ु', 'ୁ'],   // u matra
  ['ू', 'ୂ'],   // uu matra
  ['ृ', 'ୃ'],   // ru matra
  ['े', 'େ'],   // e matra
  ['ै', 'ୈ'],   // ai matra
  ['ो', 'ୋ'],   // o matra
  ['ौ', 'ୌ'],   // au matra
  // Signs
  ['ं', 'ଂ'],   // anusvara
  ['ः', 'ଃ'],   // visarga
  ['्', '୍'],   // virama (halant)
  ['़', '଼'],   // nukta → Odia nukta (U+0B3C)
];

let allPass = true;
for (const [dev, expectedOdia] of pairs) {
  const got = devanagariToOdia(dev);
  const pass = got === expectedOdia;
  if (!pass) {
    allPass = false;
    console.log(`FAIL: '${dev}' (U+${dev.charCodeAt(0).toString(16)}) → '${got}' (U+${got.charCodeAt(0).toString(16)}), expected '${expectedOdia}' (U+${expectedOdia.charCodeAt(0).toString(16)})`);
  }
}
console.log(`\nAll ${pairs.length} character mappings: ${allPass ? 'PASS' : 'FAIL'}`);

// Full sentence comparison with reference
const ref = 'ଦିନେ ମା ଲକ୍ଷ୍ମୀ ଜଣେ ସାଧବଙ୍କ ଉପରେ ଅଭିମାନ କରିତାଙ୍କ ଘର ଛାଡ଼ି ଚାଲି ଯାଇଥିଲେ';
const groqSentence = 'दिने मा लख्मी जने साधाबंगा उपरे अभिमान करी तांका घर छाड़ी चाली जाव देले';
const convertedSentence = devanagariToOdia(groqSentence);
console.log(`\nReference:   ${ref}`);
console.log(`Converted:   ${convertedSentence}`);
console.log(`\nNote: Word boundaries differ between Groq and reference, but individual Odia characters should match.`);
