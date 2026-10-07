/**
 * Unit contract for the email transport (server/services/emailTransport.ts).
 *
 * Covers mode selection, link/message building, HTML escaping, the dev-log
 * transport output, the sanitized error classifier and the Resend HTTPS
 * sender. Real network delivery is never attempted here: `fetch` is stubbed
 * and its calls are captured so the Authorization header, payload and failure
 * handling can be asserted hermetically.
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
  createResendSender,
  classifyDeliveryError,
  scrubSensitiveText,
  type EmailMessage,
} from './emailTransport';

type CapturedFetch = { url: string; init: RequestInit };

const RESEND_URL = 'https://api.resend.com/emails';

/** Swap in a fake fetch that records calls and returns the given response. */
function withFetchMock(
  respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response
): { calls: CapturedFetch[]; restore: () => void } {
  const calls: CapturedFetch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const SAMPLE_MESSAGE: EmailMessage = {
  to: 'u@example.com',
  subject: 'Verify your Odia SRT email address',
  text: 'Click this link to verify your email address and start transcribing:\n\nhttps://app.example.com/api/auth/verify-email?token=raw-token-value',
  html: '<p>Verify now</p>',
};

test('emailTransportConfig reads straight from the environment and trims', () => {
  const cfg = emailTransportConfig({
    EMAIL_FROM: '  support@example.com  ',
    RESEND_API_KEY: '  re_abcdefg  ',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.emailFrom, 'support@example.com');
  assert.equal(cfg.apiKey, 're_abcdefg');

  const empty = emailTransportConfig({} as NodeJS.ProcessEnv);
  assert.equal(empty.emailFrom, '');
  assert.equal(empty.apiKey, '');
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

test('createEmailSender selects Resend only when key AND from are configured, else the log fallback', () => {
  const noResend = createEmailSender({} as NodeJS.ProcessEnv);
  assert.equal(noResend.mode, 'log', 'no Resend config -> development log transport');

  const halfConfigured = createEmailSender({ RESEND_API_KEY: 're_x' } as NodeJS.ProcessEnv);
  assert.equal(halfConfigured.mode, 'log', 'key alone must NOT enable Resend (no from-address)');

  const resend = createEmailSender({
    RESEND_API_KEY: 're_x',
    EMAIL_FROM: 'me@x.com',
  } as NodeJS.ProcessEnv);
  assert.equal(resend.mode, 'resend');
});

test('the log transport prints the verification LINK and never a token hash or credentials', async () => {
  let printed: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => printed.push(a.map(String).join(' '));
  try {
    const delivery = await createLogSender()(SAMPLE_MESSAGE);
    assert.equal(delivery.delivered, true);
    assert.equal(delivery.transport, 'log');
    assert.ok(!delivery.error, 'log delivery never reports an error');
  } finally {
    console.log = original;
  }
  assert.ok(printed.some((l) => l.includes('[email:log]')), 'lines must be labelled [email:log]');
  assert.ok(
    printed.some((l) => l.includes('verification link (dev only)')),
    'the dev fallback must be unmistakably labelled as not-real-mail'
  );
  assert.ok(
    printed.some((l) => l.includes('https://app.example.com/api/auth/verify-email?token=raw-token-value')),
    'the dev log must expose the full clickable verification link'
  );
});

test('Resend sender posts the exact payload with a Bearer header and reports success', async () => {
  const mock = withFetchMock(async () => new Response(JSON.stringify({ id: 'resend-id-1' }), { status: 200 }));
  let printed: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => printed.push(a.map(String).join(' '));
  try {
    const sender = createResendSender({ apiKey: 're_TOP_SECRET_KEY', emailFrom: 'Odia SRT <noreply@example.com>' });
    const delivery = await sender(SAMPLE_MESSAGE);
    assert.equal(delivery.delivered, true);
    assert.equal(delivery.transport, 'resend');
    assert.ok(!delivery.error, 'success reports no error');
  } finally {
    console.log = original;
    mock.restore();
  }

  assert.equal(mock.calls.length, 1, 'exactly one API call');
  assert.equal(mock.calls[0].url, RESEND_URL);
  const headers = new Headers(mock.calls[0].init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer re_TOP_SECRET_KEY', 'the API key travels as a Bearer token');
  assert.equal(headers.get('Content-Type'), 'application/json');

  const body = JSON.parse(String(mock.calls[0].init.body));
  assert.equal(body.from, 'Odia SRT <noreply@example.com>');
  assert.deepEqual(body.to, ['u@example.com']);
  assert.equal(body.subject, SAMPLE_MESSAGE.subject);
  assert.equal(body.text, SAMPLE_MESSAGE.text);
  assert.equal(body.html, SAMPLE_MESSAGE.html);

  assert.ok(
    !printed.some((l) => l.includes('re_TOP_SECRET_KEY')),
    'the API key must never appear in logs'
  );
  assert.ok(
    !printed.some((l) => l.includes('raw-token-value')),
    'the verification token/link must never appear in the success log'
  );
});

test('Resend non-2xx returns delivered=false with a sanitized, classified error', async () => {
  const mock = withFetchMock(async () =>
    new Response(JSON.stringify({ message: 'You are not allowed to send to bob@example.com. token=abc123' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  try {
    const sender = createResendSender({ apiKey: 're_TOP_SECRET_KEY', emailFrom: 'noreply@example.com' });
    const delivery = await sender(SAMPLE_MESSAGE);
    assert.equal(delivery.delivered, false);
    assert.equal(delivery.transport, 'resend');
    assert.ok(delivery.error, 'a failure must carry an error');
    assert.ok(delivery.error.includes('resend_http_403'), 'the HTTP status class is classified');
    assert.ok(!delivery.error.includes('re_TOP_SECRET_KEY'), 'no API key in the error');
    assert.ok(!delivery.error.includes('token=abc123'), 'no token fragment in the error');
    assert.ok(!delivery.error.includes('bob@example.com'), 'no email address in the error');
    const classified = classifyDeliveryError(delivery.error);
    assert.ok(classified.startsWith('resend_http_403'), 'the HTTP status class is classified');
    assert.ok(!classified.includes('re_TOP_SECRET_KEY'), 'no API key in the logged classification');
    assert.ok(!classified.includes('bob@example.com'), 'no email address in the logged classification');
    assert.ok(!classified.includes('abc123'), 'no token value in the logged classification');

    const neverLogs = await sender(SAMPLE_MESSAGE);
    assert.equal(neverLogs.delivered, false);
    assert.ok(!neverLogs.error!.includes('raw-token-value'), 'the link/token is never echoed in errors');
  } finally {
    mock.restore();
  }
});

test('a network failure is classified safely (ENOTFOUND) and never rejects', async () => {
  const mock = withFetchMock(async () => {
    const cause = new Error('getaddrinfo ENOTFOUND api.resend.com');
    (cause as { code?: string }).code = 'ENOTFOUND';
    throw Object.assign(new TypeError('fetch failed'), { cause });
  });
  try {
    const sender = createResendSender({ apiKey: 're_TOP_SECRET_KEY', emailFrom: 'noreply@example.com' });
    const delivery = await sender(SAMPLE_MESSAGE);
    assert.equal(delivery.delivered, false, 'network failure -> delivered=false');
    assert.equal(delivery.transport, 'resend');
    assert.ok(delivery.error!.includes('ENOTFOUND'), 'the error code surfaces for classification');
    assert.ok(!delivery.error!.includes('re_TOP_SECRET_KEY'), 'no API key in the error');
    assert.equal(classifyDeliveryError(delivery.error), 'ENOTFOUND');
  } finally {
    mock.restore();
  }
});

test('classifyDeliveryError returns the known failure class verbatim', () => {
  assert.equal(classifyDeliveryError('EAUTH: Invalid login - 535 5.7.8 Username and Password not accepted. For more info go to https://support.google.com/mail/?p=BadCredentials'), 'EAUTH');
  assert.equal(classifyDeliveryError('getaddrinfo ENOTFOUND api.resend.com'), 'ENOTFOUND');
  assert.equal(classifyDeliveryError('connect ETIMEDOUT api.resend.com:443'), 'ETIMEDOUT');
  assert.equal(classifyDeliveryError('EOVERFLOW ECONNRESET during message'), 'ECONNRESET');
  assert.equal(classifyDeliveryError(''), 'unknown', 'empty input collapses to unknown');
  assert.equal(classifyDeliveryError(null), 'unknown');
});

test('classifyDeliveryError falls back to a scrubbed short message, never a credential', () => {
  const out = classifyDeliveryError(
    '535 5.7.8 Username and Password not accepted. token=deadbeef pass=supersecret Authorization: Bearer aaaBbbCcc tell user=bob@example.com now'
  );
  assert.ok(out.length <= 120, 'output stays short');
  assert.ok(!out.toLowerCase().includes('supersecret'), 'no password value');
  assert.ok(!out.includes('deadbeef'), 'no token value');
  assert.ok(!out.includes('aaaBbbCcc'), 'no bearer value');
  assert.ok(!out.includes('bob@example.com'), 'no email address');
  assert.ok(out.includes('535'), 'the safe SMTP response fragment survives');
});

test('scrubSensitiveText removes emails, Bearer/token/pass fragments and collapses space', () => {
  const out = scrubSensitiveText('mail to a@b.com token=xyz pass=abc then Bearer qwerty123 and Authorization: Bearer aj12345');
  assert.ok(!out.includes('a@b.com'));
  assert.ok(!out.includes('xyz'));
  assert.ok(!out.includes('abc'));
  assert.ok(!out.includes('qwerty123'));
  assert.ok(!out.includes('aj12345'));
  assert.ok(out.includes('Bearer=***'));
  assert.ok(out.includes('token=***'));
  assert.ok(out.includes('pass=***'));
  assert.ok(out.includes('Authorization=***'));
  assert.ok(!/\s{2,}/.test(out), 'whitespace collapses');
});