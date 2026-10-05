import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPOKEN_WORDS_PER_SEGMENT,
  chunkWordsByCount,
  findOptimalNaturalWordChunks,
  enforceMaxWordsPerSegment,
  enforceTimeLimitsPerSegment,
  generateSrtContent,
  applyTaggingRule,
  auditRuleCompliance,
  countWords,
} from '../../src/utils/srtRules.ts';
import type { SubtitleSegment } from '../../src/types.ts';

/**
 * FROZEN PRODUCTION SEGMENTATION RULE
 * ===================================
 *  1. Maximum 3 SPOKEN words per normal subtitle segment.
 *  2. Normal spoken segments hold 2-3 spoken words.
 *  3. 4+ spoken words in a normal segment is NOT allowed.
 *  4. Word count is the PRIMARY segmentation constraint. Duration follows the
 *     natural speech timing of the real audio and is NOT itself a rule.
 *  5. No word is ever split mid-word, omitted, invented, reordered or
 *     paraphrased.
 *  6. Every spoken occurrence appears EXACTLY ONCE. Legitimate repetition
 *     ("haan haan mu jibi") MUST survive; a boundary word copied into two
 *     adjacent segments MUST NOT.
 *
 * These tests target the ACTIVE production path (buildMax3WordSegments in
 * server.ts, which groups words via findOptimalNaturalWordChunks) plus the
 * SRT export path (generateSrtContent).
 */

const MAX = MAX_SPOKEN_WORDS_PER_SEGMENT; // 3

/** Import the real production pipeline without binding a port. */
process.env.ODIA_SKIP_SERVER = '1';
const { buildMax3WordSegments } = (await import('../../server.ts')) as {
  buildMax3WordSegments: (
    rawTranscript: string,
    totalDuration: number,
    wordTimings: Array<{ text: string; startSeconds: number; endSeconds: number }>,
    scalingFactor?: number
  ) => SubtitleSegment[];
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Group sizes of the produced cues, e.g. [3, 3, 1]. */
const sizes = (segs: SubtitleSegment[]): number[] =>
  segs.map((s) => s.text.split(/\s+/).filter(Boolean).length);

/** Every spoken token across all cues, in order. */
const tokens = (segs: SubtitleSegment[]): string[] =>
  segs.flatMap((s) => s.text.split(/\s+/).filter(Boolean));

/** Cue-wise token lists. */
const groups = (segs: SubtitleSegment[]): string[][] =>
  segs.map((s) => s.text.split(/\s+/).filter(Boolean));

/**
 * Run the ACTIVE production segmentation path. Sarvam returns phrase/segment
 * timestamps (timestamps.chunks), never 1:1 word timings, so production always
 * takes the phrase-anchor branch inside buildMax3WordSegments.
 */
function segment(
  words: string[],
  opts: { phrases?: Array<[number, number]>; wordTimings?: Array<{ text: string; startSeconds: number; endSeconds: number }> } = {}
): SubtitleSegment[] {
  const raw = words.join(' ');
  const duration = opts.wordTimings
    ? opts.wordTimings[opts.wordTimings.length - 1].endSeconds
    : (opts.phrases?.[opts.phrases.length - 1]?.[1] ?? words.length * 0.4);
  const timings =
    opts.wordTimings ??
    (opts.phrases ?? [[0, duration]]).map(([s, e], i) => ({
      text: '',
      startSeconds: s,
      endSeconds: e,
    }));
  return buildMax3WordSegments(raw, duration, timings, 1);
}

/** Sorted-token equality: proves nothing lost, duplicated, invented or reordered. */
function sameWordMultiset(source: string[], out: string[]): boolean {
  return source.slice().sort().join('|') === out.slice().sort().join('|');
}

function mkSeg(over: Partial<SubtitleSegment> = {}): SubtitleSegment {
  const start = over.startSeconds ?? 0;
  const end = over.endSeconds ?? start + 1;
  return {
    id: 1,
    startSeconds: start,
    endSeconds: end,
    startTimeFormatted: '00:00:00,000',
    endTimeFormatted: '00:00:01,000',
    text: '',
    classification: 'CLEAR_SPEECH',
    taggedText: '',
    confidence: 0.98,
    ...over,
  };
}

/** Count adjacent cues that repeat the same word across the boundary. */
function boundaryDuplicates(segs: SubtitleSegment[]): number {
  const g = groups(segs);
  let n = 0;
  for (let i = 0; i < g.length - 1; i++) {
    if (g[i].length && g[i + 1].length && g[i][g[i].length - 1] === g[i + 1][0]) n++;
  }
  return n;
}

/** Spoken words in an exported SRT cue (XML-like tags are not words). */
function srtCueWords(block: string): string[] {
  const text = block
    .split(/\r?\n/)
    .slice(2)
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  return text ? text.split(/\s+/).filter(Boolean) : [];
}

// ===========================================================================
// TEST 1 - 4 spoken words -> 3 + 1
// ===========================================================================
test('TEST 1: 4 spoken words segment as 3 + 1', () => {
  const w = ['A', 'B', 'C', 'D'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 1]);
  assert.deepEqual(tokens(segs), w, 'every word kept exactly once, in order');
});

