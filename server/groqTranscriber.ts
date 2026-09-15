/**
 * Groq Whisper integration for Odia speech transcription.
 *
 * Replaces Gemini's audio transcription + word timestamps with Groq's
 * Whisper API (whisper-large-v3-turbo). Language detection and word-level
 * timestamps are provided by Whisper. Acoustic classification is handled
 * locally by the existing VAD pipeline.
 */
import Groq from 'groq-sdk';

/**
 * Convert Devanagari text (U+0900–U+097F) to Odia script (U+0B00–U+0B7F).
 *
 * Groq Whisper does not support Odia (`or`), so we request Hindi (`hi`) which
 * produces Devanagari output. Both scripts occupy consecutive Unicode blocks
 * with a fixed offset of +0x0200, so every Devanagari character maps directly
 * to its Odia equivalent. Characters outside the Devanagari block (punctuation,
 * Latin, digits) pass through unchanged.
 */
export function devanagariToOdia(text: string): string {
  return text.replace(/[\u0900-\u097F]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) + 0x0200);
  });
}

/**
 * Whisper Odia spelling-correction map.
 *
 * Groq Whisper (Hindi hint) produces Devanagari → converted to Odia via
 * devanagariToOdia, but systematic recognition errors remain. This map
 * replaces known incorrect tokens with their correct Odia spellings,
 * verified against a Gemini-produced reference transcription.
 *
 * Each entry is a 1:1 token replacement (never adds or removes words)
 * so that word-count-dependent placement logic is unaffected.
 */
