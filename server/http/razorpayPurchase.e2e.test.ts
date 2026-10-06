/**
 * Razorpay TEST MODE purchase flow over REAL HTTP: the REAL server process,
 * real auth, real ledger, real signature math — and an in-memory gateway
 * injected into the child process so no request ever leaves this machine.
 *
 * Why a child process: server.ts binds a port and installs timers on import
 * (see authRoutes.e2e.test.ts), which would keep the test runner alive.
 *
 * Why a fixture instead of route mocks: the gateway seam is the razorpay SDK.
 * Replacing it in the require cache lets the production routes run unmodified
 * while tests control exactly what the gateway answers — amounts, statuses and
 * the payer notes that createRazorpayOrder actually wrote.
 *
 * Regression coverage (the two payment-path defect fixes):
 *   DEFECT 1 — webhook signatures are HMACs over the EXACT raw request bytes:
 *              valid raw HMAC accepted; tampered bytes rejected; a signature
 *              over the JSON-normalised form cannot pass; the exact bytes as
 *              sent are what gets verified.
 *   DEFECT 2 — verify binds the payment to the order's recorded payer:
 *              the owner passes; a different signed-in user with a valid
 *              signature is refused 403 BEFORE any credit is recorded;
 *              replays of both routes stay idempotent; failed payments
 *              credit nothing.
 *
 * TEST MODE ONLY: fake rzp_test_ credentials injected into the child, never a
 * live key, and no secret value may ever appear in any response body.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = Number(process.env.RZP_E2E_PORT ?? 4327);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'CorrectHorse1!';

// TEST credentials are FAKE and injected only into the child process.
// The key id must look like a real test key; the secrets only ever exist
// here and in the child's environment, never in a response body.
const KEY_ID = 'rzp_test_e2e_fake_key_id_0001';
const KEY_SECRET = 'e2e_fake_test_key_secret_001';
const WEBHOOK_SECRET = 'e2e_fake_webhook_secret_001';

const STARTER_PRICE_INR = 69;
const STARTER_PAISE = STARTER_PRICE_INR * 100;
const STARTER_CREDITS = 15;
const OPENING_CREDITS = 25;

let dir: string;
let dbUrl: string;
let child: ChildProcess | undefined;
let stdout = '';
let stderr = '';

interface HttpResult {
  status: number;
  json: any;
  text: string;
}

async function post(path: string, body: unknown, token?: string): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is itself a finding */
  }
  return { status: res.status, json, text };
}

/** Sends a body byte-for-byte as given — the webhook contract is raw bytes. */
async function postRaw(path: string, rawBody: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* see above */
  }
  return { status: res.status, json, text };
}

async function get(path: string, token?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* see above */
  }
  return { status: res.status, json, text };
}

const hmac = (secret: string, data: string): string =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

const signPayment = (orderId: string, paymentId: string): string =>
  hmac(KEY_SECRET, `${orderId}|${paymentId}`);

async function signup(email: string): Promise<{ token: string; userId: string }> {
  const res = await post('/api/account/signup', { email, password: PASSWORD });
  assert.equal(res.status, 201, `signup must succeed: ${res.text}`);
  return { token: res.json.token, userId: res.json.userId };
}

async function wallet(token: string): Promise<{ credits: number; purchases: any[] }> {
  const res = await get('/api/credits/me', token);
  assert.equal(res.status, 200, `wallet must load: ${res.text}`);
  const purchases = (res.json.transactions as any[]).filter((t) => t.type === 'PURCHASE');
  return { credits: res.json.credits, purchases };
}

function assertNoSecrets(res: HttpResult, where: string): void {
  assert.ok(!res.text.includes(KEY_SECRET), `${where} must never contain the key secret`);
  assert.ok(!res.text.includes(WEBHOOK_SECRET), `${where} must never contain the webhook secret`);
}

/** Razorpay-shaped webhook payload carrying payer notes from order creation. */
function webhookPayload(opts: {
  paymentId: string;
  orderId: string;
  userId: string;
  planId: string;
  status: 'captured' | 'failed';
}): string {
  const captured = opts.status === 'captured';
  return JSON.stringify({
    event: captured ? 'payment.captured' : 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: opts.paymentId,
          order_id: opts.orderId,
          amount: STARTER_PAISE,
          currency: 'INR',
          status: opts.status,
          captured,
          captured_at: 1700000000,
          notes: {
            userId: opts.userId,
            planId: opts.planId,
            userEmail: 'payer@example.com',
          },
        },
      },
    },
  });
}