// ===========================================================================
// TEST 2 - 5 spoken words -> 3 + 2
// ===========================================================================
test('TEST 2: 5 spoken words segment as 3 + 2', () => {
  const w = ['A', 'B', 'C', 'D', 'E'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 2]);
  assert.deepEqual(tokens(segs), w);
});

// ===========================================================================
// TEST 3 - 6 spoken words -> 3 + 3
// ===========================================================================
test('TEST 3: 6 spoken words segment as 3 + 3', () => {
  const w = ['A', 'B', 'C', 'D', 'E', 'F'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 3]);
  assert.deepEqual(tokens(segs), w);
});

// ===========================================================================
// TEST 4 - 7 spoken words -> 3 + 3 + 1
// ===========================================================================
test('TEST 4: 7 spoken words segment as 3 + 3 + 1', () => {
  const w = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 3, 1]);
  assert.deepEqual(tokens(segs), w);
});

// ===========================================================================
// TEST 5 - 8 spoken words -> 3 + 3 + 2
// ===========================================================================
test('TEST 5: 8 spoken words segment as 3 + 3 + 2', () => {
  const w = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 3, 2]);
  assert.deepEqual(tokens(segs), w);
});

// ===========================================================================
// TEST 6 - 2 spoken words remain together
// ===========================================================================
test('TEST 6: 2 spoken words stay in one segment', () => {
  const segs = segment(['A', 'B']);
  assert.deepEqual(sizes(segs), [2]);
  assert.equal(segs.length, 1);
});

// ===========================================================================
// TEST 7 - 3 spoken words remain together
// ===========================================================================
test('TEST 7: 3 spoken words stay in one segment', () => {
  const segs = segment(['A', 'B', 'C']);
  assert.deepEqual(sizes(segs), [3]);
  assert.equal(segs.length, 1);
});

// ===========================================================================
// TEST 8 - legitimate repeated word must remain repeated
// ===========================================================================
test('TEST 8: a legitimately repeated word is NOT de-duplicated', () => {
  const w = ['ହଁ', 'ହଁ', 'ମୁଁ', 'ଯିବି'];
  const segs = segment(w);
  const out = tokens(segs);
  assert.equal(out.filter((t) => t === 'ହଁ').length, 2, 'both spoken ହଁ occurrences must remain');
  assert.deepEqual(out, w, 'word order preserved');
  assert.equal(boundaryDuplicates(segs), 0);
});

test('TEST 8b: repeated word across a cue boundary keeps BOTH occurrences', () => {
  // The same word ends one cue and starts the next as two real spoken
  // occurrences (separate source positions) - it must not be collapsed.
  const w = ['ହଁ', 'ହଁ', 'ହଁ', 'ହଁ'];
  const segs = segment(w);
  assert.deepEqual(sizes(segs), [3, 1]);
  assert.equal(tokens(segs).filter((t) => t === 'ହଁ').length, 4, 'all four spoken occurrences remain');
});