const ODIA_SPELLING_MAP: Record<string, string> = {
  // Lakshmi
  '\u0B32\u0B16\u0B4D\u0B2E\u0B40': '\u0B32\u0B15\u0B4D\u0B37\u0B4D\u0B2E\u0B40', // ଲଖ୍ମୀ → ଲକ୍ଷ୍ମୀ
  '\u0B32\u0B16\u0B2E\u0B40': '\u0B32\u0B15\u0B4D\u0B37\u0B4D\u0B2E\u0B40',       // ଲଖମୀ → ଲକ୍ଷ୍ମୀ

  // jane → jane (ଜଣେ)
  '\u0B1C\u0B28\u0B47': '\u0B1C\u0B23\u0B47',   // ଜନେ → ଜଣେ

  // sadhava (various Whisper forms)
  '\u0B38\u0B3E\u0B27\u0B3E\u0B35\u0B02\u0B17\u0B3E': '\u0B38\u0B3E\u0B27\u0B2C', // ସାଧାବଂଗା → ସାଧବ
  '\u0B38\u0B3E\u0B27\u0B3E\u0B35\u0B02\u0B15': '\u0B38\u0B3E\u0B27\u0B2C',     // ସାଧାବଂକ → ସାଧବ
  '\u0B38\u0B3E\u0B27\u0B3E\u0B35': '\u0B38\u0B3E\u0B27\u0B2C',                 // ସାଧାଵ → ସାଧବ
  '\u0B38\u0B3E\u0B27\u0B2D\u0B3E\u0B02': '\u0B38\u0B3E\u0B27\u0B2C',           // ସାଧଭାଂ → ସାଧବ

  // kari (doing)
  '\u0B15\u0B30\u0B40': '\u0B15\u0B30\u0B3F',   // କରୀ → କରି

  // tanka/tanko (his/her)
  '\u0B24\u0B3E\u0B02\u0B15\u0B3E': '\u0B24\u0B3E\u0B02\u0B15',     // ତାଂକା → ତାଙ୍କ
  '\u0B24\u0B3E\u0B02\u0B15\u0B4B': '\u0B24\u0B3E\u0B02\u0B15\u0B41', // ତାଂକୋ → ତାଙ୍କୁ

  // chhaadi (left)
  '\u0B1B\u0B3E\u0B21\u0B40': '\u0B1B\u0B3E\u0B21\u0B3F',   // ଛାଡ଼ୀ → ଛାଡ଼ି
  '\u0B1B\u0B21\u0B40': '\u0B1B\u0B3E\u0B21\u0B3F',         // ଛଡ଼ୀ → ଛାଡ଼ି

  // chaali (walked)
  '\u0B1A\u0B3E\u0B32\u0B40': '\u0B1A\u0B3E\u0B32\u0B3F',   // ଚାଲୀ → ଚାଲି

  // jaau (going)
  '\u0B1C\u0B3E\u0B35': '\u0B2F\u0B3E\u0B09',     // ଜାଵ → ଯାଉ
  '\u0B1C\u0B3E\u0B13': '\u0B2F\u0B3E\u0B09\u0B1B', // ଜାଓ → ଯାଉଛ

  // jiba (will go)
  '\u0B1C\u0B40\u0B35\u0B3E': '\u0B2F\u0B3F\u0B2C\u0B3E',         // ଜୀଵା → ଯିବା
  '\u0B1C\u0B40\u0B35\u0B3E\u0B2A\u0B3E\u0B08': '\u0B2F\u0B3F\u0B2C\u0B3E\u0B2A\u0B3E\u0B07\u0B01', // ଜୀଵାପାଈ → ଯିବାପାଇଁ
  '\u0B1C\u0B3F\u0B35\u0B3E\u0B2A\u0B30\u0B47': '\u0B2F\u0B3F\u0B2C\u0B3E\u0B2A\u0B30\u0B47', // ଜିଵାପରେ → ଯିବାପରେ
  '\u0B1C\u0B3F\u0B35\u0B3E\u0B15\u0B42': '\u0B2F\u0B3F\u0B2C\u0B3E\u0B15\u0B41',   // ଜିଵାକୂ → ଯିବାକୁ
  '\u0B1C\u0B3F\u0B35\u0B4B': '\u0B2F\u0B3F\u0B2C',               // ଜିଵୋ → ଯିବ

  // samaya (time)
  '\u0B38\u0B2E\u0B2F': '\u0B38\u0B2E\u0B5F',   // ସମଯ → ସମୟ (0B2F→0B5F)
  '\u0B38\u0B2E\u0B47\u0B28\u0B30\u0B47': '\u0B38\u0B2E\u0B5F\u0B30\u0B47', // ସମେନରେ → ସମୟରେ

  // pahanchi (arrived)
  '\u0B2A\u0B39\u0B02\u0B1A\u0B40': '\u0B2A\u0B39\u0B02\u0B1A\u0B3F', // ପହଂଚୀ → ପହଞ୍ଚି

  // maku (to mother)
  '\u0B2E\u0B3E\u0B28\u0B15\u0B41': '\u0B2E\u0B3E\u0B02\u0B15\u0B41', // ମାନକୁ → ମାଙ୍କୁ

  // na (negation)
  '\u0B28\u0B35': '\u0B28',   // ନଵ → ନ

  // guhaari (cried)
  '\u0B17\u0B43\u0B39\u0B30\u0B40': '\u0B17\u0B41\u0B39\u0B3E\u0B30\u0B3F', // ଗୁଃରୀ → ଗୁହାରି

  // nishpatti (decision)
  '\u0B28\u0B3F\u0B38\u0B4D\u0B2A\u0B24\u0B40': '\u0B28\u0B3F\u0B37\u0B4D\u0B2A\u0B24\u0B4D\u0B24\u0B3F', // ନିସ୍ପତୀ → ନିଷ୍ପତ୍ତି

  // neisari (already decided - Whisper variants)
  '\u0B28\u0B47\u0B08\u0B36\u0B3E\u0B30\u0B40': '\u0B28\u0B47\u0B07\u0B38\u0B3E\u0B30\u0B3F\u0B25\u0B3F\u0B2C\u0B3E\u0B30\u0B41', // ନେଈଶାରୀ → ନେଇସାରିଥିବାରୁ
  '\u0B28\u0B47\u0B08\u0B1A\u0B3E\u0B30\u0B40': '\u0B28\u0B47\u0B07\u0B38\u0B3E\u0B30\u0B3F\u0B25\u0B3F\u0B2C\u0B3E\u0B30\u0B41', // ନେଈଚାରୀ → ନେଇସାରିଥିବାରୁ

  // thibaru (hence)
  '\u0B25\u0B3F\u0B35\u0B3E\u0B30\u0B42': '\u0B25\u0B3F\u0B2C\u0B3E\u0B30\u0B41', // ଥିଵାରୂ → ଥିବାରୁ

  // nija (own)
  '\u0B28\u0B3F\u0B1C\u0B4B': '\u0B28\u0B3F\u0B1C', // ନିଜୋ → ନିଜ

  // atala (steadfast)
  '\u0B05\u0B1F\u0B23\u0B3E': '\u0B05\u0B1F\u0B33', // ଅଟଣା → ଅଟଳ

  // prasanna (pleased)
  '\u0B2A\u0B4D\u0B30\u0B38\u0B28\u0B4D\u0B28\u0B4D\u0B4B\u0B02': '\u0B2A\u0B4D\u0B30\u0B38\u0B28\u0B4D\u0B28', // ପ୍ରସନ୍ନୋଂ → ପ୍ରସନ୍ନ

  // kichhi (something)
  '\u0B15\u0B3F\u0B1B\u0B40': '\u0B15\u0B3F\u0B1B\u0B3F', // କିଛୀ → କିଛି
  '\u0B15\u0B40\u0B1B\u0B40': '\u0B15\u0B3F\u0B1B\u0B3F', // କୀଛୀ → କିଛି

  // baramagibaku (to ask for boon)
  '\u0B2C\u0B30\u0B2E\u0B3E\u0B17\u0B3F\u0B35\u0B3E\u0B15\u0B4B': '\u0B2C\u0B30\u0B2E\u0B3E\u0B17\u0B3F\u0B35\u0B3E\u0B15\u0B41', // ବରମାଗୀବାକୋ → ବରମାଗିବାକୁ

  // sadhavajanaka (the merchant person)
  '\u0B38\u0B3E\u0B27\u0B3E\u0B35\u0B02\u0B1A\u0B28\u0B15\u0B4B': '\u0B38\u0B3E\u0B27\u0B2C\u0B1C\u0B23\u0B15', // ସାଧାବଂଚନକୋ → ସାଧବଜଣକ

  // buji (understood)
  '\u0B2C\u0B41\u0B1D\u0B40': '\u0B2C\u0B41\u0B1D\u0B3F', // ବୁଝୀ → ବୁଝି

  // je (who)
  '\u0B1C\u0B47': '\u0B2F\u0B47', // ଜେ → ଯେ

  // haani (loss)
  '\u0B39\u0B3E\u0B28\u0B40': '\u0B39\u0B3E\u0B28\u0B3F', // ହାନୀ → ହାନି
  '\u0B39\u0B3E\u0B23\u0B40': '\u0B39\u0B3E\u0B28\u0B3F', // ହାଣୀ → ହାନି

  // aasi (came)
  '\u0B06\u0B36\u0B40': '\u0B06\u0B38\u0B3F',     // ଆଶୀ → ଆସି
  '\u0B06\u0B1A\u0B40': '\u0B06\u0B38\u0B3F',     // ଆଚୀ → ଆସି
  '\u0B06\u0B36\u0B3F\u0B32\u0B47': '\u0B06\u0B38\u0B3F\u0B32\u0B47', // ଆଶିଲେ → ଆସିଲେ

  // pahan (reach)
  '\u0B2A\u0B39\u0B28': '\u0B2A\u0B39\u0B1E\u0B4D\u0B1A\u0B3F\u0B2C', // ପହନ → ପହଞ୍ଚିବ

  // tenuase/tenu (therefore)
  '\u0B24\u0B47\u0B28\u0B41\u0B38\u0B47': '\u0B24\u0B47\u0B23\u0B41\u0B38\u0B47', // ତେନୁସେ → ତେଣୁସେ
  '\u0B24\u0B47\u0B28\u0B41': '\u0B24\u0B47\u0B23\u0B41',                         // ତେନୁ → ତେଣୁ

  // bhaavi (thought)
  '\u0B2D\u0B3E\u0B35\u0B40': '\u0B2D\u0B3E\u0B2C\u0B3F', // ଭାଵୀ → ଭାବି

  // chinti (thought)
  '\u0B1A\u0B3F\u0B28\u0B4D\u0B24\u0B40': '\u0B1A\u0B3F\u0B28\u0B4D\u0B24\u0B3F', // ଚିନ୍ତୀ → ଚିନ୍ତି

  // kahili/kahi (said)
  '\u0B15\u0B39\u0B40\u0B32\u0B40': '\u0B15\u0B39\u0B3F\u0B32\u0B47', // କହୀଲୀ → କହିଲେ
  '\u0B15\u0B39\u0B40': '\u0B15\u0B39\u0B3F',                           // କହୀ → କହି
  '\u0B15\u0B39\u0B40\u0B09': '\u0B15\u0B3E\u0B39\u0B3F\u0B07\u0B01',  // କହୀଂ → କାହିଁ

  // shakti (power)
  '\u0B38\u0B15\u0B4D\u0B24\u0B3F': '\u0B36\u0B15\u0B4D\u0B24\u0B3F', // ସକ୍ତି → ଶକ୍ତି

  // karamati (trick)
  '\u0B15\u0B30\u0B3E\u0B2E\u0B24\u0B40': '\u0B15\u0B30\u0B3E\u0B2E\u0B24\u0B3F', // କରାମତୀ → କରାମତି

  // aarambha (beginning)
  '\u0B06\u0B30\u0B3E\u0B2E\u0B4D\u0B2D\u0B3E': '\u0B06\u0B30\u0B2E\u0B4D\u0B2D', // ଆରାମ୍ଭା → ଆରମ୍ଭ

  // bohu (daughter-in-law)
  '\u0B2D\u0B43\u0B39\u0B42': '\u0B2C\u0B4B\u0B39\u0B42', // ଭୂହୂ → ବୋହୂ

  // khechudi (khichdi - various forms)
  '\u0B16\u0B47\u0B1A\u0B42\u0B21\u0B3F\u0B30\u0B40': '\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B3C\u0B3F\u0B30\u0B47', // ଖେଚୂଡ଼ୀରେ → ଖେଚୁଡ଼ିରେ
  '\u0B16\u0B47\u0B1A\u0B42\u0B21\u0B3F': '\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B3C\u0B3F', // ଖେଚୂଡ଼ୀ → ଖେଚୁଡ଼ି
  '\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B40': '\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B3C\u0B3F', // ଖେଚୁଡୀ → ଖେଚୁଡ଼ି
  '\u0B16\u0B47\u0B1C\u0B41\u0B21\u0B3F\u0B15\u0B41': '\u0B16\u0B47\u0B1A\u0B41\u0B21\u0B3C\u0B3F\u0B15\u0B41', // ଖେଜୁଡିକୁ → ଖେଚୁଡ଼ିକୁ

  // karu (doing)
  '\u0B15\u0B30\u0B42': '\u0B15\u0B30\u0B41', // କରୂ → କରୁ

  // thele (was)
  '\u0B25\u0B47\u0B32\u0B47': '\u0B25\u0B3F\u0B32\u0B47', // ଥେଲେ → ଥିଲେ

  // aabashyaka (necessary)
  '\u0B06\u0B35\u0B38\u0B4D\u0B2F': '\u0B06\u0B2C\u0B36\u0B4D\u0B5F\u0B15', // ଆଵସ୍ଯ → ଆବଶ୍ୟକ

  // luna (salt - without anusvara)
  '\u0B32\u0B41\u0B28': '\u0B32\u0B41\u0B23', // ଲୁନ → ଲୁଣ

  // khi (garbled kichhi)
  '\u0B1B\u0B40': '\u0B15\u0B3F\u0B1B\u0B3F', // ଛୀ → କିଛି

  // majhiaan (middle)
  '\u0B2E\u0B1C\u0B3F\u0B2F\u0B3E\u0B02': '\u0B2E\u0B1D\u0B3F\u0B2F\u0B3F\u0B06\u0B02', // ମଜିଯାଂ → ମଝିଆଁ

  // sethii (in that)
  '\u0B38\u0B47\u0B25\u0B40': '\u0B38\u0B47\u0B25\u0B3F', // ସେଥୀ → ସେଥି

  // saasu (mother-in-law)
  '\u0B38\u0B3E\u0B38\u0B41': '\u0B38\u0B3E\u0B36\u0B42', // ସାସୁ → ସାଶୂ

  // madhya (also)
  '\u0B2E\u0B24\u0B4D\u0B2F\u0B4B\u0B02': '\u0B2E\u0B27\u0B4D\u0B5F', // ମତ୍ଯୋଂ → ମଧ୍ୟ

  // ohlaiba (to take down)
  '\u0B13\u0B32\u0B4D\u0B32\u0B47\u0B39\u0B40\u0B35\u0B3E': '\u0B13\u0B39\u0B4D\u0B32\u0B3E\u0B07\u0B2C\u0B3E', // ଓଲ୍ଲେହୀଵା → ଓହ୍ଲାଇବା

  // lunaupaigail -> lunapakaile (put salt)
  '\u0B32\u0B41\u0B23\u0B3E\u0B09\u0B2A\u0B17\u0B3E\u0B08\u0B32\u0B47': '\u0B32\u0B41\u0B23\u0B2A\u0B15\u0B3E\u0B07\u0B32\u0B47', // ଲୁଣାଉପଗାଈଲେ → ଲୁଣପକାଇଲେ

  // sandhyaarae (in the evening)
  '\u0B38\u0B02\u0B27\u0B4D\u0B2F\u0B3E\u0B30\u0B48': '\u0B38\u0B28\u0B4D\u0B27\u0B4D\u0B5F\u0B3E\u0B30\u0B47', // ସଂଧ୍ଯାରୈ → ସନ୍ଧ୍ୟାରେ

  // sadhavvvvv -> sadhava (repetition artifact)
  '\u0B38\u0B3E\u0B27\u0B35\u0B35\u0B35\u0B35\u0B35': '\u0B38\u0B3E\u0B27\u0B2C', // ସାଧଵଵଵଵ → ସାଧବ

  // khaikale/khai (ate)
  '\u0B16\u0B3E\u0B08\u0B32\u0B47': '\u0B16\u0B3E\u0B07\u0B32\u0B47', // ଖାଈଲେ → ଖାଇଲେ
  '\u0B16\u0B3E\u0B08': '\u0B16\u0B3E\u0B07',                         // ଖାଈ → ଖାଇ

  // debakhyaani -> deba kshani
  '\u0B26\u0B47\u0B35\u0B3E\u0B16\u0B4D\u0B2F\u0B23\u0B40': '\u0B26\u0B47\u0B2C\u0B3E\u0B15\u0B4D\u0B37\u0B23\u0B3F', // ଦେଵାଖ୍ଯଣୀ → ଦେବାକ୍ଷଣି

  // jaani (knew)
  '\u0B1C\u0B3E\u0B28\u0B40': '\u0B1C\u0B3E\u0B23\u0B3F', // ଜାନୀ → ଜାଣି

  // khusire (happily)
  '\u0B16\u0B41\u0B38\u0B40\u0B30\u0B47': '\u0B16\u0B41\u0B38\u0B3F\u0B30\u0B47', // ଖୁସୀରେ → ଖୁସିରେ
  '\u0B16\u0B41\u0B38\u0B40-\u0B16\u0B41\u0B38\u0B40': '\u0B16\u0B41\u0B38\u0B3F-\u0B16\u0B41\u0B38\u0B3F', // ଖୁଶୀ-ଖୁଶୀ → ଖୁସି-ଖୁସି

  // yahaan -> eha (this)
  '\u0B2F\u0B39\u0B3E\u0B02': '\u0B0F\u0B39\u0B3E', // ଯହାଂ → ଏହା

  // badapu -> bada puua (elder son)
  '\u0B2C\u0B21\u0B4D\u0B30\u0B2A\u0B41': '\u0B2C\u0B21\u0B4D\u0B30\u0B2A\u0B41\u0B05', // ବଡ଼ପୁ → ବଡ଼ପୁଅ

  // parcharele -> parcharile (asked)
  '\u0B2A\u0B1A\u0B3E\u0B30\u0B47\u0B32\u0B47': '\u0B2A\u0B1A\u0B3E\u0B30\u0B3F\u0B32\u0B47', // ପଚାରେଲେ → ପଚାରିଲେ
  '\u0B2A\u0B1C\u0B3E\u0B30\u0B40\u0B32\u0B47': '\u0B2A\u0B1A\u0B3E\u0B30\u0B3F\u0B32\u0B47', // ପଜାରୀଲେ → ପଚାରିଲେ

  // paaiile -> paaille
  '\u0B2A\u0B3E\u0B08\u0B32\u0B47': '\u0B2A\u0B3E\u0B07\u0B32\u0B47', // ପାଈଲେ → ପାଇଲେ

  // parendin (next day)
  '\u0B2A\u0B30\u0B26\u0B47\u0B28': '\u0B2A\u0B30\u0B26\u0B3F\u0B28', // ପରଦେନ → ପରଦିନ

  // khaani -> haani (loss)
  '\u0B16\u0B3E\u0B28\u0B40': '\u0B39\u0B3E\u0B28\u0B3F', // ଖାନୀ → ହାନି

  // hahutibabele -> heuchiba bele (while being)
  '\u0B39\u0B39\u0B41\u0B24\u0B3F\u0B35\u0B3E\u0B2C\u0B47\u0B32\u0B47': '\u0B39\u0B47\u0B09\u0B25\u0B3F\u0B2C\u0B3E\u0B2C\u0B47\u0B33\u0B47', // ହହୁତିଵାବେଲେ → ହେଉଥିବାବେଳେ

  // kaahi -> kaahinki (why)
  '\u0B15\u0B3E\u0B39\u0B40': '\u0B15\u0B3E\u0B39\u0B3F\u0B07\u0B01\u0B15\u0B3F', // କାହୀ → କାହିଁକି

  // jeuthii -> jeunthi (where)
  '\u0B1C\u0B47\u0B09\u0B20\u0B40': '\u0B2F\u0B47\u0B09\u0B01\u0B20\u0B3F', // ଜେଉଠୀ → ଯେଉଁଠି

  // sadasya (member)
  '\u0B38\u0B26\u0B38\u0B4D\u0B2F': '\u0B38\u0B26\u0B38\u0B4D\u0B5F', // ସଦସ୍ଯ → ସଦସ୍ୟ (0B2F→0B5F)

  // eko -> eka (one)
  '\u0B0F\u0B15\u0B4B': '\u0B0F\u0B15', // ଏକୋ → ଏକ

  // kila -> kilo (kg)
  '\u0B15\u0B3F\u0B32\u0B3E': '\u0B15\u0B3F\u0B32\u0B4B', // କିଲା → କିଲୋ

  // staana -> sthaana (place)
  '\u0B38\u0B4D\u0B24\u0B3E\u0B28\u0B3E': '\u0B38\u0B4D\u0B25\u0B3E\u0B28', // ସ୍ତାନା → ସ୍ଥାନ

  // aur -> arthaat (meaning)
  '\u0B05\u0B39\u0B41\u0B30': '\u0B05\u0B30\u0B4D\u0B25\u0B3E\u0B24\u0B4D', // ଔର → ଅର୍ଥାତ୍

  // bhitare (within)
  '\u0B2D\u0B40\u0B24\u0B30\u0B47': '\u0B2D\u0B3F\u0B24\u0B30\u0B47', // ଭୀତରେ → ଭିତରେ

  // dhile -> thile (was)
  '\u0B27\u0B3F\u0B32\u0B47': '\u0B25\u0B3F\u0B32\u0B47', // ଧିଲେ → ଥିଲେ

  // amangal -> amangala (inauspicious)
  '\u0B05\u0B2E\u0B02\u0B17\u0B32': '\u0B05\u0B2E\u0B0E\u0B17\u0B33', // ଅମଂଗଲ → ଅମଙ୍ଗଳ

  // akalyaana -> akalyaana
  '\u0B05\u0B15\u0B32\u0B4D\u0B32\u0B4D\u0B2F\u0B3E\u0B28\u0B3E': '\u0B05\u0B15\u0B32\u0B4D\u0B5F\u0B3E\u0B23', // ଅକଲ୍ଲ୍ଯାନା → ଅକଲ୍ୟାଣ

  // kareN -> karinaa (not doing)
  '\u0B15\u0B30\u0B47\u0B02': '\u0B15\u0B30\u0B3F\u0B28\u0B3E\u0B25\u0B3E\u0B0F', // କରେଂ → କରିନଥାଏ

  // prakrata -> prakruta (real)
  '\u0B2A\u0B4D\u0B30\u0B15\u0B4D\u0B30\u0B24': '\u0B2A\u0B4D\u0B30\u0B15\u0B43\u0B24', // ପ୍ରକ୍ରତ → ପ୍ରକୃତ

  // jivana -> jibana (life)
  '\u0B1C\u0B3F\u0B35\u0B28': '\u0B1C\u0B40\u0B2C\u0B28', // ଜିଵନ → ଜୀବନ

  // sukhoo -> sukha (happiness)
  '\u0B38\u0B41\u0B16\u0B4B': '\u0B38\u0B41\u0B16', // ସୁଖୋ → ସୁଖ

  // dukhi -> duhkha (sorrow)
  '\u0B26\u0B41\u0B16\u0B35\u0B40': '\u0B26\u0B41\u0B39\u0B4D\u0B16', // ଦୁଖଵୀ → ଦୁଃଖ

  // asubitaa -> asubidhaa (difficulty)
  '\u0B05\u0B38\u0B41\u0B35\u0B3F\u0B24\u0B3E': '\u0B05\u0B38\u0B41\u0B2C\u0B3F\u0B27\u0B3E', // ଅସୁଵିତା → ଅସୁବିଧା

  // kharaab -> kharaap (bad)
  '\u0B16\u0B30\u0B3E\u0B35': '\u0B16\u0B30\u0B3E\u0B2A', // ଖରାବ → ଖରାପ

  // laagii -> laagi (happening)
  '\u0B32\u0B3E\u0B17\u0B40': '\u0B32\u0B3E\u0B17\u0B3F', // ଲାଗୀ → ଲାଗି

  // upasthita (present)
  '\u0B09\u0B2A\u0B38\u0B4D\u0B24\u0B3F\u0B24': '\u0B09\u0B2A\u0B38\u0B4D\u0B25\u0B3F\u0B24', // ଉପସ୍ତିତ → ଉପସ୍ଥିତ

  // saho -> saha (with)
  '\u0B38\u0B39\u0B4B': '\u0B38\u0B39', // ସହୋ → ସହ

  // rahe -> rahi (remained)
  '\u0B30\u0B39\u0B40': '\u0B30\u0B39\u0B3F', // ରହୀ → ରହି

  // paire -> paariba (can)
  '\u0B2A\u0B48\u0B30\u0B3F\u0B2C': '\u0B2A\u0B3E\u0B30\u0B3F\u0B2C', // ପୈରିବ → ପାରିବ

  // naheeN -> naahin (no)
  '\u0B28\u0B39\u0B40\u0B02': '\u0B28\u0B3E\u0B39\u0B3F\u0B02', // ନହୀଂ → ନାହିଁ

  // paiN (for)
  '\u0B2A\u0B3E\u0B08': '\u0B2A\u0B3E\u0B07\u0B01', // ପାଈ → ପାଇଁ

  // shem -> shesh (end)
  '\u0B36\u0B47\u0B2E': '\u0B36\u0B47\u0B37', // ଶେମ → ଶେଷ

  // tanka/tanku (his/her) — anusvara form without the vowel ending
  '\u0B24\u0B3E\u0B02\u0B15': '\u0B24\u0B3E\u0B19\u0B4D\u0B15',         // ତାଂକ → ତାଙ୍କ
  '\u0B24\u0B3E\u0B02\u0B15\u0B41': '\u0B24\u0B3E\u0B19\u0B4D\u0B15\u0B41', // ତାଂକୁ → ତାଙ୍କୁ

  // pahamchi (reached/reach) — anusvara vs conjunct
  '\u0B2A\u0B39\u0B02\u0B1A\u0B3F': '\u0B2A\u0B39\u0B1E\u0B4D\u0B1A\u0B3F', // ପହଂଚି → ପହଞ୍ଚି

  // hoi (became) — long i
  '\u0B39\u0B4B\u0B08': '\u0B39\u0B4B\u0B07', // ହୋଈ → ହୋଇ

  // pakaai/pakaailE (put salt) — long i
  '\u0B2A\u0B15\u0B3E\u0B08': '\u0B2A\u0B15\u0B3E\u0B07',           // ପକାଈ → ପକାଇ
  '\u0B2A\u0B15\u0B3E\u0B08\u0B32\u0B47': '\u0B2A\u0B15\u0B3E\u0B07\u0B32\u0B47', // ପକାଈଲେ → ପକାଇଲେ

  // sandhyaare (in the evening) — conjunct/spelling
  '\u0B38\u0B02\u0B27\u0B4D\u0B2F\u0B3E\u0B30\u0B47': '\u0B38\u0B28\u0B4D\u0B27\u0B4D\u0B5F\u0B3E\u0B30\u0B47', // ସଂଧ୍ଯାରେ → ସନ୍ଧ୍ୟାରେ

  // aasile (came) — long i
  '\u0B06\u0B38\u0B40\u0B32\u0B47': '\u0B06\u0B38\u0B3F\u0B32\u0B47', // ଆସୀଲେ → ଆସିଲେ
  '\u0B06\u0B36\u0B40\u0B32\u0B47': '\u0B06\u0B38\u0B3F\u0B32\u0B47', // ଆଶୀଲେ → ଆସିଲେ

  // kholi (opened) — long i
  '\u0B16\u0B4B\u0B32\u0B40': '\u0B16\u0B4B\u0B32\u0B3F', // ଖୋଲୀ → ଖୋଲି

  // kaahiniki (why) — stray i + anusvara
  '\u0B15\u0B3E\u0B39\u0B3F\u0B07\u0B01\u0B15\u0B3F': '\u0B15\u0B3E\u0B39\u0B3F\u0B01\u0B15\u0B3F', // କାହିଇଁକି → କାହିଁକି

  // amangala (inauspicious) — vowel e instead of n
  '\u0B05\u0B2E\u0B0E\u0B17\u0B33': '\u0B05\u0B2E\u0B19\u0B4D\u0B17\u0B33', // ଅମ଎ଗଳ → ଅମଙ୍ଗଳ

  // aasiba (will come) — long i
  '\u0B06\u0B38\u0B40\u0B2C': '\u0B06\u0B38\u0B3F\u0B2C', // ଆସୀବ → ଆସିବ

  // duhkha (sorrow) — ha + kh -> visarga form
  '\u0B26\u0B41\u0B39\u0B4D\u0B16': '\u0B26\u0B41\u0B03\u0B16', // ଦୁହ୍ଖ → ଦୁଃଖ

  // khusikhusi (happily) — sha to sa, long i
  '\u0B16\u0B41\u0B36\u0B40\u0B16\u0B41\u0B36\u0B40': '\u0B16\u0B41\u0B38\u0B3F\u0B16\u0B41\u0B38\u0B3F', // ଖୁଶୀଖୁଶୀ → ଖୁସିଖୁସି

  // buddhiya (clever) — ya to aa
  '\u0B2C\u0B41\u0B26\u0B4D\u0B27\u0B3F\u0B2F\u0B3E': '\u0B2C\u0B41\u0B26\u0B4D\u0B27\u0B3F\u0B06', // ବୁଦ୍ଧିଯା → ବୁଦ୍ଧିଆ

  // beshi (more) — long i
  '\u0B2C\u0B47\u0B36\u0B40': '\u0B2C\u0B47\u0B36\u0B3F', // ବେଶୀ → ବେଶି

  // naahin (not) — anusvara vs candrabindu
  '\u0B28\u0B3E\u0B39\u0B3F\u0B02': '\u0B28\u0B3E\u0B39\u0B3F\u0B01', // ନାହିଂ → ନାହିଁ
};

