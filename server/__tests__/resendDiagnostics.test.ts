import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

const routeStart = serverSrc.indexOf("app.post('/api/account/resend-verification'");
assert.ok(routeStart > 0, 'server must register the resend route');
const routeEnd = serverSrc.indexOf('\n  }));', routeStart);
assert.ok(routeEnd > routeStart, 'resend route body must be sliceable');
const routeBody = serverSrc.slice(routeStart, routeEnd);

/**
 * Extract every nestedLog.<level>(...) call in `src` by balancing parentheses,
 * so assertions run against the ACTUAL log arguments rather than a fixed
 * character window (which would bleed into neighbouring non-log code).
 */
function extractLogCalls(src: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('nestedLog.', from);
    if (at < 0) return calls;
    const open = src.indexOf('(', at);
    assert.ok(open > at, 'nestedLog call must have an argument list');
    let depth = 0;
    let close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    assert.ok(close > open, 'nestedLog call must be balanced');
    const semi = src.indexOf(';', close);
    calls.push(src.slice(at, semi + 1));
    from = semi + 1;
  }
}

test('D1. every resend gate logs its decision — the route is never silent', () => {
  // One line proves the route was reached at all (this is the line that was
  // missing in production: a click that never logged anything).
  assert.ok(routeBody.includes("'resend verification request received'"), 'request-received log');

  // Every early exit must be preceded by a decision/error log.
  const positions: number[] = [];
  let i = -1;
  while ((i = routeBody.indexOf('return res.status(', i + 1)) !== -1) positions.push(i);
  assert.ok(positions.length >= 8, `expected all ${8} exits, saw ${positions.length}`);
  for (const p of positions) {
    const before = routeBody.slice(Math.max(0, p - 450), p);
    assert.match(
      before,
      /nestedLog\.(info|error)\(/,
      `the exit at offset ${p} must log its decision before responding`,
    );
  }

  // All six gates are individually nameable from the logs.
  for (const outcome of [
    'invalid_email',
    'rate_limited',
    'unknown_account',
    'already_verified',
    'cooldown',
    'token_issue_failed',
  ]) {
    assert.ok(routeBody.includes(`outcome: '${outcome}'`), `decision outcome '${outcome}' must be logged`);
  }
});

test('D2. the send path is bracketed: token issued -> send attempt (with transport) -> result', () => {
  assert.ok(routeBody.includes("'resend verification token issued'"), 'token issuance is logged');
  assert.match(
    routeBody,
    /'resend verification send attempt', \{ userId: user\.id, transport: verificationSender\.mode \}/,
    'the attempt must name the selected transport and precede the transport call',
  );
  const attemptAt = routeBody.indexOf("'resend verification send attempt'");
  const sendAt = routeBody.indexOf('await verificationSender.sender(');
  assert.ok(attemptAt > 0 && sendAt > attemptAt, 'attempt is logged BEFORE the send (a hang still leaves a trace)');
  assert.match(routeBody, /'resend verification email sent'/, 'the result is logged');
  assert.ok(
    routeBody.includes('nestedLog.error(\'resend verification token issuance failed\''),
    'a failed token mint is an ERROR line, not a silent neutral 202',
  );

  // Boot-time transport selection (resend vs log) is visible in production.
  assert.match(
    serverSrc,
    /nestedLog\.info\('email transport configured', \{ transport: verificationSender\.mode \}\)/,
    'boot must log which email transport is configured',
  );
});

test('D3. resend diagnostics never log the address, the token or any secret', () => {
  const calls = extractLogCalls(routeBody);
  assert.ok(calls.length >= 10, `expected the route to emit many log lines, saw ${calls.length}`);

  const forbidden: Array<[string, RegExp]> = [
    ['raw verification token', /\braw\b/],
    ['rawToken', /\brawToken\b/],
    ['token material', /token=|token:|tokenHash/],
    ['the email address variable', /user\.email/],
    ['the API key', /RESEND_API_KEY/],
    ['password', /password/i],
    ['session token', /req\.headers\.authorization(?!\))/],
  ];
  for (const call of calls) {
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(call), `log call must not carry ${label}: ${call.slice(0, 160)}`);
    }
  }

  // The only auth signal logged is boolean header PRESENCE.
  const received = calls.find((c) => c.includes('request received'));
  assert.ok(received, 'request-received line exists');
  assert.match(received, /authenticated: Boolean\(req\.headers\.authorization\)/);
  assert.ok(!/authorization:\s*req\.headers\.authorization/.test(received), 'the auth header value is never logged');

  // Decisions identify accounts by id only — never by address.
  const decisions = calls.filter((c) => c.includes("'resend verification decision'"));
  assert.ok(decisions.length >= 6, 'one decision per gate');
  for (const d of decisions) assert.ok(!d.includes('@'), 'decision fields must not include an email address');
});

test('D4. the cooldown and rate-limit states are displayable by the frontend', () => {
  assert.ok(
    routeBody.includes('Please wait before requesting another verification email.'),
    'cooldown 429 copy the UI can show verbatim',
  );
  assert.ok(
    routeBody.includes('Too many requests. Please wait before trying again.'),
    'rate-limit 429 copy the UI can show verbatim',
  );
});
