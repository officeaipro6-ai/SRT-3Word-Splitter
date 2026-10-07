/**
 * Unit contract for the PURE email-verification rules (server/services/emailVerification.ts).
 *
 * No store, no transport, no HTTP: only the domain decisions (token issuance,
 * grandfathering, single-use expiry, resend cooldown). Persistence and delivery
 * are covered by the facade/e2e suites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  EMAIL_VERIFY_TTL_MS,
  EMAIL_VERIFY_RESEND_COOLDOWN_MS,
  issueVerificationToken,
  hashVerificationToken,
  isEmailVerified,
  isVerificationTokenValid,
  resendCooldownRemainingMs,
} from './emailVerification';

test('issueVerificationToken mints 256-bit raw, sha256 hash and an expiry', () => {
  const t0 = 1_700_000_000_000;
  const token = issueVerificationToken(t0);

  // 32 random bytes -> 43 chars of base64url (no padding).
  assert.match(token.raw, /^[A-Za-z0-9_-]{43}$/);
  assert.match(token.hash, /^[a-f0-9]{64}$/, 'the persisted form is a sha256 hex digest');
  assert.equal(
    token.hash,
    createHash('sha256').update(token.raw).digest('hex'),
    'the hash must be exactly sha256(raw) — nothing else is sent or stored'
  );
  assert.equal(token.expiresAt, new Date(t0 + EMAIL_VERIFY_TTL_MS).toISOString());

  const again = issueVerificationToken(t0);
  assert.notEqual(again.raw, token.raw, 'two issuances must never collide');
  assert.notEqual(again.hash, token.hash);
});

test('hashVerificationToken is deterministic and rejects falsy input safely', () => {
  const value = 'a-token-value';
  assert.equal(hashVerificationToken(value), hashVerificationToken(value));
  assert.equal(hashVerificationToken(value), createHash('sha256').update(value).digest('hex'));
  // A blank/garbage string is hashed, never thrown on.
  assert.match(hashVerificationToken(''), /^[a-f0-9]{64}$/);
});

test('isEmailVerified grandfathers legacy and exempts no-email users', () => {
  // Absent record / anonymous session / no email: not part of verification.
  assert.equal(isEmailVerified(null), true);
  assert.equal(isEmailVerified(undefined), true);
  assert.equal(isEmailVerified({ email: undefined }), true);
  assert.equal(isEmailVerified({ email: null }), true);
  assert.equal(isEmailVerified({ email: 'not-an-owner@example.com' }), true);

  // An explicit false is the ONLY keyed-out state.
  assert.equal(isEmailVerified({ email: 'u@example.com', emailVerified: false }), false);

  // Field absent on an email account = grandfathered verified (legacy rows).
  assert.equal(isEmailVerified({ email: 'legacy@example.com' }), true);
  assert.equal(isEmailVerified({ email: 'verified@example.com', emailVerified: true }), true);
});

test('a stored token is valid only while it matches and has not expired', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const later = '2026-01-01T01:00:00.000Z';
  const past = '2025-12-31T00:00:00.000Z';

  assert.equal(isVerificationTokenValid(null, 'x'), false);
  assert.equal(isVerificationTokenValid({}, 'x'), false, 'no stored hash -> invalid');
  assert.equal(
    isVerificationTokenValid({ emailVerifyTokenHash: 'a', emailVerifyExpiresAt: later }, 'b', now),
    false,
    'a mismatched hash must be invalid'
  );
  assert.equal(
    isVerificationTokenValid({ emailVerifyTokenHash: 'a', emailVerifyExpiresAt: null }, 'a', now),
    false,
    'a null expiry must be invalid'
  );
  assert.equal(
    isVerificationTokenValid({ emailVerifyTokenHash: 'a', emailVerifyExpiresAt: past }, 'a', now),
    false,
    'an expired link must be invalid'
  );
  assert.equal(
    isVerificationTokenValid({ emailVerifyTokenHash: 'a', emailVerifyExpiresAt: later }, 'a', now),
    true
  );
  // A link whose expiry equals "now" is already expired (strictly after-now).
  assert.equal(isVerificationTokenValid({ emailVerifyTokenHash: 'a', emailVerifyExpiresAt: now }, 'a', now), false);
});

test('resend cooldown counts down from the last send and returns 0 when free', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  assert.equal(resendCooldownRemainingMs(null), 0);
  assert.equal(resendCooldownRemainingMs({}), 0);
  assert.equal(resendCooldownRemainingMs({ emailVerifyLastSentAt: 'garbage' }, now), 0);

  // Just sent -> full cooldown remaining.
  const justSent = { emailVerifyLastSentAt: new Date(now).toISOString() };
  assert.equal(resendCooldownRemainingMs(justSent, now), EMAIL_VERIFY_RESEND_COOLDOWN_MS);

  // Halfway through the window -> half remains.
  const half = new Date(now - EMAIL_VERIFY_RESEND_COOLDOWN_MS / 2).toISOString();
  assert.equal(
    resendCooldownRemainingMs({ emailVerifyLastSentAt: half }, now),
    EMAIL_VERIFY_RESEND_COOLDOWN_MS / 2
  );

  // Window elapsed -> free to resend.
  const old = new Date(now - EMAIL_VERIFY_RESEND_COOLDOWN_MS - 1).toISOString();
  assert.equal(resendCooldownRemainingMs({ emailVerifyLastSentAt: old }, now), 0);
});