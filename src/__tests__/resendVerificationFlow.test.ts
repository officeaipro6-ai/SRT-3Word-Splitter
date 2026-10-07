import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const panelSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AccountPanel.tsx'), 'utf8');
const clientSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sessionClient.ts'), 'utf8');
const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

function sliceBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0, `missing marker: ${from}`);
  assert.ok(b > a, `missing marker after ${from}: ${to}`);
  return src.slice(a, b);
}

const handler = sliceBetween(panelSrc, 'const sendVerification = async () => {', 'const signOut = async () => {');
const resendFn = sliceBetween(
  clientSrc,
  'export async function resendVerificationEmail(',
  'export async function logoutAccount(',
);

test('R1. clicking resend POSTs /api/account/resend-verification to the registered route', () => {
  // The exact API call: path, method and body must match the backend.
  assert.match(resendFn, /getApiUrl\('\/api\/account\/resend-verification'\)/, 'exact API path');
  assert.match(resendFn, /method: 'POST'/, 'HTTP method is POST');
  assert.match(resendFn, /JSON\.stringify\(\{ email: email\.trim\(\)\.toLowerCase\(\) \}\)/, 'sends the address');

  // Both UI entry points (badge "Resend link" and banner "Resend verification
  // link") go through the single handler, which calls that client function.
  const clicks = panelSrc.match(/onClick=\{\(\) => void sendVerification\(\)\}/g) || [];
  assert.equal(clicks.length, 2, 'both resend buttons must call sendVerification');
  assert.match(handler, /await resendVerificationEmail\(target\)/);

  // ...and the server exposes exactly that path (no client/server drift).
  assert.ok(
    serverSrc.includes("app.post('/api/account/resend-verification'"),
    'server must register the resend route',
  );
});

test('R2. a blocked resend (429 cooldown / rate limit) is shown for a signed-in account, never swallowed', () => {
  // Failures land in resendError — NOT the form-gated `error` state.
  assert.match(handler, /setResendError\(e\.message/, 'the catch must feed the always-visible strip');
  assert.ok(!/setError\(e\.message\)/.test(handler), 'resend failures must not use the form-gated error');

  // The strip renders as a top-level sibling BEFORE the sign-in form gate, so
  // it is visible precisely when the resend buttons are (signed-in, no form).
  const stripIdx = panelSrc.indexOf('{resendError && (');
  const formIdx = panelSrc.indexOf('{showForm && !isAccount && !isOwner && (');
  assert.ok(stripIdx > 0, 'the resendError strip must exist');
  assert.ok(formIdx > stripIdx, 'the strip must sit outside/above the form gate');

  // No-address clicks report instead of silently returning.
  assert.match(handler, /if \(!target\) \{[\s\S]*?setResendError\(/, 'a no-target resend must say so');

  // The server's exact safe state travels through the client to that strip.
  assert.match(resendFn, /if \(!res\.ok\) throw new Error\(data\.error/, 'server message is re-thrown');
  assert.ok(
    serverSrc.includes('Please wait before requesting another verification email.'),
    'cooldown 429 must carry displayable wait copy',
  );
  assert.ok(
    serverSrc.includes('Too many requests. Please wait before trying again.'),
    'rate-limit 429 must carry displayable wait copy',
  );

  // A stale error is cleared when the login/signup form is next submitted.
  const submit = sliceBetween(panelSrc, 'const submit = async () => {', 'const sendVerification = async () => {');
  assert.match(submit, /setResendError\(null\)/, 'submit clears the resend error strip');
});

test('R3. the UI never claims an unconditional send when the server may not have sent', () => {
  // The old default invented a delivery the 202 does not guarantee.
  assert.ok(
    !panelSrc.includes('A fresh verification link has been sent to your inbox.'),
    'the unqualified "sent to your inbox" default must be gone',
  );

  // Success renders the SERVER message, falling back to the conditional notice.
  assert.match(handler, /setResendNotice\(message \|\| NEUTRAL_VERIFICATION_NOTICE\)/);
  assert.match(
    panelSrc,
    /If this address has an account that still needs verification, a fresh link has been sent to it\./,
    'fallback copy is conditional, never an unqualified send claim',
  );

  // Server side: every plain 202 shares the byte-identical neutral notice
  // (unknown account, token failure, real send), while already-verified keeps
  // its own distinguishable message.
  const neutralUses = serverSrc.match(/message: NEUTRAL_VERIFICATION_NOTICE/g) || [];
  assert.equal(neutralUses.length, 3, 'unknown / token-failed / sent must share one neutral notice');
  assert.ok(serverSrc.includes("message: 'This email is already verified"), 'verified keeps its message');
});
