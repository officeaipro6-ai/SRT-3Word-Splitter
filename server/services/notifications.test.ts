import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  OWNER_NOTIFICATION_EVENTS,
  PROVIDER_BALANCE_THRESHOLDS,
  balanceEventFor,
  createOwnerNotifier,
  redactSecrets,
  renderOwnerNotification,
  type OwnerNotificationPayload,
} from './notifications.ts';

const silentLog = { info: () => undefined, warn: () => undefined };

test('all four owner-alert events exist and are typed', () => {
  assert.deepEqual(OWNER_NOTIFICATION_EVENTS.slice().sort(), [
    'LOW_BALANCE',
    'PROVIDER_BLOCKED',
    'PROVIDER_WARNING',
    'QUOTA_EXHAUSTED',
  ]);
});

test('each event renders an actionable operator message with no invented data', () => {
  const cases: Array<[OwnerNotificationPayload['event'], RegExp]> = [
    ['PROVIDER_BLOCKED', /BLOCKED/i],
    ['QUOTA_EXHAUSTED', /exhausted quota/i],
    ['PROVIDER_WARNING', /repeated failures/i],
    ['LOW_BALANCE', /balance is low/i],
  ];
  for (const [event, expected] of cases) {
    const { title, body } = renderOwnerNotification({
      event,
      provider: 'sarvam',
      reason: 'test reason',
      lastError: 'HTTP 402: no credits available',
      lastHttpStatus: 402,
    });
    assert.match(title, /\S/);
    assert.match(body, expected);
    assert.match(body, /sarvam/);
    // The message must state the honest position on balances and automation.
    assert.match(body, /Balance: unknown|no verified balance\/quota API/);
    assert.match(body, /Automatic recharge is disabled/);
  }
});

test('the balance line only shows a percentage when a real source supplies one', () => {
  const known = renderOwnerNotification({
    event: 'LOW_BALANCE',
    provider: 'sarvam',
    balancePercent: 8,
    balanceSource: 'provider /account/usage',
  });
  assert.match(known.body, /8% remaining/);
  assert.match(known.body, /provider \/account\/usage/);

  const unknown = renderOwnerNotification({ event: 'PROVIDER_WARNING', provider: 'sarvam', balancePercent: null });
  assert.doesNotMatch(unknown.body, /%/);
  assert.match(unknown.body, /Balance: unknown/);
});

test('the documented thresholds map percentages to the right event', () => {
  assert.deepEqual(
    { ...PROVIDER_BALANCE_THRESHOLDS },
    { warning: 25, low: 10, critical: 5, blocked: 0 }
  );
  assert.equal(balanceEventFor(100), null);
  assert.equal(balanceEventFor(26), null);
  assert.equal(balanceEventFor(25), 'PROVIDER_WARNING');
  assert.equal(balanceEventFor(11), 'PROVIDER_WARNING');
  assert.equal(balanceEventFor(10), 'LOW_BALANCE');
  assert.equal(balanceEventFor(6), 'LOW_BALANCE');
  assert.equal(balanceEventFor(5), 'LOW_BALANCE');
  assert.equal(balanceEventFor(0), 'QUOTA_EXHAUSTED');
  // Unknown readings NEVER produce a balance alert — we do not fabricate one.
  assert.equal(balanceEventFor(null), null);
  assert.equal(balanceEventFor(undefined), null);
  assert.equal(balanceEventFor(Number.NaN), null);
});

test('with no transport configured, alerts are recorded but never claimed as delivered', () => {
  const notifier = createOwnerNotifier({ log: silentLog });
  assert.deepEqual(notifier.transportNames(), []);
  const n = notifier.notifyOwner({ event: 'QUOTA_EXHAUSTED', provider: 'sarvam', lastHttpStatus: 402 });
  assert.equal(n.delivered, false);
  assert.deepEqual(n.deliveries, []);
  assert.equal(n.deliveredAt, null);
  assert.match(n.note || '', /NOT connected/i);
  const recent = notifier.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].event, 'QUOTA_EXHAUSTED');
  // The admin API must be able to report the honest delivery status.
  assert.equal(notifier.transportNames().length > 0, false);
});

test('a transport added later receives the rendered message and is then marked delivered', () => {
  const seen: string[] = [];
  const notifier = createOwnerNotifier({
    log: silentLog,
    transports: {
      // Stands in for a future WhatsApp/email transport. Nothing in this repo
      // sends anything; this only proves the abstraction is transport-agnostic.
      'test-transport': (n) => {
        seen.push(n.body);
        return true;
      },
    },
  });
  const n = notifier.notifyOwner({ event: 'PROVIDER_BLOCKED', provider: 'sarvam', lastHttpStatus: 402 });
  assert.equal(n.delivered, true);
  assert.deepEqual(n.deliveries, ['test-transport']);
  assert.ok(n.deliveredAt);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /BLOCKED/);
  assert.equal(n.note, null);
});

