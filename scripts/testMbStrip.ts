import { stripMbCues, generateSrtContent, applyTaggingRule } from '../src/utils/srtRules';
import type { SubtitleSegment } from '../src/types';

let failed = 0;
function check(name: string, actual: any, expected: any) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

let id = 0;
function seg(text: string, cls: string, start: number, end: number): SubtitleSegment {
  return {
    id: ++id,
    startSeconds: start,
    endSeconds: end,
    startTimeFormatted: `00:00:${String(Math.floor(start)).padStart(2, '0')},000`,
    endTimeFormatted: `00:00:${String(Math.floor(end)).padStart(2, '0')},000`,
    text,
    classification: cls as any,
    taggedText: applyTaggingRule(text, cls as any, end - start).taggedText,
    acousticNote: '',
    confidence: 0.95,
    wordTimings: text.split(' ').map((w, i) => ({ word: w, startSeconds: start + i * 0.2, endSeconds: start + i * 0.2 + 0.4 })),
  };
}

const segments: SubtitleSegment[] = [
  seg('ଦିନେ ନେଇସାରିଥିବାରୁ', 'SPEECH_WITH_MUSIC', 0, 2.5),   // -> plain transcript text (no <MB>)
  seg('ଓଡ଼ିଆ ଖବର', 'CLEAR_SPEECH', 3, 4.5),                  // keep
  seg('', 'UNINTELLIGIBLE_SPEECH', 5, 6.5),                   // -> plain (empty) text (no <MB>)
  seg('ଖବର ଆସିଛି', 'SPEECH_WITH_NOISE', 7, 8.5),             // keep
  seg('', 'SILENCE', 9, 12),                                  // keep (>=2s)
];

// 1. MB tagging is disabled, so no cue resolves to <MB></MB> and stripMbCues
//    is now a passthrough that keeps every cue.
const stripped = stripMbCues(segments);
check('stripMbCues keeps SPEECH_WITH_MUSIC (plain text now)', stripped.some((s) => s.classification === 'SPEECH_WITH_MUSIC'), true);
check('stripMbCues keeps UNINTELLIGIBLE_SPEECH (plain text now)', stripped.some((s) => s.classification === 'UNINTELLIGIBLE_SPEECH'), true);
check('stripMbCues keeps CLEAR_SPEECH', stripped.some((s) => s.classification === 'CLEAR_SPEECH'), true);
check('stripMbCues keeps SPEECH_WITH_NOISE', stripped.some((s) => s.classification === 'SPEECH_WITH_NOISE'), true);
check('stripMbCues keeps SILENCE', stripped.some((s) => s.classification === 'SILENCE'), true);
check('stripMbCues keeps order', stripped.map((s) => s.classification).join(','), 'SPEECH_WITH_MUSIC,CLEAR_SPEECH,UNINTELLIGIBLE_SPEECH,SPEECH_WITH_NOISE,SILENCE');

// 2. Preview (generateSrtContent) no longer contains any <MB> tag.
const preview = generateSrtContent(segments);
check('preview never contains <MB>', preview.includes('<MB>'), false);
check('preview never contains </MB>', preview.includes('</MB>'), false);

// 3. Exported SRT has no <MB>, keeps plain transcript text, and sequential numbering.
const exported = generateSrtContent(stripMbCues(segments));
check('exported SRT has no <MB>', exported.includes('<MB>'), false);
check('exported SRT has no </MB>', exported.includes('</MB>'), false);
const numbers = exported.split('\n').filter((l) => /^\d+$/.test(l.trim())).map((n) => Number(n.trim()));
check('exported SRT sequential numbering', numbers.join(','), '1,2,3,4,5');
check('exported SRT has 5 cues', numbers.length, 5);
check('exported SRT keeps SPEECH_WITH_MUSIC words as plain text', exported.includes('ଦିନେ ନେଇସାରିଥିବାରୁ'), true);
check('exported SRT keeps CLEAR_SPEECH', exported.includes('ଓଡ଼ିଆ ଖବର'), true);
check('exported SRT keeps SPEECH_WITH_NOISE as plain text', exported.includes('ଖବର ଆସିଛି'), true);
check('exported SRT wraps SPEECH_WITH_NOISE words in <NOISE>', exported.includes('<NOISE>ଖବର ଆସିଛି</NOISE>'), true);
check('exported SRT keeps <SIL></SIL>', exported.includes('<SIL></SIL>'), true);
check('exported SRT timestamps unchanged', exported.includes('00:00:07,000 --> 00:00:08,500'), true);

console.log(failed === 0 ? '\nAll MB-strip tests passed.' : `\n${failed} test(s) FAILED.`);