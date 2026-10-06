/**
 * Frontend purchase flow contract (Razorpay TEST MODE checkout).
 *
 * The browser must:
 *   - open Checkout ONLY with the order the SERVER created (key/amount/order_id
 *     come from the create-credit-purchase-order response — no client-side
 *     price or amount is ever constructed here);
 *   - send the three Razorpay signature fields back to the server for
 *     verification, which is the ONLY way credits are added;
 *   - never call the verify endpoint from a failed or dismissed payment, so a
 *     failed/cancelled payment credits 0.
 *
 * Source-level assertions (same style as audioSpendGate.test.ts): this file
 * proves the wiring, while the server-side tests prove the money logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelSrc = readFileSync(new URL('./CreditPacksPanel.tsx', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('../lib/sessionClient.ts', import.meta.url), 'utf8');

test('checkout opens with the SERVER-created order only (no client-side amount)', () => {
  assert.match(panelSrc, /createCreditPurchaseOrder\(planId\)/, 'the order is created server-side');
  assert.match(panelSrc, /key:\s*order\.keyId/, 'public key comes from the order response');
  assert.match(panelSrc, /amount:\s*order\.amount/, 'amount comes from the order response');
  assert.match(panelSrc, /order_id:\s*order\.orderId/, 'the Razorpay order id comes from the order response');
  assert.doesNotMatch(panelSrc, /amount:\s*\d/, 'no literal amount may be passed to Checkout');
});

test('verification sends the three Razorpay signature fields to the server', () => {
  assert.match(panelSrc, /verifyCreditPurchase\(\{/, 'the browser asks the SERVER to verify');
  assert.match(panelSrc, /orderId:\s*response\.razorpay_order_id/);
  assert.match(panelSrc, /paymentId:\s*response\.razorpay_payment_id/);
  assert.match(panelSrc, /signature:\s*response\.razorpay_signature/);

  assert.match(clientSrc, /\/api\/credits\/purchase\/order/, 'order endpoint used by the client');
  assert.match(clientSrc, /\/api\/credits\/purchase\/verify/, 'verify endpoint used by the client');
});

test('a failed or dismissed payment never calls the verify endpoint (credits 0)', () => {
  const failIdx = panelSrc.indexOf("payment.failed");
  const openIdx = panelSrc.indexOf('rzp.open()');
  assert.ok(failIdx >= 0, 'the payment.failed handler must exist');
  assert.ok(openIdx > failIdx, 'payment.failed must be registered before open()');
  const failSlice = panelSrc.slice(failIdx, openIdx);
  assert.ok(!failSlice.includes('verifyCreditPurchase'), 'failed payments must not reach server verification');

  const dismissIdx = panelSrc.indexOf('ondismiss');
  assert.ok(dismissIdx >= 0, 'the modal ondismiss handler must exist');
  const dismissSlice = panelSrc.slice(dismissIdx, dismissIdx + 240);
  assert.ok(!dismissSlice.includes('verifyCreditPurchase'), 'dismissed payments must not reach verification');
});