// ===========================================================================
// TEST 9 - the same timestamped boundary word must NOT be duplicated
// ===========================================================================
test('TEST 9: no adjacent cue shares its boundary word (the production dup bug)', () => {
  // Long continuous Odia speech in one Sarvam phrase. The previous chunker used
  // a 7-word stride with an 8-word slice, which re-emitted the boundary word
  // into the next cue ("... ok Anonymous" / "Anonymous ...").
  const w = (
    'ଏ ହେଉଁ ବହୁତ ବଡ ବାତା ଯାହା ଆମେ ଅନେକ କାଲ ଧରି କଥା କରିବା ଉତ୍ତର ଦେଇଛି ଏବଂ ଏ ସବୁ ଗୁରୁତ୍ତର ପରିଣତି ଅଛି ବୋଧହର୍ମା'
  ).split(/\s+/);

  const segs = segment(w);
  assert.equal(boundaryDuplicates(segs), 0, 'no word may appear on both sides of a cue boundary');
  assert.equal(tokens(segs).length, w.length, 'no word duplicated across boundaries');
  assert.ok(sameWordMultiset(w, tokens(segs)), 'emitted words equal source words exactly');
});

test('TEST 9b: multi-phrase input never duplicates a boundary word either', () => {
  const w = 'ମୁଁ ରହସ୍ୟ କହୁଛି ଏହି ବିଷୟରେ ଅନେକ କଥା ଆଛି ଯାହା ଆପଣ ଶୁଣୁଛନ୍ତି ମନେ କରନ୍ତୁ'.split(
    /\s+/
  );
  const segs = segment(w, { phrases: [[0, 3.2], [3.2, 8]] });
  assert.equal(tokens(segs).length, w.length);
  assert.equal(boundaryDuplicates(segs), 0);
  assert.ok(sameWordMultiset(w, tokens(segs)));
});

// ===========================================================================
// TEST 10 - same text, separate spoken occurrences (different timestamps)
// ===========================================================================
test('TEST 10: same word at two different timestamps is kept twice', () => {
  const w = ['ହଁ', 'ମୁଁ', 'ଯିବି', 'ହଁ', 'ଆସିବି'];
  const timings = [
    { text: 'ହଁ', startSeconds: 0.0, endSeconds: 0.4 },
    { text: 'ମୁଁ', startSeconds: 0.4, endSeconds: 0.8 },
    { text: 'ଯିବି', startSeconds: 0.8, endSeconds: 1.4 },
    { text: 'ହଁ', startSeconds: 2.0, endSeconds: 2.4 },
    { text: 'ଆସିବି', startSeconds: 2.4, endSeconds: 2.8 },
  ];
  const segs = segment(w, { wordTimings: timings });

  assert.equal(tokens(segs).filter((t) => t === 'ହଁ').length, 2, 'two distinct spoken ହଁ occurrences both survive');
  assert.ok(sameWordMultiset(w, tokens(segs)));
  for (const s of segs) {
    assert.ok(s.endSeconds > s.startSeconds, 'cue keeps a valid interval');
  }
});

// ===========================================================================
// TEST 11 - NOISE tagging stays correct
// ===========================================================================
test('TEST 11: speech + background noise stays <NOISE>spoken text</NOISE>', () => {
  const r = applyTaggingRule('ଏ ହେଉଁ ପାଙ୍ଗ', 'SPEECH_WITH_NOISE', 2.0);
  assert.equal(r.taggedText, '<NOISE>ଏ ହେଉଁ ପାଙ୍ଗ</NOISE>');
  assert.ok(!r.taggedText.startsWith('<NOISE></NOISE>'), 'must not collapse to an empty noise tag');

  // Splitting an over-long noisy segment re-applies the tag to EVERY part.
  const noisy = mkSeg({
    text: 'ଏ ହେଉଁ ପାଙ୍ଗ ଗାଇତା ବାଜିଛି',
    classification: 'SPEECH_WITH_NOISE',
    endSeconds: 4,
  });
  const split = enforceMaxWordsPerSegment([noisy], MAX);
  assert.ok(split.length > 1);
  for (const s of split) {
    assert.ok(s.taggedText.startsWith('<NOISE>'), 'each part keeps its opening tag');
    assert.ok(s.taggedText.endsWith('</NOISE>'), 'each part keeps its closing tag');
    assert.ok(countWords(s.taggedText) <= MAX, 'tags are not counted as spoken words');
  }
});

