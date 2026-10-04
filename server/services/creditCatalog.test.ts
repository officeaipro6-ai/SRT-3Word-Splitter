/**
 * Stage 5D finalization — credit catalog resolution.
 *
 * Covers the pre-existing `ReferenceError` that broke EVERY purchase path in
 * BOTH providers: `creditPolicy.getPlanById()` referenced `CREDIT_PLANS` /
 * `CreditPlan`, neither of which existed in that module, so it threw
 * `ReferenceError: CREDIT_PLANS is not defined` before a single credit was ever
 * considered. `razorpayService` also carried a second, byte-identical literal
 * copy of the catalog.
 *
 * These tests pin: every supported plan ID resolves, invalid IDs are rejected,
 * the prices/credits are EXACTLY unchanged, and there is now genuinely only
 * one catalog (identity, not just deep-equality).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_PACKS, getPlanById, type CreditPack } from './creditPolicy';
import { CREDIT_PLANS, getPlanById as razorpayGetPlanById } from './razorpayService';

/** The exact catalog as it was defined before this stage. Prices are product decisions. */
const LOCKED_CATALOG: ReadonlyArray<[string, string, number, number]> = [
  ['starter', 'Starter', 69, 15],
  ['basic', 'Basic', 129, 35],
  ['standard', 'Standard', 299, 80],
  ['pro', 'Pro', 599, 180],
  ['large', 'Large', 1199, 400],
  ['annual', 'Annual', 4499, 2000],
];

test('5D-F1. every supported plan ID resolves to its locked price and credit count', () => {
  assert.equal(CREDIT_PACKS.length, LOCKED_CATALOG.length, 'catalog size must not change');
  for (const [id, name, priceInr, credits] of LOCKED_CATALOG) {
    const plan = getPlanById(id);
    assert.ok(plan, `plan "${id}" must resolve (this used to throw ReferenceError)`);
    assert.equal(plan.id, id);
    assert.equal(plan.name, name);
    assert.equal(plan.priceInr, priceInr, `price for ${id} must be unchanged`);
    assert.equal(plan.credits, credits, `credits for ${id} must be unchanged`);
  }
});

test('5D-F2. invalid plan IDs are rejected, not resolved and not thrown', () => {
  const bad = ['nope', '', ' ', 'Starter', 'BASIC', 'starter ', 'toString', '__proto__', 'constructor', 'id'];
  for (const id of bad) {
    assert.equal(getPlanById(id), undefined, `plan id ${JSON.stringify(id)} must be rejected`);
  }
});

test('5D-F3. the annual pack keeps its never-auto-renew marker', () => {
  const annual = getPlanById('annual');
  assert.ok(annual);
  assert.equal(annual.annual, true, 'annual is a distinct product and must stay flagged');
  const starter = getPlanById('starter');
  assert.notEqual(starter?.annual, true);
});

test('5D-F4. there is exactly ONE catalog: razorpayService re-exports, not duplicates', () => {
  // Identity (not deepEqual) is the real assertion: a duplicated literal would
  // pass deepEqual but would drift the moment either copy is edited.
  assert.equal(CREDIT_PLANS, CREDIT_PACKS, 'razorpayService must re-export the canonical array');
  assert.equal(razorpayGetPlanById, getPlanById, 'razorpayService must re-export the canonical resolver');
});

test('5D-F5. the resolver is a pure read of the catalog and never mutates it', () => {
  const before = JSON.stringify(CREDIT_PACKS);
  for (const p of CREDIT_PACKS) getPlanById(p.id);
  assert.equal(JSON.stringify(CREDIT_PACKS), before, 'catalog must be immutable under resolution');
});

test('5D-F6. every catalog entry is a well-formed pack (guards future edits)', () => {
  for (const p of CREDIT_PACKS as readonly CreditPack[]) {
    assert.ok(p.id && typeof p.id === 'string', 'pack needs an id');
    assert.ok(p.name && typeof p.name === 'string', 'pack needs a name');
    assert.ok(Number.isInteger(p.priceInr) && p.priceInr > 0, `${p.id} price must be a positive integer`);
    assert.ok(Number.isInteger(p.credits) && p.credits > 0, `${p.id} credits must be a positive integer`);
    assert.ok(p.glyph && typeof p.glyph === 'string', `${p.id} needs a glyph`);
  }
});