test('a throwing transport can never break provider-safety handling', () => {
  const notifier = createOwnerNotifier({
    log: silentLog,
    transports: {
      broken: () => {
        throw new Error('transport exploded');
      },
    },
  });
  const n = notifier.notifyOwner({ event: 'PROVIDER_BLOCKED', provider: 'sarvam' });
  assert.equal(n.delivered, false);
  assert.equal(notifier.recent().length, 1);
});

test('a rejecting async transport is logged, not thrown and not unhandled', async () => {
  const warnings: Array<[string, Record<string, unknown>?]> = [];
  const notifier = createOwnerNotifier({
    log: {
      info: () => undefined,
      warn: (m, f) => { warnings.push([m, f]); },
    },
    transports: {
      'async-broken': () => Promise.reject(new Error('webhook 500')),
    },
  });
  const n = notifier.notifyOwner({ event: 'PROVIDER_BLOCKED', provider: 'sarvam' });
  assert.equal(n.delivered, false, 'delivery is not claimed before the promise settles');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(warnings.some(([m]) => m.includes('transport failed')));
  assert.equal(notifier.recent()[0].delivered, false);
});

test('an async transport that resolves true records delivery', async () => {
  const notifier = createOwnerNotifier({
    log: silentLog,
    transports: { 'async-transport': async () => true },
  });
  const n = notifier.notifyOwner({ event: 'PROVIDER_BLOCKED', provider: 'sarvam' });
  assert.equal(n.delivered, false);
  await new Promise((r) => setTimeout(r, 10));
  const stored = notifier.recent()[0];
  assert.equal(stored.delivered, true);
  assert.deepEqual(stored.deliveries, ['async-transport']);
});

test('secrets are scrubbed from rendered alerts and stored errors', () => {
  // The whole credential (name + value) is removed, not just the value.
  assert.equal(redactSecrets('api-subscription-key: abc123'), '[redacted]');
  assert.match(redactSecrets('Authorization: Bearer sk-abcdefghijkl'), /\[redacted\]/);
  assert.match(redactSecrets('SARVAM_API_KEY=deadbeef'), /\[redacted\]/);
  const long = redactSecrets('x'.repeat(1000), 50);
  assert.ok(long.length <= 51);

  const notifier = createOwnerNotifier({ log: silentLog });
  const n = notifier.notifyOwner({
    event: 'PROVIDER_BLOCKED',
    provider: 'sarvam',
    reason: 'failed with api-subscription-key: supersecretvalue',
    lastError: 'Authorization: Bearer sk-live-1234567890',
  });
  assert.doesNotMatch(n.body, /supersecretvalue/);
  assert.doesNotMatch(n.body, /sk-live-1234567890/);
  assert.doesNotMatch(n.reason || '', /supersecretvalue/);
  assert.doesNotMatch(n.lastError || '', /sk-live-1234567890/);
});

test('no WhatsApp/phone integration was added: no package, no endpoint, no fake send', () => {
  const src = fs.readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).join(',');
  for (const banned of ['twilio', 'whatsapp', 'wa-automate', 'wati', 'interakt', 'axios', 'node-fetch']) {
    assert.ok(!deps.toLowerCase().includes(banned), `${banned} must not be added as a dependency`);
  }
  // The abstraction is transport-neutral: no HTTP call and no URL in the module.
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\/(api\.)?(twilio|whatsapp|meta)/i);
  // It is honest about not being connected by default.
  assert.match(src, /WhatsApp is NOT connected/);
  // No WhatsApp API is called anywhere: the server only ever mentions the word
  // in documentation stating that no channel is connected.
  const server = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /api\.whatsapp|graph\.facebook|wa\.me|twilio/i);
  assert.doesNotMatch(server, /sendMessage|sendWhatsApp/i);
  assert.match(server, /WhatsApp is NOT connected/);
});

test('alerts are bounded and resettable (no unbounded memory growth)', () => {
  const notifier = createOwnerNotifier({ log: silentLog });
  for (let i = 0; i < 80; i += 1) {
    notifier.notifyOwner({ event: 'PROVIDER_WARNING', provider: 'sarvam' });
  }
  assert.ok(notifier.recent(100).length <= 50);
  notifier.reset();
  assert.equal(notifier.recent().length, 0);
});