test('TEST 11b: background-noise-only stays exactly <NOISE></NOISE>', () => {
  assert.equal(applyTaggingRule('', 'NOISE_ONLY', 2.0).taggedText, '<NOISE></NOISE>');
  assert.equal(applyTaggingRule('', 'MUSIC_ONLY', 2.0).taggedText, '<NOISE></NOISE>');
});

// ===========================================================================
// TEST 12 - FIL tagging stays correct
// ===========================================================================
test('TEST 12: filler stays wrapped in <FIL>...</FIL>', () => {
  const r = applyTaggingRule('ମ୍ମ୍', 'FILLER', 0.4);
  assert.equal(r.taggedText, '<FIL>ମ୍ମ୍</FIL>');
  assert.equal(applyTaggingRule('ହାହା', 'LAUGH', 1.2).taggedText, '<FIL>ହାହା</FIL>');

  const filler = mkSeg({
    text: 'ମ୍ମ୍ ମ୍ମ୍ ମ୍ମ୍ ମ୍ମ୍',
    classification: 'FILLER',
    endSeconds: 4,
  });
  const split = enforceMaxWordsPerSegment([filler], MAX);
  assert.ok(split.length > 1);
  for (const s of split) {
    assert.ok(s.taggedText.startsWith('<FIL>') && s.taggedText.endsWith('</FIL>'), 'filler tag never split mid-tag');
  }
});

// ===========================================================================
// TEST 13 - SIL tagging stays correct
// ===========================================================================
test('TEST 13: real silence >= 1s stays <SIL></SIL>, shorter gaps are ignored', () => {
  assert.equal(applyTaggingRule('', 'SILENCE', 1.5).taggedText, '<SIL></SIL>');
  assert.equal(applyTaggingRule('', 'SILENCE', 1.0).taggedText, '<SIL></SIL>');
  const ignored = applyTaggingRule('', 'SILENCE', 0.4);
  assert.equal(ignored.taggedText, '[IGNORED_SILENCE_UNDER_1S]');
  assert.equal(ignored.isValidSilence, false);

  // A silence cue carries no spoken words, so it is passed through untouched
  // and its tag is preserved verbatim (never split, never re-derived).
  const sil = mkSeg({ text: '', classification: 'SILENCE', taggedText: '<SIL></SIL>', endSeconds: 3 });
  const out = enforceMaxWordsPerSegment([sil], MAX);
  assert.equal(out.length, 1);
  assert.equal(out[0].taggedText, '<SIL></SIL>');
  assert.equal(out[0].endSeconds, 3, 'silence timing untouched');
});

// ===========================================================================
// TEST 14 - <MB> is never generated
// ===========================================================================
test('TEST 14: no <MB> tag is ever produced', () => {
  const mb = applyTaggingRule('ବୁଲିଯାଇ ନାହିଁ', 'UNINTELLIGIBLE_SPEECH', 2.0);
  assert.ok(!mb.taggedText.includes('<MB>'));
  assert.ok(!mb.taggedText.includes('</MB>'));
  assert.equal(mb.taggedText, 'ବୁଲିଯାଇ ନାହିଁ', 'plain transcript text, never an invented placeholder');

  const segs = segment('ଏ ହେଉଁ ବହୁତ ବଡ ବାତା ଯାହା ଆମେ ଅନେକ କାଲ'.split(/\s+/));
  const srt = generateSrtContent(segs);
  assert.ok(!srt.includes('<MB>'), 'exported SRT contains no <MB>');
  assert.ok(!srt.includes('</MB>'));
});