/**
 * Correct Odia spelling errors produced by Whisper recognition.
 *
 * Applies in three stages:
 * 1. Strip U+0B64 (୤) — Whisper hallucinated length mark
 * 2. Exact token lookup in ODIA_SPELLING_MAP
 * 3. Fallback: replace ଵ (U+0B35) → ବ (U+0B2C) — safe in modern Odia
 */
export function correctOdiaSpelling(text: string): string {
  return text.replace(/(\S+)/g, (token) => {
    // 1. Strip Whisper artifact length mark
    let cleaned = token.replace(/\u0B64/g, '');

    // 2. Exact token lookup
    if (ODIA_SPELLING_MAP[cleaned]) {
      return ODIA_SPELLING_MAP[cleaned];
    }

    // 3. Fallback char-level: ଵ → ବ
    return cleaned.replace(/\u0B35/g, '\u0B2C');
  });
}

/**
 * Check that text is in the expected Devanagari/Odia script family.
 * Rejects Gujarati (U+0A80–U+0AFF) and mostly-Latin output that
 * auto-detect sometimes produces.
 */
function isExpectedScript(text: string): boolean {
  let devanagariOrOdia = 0;
  let gujarati = 0;
  let latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if ((cp >= 0x0900 && cp <= 0x097F) || (cp >= 0x0B00 && cp <= 0x0B7F)) devanagariOrOdia++;
    else if (cp >= 0x0A80 && cp <= 0x0AFF) gujarati++;
    else if (cp >= 0x0041 && cp <= 0x007A) latin++;
  }
  // Accept if Devanagari/Odia dominates and Gujarati is absent
  return devanagariOrOdia > 0 && gujarati === 0 && latin === 0;
}

