/**
 * Razorpay payment gateway integration — server-side only.
 *
 * SECURITY:
 * - Razorpay secret NEVER leaves this module or reaches the frontend.
 * - All order creation, signature verification, and webhook handling are
 *   server-side only.
 * - Test mode is the default; live mode requires explicit configuration.
 * - Stage 6B: a LIVE key is refused unless RAZORPAY_LIVE_ENABLED=true, so
 *   substituting a key alone can never activate LIVE payments.
 * - No hardcoded credentials; all config from environment variables.
 */
import crypto from 'crypto';
import Razorpay from 'razorpay';
import type { CreditTransactionRecord, CreditTransactionType } from '../db/types';
// Canonical catalog (single source of truth); re-exported below under the
// historical names so existing importers are unaffected.
import { CREDIT_PACKS, getPlanById, type CreditPlan } from './creditPolicy';

/**
 * Razorpay configuration from environment.
 * Returns null if configuration is incomplete.
 */
export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  testMode: boolean;
}

/**
 * Stage 6B — explicit LIVE gate.
 *
 * Razorpay LIVE key IDs are issued with an `rzp_live_` prefix (TEST keys use
 * `rzp_test_`), which makes an "obvious LIVE configuration" detectable from the
 * key ID alone. Nothing else about the credentials is inspected, and no value is
 * ever logged or echoed.
 *
 * The switch defaults to FALSE. Swapping the key alone therefore cannot make the
 * application take LIVE payments: LIVE requires `RAZORPAY_LIVE_ENABLED=true` AND
 * an unambiguous `RAZORPAY_TEST_MODE=false`. Anything less is rejected.
 *
 * This is deliberately opt-in and off by default. Activating LIVE remains a
 * separate, explicit human decision that is NOT performed by this module.
 */
export function razorpayLiveEnabled(): boolean {
  return (process.env.RAZORPAY_LIVE_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Prefix Razorpay uses for LIVE key IDs. TEST keys never carry it. */
const RAZORPAY_LIVE_KEY_PREFIX = 'rzp_live_';

/**
 * Stage 6B — decide whether the current Razorpay configuration may be used, and
 * say why not.
 *
 * Returned separately from readRazorpayConfig() so the decision has one
 * testable source of truth and a secret-free explanation an operator can act on.
 * The reason deliberately describes the *condition*, never any credential value.
 *
 * `null` means the configuration is usable. Credentials being absent is NOT a
 * guard failure — that is the pre-existing "feature not configured" case, handled
 * by readRazorpayConfig() returning null.
 */
export function razorpayLiveGuardReason(): string | null {
  const keyId = (process.env.RAZORPAY_KEY_ID ?? '').trim();
  if (keyId.length === 0) return null;

  const liveEnabled = razorpayLiveEnabled();
  const testMode = (process.env.RAZORPAY_TEST_MODE ?? 'true').toLowerCase() !== 'false';

  if (keyId.startsWith(RAZORPAY_LIVE_KEY_PREFIX) && !liveEnabled) {
    return (
      'a Razorpay LIVE key is configured but RAZORPAY_LIVE_ENABLED is not true. ' +
      'Refusing to use it, because a LIVE key must never become active merely by being ' +
      'substituted. Set RAZORPAY_LIVE_ENABLED=true (deliberately, as a separate decision) ' +
      'to allow LIVE, or restore a TEST key.'
    );
  }

  if (liveEnabled && testMode) {
    return (
      'RAZORPAY_LIVE_ENABLED is true but RAZORPAY_TEST_MODE is not false. ' +
      'Refusing this contradictory combination: LIVE credentials must not be used while ' +
      'the application still believes it is in TEST mode. Set RAZORPAY_TEST_MODE=false ' +
      'explicitly, or set RAZORPAY_LIVE_ENABLED=false.'
    );
  }

  return null;
}

/**
 * Read Razorpay configuration from environment variables.
 * Returns null if required credentials are missing, or if the Stage 6B LIVE
 * guard rejects the configuration (in which case payments stay disabled rather
 * than silently falling through to a LIVE gateway).
 */
export function readRazorpayConfig(): RazorpayConfig | null {
  const keyId = (process.env.RAZORPAY_KEY_ID ?? '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET ?? '').trim();
  const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim();
  const testMode = (process.env.RAZORPAY_TEST_MODE ?? 'true').toLowerCase() !== 'false';

  if (!keyId || !keySecret || !webhookSecret) {
    return null;
  }

  // Stage 6B: an obvious LIVE configuration is rejected here rather than
  // downstream, so no code path can construct a LIVE Razorpay client from it.
  if (razorpayLiveGuardReason() !== null) {
    return null;
  }

  return { keyId, keySecret, webhookSecret, testMode };
}

/**
 * Create Razorpay instance from config.
 * Returns null if configuration is invalid.
 */
export function createRazorpayInstance(config: RazorpayConfig): Razorpay | null {
  try {
    return new Razorpay({
      key_id: config.keyId,
      key_secret: config.keySecret,
    });
  } catch {
    return null;
  }
}

/**
 * Locked credit plans — server-side only.
 * NEVER trust client-supplied prices or credit amounts.
 *
 * The catalog itself lives in `creditPolicy` (CREDIT_PACKS) and is re-exported
 * here under its original names so existing importers keep working. A second
 * literal copy used to live in this file; it was byte-identical but a
 * divergence waiting to happen, and `creditPolicy.getPlanById` referenced a
 * `CREDIT_PLANS` identifier that did not exist in its own module.
 */
export { CREDIT_PACKS as CREDIT_PLANS, getPlanById } from './creditPolicy';
export type { CreditPlan } from './creditPolicy';

/**
 * Create a Razorpay order for a credit purchase.
 * The amount is in paise (1 INR = 100 paise) as required by Razorpay.
 */
export interface CreateOrderInput {
  userId: string;
  planId: string;
  userEmail?: string;
  receiptPrefix?: string;
}

export interface CreateOrderResult {
  orderId: string;
  amount: number; // in paise
  currency: 'INR';
  keyId: string;
  plan: CreditPlan;
}

export async function createRazorpayOrder(
  razorpay: Razorpay,
  input: CreateOrderInput
): Promise<CreateOrderResult> {
  const plan = getPlanById(input.planId);
  if (!plan) {
    throw new Error('INVALID_PLAN');
  }

  const amountPaise = plan.priceInr * 100; // Razorpay expects paise
  const receipt = `${input.receiptPrefix ?? 'credits'}_${input.userId}_${Date.now()}`;

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes: {
      userId: input.userId,
      planId: input.planId,
      userEmail: input.userEmail ?? '',
    },
  });

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: order.id.startsWith('order_') ? '' : '', // keyId is from config
    plan,
  };
}