async function sendWebhook(rawBody: string): Promise<HttpResult> {
  return postRaw('/api/credits/purchase/webhook', rawBody, {
    'x-razorpay-signature': hmac(WEBHOOK_SECRET, rawBody),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rze2e-'));
  dbUrl = `file:${join(dir, 'app.db')}`;
  const fixturePath = join(process.cwd(), 'server', 'http', 'fixtures', 'razorpayGatewayMock.cjs');

  child = spawn(
    // Single-process mode on purpose: `tsx` (the CLI) spawns a child process in
    // which our `module.register()` fixture hooks are not chained for the
    // application's imports, while `--import tsx` keeps everything in one
    // process where the razorpay interception provably applies.
    process.execPath,
    ['--require', fixturePath, '--import', 'tsx', 'server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        DATA_DIR: join(dir, 'data'),
        DATABASE_PROVIDER: 'turso',
        TURSO_DATABASE_URL: dbUrl,
        // Local libSQL file URL: no network, and not a real credential.
        TURSO_AUTH_TOKEN: 'local-e2e-file-token',
        INITIAL_CREDITS: String(OPENING_CREDITS),
        FREE_TRIAL_LIMIT: '1',
        STORAGE_PROVIDER: 'local',
        ENABLE_JOB_QUEUE: 'false',
        // Strip any real secrets this machine may have in .env so nothing here
        // can touch a live database, gateway, owner account or notification.
        ADMIN_BOOTSTRAP_TOKEN: '',
        OWNER_EMAILS: '',
        SARVAM_API_KEY: '',
        LOCAL_SUBMISSION_MODE: 'false',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        // Fake TEST-mode gateway credentials: enabled locally, inert on the
        // network (the fixture SDK never dials out), and never a live key.
        RAZORPAY_KEY_ID: KEY_ID,
        RAZORPAY_KEY_SECRET: KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        RAZORPAY_TEST_MODE: 'true',
        RAZORPAY_LIVE_ENABLED: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr?.on('data', (d) => {
    stderr += String(d);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best effort */
  }
});

// Shared actors. Tests run serially in file order, and each step asserts the
// exact wallet/ledger state it expects to leave behind.
let alice: { token: string; userId: string };
let alicePaid: { orderId: string; paymentId: string; signature: string; transactionId: string };

test('boot: the server runs in TEST mode with the purchase routes behind auth', async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);

  const anonymous = await post('/api/credits/purchase/order', { planId: 'starter' });
  assert.equal(anonymous.status, 401, 'order creation must require a session');
  assert.equal((await post('/api/credits/purchase/verify', { planId: 'starter' })).status, 401);
  assert.equal(
    (await post('/api/credits/purchase/webhook', {}, undefined)).status,
    400,
    'a webhook without Razorpay signature headers must be refused',
  );
});

test('checkout: a captured payment credits the paying account once (owner path)', async () => {
  alice = await signup('rzp-alice@example.com');
  const start = await wallet(alice.token);
  assert.equal(start.credits, OPENING_CREDITS, 'signup opens the ledger at INITIAL_CREDITS');
  assert.equal(start.purchases.length, 0);

  // Client sends ONLY the plan id; every price/credit figure comes back from
  // the server's locked catalog, and the checkout key is the TEST key id.
  const order = await post('/api/credits/purchase/order', { planId: 'starter' }, alice.token);
  assert.equal(order.status, 200, `order creation must succeed: ${order.text}`);
  assert.ok(order.json.orderId.startsWith('order_'), 'a gateway order id must be returned');
  assert.equal(order.json.amount, STARTER_PAISE, 'amount must be the catalog price in paise');
  assert.equal(order.json.currency, 'INR');
  assert.equal(order.json.keyId, KEY_ID, 'checkout must receive the TEST key id');
  assert.equal(order.json.plan.credits, STARTER_CREDITS);
  assert.equal(order.json.plan.priceInr, STARTER_PRICE_INR);
  assertNoSecrets(order, 'the order response');

  // The fake gateway derives payment facts from the stored order, so this
  // signature passes only if production verified amount/status/order too.
  const paymentId = `pay::${order.json.orderId}::captured`;
  const signature = signPayment(order.json.orderId, paymentId);
  const verify = await post(
    '/api/credits/purchase/verify',
    { orderId: order.json.orderId, paymentId, signature, planId: 'starter' },
    alice.token,
  );
  assert.equal(verify.status, 200, `verify must succeed: ${verify.text}`);
  assert.equal(verify.json.success, true);
  assert.equal(verify.json.alreadyProcessed, false, 'the first capture must apply');
  assert.equal(verify.json.credits, OPENING_CREDITS + STARTER_CREDITS, 'verify reports the new balance');
  assertNoSecrets(verify, 'the verify response');

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + STARTER_CREDITS);
  assert.equal(after.purchases.length, 1, 'exactly one PURCHASE ledger row');
  const row = after.purchases[0];
  // paymentId is its own first-class column; packageId/paymentStatus ride in
  // the `extra` overflow bag and are lifted back onto the record on read, so
  // the PERSISTED row carries the full purchase metadata.
  assert.equal(row.paymentId, paymentId, 'the ledger row records the gateway payment id');
  assert.equal(row.packageId, 'starter', 'the persisted ledger row carries the catalog pack');
  assert.equal(row.paymentStatus, 'captured', 'the persisted ledger row carries the capture status');
  assert.equal(verify.json.transaction.packageId, 'starter', 'the verified response carries the catalog pack');
  assert.equal(verify.json.transaction.paymentStatus, 'captured');

  alicePaid = { orderId: order.json.orderId, paymentId, signature, transactionId: verify.json.transaction.id };
});

test('payer binding: another signed-in user cannot claim the order (403, no credit)', async () => {
  const bob = await signup('rzp-bob@example.com');

  // Bob's own order, correctly signed — the only thing wrong is WHO presents it.
  const bobOrder = await post('/api/credits/purchase/order', { planId: 'starter' }, bob.token);
  assert.equal(bobOrder.status, 200, bobOrder.text);
  const bobPaymentId = `pay::${bobOrder.json.orderId}::captured`;
  const bobSignature = signPayment(bobOrder.json.orderId, bobPaymentId);

  const stolen = await post(
    '/api/credits/purchase/verify',
    { orderId: bobOrder.json.orderId, paymentId: bobPaymentId, signature: bobSignature, planId: 'starter' },
    alice.token,
  );
  assert.equal(stolen.status, 403, `a foreign payer must be refused: ${stolen.text}`);
  assert.equal(stolen.json.code, 'PAYER_MISMATCH');
  assert.ok(!stolen.text.includes(bob.userId), 'the refusal must not reveal the real payer id');
  assertNoSecrets(stolen, 'the payer-mismatch response');

  const aliceNow = await wallet(alice.token);
  assert.equal(aliceNow.credits, OPENING_CREDITS + STARTER_CREDITS, 'no credit may be applied');
  assert.equal(aliceNow.purchases.length, 1, 'no ledger row may be added');
  const bobNow = await wallet(bob.token);
  assert.equal(bobNow.credits, OPENING_CREDITS, "the order owner's wallet is untouched");
  assert.equal(bobNow.purchases.length, 0);
});

test('idempotency: replaying verify returns the original result without re-crediting', async () => {
  const replay = await post(
    '/api/credits/purchase/verify',
    { orderId: alicePaid.orderId, paymentId: alicePaid.paymentId, signature: alicePaid.signature, planId: 'starter' },
    alice.token,
  );
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.alreadyProcessed, true, 'the replay must be recognised');
  // The replayed transaction is read back through TursoScope.toTransaction
  // inside the idempotency check — the metadata must survive that path too.
  assert.equal(replay.json.transaction.id, alicePaid.transactionId, 'the ORIGINAL row is returned');
  assert.equal(replay.json.transaction.packageId, 'starter', 'the scope-read replay carries the pack');
  assert.equal(replay.json.transaction.paymentStatus, 'captured');

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + STARTER_CREDITS, 'balance must not move');
  assert.equal(after.purchases.length, 1, 'no second PURCHASE row');
});