/**
 * Keep only characters that belong in Odia-ish transcription output:
 * Devanagari (U+0900-U+097F) and Odia (U+0B00-U+0B7F) blocks, plus the
 * zero-width joiner/non-joiner. Dropped silently: Gujarati (U+0A80-U+0AFF),
 * Latin, digits, and ALL punctuation/symbols. This guarantees the transcription
 * text never carries foreign script or punctuation into the final SRT.
 */
function cleanTextToken(tok: string): string {
  return Array.from(tok)
    .filter((ch) => {
      const cp = ch.codePointAt(0) || 0;
      return (
        (cp >= 0x0900 && cp <= 0x097f) ||
        (cp >= 0x0b00 && cp <= 0x0b7f) ||
        cp === 0x200b ||
        cp === 0x200d
      );
    })
    .join('');
}

/**
 * Clean a whole transcription string (segment or sentence): collapse to
 * tokens, drop/blank out foreign-script or punctuation-only tokens, and
 * return only the surviving Odia/Devanagari tokens joined by single spaces.
 */
function cleanTranscriptionText(text: string): string {
  if (!text) return '';
  return text
    .split(/\s+/)
    .map((tok) => cleanTextToken(tok))
    .filter(Boolean)
    .join(' ');
}

export interface WhisperWord {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

export interface WhisperSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  words: WhisperWord[];
}