// ===========================================================================
// TEST 15 - no normal spoken segment ever exceeds 3 spoken words
// ===========================================================================
test('TEST 15: production cues and exported SRT never exceed 3 spoken words', () => {
  const w = 'ଏ ହେଉଁ ବହୁତ ବଡ ବାତା ଯାହା ଆମେ ଅନେକ କାଲ ଧରି କଥା କରିବା ଉତ୍ତର ଦେଇଛି ଏବଂ ଏ ସବୁ ଗୁରୁତ୍ତର ପରିଣତି ଅଛି ବୋଧହର୍ମା'.split(
    /\s+/
  );
  const segs = segment(w);
  for (const s of segs) {
    assert.ok(countWords(s.text) <= MAX, `cue "${s.text}" has ${countWords(s.text)} words`);
  }

  // The exported SRT is the file the customer downloads: same ceiling.
  const blocks = generateSrtContent(segs)
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  assert.ok(blocks.length > 0);
  for (const b of blocks) {
    assert.ok(srtCueWords(b).length <= MAX, `exported cue exceeds ${MAX} spoken words: ${b}`);
  }
});

test('TEST 15b: the short-cue merge can never build a 4+ word segment', () => {
  // Three 1-word cues in a row: merging is allowed, but only up to the max.
  const segs = [
    mkSeg({ id: 1, text: 'ଏ', startSeconds: 0, endSeconds: 0.5 }),
    mkSeg({ id: 2, text: 'ହେଉଁ', startSeconds: 0.5, endSeconds: 1.0 }),
    mkSeg({ id: 3, text: 'ବଡ', startSeconds: 1.0, endSeconds: 1.5 }),
    mkSeg({ id: 4, text: 'ବାତା', startSeconds: 1.5, endSeconds: 2.0 }),
  ];
  const merged = enforceTimeLimitsPerSegment(segs, 1.0, 4.0);
  for (const s of merged) {
    assert.ok(countWords(s.text) <= MAX, `merged cue "${s.text}" exceeds the maximum`);
  }
  assert.equal(tokens(merged).length, 4, 'merge must not lose or duplicate words');
});

test('TEST 15c: enforceMaxWordsPerSegment splits an oversized spoken cue', () => {
  const seg = mkSeg({ text: 'ଏ ହେଉଁ ବହୁତ ବଡ ବାତା ଯାହା', endSeconds: 5 });
  const out = enforceMaxWordsPerSegment([seg], MAX);
  assert.deepEqual(sizes(out), [3, 3]);
  assert.equal(tokens(out).length, 6);
  assert.ok(out[0].startSeconds === 0, 'first part keeps the original start');
  assert.ok(out[out.length - 1].endSeconds === 5, 'last part keeps the original end');
});

test('TEST 15e: a long slow segment WITH 1:1 word timings still exports at max 3', () => {
  // Guards the export path: the time-based splitter groups words by speech
  // duration, so a slow speaker with 1:1 timings can otherwise produce a cue
  // above the maximum. Word count is primary, so the export must still cap it.
  const w = ['ଏ', 'ହେଉଁ', 'ବହୁତ', 'ବଡ', 'ବାତା', 'ଯାହା'];
  // SubtitleSegment.wordTimings keys each entry by `word` (per-word 1:1 timings).
  const timings = w.map((t, i) => ({ word: t, startSeconds: i * 1.2, endSeconds: i * 1.2 + 1.1 }));
  const slow = mkSeg({
    text: w.join(' '),
    wordTimings: timings,
    startSeconds: 0,
    endSeconds: timings[timings.length - 1].endSeconds,
  });

  const blocks = generateSrtContent([slow])
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  assert.ok(blocks.length >= 2, 'the 7.1s segment must be split');
  for (const b of blocks) {
    assert.ok(srtCueWords(b).length <= MAX, `exported cue exceeds ${MAX} spoken words: ${b}`);
  }
  const all = blocks.flatMap(srtCueWords);
  assert.ok(sameWordMultiset(w, all), 'no word lost or duplicated while capping');
});

test('TEST 15f: the chunker honours the requested limit (it used to ignore it)', () => {
  assert.deepEqual(findOptimalNaturalWordChunks(['a', 'b', 'c', 'd', 'e', 'f'], 3).map((c) => c.length), [3, 3]);
  assert.deepEqual(findOptimalNaturalWordChunks(['a', 'b', 'c', 'd', 'e', 'f'], 2).map((c) => c.length), [2, 2, 2]);
  assert.deepEqual(chunkWordsByCount(['a', 'b', 'c'], 3).map((c) => c.length), [3]);
  assert.deepEqual(chunkWordsByCount([], 3), []);
});

