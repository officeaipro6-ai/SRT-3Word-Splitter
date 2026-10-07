/**
 * Unit contract for the email transport (server/services/emailTransport.ts).
 *
 * Covers the mode selection, link/message building, HTML escaping and the
 * dev-log transport output. Real SMTP delivery is never attempted here (it
 * would need a server); the log transport and the sender factory are asserted
 * hermetically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailTransportConfig,
  verificationLink,
  buildVerificationEmail,
  verificationEmailFor,
  createEmailSender,
  createLogSender,
  type EmailMessage,
} from './emailTransport';

test('emailTransportConfig reads straight from the environment and trims', () => {
  const cfg = emailTransportConfig({
    EMAIL_FROM: '  support@example.com  ',
    SMTP_HOST: ' smtp.example.com ',
    SMTP_PORT: ' 587 ',
    SMTP_USER: ' u ',
    SMTP_PASSWORD: ' s ',
    SMTP_SECURE: ' true ',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.emailFrom, 'support@example.com');
  assert.equal(cfg.smtpHost, 'smtp.example.com');
  assert.equal(cfg.smtpPort, '587');
  assert.equal(cfg.smtpUser, 'u');
  assert.equal(cfg.smtpPassword, 's');
  assert.equal(cfg.smtpSecure, 'true');

  const empty = emailTransportConfig({} as NodeJS.ProcessEnv);
  assert.equal(empty.emailFrom, '');
  assert.equal(empty.smtpHost, '');
});

test('verificationLink resolves one route, normalises base and URL-encodes the token', () => {
  assert.equal(
    verificationLink('abc-123_SY', 'https://app.example.com/'),
    'https://app.example.com/api/auth/verify-email?token=abc-123_SY'
  );
  // Trailing slashes collapse; the token is single-argument, always encoded.
  assert.equal(
    verificationLink('a b+c', 'https://x.example.com////'),
    'https://x.example.com/api/auth/verify-email?token=a%20b%2Bc'
  );
});

test('buildVerificationEmail carries the link, an HTML-safe copy and a normalized recipient', () => {
  const link = 'https://app.example.com/api/auth/verify-email?token=deadbeef';
  const msg = buildVerificationEmail('  Mixed@Example.COM  ', link, 'noreply@example.com');

  assert.equal(msg.to, 'mixed@example.com', 'the recipient is normalized to the stored account email');
  assert.equal(msg.subject, 'Verify your Odia SRT email address');
  assert.ok(msg.text.includes(link), 'the plain-text body must contain the clickable link');
  assert.ok(msg.html.includes('https://app.example.com/api/auth/verify-email?token=deadbeef'));
  assert.ok(msg.html.startsWith('<div style='));
});

test('HTML in the base URL is escaped so the email cannot carry markup', () => {
  // A hostile/injected base URL must never become HTML in the email.
  const msg = buildVerificationEmail(
    'u@example.com',
    'https://evil.example.com/x?token=<img src=x onerror=alert(1)>&amp',
    'noreply@example.com'
  );
  assert.ok(!msg.html.includes('<img'), 'the button href must escape the raw URL');
  assert.ok(msg.html.includes('&lt;img'), 'angle brackets must be entity-escaped');
});

test('verificationEmailFor prefers the explicit app base URL, then the request origin', () => {
  const token = 'tok-123';
  const { message } = verificationEmailFor('u@example.com', token, {
    appBaseUrl: 'https://fixed.example.com/',
    requestBaseUrl: 'https://req.example.com',
  });
  assert.ok(message.text.includes('https://fixed.example.com/api/auth/verify-email'));

  const req = verificationEmailFor('u@example.com', token, { requestBaseUrl: 'http://localhost:3000' });
  assert.ok(req.message.text.includes('http://localhost:3000/api/auth/verify-email'));

  const def = verificationEmailFor('u@example.com', token, {});
  assert.ok(def.message.text.includes('http://localhost:3000/api/auth/verify-email'));
});

test('createEmailSender selects SMTP only when host AND from are configured, else the log fallback', () => {
  const noSmtp = createEmailSender({} as NodeJS.ProcessEnv);
  assert.equal(noSmtp.mode, 'log', 'no SMTP config -> development log transport');

  const halfConfigured = createEmailSender({ SMTP_HOST: 'smtp.x.com' } as NodeJS.ProcessEnv);
  assert.equal(halfConfigured.mode, 'log', 'host alone must NOT enable SMTP (no from-address)');

  const smtp = createEmailSender({
    SMTP_HOST: 'smtp.x.com',
    EMAIL_FROM: 'me@x.com',
    SMTP_PASSWORD: 'super-secret',
  } as NodeJS.ProcessEnv);
  assert.equal(smtp.mode, 'smtp');
});

test('the log transport prints the verification LINK and never a token hash or credentials', async () => {
  const msg: EmailMessage = {
    to: 'u@example.com',
    subject: 'Verify your Odia SRT email address',
    text: 'Click this link to verify your email address and start transcribing:\n\nhttps://app.example.com/api/auth/verify-email?token=raw-token-value',
    html: '<p>x</p>',
  };

  let printed: string[] = [];
  let delivery:
    | Awaited<ReturnType<ReturnType<typeof createLogSender>>>
    | undefined;
  const original = console.log;
  console.log = (...a: unknown[]) => printed.push(a.map(String).join(' '));
  try {
    delivery = await createLogSender()(msg);
  } finally {
    console.log = original;
  }

  assert.equal(delivery!.delivered, true);
  assert.equal(delivery!.transport, 'log');
  assert.ok(!delivery!.error, 'log delivery never reports an error');
  assert.ok(printed.some((l) => l.includes('[email:log]')), 'lines must be labelled [email:log]');
  assert.ok(
    printed.some((l) => l.includes('verification link (dev only)')),
    'the dev fallback must be unmistakably labelled as not-real-mail'
  );
  assert.ok(
    printed.some((l) => l.includes('https://app.example.com/api/auth/verify-email?token=raw-token-value')),
    'the dev log must expose the full clickable verification link'
  );
  assert.ok(
    !printed.some((l) => l.includes('super-secret')),
    'no credential may ever reach the log transport output'
  );
});