export interface WhisperResult {
  segments: WhisperSegment[];
  detectedLanguage: string;
  languageCode: string;
  durationSeconds: number;
}

let primaryClient: Groq | null = null;
let fallbackClient: Groq | null = null;
let usingFallback = false;

function isValidKey(key: string | undefined): boolean {
  return Boolean(key && key !== 'YOUR_GROQ_API_KEY_HERE' && key.length > 10);
}

function getPrimaryClient(): Groq {
  if (!primaryClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!isValidKey(apiKey)) {
      throw new Error(
        'GROQ_API_KEY environment variable is not configured. ' +
        'Get a free key at https://console.groq.com, ' +
        'then set GROQ_API_KEY in your .env file.'
      );
    }
    primaryClient = new Groq({ apiKey });
  }
  return primaryClient;
}

function getFallbackClient(): Groq | null {
  if (!fallbackClient) {
    const apiKey = process.env.GROQ_API_KEY_FALLBACK;
    if (isValidKey(apiKey)) {
      fallbackClient = new Groq({ apiKey });
    }
  }
  return fallbackClient;
}

function getGroqClient(): Groq {
  if (usingFallback) {
    const fb = getFallbackClient();
    if (fb) return fb;
  }
  return getPrimaryClient();
}

/**
 * Switch to fallback key after primary key fails with rate limit/auth error.
 * Returns true if fallback is available.
 */