// ===========================================================================
// TEST 16 - no word is ever split in the middle
// ===========================================================================
test('TEST 16: no word is split, truncated or corrupted (Unicode safe)', () => {
  const w = [
    'ଏ',
    'ହେଉଁ',
    'ବହୁତ',
    'ବଡ',
    'ବାତା',
    'ଯାହା',
    'ଆମେ',
    'ଅନେକ',
    'କାଲ',
    'ଧରି',
    'କଥା',
    'କରିବା',
  ];
  const out = segment(w);
  // Every emitted token must be byte-identical to a source word: proves no word
  // was cut mid-word and no Unicode sequence was damaged.
  for (const t of tokens(out)) {
    assert.ok(w.includes(t), `token "${t}" is not a whole source word`);
  }
  assert.ok(sameWordMultiset(w, tokens(out)), 'exact word preservation');
  assert.deepEqual(tokens(out), w, 'order preserved');

  // Combining marks / conjuncts survive intact.
  const complex = ['ରହସ୍ୟ', 'କହୁଛି', 'ଏହି', 'ବିଷୟରେ'];
  const segs2 = segment(complex);
  assert.deepEqual(tokens(segs2), complex);
});

// ===========================================================================
// Word preservation / ordering invariants (supporting frozen guarantees)
// ===========================================================================
test('every spoken word appears exactly once across many sizes', () => {
  for (let n = 1; n <= 40; n++) {
    const w = Array.from({ length: n }, (_, i) => `w${i}`);
    const out = segment(w);
    assert.equal(tokens(out).length, n, `n=${n}: token count`);
    assert.ok(sameWordMultiset(w, tokens(out)), `n=${n}: word multiset`);
    assert.deepEqual(tokens(out), w, `n=${n}: order`);
    assert.equal(boundaryDuplicates(out), 0, `n=${n}: no boundary duplicate`);
    assert.ok(Math.max(...sizes(out)) <= MAX, `n=${n}: max words`);
  }
});

test('spoken transcription stays punctuation-free', () => {
  const w = 'ଏ ହେଉଁ ବହୁତ ବଡ ବାତା ଯାହା'.split(/\s+/);
  const out = segment(w);
  const speech = out.filter((s) => s.classification === 'CLEAR_SPEECH');
  for (const s of speech) {
    assert.ok(!/[।,!?;:]/.test(s.text), `spoken text must stay punctuation-free: "${s.text}"`);
  }
});

test('audit reports the frozen 3-word rule', () => {
  const ok = segment(['ଏ', 'ହେଉଁ', 'ବହୁତ', 'ବଡ', 'ବାତା']);
  const audit = auditRuleCompliance(ok);
  assert.equal(audit.ruleChecks.timingRule.passed, true, 'no cue exceeds the maximum');
  assert.equal(audit.ruleChecks.timingRule.nonCompliantCount, 0);
  assert.equal(audit.ruleChecks.timingRule.maxWords, 3);

  const over = mkSeg({ text: 'ଏ ହେଉଁ ବହୁତ ବଡ' });
  const bad = auditRuleCompliance([over]);
  assert.equal(bad.ruleChecks.timingRule.passed, false);
  assert.equal(bad.ruleChecks.timingRule.nonCompliantCount, 1);
});

// ===========================================================================
// TEST 17 - blank-page regression (commit c745acc) still holds
// ===========================================================================
test('TEST 17: the blank-page fix contract is intact', () => {
  // auditRuleCompliance still returns the key the UI actually reads, and the
  // phantom wordLimitRule (the original crash) is still absent.
  const audit = auditRuleCompliance(segment(['ଏ', 'ହେଉଁ', 'ବହୁତ'])) as unknown as Record<string, unknown>;
  const checks = audit.ruleChecks as Record<string, unknown>;
  assert.notEqual(checks.timingRule, undefined, 'ruleChecks.timingRule must exist');
  assert.equal(
    checks.wordLimitRule,
    undefined,
    'ruleChecks.wordLimitRule must not exist: nothing returns it and the UI must not read it'
  );
});