/**
 * Verify Razorpay webhook signature.
 * Returns true if signature is valid, false otherwise.
 */
export function verifyWebhookSignature(
  webhookSecret: string,
  payload: string | Buffer,
  signature: string
): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Verify Razorpay payment signature (for checkout redirect/callback verification).
 */
export function verifyPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Payment record for webhook processing.
 * Mirrors the fields we need to create the PURCHASE credit transaction.
 */
export interface PaymentRecord {
  paymentId: string;
  orderId: string;
  userId: string;
  planId: string;
  amount: number; // in INR
  currency: string;
  status: 'captured' | 'failed' | 'refunded' | 'authorized';
  capturedAt?: string;
  email?: string;
}

/**
 * Parse Razorpay webhook payload into a PaymentRecord.
 * Returns null if the event is not relevant or data is invalid.
 */
export function parseWebhookPayload(payload: any): PaymentRecord | null {
  if (!payload?.event || !payload?.payload?.payment?.entity) {
    return null;
  }

  const payment = payload.payload.payment.entity;
  const orderId = payment.order_id;
  const paymentId = payment.id;
  const amount = payment.amount; // in paise
  const currency = payment.currency;
  const status = payment.status;
  const capturedAt = payment.captured ? new Date(payment.captured_at * 1000).toISOString() : undefined;
  const notes = payment.notes ?? {};

  const userId = notes.userId;
  const planId = notes.planId;
  const email = notes.userEmail;

  if (!userId || !planId) {
    return null;
  }

  return {
    paymentId,
    orderId,
    userId,
    planId,
    amount: amount / 100, // convert paise to INR
    currency,
    status,
    capturedAt,
    email,
  };
}

/**
 * Create a PURCHASE credit transaction record from a successful payment.
 */
export function createPurchaseTransaction(
  payment: PaymentRecord,
  userId: string,
  _email?: string
): Omit<CreditTransactionRecord, 'id' | 'createdAt'> {
  const plan = getPlanById(payment.planId);
  if (!plan) {
    throw new Error('INVALID_PLAN_IN_PAYMENT');
  }

  return {
    userId,
    amount: plan.credits,
    type: 'PURCHASE' as CreditTransactionType,
    reason: 'purchase',
    balanceBefore: 0, // will be filled by credit service
    balanceAfter: 0, // will be filled by credit service
    paymentId: payment.paymentId,
    paymentStatus: 'captured',
    packageId: payment.planId,
  };
}