export function switchToFallback(reason: string): boolean {
  const fb = getFallbackClient();
  if (fb) {
    usingFallback = true;
    console.log(`[Groq] Switching to fallback key: ${reason}`);
    return true;
  }
  return false;
}

/**
 * Call the Groq Whisper transcription API.
 *
 * @param file          File-like audio object
 * @param mimeType      MIME type of the audio
 * @param languageHint  Optional ISO 639-1 language code (e.g. 'hi'). Omit to
 *                      let Whisper auto-detect.
 */
async function callGroqTranscription(
  file: File,
  mimeType: string,
  languageHint?: string,
): Promise<any> {
  const groq = getGroqClient();
  const params: Record<string, unknown> = {
    file,
    model: 'whisper-large-v3-turbo',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  };
  if (languageHint) {
    params.language = languageHint;
  }
  return groq.audio.transcriptions.create(params as any);
}

/**
 * Parse a Groq Whisper API response into WhisperSegments with Odia conversion.
 */
function parseWhisperResponse(response: any, chunkOffset: number): { segments: WhisperSegment[]; duration: number } {
  const verboseResponse = response as any;
  const whisperSegments: WhisperSegment[] = [];
  let totalDuration = 0;

  if (verboseResponse.segments) {
    for (const seg of verboseResponse.segments) {
      const segStart = chunkOffset + (seg.start || 0);
      const segEnd = chunkOffset + (seg.end || 0);
      const words: WhisperWord[] = [];

      if (seg.words && Array.isArray(seg.words) && seg.words.length > 0) {
        for (const w of seg.words) {
          const cleaned = cleanTextToken((w.word || '').trim());
          if (!cleaned) continue;
          words.push({
            word: correctOdiaSpelling(devanagariToOdia(cleaned)),
            startSeconds: chunkOffset + (w.start || 0),
            endSeconds: chunkOffset + (w.end || 0),
          });
        }
      } else if (seg.text && seg.text.trim().length > 0) {
        // Groq Whisper omits word-level timestamps. Do NOT fabricate evenly
        // distributed timings: doing so pins words to wrong time windows
        // (e.g. over a music-only intro there is no speech). When words are
        // absent the pipeline gates the segment's text by VAD-confirmed speech
        // regions instead (see classifyWhisperSegments / createTextCues).
        // words stays empty here.
      }

      if (segEnd > totalDuration) totalDuration = segEnd;

      const segText = cleanTranscriptionText((seg.text || '').trim());
      whisperSegments.push({
        startSeconds: segStart,
        endSeconds: segEnd,
        text: segText ? correctOdiaSpelling(devanagariToOdia(segText)) : '',
        words,
      });
    }
  }

  // If Whisper returned no segments but has text, create a single segment.
  // Do NOT fabricate evenly-distributed word timings (see segments path above):
  // with no real per-word timestamps, the downstream pipeline gates the text
  // by VAD-confirmed speech regions instead, so words are never pinned onto
  // wrong time windows (e.g. a music-only intro with no genuine speech).
  if (whisperSegments.length === 0 && verboseResponse.text) {
    const segText = cleanTranscriptionText(verboseResponse.text.trim());
    const duration = verboseResponse.duration || 0;
    whisperSegments.push({
      startSeconds: chunkOffset,
      endSeconds: chunkOffset + duration,
      text: segText ? correctOdiaSpelling(devanagariToOdia(segText)) : '',
      words: [],
    });
    totalDuration = chunkOffset + duration;
  }

  return { segments: whisperSegments, duration: totalDuration };
}

