import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANNOT_MEASURE_DURATION_MESSAGE,
  CREDIT_PACKS,
  creditsForDuration,
  NOT_ENOUGH_CREDITS_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
} from './creditPolicy.ts';

test('1 credit = 1 minute, rounded UP (never below 1 credit)', () => {
  // 0-60s -> 1 credit
  assert.equal(creditsForDuration(0), 1);
  assert.equal(creditsForDuration(0.4), 1);
  assert.equal(creditsForDuration(1), 1);
  assert.equal(creditsForDuration(59.9), 1);
  assert.equal(creditsForDuration(60), 1);
  // 61-120s -> 2 credits
  assert.equal(creditsForDuration(60.1), 2);
  assert.equal(creditsForDuration(61), 2);
  assert.equal(creditsForDuration(119), 2);
  assert.equal(creditsForDuration(120), 2);
  // 121-180s -> 3 credits
  assert.equal(creditsForDuration(120.1), 3);
  assert.equal(creditsForDuration(121), 3);
  assert.equal(creditsForDuration(180), 3);
  // longer audio keeps rounding up
  assert.equal(creditsForDuration(181), 4);
  assert.equal(creditsForDuration(599), 10);
  assert.equal(creditsForDuration(600), 10);
  assert.equal(creditsForDuration(601), 11);
});

test('a corrupt/unknown duration never grants 0 free credits', () => {
  assert.equal(creditsForDuration(Number.NaN), 1);
  assert.equal(creditsForDuration(Number.POSITIVE_INFINITY), 1);
  assert.equal(creditsForDuration(-5), 1);
  assert.equal(creditsForDuration(undefined as unknown as number), 1);
  assert.equal(creditsForDuration(null as unknown as number), 1);
});

test('pack catalog matches the product spec exactly', () => {
  assert.deepEqual(
    CREDIT_PACKS.map((p) => [p.name, p.priceInr, p.credits, p.glyph, p.annual === true]),
    [
      ['Starter', 69, 15, '🟢', false],
      ['Basic', 129, 35, '🔵', false],
      ['Standard', 299, 80, '🟣', false],
      ['Pro', 599, 180, '🟠', false],
      ['Large', 1199, 400, '🔴', false],
      ['Annual', 4499, 2000, '⭐', true],
    ]
  );
  // Unique ids (used as React keys / future product ids) and all 6 packs exist.
  assert.equal(new Set(CREDIT_PACKS.map((p) => p.id)).size, 6);
});

test('pack prices are whole rupees and credits are whole positive numbers', () => {
  for (const pack of CREDIT_PACKS) {
    assert.ok(Number.isInteger(pack.priceInr) && pack.priceInr > 0, `${pack.name} price`);
    assert.ok(Number.isInteger(pack.credits) && pack.credits > 0, `${pack.name} credits`);
  }
});

test('annual plan is a separate product and never auto-renews', () => {
  const annual = CREDIT_PACKS.find((p) => p.annual);
  assert.ok(annual, 'annual pack exists');
  assert.equal(annual.name, 'Annual');
  assert.match(annual.blurb ?? '', /never auto-renewed/i);
  // No pack declares auto-renewal of any kind.
  for (const pack of CREDIT_PACKS) {
    assert.doesNotMatch(`${pack.blurb ?? ''}`.replace(/never auto-renewed/gi, ''), /auto-?renew(?!ed)/i);
  }
});

test('user-facing messages are the exact product copy', () => {
  assert.equal(NOT_ENOUGH_CREDITS_MESSAGE, 'Not enough credits. Please purchase a credit pack.');
  assert.equal(PROVIDER_UNAVAILABLE_MESSAGE, 'Processing temporarily unavailable. Please try again later.');
  assert.match(CANNOT_MEASURE_DURATION_MESSAGE, /Could not determine the audio duration/);
});
