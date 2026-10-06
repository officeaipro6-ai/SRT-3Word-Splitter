/**
 * Razorpay TEST MODE purchase contract — the five required areas:
 *
 *   1. ORDER CREATION      — server-side only, amount derived from the locked
 *                            credit-pack catalog, never from the client.
 *   2. SIGNATURE VERIFY    — HMAC-SHA256 payment + webhook signatures are
 *                            checked with timing-safe comparison.
 *   3. FAILED PAYMENT      — a non-captured payment is gated out BEFORE any
 *                            credit-adding call, so it credits 0.
 *   4. DUPLICATE PAYMENT   — recordPurchase is idempotent by paymentId on the
 *                            JSON provider (Turso's concurrent case is proven
 *                            separately in db/writeSerialization.test.ts 5D-M5/M6).
 *   5. CREDIT ASSIGNMENT   — exactly plan.credits land in the balance and in one
 *                            PURCHASE ledger row carrying the payment metadata.
 *
 * The gateway is faked at the instance boundary (createRazorpayOrder takes the
 * Razorpay instance as a parameter), so no test here opens a network connection,
 * reads a real credential, or prints a secret. TEST mode only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Razorpay from 'razorpay';

import { DataStore } from '../db/store.ts';
import { UserRepo, CreditRepo } from '../db/repos.ts';
import { FileCreditService, CreditError } from './creditService.ts';
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  parseWebhookPayload,
} from './razorpayService.ts';
import { CREDIT_PACKS } from './creditPolicy.ts';

// ------------------------------------------------------------ fake gateway ---

interface OrderCreateParams {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

function makeFakeRazorpay() {
  const orderCalls: OrderCreateParams[] = [];
  const fetchedPaymentIds: string[] = [];
  return {
    orderCalls,
    fetchedPaymentIds,
    orders: {
      create: async (params: OrderCreateParams) => {
        orderCalls.push(params);
        return { id: `order_test_${orderCalls.length}` };
      },
    },
    payments: {
      fetch: async (paymentId: string) => {
        fetchedPaymentIds.push(paymentId);
        return { id: paymentId };
      },
    },
  };
}

function asGateway(fake: ReturnType<typeof makeFakeRazorpay>): Razorpay {
  return fake as unknown as Razorpay;
}

const hmac = (secret: string, data: string | Buffer) =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

// ------------------------------------------------------ json credit fixture ---

async function makeCredits(initialCredits: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-rzp-purchase-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const users = new UserRepo(store);
  const creditRepo = new CreditRepo(store);
  const service = new FileCreditService(users, creditRepo);
  const user = users.createUser('token-hash', initialCredits);
  return { service, user, users };
}

function purchaseInput(userId: string, paymentId: string, planId = 'starter') {
  return {
    userId,
    planId,
    paymentId,
    orderId: `order_for_${paymentId}`,
    amountInr: CREDIT_PACKS.find((p) => p.id === planId)!.priceInr,
    currency: 'INR',
    planName: CREDIT_PACKS.find((p) => p.id === planId)!.name,
  };
}

// ------------------------------------------------------- 1. order creation ----

test('order creation: the amount sent to the gateway is always the catalog price in paise', async () => {
  for (const pack of CREDIT_PACKS) {
    const fake = makeFakeRazorpay();
    const result = await createRazorpayOrder(asGateway(fake), {
      userId: 'u_order_1',
      planId: pack.id,
      userEmail: 'buyer@example.com',
    });

    assert.equal(result.amount, pack.priceInr * 100, `${pack.id}: paise amount must come from the catalog`);
    assert.equal(result.currency, 'INR');
    assert.equal(result.plan.id, pack.id);
    assert.equal(fake.orderCalls.length, 1, 'exactly one gateway order per request');

    const sent = fake.orderCalls[0];
    assert.equal(sent.amount, pack.priceInr * 100, 'gateway receives the catalog amount');
    assert.equal(sent.currency, 'INR');
    assert.equal(sent.notes.userId, 'u_order_1', 'the order must be traceable to the buyer');
    assert.equal(sent.notes.planId, pack.id);
    assert.equal(sent.notes.userEmail, 'buyer@example.com');
    assert.ok(sent.receipt.includes('u_order_1'), 'receipt carries the buyer id');
  }
});

test('order creation: the client can never supply the price — extra amount fields are ignored', async () => {
  const fake = makeFakeRazorpay();
  const spoofed = {
    userId: 'u_spoof',
    planId: 'annual',
    amount: 1,
    priceInr: 1,
    credits: 999999,
  } as unknown as Parameters<typeof createRazorpayOrder>[1];

  const result = await createRazorpayOrder(asGateway(fake), spoofed);

  assert.equal(result.amount, 4499 * 100, 'annual pack price comes from the catalog, not the request');
  assert.equal(fake.orderCalls[0].amount, 4499 * 100);
  assert.equal(result.plan.credits, 2000, 'credit count also comes from the catalog');
});

test('order creation: an unknown plan is refused before any gateway call', async () => {
  const fake = makeFakeRazorpay();
  await assert.rejects(
    () => createRazorpayOrder(asGateway(fake), { userId: 'u1', planId: 'definitely-not-a-plan' }),
    (e: unknown) => e instanceof Error && e.message === 'INVALID_PLAN',
  );
  assert.equal(fake.orderCalls.length, 0, 'no order may be created for an unknown plan');
});

test('order creation: the server-side order route resolves the plan itself (no client pricing)', () => {
  const serverSrc = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const orderIdx = serverSrc.indexOf("app.post('/api/credits/purchase/order'");
  const verifyIdx = serverSrc.indexOf("app.post('/api/credits/purchase/verify'");
  assert.ok(orderIdx >= 0 && verifyIdx > orderIdx, 'order route must exist');
  const slice = serverSrc.slice(orderIdx, verifyIdx);
  assert.match(slice, /getPlanById\(planId\)/, 'the route resolves the plan server-side');
  assert.match(slice, /createRazorpayOrder\(razorpay/, 'the route delegates to the server-side order creator');
  assert.ok(
    !/req\.body\??\.\s*(amount|price|priceInr|credits)/.test(slice),
    'the route must never read a price or credit count from the request body',
  );
});

// -------------------------------------------------- 2. signature verification --

test('signature verification: a correctly signed order|payment pair is accepted', () => {
  const secret = 'rzp_test_fake_key_secret_for_tests_only';
  const orderId = 'order_abc123';
  const paymentId = 'pay_xyz789';
  const signature = hmac(secret, `${orderId}|${paymentId}`);

  assert.equal(verifyPaymentSignature(secret, orderId, paymentId, signature), true);
});

test('signature verification: any tampering is rejected', () => {
  const secret = 'rzp_test_fake_key_secret_for_tests_only';
  const orderId = 'order_abc123';
  const paymentId = 'pay_xyz789';
  const signature = hmac(secret, `${orderId}|${paymentId}`);

  assert.equal(verifyPaymentSignature(secret, orderId, 'pay_other', signature), false, 'wrong payment id');
  assert.equal(verifyPaymentSignature(secret, 'order_other', paymentId, signature), false, 'wrong order id');
  assert.equal(
    verifyPaymentSignature('rzp_test_wrong_secret', orderId, paymentId, signature),
    false,
    'wrong secret',
  );

  const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  assert.equal(verifyPaymentSignature(secret, orderId, paymentId, flipped), false, 'flipped signature nibble');
});

test('signature verification: malformed signatures never throw and never pass', () => {
  const secret = 'rzp_test_fake_key_secret_for_tests_only';
  for (const bad of ['', 'zz', 'deadbeef', 'not-hex-at-all!!', 'ab']) {
    assert.equal(verifyPaymentSignature(secret, 'order_1', 'pay_1', bad), false, `sig=${JSON.stringify(bad)}`);
  }
});

test('signature verification: webhook signature is verified against the exact raw payload', () => {
  const webhookSecret = 'whsec_test_fake_webhook_secret';
  const payload = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const signature = hmac(webhookSecret, payload);

  assert.equal(verifyWebhookSignature(webhookSecret, payload, signature), true);

  const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', extra: 1 }));
  assert.equal(verifyWebhookSignature(webhookSecret, tampered, signature), false, 'payload was altered');
  assert.equal(verifyWebhookSignature('whsec_wrong', payload, signature), false, 'wrong webhook secret');
  assert.equal(verifyWebhookSignature(webhookSecret, payload, 'deadbeef'), false, 'truncated signature');
  assert.equal(verifyWebhookSignature(webhookSecret, payload, ''), false, 'empty signature');
});

// ------------------------------------------------------- 3. failed payment -----

test('failed payment: a payment.failed webhook payload parses as status=failed (gated to 0 credits)', () => {
  const record = parseWebhookPayload({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_failed_1',
          order_id: 'order_failed_1',
          amount: 6900, // paise
          currency: 'INR',
          status: 'failed',
          captured: false,
          notes: { userId: 'u1', planId: 'starter', userEmail: 'buyer@example.com' },
        },
      },
    },
  });

  assert.ok(record, 'the payload is parseable so the handler can inspect its status');
  assert.equal(record.status, 'failed', 'a failed payment must carry status=failed');
  assert.equal(record.amount, 69, 'amount is normalised to INR');
});

test('failed payment: a payload without a payer/plan can never credit anyone', () => {
  assert.equal(
    parseWebhookPayload({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_x',
            order_id: 'order_x',
            amount: 6900,
            currency: 'INR',
            status: 'captured',
            captured: true,
            captured_at: 1700000000,
            notes: {}, // no userId, no planId
          },
        },
      },
    }),
    null,
    'an unattributable payment must be dropped, not credited',
  );
  assert.equal(parseWebhookPayload({ event: 'order.paid' }), null, 'non-payment events are ignored');
  assert.equal(parseWebhookPayload(null), null);
  assert.equal(parseWebhookPayload({}), null);
});

test('failed payment: both server routes gate non-captured payments BEFORE any credit-adding call', () => {
  const serverSrc = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

  // Checkout verify route: bad signature, then non-captured, then amount/currency,
  // payer binding, and only afterwards may recordPurchase appear.
  const verifyIdx = serverSrc.indexOf("app.post('/api/credits/purchase/verify'");
  const webhookIdx = serverSrc.indexOf("app.post('/api/credits/purchase/webhook'");
  assert.ok(verifyIdx >= 0 && webhookIdx > verifyIdx, 'verify route must exist');
  const verifySlice = serverSrc.slice(verifyIdx, webhookIdx);
  const sigIdx = verifySlice.indexOf('INVALID_SIGNATURE');
  const capIdx = verifySlice.indexOf("paymentDetails.status !== 'captured'");
  const payerIdx = verifySlice.indexOf('PAYER_MISMATCH');
  const recIdx = verifySlice.indexOf('credits.recordPurchase');
  assert.ok(sigIdx >= 0, 'the verify route must reject invalid signatures');
  assert.ok(capIdx >= 0, 'the verify route must reject non-captured payments');
  assert.ok(payerIdx >= 0, 'the verify route must bind the payment to the calling payer');
  assert.ok(recIdx >= 0, 'the verify route must credit through recordPurchase');
  assert.ok(sigIdx < recIdx, 'signature check must run before credits are added');
  assert.ok(capIdx < recIdx, 'captured-status check must run before credits are added');
  assert.ok(payerIdx < recIdx, 'payer binding must run before credits are added');

  // Webhook route: signature + captured gate before recordPurchase.
  const communityIdx = serverSrc.indexOf('COMMUNITY & SUPPORT');
  assert.ok(webhookIdx >= 0 && communityIdx > webhookIdx, 'webhook route must exist');
  const webhookSlice = serverSrc.slice(webhookIdx, communityIdx);
  const webSigIdx = webhookSlice.indexOf('verifyWebhookSignature');
  const webCapIdx = webhookSlice.indexOf("payment.status !== 'captured'");
  const webRecIdx = webhookSlice.indexOf('credits.recordPurchase');
  assert.ok(webSigIdx >= 0, 'the webhook route must verify the webhook signature');
  assert.ok(webCapIdx >= 0, 'the webhook route must skip non-captured payments');
  assert.ok(webRecIdx >= 0, 'the webhook route must credit through recordPurchase');
  assert.ok(webSigIdx < webRecIdx, 'webhook signature check must run before credits are added');
  assert.ok(webCapIdx < webRecIdx, 'captured gate must run before credits are added');
});

// ------------------------------------- 4. duplicate payment (idempotency) ------

test('duplicate payment: replaying the same paymentId credits exactly once', async () => {
  const { service, user } = await makeCredits(100);
  const first = service.recordPurchase(purchaseInput(user.id, 'pay_dup_json_1'));
  const second = service.recordPurchase(purchaseInput(user.id, 'pay_dup_json_1'));

  assert.equal(first.alreadyProcessed, false, 'the first application must go through');
  assert.equal(second.alreadyProcessed, true, 'the replay must be recognised');
  assert.equal(second.transaction.id, first.transaction.id, 'the replay returns the original ledger row');
  assert.equal(service.getBalance(user.id), 100 + 15, 'starter pack (15 credits) applied exactly once');
  assert.equal(
    service.getTransactions(user.id).filter((t) => t.type === 'PURCHASE').length,
    1,
    'exactly one PURCHASE ledger row for one payment',
  );
});

test('duplicate payment: a distinct paymentId for the same plan credits again (separate purchase)', async () => {
  const { service, user } = await makeCredits(0);
  service.recordPurchase(purchaseInput(user.id, 'pay_json_a'));
  service.recordPurchase(purchaseInput(user.id, 'pay_json_b'));
  assert.equal(service.getBalance(user.id), 30, 'two legitimate starter purchases = 30 credits');
  assert.equal(service.getTransactions(user.id).filter((t) => t.type === 'PURCHASE').length, 2);
});

test('duplicate payment: an invalid plan in a purchase attempt credits nothing', async () => {
  const { service, user } = await makeCredits(50);
  assert.throws(
    () =>
      service.recordPurchase({
        userId: user.id,
        planId: 'not-a-real-plan',
        paymentId: 'pay_bad_plan',
        orderId: 'order_bad_plan',
        amountInr: 1,
        currency: 'INR',
        planName: 'Bogus',
      }),
    (e: unknown) => e instanceof CreditError && e.code === 'INVALID_AMOUNT',
  );
  assert.equal(service.getBalance(user.id), 50, 'balance untouched by a rejected purchase');
  assert.equal(service.getTransactions(user.id).length, 0, 'no ledger row written');
});

// -------------------------------------------------- 5. credit assignment --------

test('credit assignment: a verified purchase writes plan credits + full payment metadata to the ledger', async () => {
  const { service, user } = await makeCredits(100);
  const pack = CREDIT_PACKS.find((p) => p.id === 'standard')!;
  const result = service.recordPurchase({
    userId: user.id,
    planId: 'standard',
    paymentId: 'pay_assign_1',
    orderId: 'order_assign_1',
    amountInr: pack.priceInr,
    currency: 'INR',
    planName: pack.name,
    email: 'buyer@example.com',
  });

  assert.equal(result.credits, service.getBalance(user.id), 'returned credits reflect the new balance');
  assert.equal(service.getBalance(user.id), 100 + pack.credits, 'exactly plan.credits added');

  const txn = result.transaction;
  assert.equal(txn.type, 'PURCHASE');
  assert.equal(txn.amount, pack.credits, 'ledger amount is the pack credit count');
  assert.equal(txn.userId, user.id);
  assert.equal(txn.paymentId, 'pay_assign_1', 'ledger row is keyed to the gateway payment');
  assert.equal(txn.paymentStatus, 'captured');
  assert.equal(txn.packageId, 'standard');
  assert.equal(txn.balanceBefore, 100);
  assert.equal(txn.balanceAfter, 100 + pack.credits);
  assert.equal(txn.reason, 'purchase');
  assert.ok(txn.id && txn.id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(txn.createdAt)));
});

test('credit assignment: the locked TEST-mode catalog prices and credit counts are unchanged', () => {
  assert.deepEqual(
    CREDIT_PACKS.map((p) => ({ id: p.id, priceInr: p.priceInr, credits: p.credits })),
    [
      { id: 'starter', priceInr: 69, credits: 15 },
      { id: 'basic', priceInr: 129, credits: 35 },
      { id: 'standard', priceInr: 299, credits: 80 },
      { id: 'pro', priceInr: 599, credits: 180 },
      { id: 'large', priceInr: 1199, credits: 400 },
      { id: 'annual', priceInr: 4499, credits: 2000 },
    ],
    'credit-pack prices/credits must not change without an explicit product decision',
  );
});
