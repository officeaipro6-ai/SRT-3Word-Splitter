import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommunityText, normalizeForModeration } from './moderationClassifier.ts';

test('clean, ordinary support messages are CLEAN', () => {
  const clean = [
    'The subtitle timings are about 300ms late on the second line.',
    'Thanks for the update, the SRT looks great now.',
    'My credits show 12 but the app says insufficient balance, can you check?',
    'I could not log in after resetting my password.',
    'Please add a fix for the NOISE tag appearing on music.',
    'How do I download the generated file?',
  ];
  for (const text of clean) {
    assert.equal(analyzeCommunityText(text).verdict, 'CLEAN', `expected CLEAN: ${text}`);
  }
});

test('a clear personal insult is CONFIRMED', () => {
  const a = analyzeCommunityText('you are a pathetic loser and I hate you');
  assert.equal(a.verdict, 'CONFIRMED');
  assert.ok(a.categories.includes('INSULT') || a.categories.includes('HARASSMENT'));
});

test('explicit threats and self-harm encouragement are CONFIRMED', () => {
  const threats = [
    'I will kill you',
    'you should die',
    'go kill yourself',
    'I hope you suffer',
    'I am going to find you and hurt you',
  ];
  for (const t of threats) {
    const a = analyzeCommunityText(t);
    assert.equal(a.verdict, 'CONFIRMED', `expected CONFIRMED: ${t}`);
    assert.ok(a.categories.includes('THREAT'), `expected THREAT: ${t}`);
  }
});

test('strong vulgar abuse aimed at the reader is CONFIRMED', () => {
  const a = analyzeCommunityText('you are such an asshole, shut up');
  assert.equal(a.verdict, 'CONFIRMED');
});

test('FALSE POSITIVE PROTECTION: reporting abuse is never punished', () => {
  const reports = [
    'someone called me an idiot and I reported him',
    'he insulted me in the community thread yesterday',
    'I was harassed by another user, please help',
    'the user threatened me and I want to complain',
  ];
  for (const text of reports) {
    const a = analyzeCommunityText(text);
    // The invariant that matters: a victim reporting abuse is NEVER punished.
    assert.notEqual(a.verdict, 'CONFIRMED', `must never auto-confirm: ${text}`);
  }
  // A report that itself repeats the insult word is routed to a human instead of
  // being punished.
  const repeated = analyzeCommunityText('someone called me an idiot and I reported him');
  assert.equal(repeated.verdict, 'UNCERTAIN');
});

test('FALSE POSITIVE PROTECTION: quoting/asking about a word is not a violation', () => {
  const meta = [
    'what does the word idiot mean in Odia?',
    'the phrase "you are an idiot" is offensive, is it not?',
    'the community guidelines say insulting language is not allowed, correct?',
    'I do not use rude words here, please do not either',
    'sorry if I was rude earlier',
  ];
  for (const text of meta) {
    const a = analyzeCommunityText(text);
    assert.notEqual(a.verdict, 'CONFIRMED', `must never auto-confirm: ${text}`);
  }
});

test('mild slang alone is UNCERTAIN (admin review), never an automatic restriction', () => {
  const a = analyzeCommunityText('this damn app is so stupid');
  assert.equal(a.verdict, 'UNCERTAIN');
});

test('leetspeak and letter repetition do not defeat the classifier', () => {
  assert.equal(normalizeForModeration('@$$hole'), 'asshole');
  assert.equal(normalizeForModeration('@sh0le'), 'ashole');
  assert.ok(normalizeForModeration('fuuuuck').includes('fuck'));
  const a = analyzeCommunityText('you are an @ssh0le');
  assert.equal(a.verdict, 'CONFIRMED');
});

test('the analysis never leaks the matched word list to callers', () => {
  const a = analyzeCommunityText('you are a pathetic loser');
  const json = JSON.stringify(a);
  for (const w of ['pathetic', 'loser']) {
    assert.ok(!json.toLowerCase().includes(w), `raw term ${w} must not be returned`);
  }
  // Reasons are category-level descriptions instead.
  assert.ok(a.signals.every((s) => typeof s.reason === 'string' && s.reason.length > 0));
});

test('empty and whitespace text are CLEAN', () => {
  assert.equal(analyzeCommunityText('').verdict, 'CLEAN');
  assert.equal(analyzeCommunityText('    ').verdict, 'CLEAN');
});