test('webhook: a valid raw-body HMAC is accepted and credits the order owner', async () => {
  const raw = webhookPayload({
    paymentId: 'pay_wh_accept_1',
    orderId: 'order_e2e_wh_1',
    userId: alice.userId,
    planId: 'starter',
    status: 'captured',
  });
  const res = await sendWebhook(raw);
  assert.equal(res.status, 200, `the webhook must be accepted: ${res.text}`);
  assert.equal(res.json.received, true);
  assert.equal(res.json.creditsAdded, STARTER_CREDITS);
  assert.equal(res.json.alreadyProcessed, false);
  assertNoSecrets(res, 'the webhook response');

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 2 * STARTER_CREDITS);
  assert.equal(after.purchases.length, 2);
  assert.ok(
    after.purchases.some((t) => t.paymentId === 'pay_wh_accept_1'),
    'the webhook payment must appear in the ledger',
  );
});

test('webhook: replaying the same signed payload credits exactly once', async () => {
  const raw = webhookPayload({
    paymentId: 'pay_wh_accept_1',
    orderId: 'order_e2e_wh_1',
    userId: alice.userId,
    planId: 'starter',
    status: 'captured',
  });
  const res = await sendWebhook(raw);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.received, true);
  assert.equal(res.json.alreadyProcessed, true, 'the replay must be recognised');

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 2 * STARTER_CREDITS, 'balance must not move');
  assert.equal(after.purchases.length, 2, 'no second PURCHASE row for the same payment');
});

