import { applyTaggingRule, auditRuleCompliance } from '../src/utils/srtRules';
import type { SubtitleSegment } from '../src/types';

let failed = 0;
function check(name: string, actual: any, expected: any) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

// 1. MB tagging is removed: SPEECH_WITH_MUSIC must output its actual transcript
//    text as plain text, never <MB></MB>.
check('SPEECH_WITH_MUSIC -> plain transcript text', applyTaggingRule('ଦିନେ ନେଇସାରିଥିବାରୁ', 'SPEECH_WITH_MUSIC', 2.5).taggedText, 'ଦିନେ ନେଇସାରିଥିବାରୁ');

// 2. SPEECH_WITH_NOISE must wrap the ACTUAL spoken words in <NOISE>...</NOISE>
//    (requirement: speech over BGM/noise -> <NOISE>spoken words</NOISE>).
check('SPEECH_WITH_NOISE -> <NOISE>...</NOISE>', applyTaggingRule('ଖବର ଆସିଛି', 'SPEECH_WITH_NOISE', 2.0).taggedText, '<NOISE>ଖବର ଆସିଛି</NOISE>');

// 3. UNINTELLIGIBLE_SPEECH with no transcript text -> plain (empty) text, no <MB>.
check('UNINTELLIGIBLE_SPEECH -> plain text (no <MB>)', applyTaggingRule('', 'UNINTELLIGIBLE_SPEECH', 1.5).taggedText, '');

// 4. MUSIC_ONLY / NOISE_ONLY unchanged.
check('MUSIC_ONLY -> <NOISE></NOISE>', applyTaggingRule('', 'MUSIC_ONLY', 1.0).taggedText, '<NOISE></NOISE>');
check('NOISE_ONLY -> <NOISE></NOISE>', applyTaggingRule('', 'NOISE_ONLY', 1.0).taggedText, '<NOISE></NOISE>');

// 5. CLEAR_SPEECH unchanged.
check('CLEAR_SPEECH unchanged', applyTaggingRule('ଓଡ଼ିଆ ଖବର', 'CLEAR_SPEECH', 1.2).taggedText, 'ଓଡ଼ିଆ ଖବର');

// 6. FILLER unchanged.
check('FILLER -> <FIL>...</FIL>', applyTaggingRule('hmm', 'FILLER', 0.4).taggedText, '<FIL>hmm</FIL>');

// 7. SILENCE rules unchanged.
check('SILENCE >=2s -> <SIL></SIL>', applyTaggingRule('', 'SILENCE', 2.3).taggedText, '<SIL></SIL>');
check('SILENCE <2s ignored', applyTaggingRule('', 'SILENCE', 0.9).taggedText, '[IGNORED_SILENCE_UNDER_2S]');

// 8. Audit: a SPEECH_WITH_MUSIC segment with plain transcript text must be
//    compliant (MB no longer generated) — but ruleMB still counts it.
const seg = (cls: string, tagged: string): SubtitleSegment => ({
  id: 1,
  startSeconds: 0,
  endSeconds: 2.5,
  startTimeFormatted: '00:00:00,000',
  endTimeFormatted: '00:00:02,500',
  text: 'ଦିନେ ନେଇସାରିଥିବାରୁ',
  classification: cls as any,
  taggedText: tagged,
  acousticNote: '',
  confidence: 0.95,
  wordTimings: [
    { word: 'ଦିନେ', startSeconds: 0.0, endSeconds: 0.4 },
    { word: 'ନେଇସାରିଥିବାରୁ', startSeconds: 0.5, endSeconds: 2.5 },
  ],
});
const audit = auditRuleCompliance([seg('SPEECH_WITH_MUSIC', 'ଦିନେ ନେଇସାରିଥିବାରୁ')]);
check('audit ruleMB counts SPEECH_WITH_MUSIC', audit.ruleChecks.ruleMB.count, 1);
check('audit ruleB excludes SPEECH_WITH_MUSIC', audit.ruleChecks.ruleB.count, 0);
check('audit fully compliant for plain-text music segment', audit.isFullyCompliant, true);

// 9. Audit still flags a SPEECH_WITH_MUSIC segment that contains a <MB> tag.
const badAudit = auditRuleCompliance([seg('SPEECH_WITH_MUSIC', '<MB></MB>')]);
check('audit warns on leaked <MB></MB> tag', badAudit.isFullyCompliant, false);

console.log(failed === 0 ? '\nAll mapping tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);