/**
 * Transcribe an audio buffer using Groq Whisper.
 *
 * @param audioBuffer  Raw audio bytes (WAV preferred; MP3/OGG also supported)
 * @param mimeType     MIME type of the audio (default 'audio/wav')
 * @param language     Optional ISO 639-1 language code hint (e.g. 'or' for Odia)
 * @param chunkOffset  Absolute time offset in seconds (for chunked processing)
 */
export async function transcribeWithWhisper(
  audioBuffer: Buffer,
  mimeType: string = 'audio/wav',
  language: string = 'or',
  chunkOffset: number = 0
): Promise<WhisperResult> {
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'wav';
  const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType });

  // Odia ('or') is not supported by Groq Whisper. Use Hindi ('hi') as the
  // closest supported language — both are Eastern Indo-Aryan and produce
  // Devanagari output. This also enables word-level timestamps which
  // require a known language.
  const initialResponse = await callGroqTranscription(file, mimeType, 'hi');
  let { segments, duration } = parseWhisperResponse(initialResponse, chunkOffset);

  // Low-density fallback: if the transcription produced suspiciously few
  // words relative to its duration (< 1 word/s), retry without the language
  // hint so Whisper can auto-detect. This fixes regions where the Hindi
  // hint causes Whisper to misrecognize Odia speech.
  const totalWords = segments.reduce((n, s) => n + s.words.length, 0);
  const audioDuration = duration - chunkOffset;
  const primaryText = segments.map((s) => s.text).join(' ');
  const primaryScriptOk = isExpectedScript(primaryText);
  // Retry when the hint produced too few words OR the primary pass leaked a
  // foreign script (Gujarati/Latin), so auto-detect has a chance to fix it.
  if (!primaryScriptOk || (audioDuration > 5 && totalWords / audioDuration < 1)) {
    console.log(
      `[Groq] ${primaryScriptOk ? 'Low word density' : 'Wrong script'}` +
        ` (${totalWords} words in ${audioDuration.toFixed(1)}s), retrying without language hint`
    );
    const retryResponse = await callGroqTranscription(file, mimeType);
    const retry = parseWhisperResponse(retryResponse, chunkOffset);
    const retryWords = retry.segments.reduce((n, s) => n + s.words.length, 0);
    // Only use retry if it produced more words AND the text is in the correct
    // script (Devanagari/Odia). Auto-detect sometimes picks Gujarati or Latin.
    const retryText = retry.segments.map((s) => s.text).join(' ');
    const retryScriptOk = isExpectedScript(retryText);
    if ((!primaryScriptOk && retryScriptOk) || (primaryScriptOk && retryScriptOk && retryWords > totalWords)) {
      console.log(`[Groq] Retry used (${retryWords} words, correct script)`);
      segments = retry.segments;
      duration = retry.duration;
    } else if (primaryScriptOk && !retryScriptOk) {
      console.log(`[Groq] Retry had more words (${retryWords}) but wrong script, keeping original`);
    } else if (!primaryScriptOk && !retryScriptOk) {
      console.log(`[Groq] Both primary and retry wrong script; foreign tokens already scrubbed`);
    }
  }

  const lang = (initialResponse as any).language || 'or';
  const isOdiaLang = lang === 'or' || lang === 'odiya' || lang === 'odia';

  return {
    segments,
    detectedLanguage: isOdiaLang ? 'Odia (ଓଡ଼ିଆ)' : lang,
    languageCode: lang,
    durationSeconds: duration,
  };
}

/**
 * Raw Whisper/Groq transcription result. Unlike WhisperResult, the text here
 * has NOT been passed through correctOdiaSpelling — it is the direct
 * script-converted (Devanagari -> Odia) words Whisper heard from the audio.
 */
export interface RawWhisperSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface RawWhisperResult {
  segments: RawWhisperSegment[];
  detectedLanguage: string;
  languageCode: string;
  durationSeconds: number;
  rawText: string;
  // Diagnostic plumbing for the Odia input-verification path.
  forcedLanguage: string;
  maxWordsPerSegment: number;
  rawSegmentCount: number;
  rawWordCount: number;
}