test('webhook: a tampered raw body fails signature verification and credits nothing', async () => {
  const raw = webhookPayload({
    paymentId: 'pay_wh_tamper_1',
    orderId: 'order_e2e_wh_2',
    userId: alice.userId,
    planId: 'starter',
    status: 'captured',
  });
  const signature = hmac(WEBHOOK_SECRET, raw);
  const tampered = raw.replace('"starter"', '"stsrter"');
  assert.notEqual(tampered, raw, 'the body must actually differ from the signed bytes');

  const res = await postRaw('/api/credits/purchase/webhook', tampered, { 'x-razorpay-signature': signature });
  assert.equal(res.status, 400, `tampered bytes must be refused: ${res.text}`);
  assert.match(res.json.error, /signature/i);

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 2 * STARTER_CREDITS, 'no credit for a tampered body');
  assert.equal(after.purchases.length, 2, 'no ledger row for a tampered body');
});

test('webhook: a signature over the JSON-normalised form cannot substitute for the raw bytes', async () => {
  // The server received this body as pretty-printed JSON. If verification ran
  // over JSON.parse -> JSON.stringify instead of the exact received bytes, this
  // normalised-form signature would pass. It must not.
  const payload = webhookPayload({
    paymentId: 'pay_wh_norm_1',
    orderId: 'order_e2e_wh_3',
    userId: alice.userId,
    planId: 'starter',
    status: 'captured',
  });
  const pretty = JSON.stringify(JSON.parse(payload), null, 2);
  assert.notEqual(pretty, payload, 'the sent bytes must differ from the normalised form');
  const normalisedSignature = hmac(WEBHOOK_SECRET, payload);

  const res = await postRaw('/api/credits/purchase/webhook', pretty, {
    'x-razorpay-signature': normalisedSignature,
  });
  assert.equal(res.status, 400, `normalised-form signatures must be refused: ${res.text}`);
  assert.match(res.json.error, /signature/i);

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 2 * STARTER_CREDITS, 'no credit from a normalised signature');
  assert.equal(after.purchases.length, 2);
});

test('webhook: the exact bytes as sent are what the signature is verified against', async () => {
  // The mirror image of the previous test: a signature over the pretty-printed
  // bytes, sent with those same pretty-printed bytes, must be accepted —
  // proving the raw payload is used as-is and never re-serialised.
  const payload = webhookPayload({
    paymentId: 'pay_wh_pretty_1',
    orderId: 'order_e2e_wh_4',
    userId: alice.userId,
    planId: 'starter',
    status: 'captured',
  });
  const pretty = JSON.stringify(JSON.parse(payload), null, 2);
  const res = await sendWebhook(pretty);
  assert.equal(res.status, 200, `the exact sent bytes must verify: ${res.text}`);
  assert.equal(res.json.creditsAdded, STARTER_CREDITS);

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 3 * STARTER_CREDITS);
  assert.equal(after.purchases.length, 3);
});

test('failed payment: a non-captured checkout and a payment.failed webhook credit nothing', async () => {
  // Checkout path: correctly signed, but the gateway says the payment failed.
  const order = await post('/api/credits/purchase/order', { planId: 'starter' }, alice.token);
  assert.equal(order.status, 200, order.text);
  const paymentId = `pay::${order.json.orderId}::failed`;
  const verify = await post(
    '/api/credits/purchase/verify',
    { orderId: order.json.orderId, paymentId, signature: signPayment(order.json.orderId, paymentId), planId: 'starter' },
    alice.token,
  );
  assert.equal(verify.status, 400, `a failed payment must not verify: ${verify.text}`);
  assert.equal(verify.json.code, 'PAYMENT_NOT_CAPTURED');

  // Webhook path: payment.failed is acknowledged but must never credit.
  const raw = webhookPayload({
    paymentId: 'pay_wh_failed_1',
    orderId: 'order_e2e_wh_5',
    userId: alice.userId,
    planId: 'starter',
    status: 'failed',
  });
  const res = await sendWebhook(raw);
  assert.equal(res.status, 200, `failed events are acknowledged: ${res.text}`);
  assert.equal(res.json.received, true);
  assert.equal(res.json.creditsAdded, undefined, 'a failed event must never add credits');

  const after = await wallet(alice.token);
  assert.equal(after.credits, OPENING_CREDITS + 3 * STARTER_CREDITS, 'no credit from either path');
  assert.equal(after.purchases.length, 3, 'no PURCHASE row from either path');
  assert.ok(
    !after.purchases.some((t) => t.paymentId === 'pay_wh_failed_1'),
    'the failed webhook payment must be absent from the ledger',
  );
});