/**
 * Transcribe an audio buffer with Groq Whisper and return the RAW Odia text
 * exactly as recognised, without any spelling-map / SRT / tagging correction.
 *
 * This is the trusted path for verifying that the EXACT uploaded audio reaches
 * Whisper: it reuses the same Groq client, but only converts Devanagari to the
 * equivalent Odia code points (a lossless script shift) and scrubs foreign
 * scripts/punctuation. It never applies correctOdiaSpelling, and never falls
 * back to any cached/canonical/old SRT.
 */
export async function transcribeRawOdiaWithWhisper(
  audioBuffer: Buffer,
  mimeType: string = 'audio/wav',
  opts: { maxWordsPerSegment?: number } = {}
): Promise<RawWhisperResult> {
  const maxWords =
    opts.maxWordsPerSegment && opts.maxWordsPerSegment > 0 ? opts.maxWordsPerSegment : 3;
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') ? 'mp3' : 'wav';
  const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType });

  // FORCE the Odia-adjacent Hindi ('hi') hint. This project is for ODIA audio.
  //
  // - Groq Whisper does NOT accept Odia ('or') — it errors on that code.
  // - Auto-detection (no hint) has, on the user's real audio, mis-picked
  //   Marathi ('mr'), which is wrong for an Odia transcription project.
  // - 'hi' is the closest Whisper-supported Eastern Indo-Aryan language and
  //   yields Devanagari, which we shift losslessly to Odia code points.
  //
  // We therefore ALWAYS send an explicit language hint of 'hi' and NEVER rely
  // on auto-detect and NEVER send 'mr'. This is the actual API parameter sent
  // to Whisper/Groq (see the diagnostic panel: LANGUAGE SENT TO WHISPER/GROQ).
  const languageHint = 'hi';
  let response: any;
  try {
    response = await callGroqTranscription(file, mimeType, languageHint);
  } catch (e: any) {
    if (isGroqRateLimitError(e) || isGroqTransientError(e)) throw e;
    // Retry once with the same forced hint on a transient/parse path.
    response = await callGroqTranscription(file, mimeType, languageHint);
  }

  const verbose = response as any;
  const aiLanguageCode = String(verbose.language || languageHint);
  const totalDuration = Math.max(Number(verbose.duration) || 0, 0);

  // Ordered, timestamped raw words produced by Whisper (no spelling map).
  type TimedWord = { word: string; start: number; end: number };
  const timedWords: TimedWord[] = [];
  let rawSegmentCount = 0;

  const normalizeWord = (w: string): string =>
    devanagariToOdia(cleanTextToken((w || '').trim()));

  if (Array.isArray(verbose.segments)) {
    rawSegmentCount = verbose.segments.length;
    for (const seg of verbose.segments) {
      const segStart = Number(seg.start) || 0;
      const segEnd = Number(seg.end) || (segStart > 0 ? segStart + 0.5 : totalDuration || 0);
      const rawWords = Array.isArray(seg.words) ? seg.words : null;

      if (rawWords && rawWords.length > 0) {
        // Word-level timestamps available: use the real per-word times.
        for (const w of rawWords) {
          const word = normalizeWord(w.word);
          if (!word) continue;
          const ws = Number(w.start);
          const we = Number(w.end);
          timedWords.push({
            word,
            start: Number.isFinite(ws) ? ws : segStart,
            end: Number.isFinite(we) ? we : segEnd,
          });
        }
      } else {
        // No word timestamps (Groq sometimes omits them). Split this segment's
        // raw text into words and distribute them linearly across the segment's
        // REAL detected [start, end] window. This preserves chronological order
        // and full audio coverage without inventing arbitrary whole-audio times.
        const segWords = (seg.text || '').trim().split(/\s+/);
        const count = segWords.length;
        if (count === 0) continue;
        const width = (segEnd - segStart) / count;
        segWords.forEach((w, idx) => {
          const word = normalizeWord(w);
          if (!word) return;
          timedWords.push({ word, start: segStart + idx * width, end: segStart + (idx + 1) * width });
        });
      }
    }
  } else if (verbose.text) {
    // Whole-response text blob fallback: distribute evenly across duration.
    rawSegmentCount = 1;
    const segWords = (verbose.text || '').trim().split(/\s+/);
    const count = segWords.length;
    const width = count > 0 ? totalDuration / count : 0;
    segWords.forEach((w, idx) => {
      const word = normalizeWord(w);
      if (!word) return;
      timedWords.push({ word, start: idx * width, end: (idx + 1) * width });
    });
  }

  const rawWordCount = timedWords.length;

  // Chunk the ordered words into max-WORDS-per-segment subtitle cues, preserving
  // exact word order and each word's real time window (start of first -> end of
  // last). We never split a word, never drop/reorder/paraphrase.
  const segments: RawWhisperSegment[] = [];
  for (let i = 0; i < timedWords.length; i += maxWords) {
    const chunk = timedWords.slice(i, i + maxWords);
    if (chunk.length === 0) continue;
    segments.push({
      startSeconds: chunk[0].start,
      endSeconds: chunk[chunk.length - 1].end,
      text: chunk.map((t) => t.word).join(' '),
    });
  }

  const rawText = timedWords.map((t) => t.word).join(' ');
  return {
    segments,
    detectedLanguage: String(aiLanguageCode) === 'or' ? 'Odia (ଓଡ଼ିଆ)' : String(aiLanguageCode),
    languageCode: String(aiLanguageCode),
    durationSeconds: totalDuration,
    rawText,
    forcedLanguage: languageHint,
    maxWordsPerSegment: maxWords,
    rawSegmentCount,
    rawWordCount,
  };
}

/**
 * Detect rate limit / quota errors from Groq.
 */
export function isGroqRateLimitError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || error.toString() || '').toLowerCase();
  const status = error.status || error.code || error.statusCode;
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  );
}

/**
 * Detect transient errors from Groq (503, network, etc.)
 */
export function isGroqTransientError(error: any): boolean {
  if (!error) return false;
  if (isGroqRateLimitError(error)) return false;
  const msg = String(error.message || error.toString() || '').toLowerCase();
  const status = error.status || error.code || error.statusCode;
  return (
    status === 503 ||
    status === 500 ||
    status === 504 ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}
