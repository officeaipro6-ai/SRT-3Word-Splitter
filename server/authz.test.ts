import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  DEFAULT_OWNER_EMAILS,
  authorizeOwnerSession,
  isAllowlistedOwnerEmail,
  isValidAdminBootstrapToken,
  isVerifiedOwner,
  normalizeEmail,
  ownerAllowlist,
  ownerNotificationRecipients,
  ownerRejectionMessage,
} from './authz.ts';

const SECRET = 'test-admin-bootstrap-secret-1234';

function withSecret<T>(fn: () => T): T {
  const previous = process.env.ADMIN_BOOTSTRAP_TOKEN;
  process.env.ADMIN_BOOTSTRAP_TOKEN = SECRET;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_BOOTSTRAP_TOKEN;
    else process.env.ADMIN_BOOTSTRAP_TOKEN = previous;
  }
}

test('the allowlist defaults to the two owner emails', () => {
  delete process.env.OWNER_EMAILS;
  assert.deepEqual(ownerAllowlist().slice().sort(), DEFAULT_OWNER_EMAILS.slice().sort());
  assert.ok(ownerAllowlist().includes('officeaipro6@gmail.com'));
  assert.ok(ownerAllowlist().includes('sumitchinara@gmail.com'));
  assert.equal(ownerAllowlist().length, 2);
});

test('OWNER_EMAILS overrides the allowlist, still read server-side only', () => {
  const previous = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = ' ops@Example.com , second@example.com ';
  try {
    assert.deepEqual(ownerAllowlist(), ['ops@example.com', 'second@example.com']);
    assert.equal(isAllowlistedOwnerEmail('OPS@EXAMPLE.COM'), true);
    assert.equal(isAllowlistedOwnerEmail('officeaipro6@gmail.com'), false);
  } finally {
    if (previous === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = previous;
  }
});

test('email comparison is case/whitespace insensitive and type-safe', () => {
  assert.equal(normalizeEmail('  OfficeAIPro6@Gmail.com '), 'officeaipro6@gmail.com');
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(42), '');
  assert.equal(isAllowlistedOwnerEmail(' SUMITCHINARA@GMAIL.COM '), true);
  assert.equal(isAllowlistedOwnerEmail('attacker@gmail.com'), false);
  assert.equal(isAllowlistedOwnerEmail(''), false);
});

test('admin bootstrap needs BOTH the secret and an allowlisted email', () => {
  withSecret(() => {
    // Correct secret + allowlisted email -> granted, canonical email returned.
    const ok = authorizeOwnerSession({
      bootstrapToken: SECRET,
      claimedEmail: '  OfficeAIPro6@Gmail.COM ',
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.ownerEmail, 'officeaipro6@gmail.com'); // canonical form persisted

    // A FORGED email with the right secret is refused: the allowlist is the
    // server's, not the browser's.
    const forged = authorizeOwnerSession({
      bootstrapToken: SECRET,
      claimedEmail: 'attacker@gmail.com',
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.code, 'EMAIL_NOT_ALLOWED');

    // The second real owner is equally allowed.
    const other = authorizeOwnerSession({
      bootstrapToken: SECRET,
      claimedEmail: 'sumitchinara@gmail.com',
    });
    assert.equal(other.ok, true);

    // Right email, WRONG/empty secret -> refused (an email alone grants nothing).
    const noSecret = authorizeOwnerSession({ bootstrapToken: '', claimedEmail: 'sumitchinara@gmail.com' });
    assert.equal(noSecret.ok, false);
    if (!noSecret.ok) assert.equal(noSecret.code, 'BAD_TOKEN');
    const wrongSecret = authorizeOwnerSession({
      bootstrapToken: 'nope-nope-nope-nope',
      claimedEmail: 'sumitchinara@gmail.com',
    });
    assert.equal(wrongSecret.ok, false);
    if (!wrongSecret.ok) assert.equal(wrongSecret.code, 'BAD_TOKEN');

    // No email at all -> refused.
    const noEmail = authorizeOwnerSession({ bootstrapToken: SECRET, claimedEmail: undefined });
    assert.equal(noEmail.ok, false);
    if (!noEmail.ok) assert.equal(noEmail.code, 'EMAIL_NOT_ALLOWED');
  });
});

test('no admin secret configured means admin access is impossible', () => {
  const previous = process.env.ADMIN_BOOTSTRAP_TOKEN;
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  try {
    const res = authorizeOwnerSession({
      bootstrapToken: 'anything-at-all',
      claimedEmail: 'officeaipro6@gmail.com',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'NO_ADMIN_SECRET');
    assert.equal(isValidAdminBootstrapToken('anything-at-all'), false);
  } finally {
    if (previous !== undefined) process.env.ADMIN_BOOTSTRAP_TOKEN = previous;
  }
});

test('the bootstrap token comparison is timing-safe and length checked', () => {
  withSecret(() => {
    assert.equal(isValidAdminBootstrapToken(SECRET), true);
    assert.equal(isValidAdminBootstrapToken(` ${SECRET} `), true);
    assert.equal(isValidAdminBootstrapToken(SECRET.slice(0, -1)), false);
    assert.equal(isValidAdminBootstrapToken(`${SECRET}x`), false);
    assert.equal(isValidAdminBootstrapToken(undefined), false);
    assert.equal(isValidAdminBootstrapToken(12345), false);
  });
});

test('isVerifiedOwner requires BOTH the ADMIN role and an allowlisted stored email', () => {
  delete process.env.OWNER_EMAILS;
  assert.equal(isVerifiedOwner({ role: 'ADMIN', ownerEmail: 'officeaipro6@gmail.com' }), true);
  assert.equal(isVerifiedOwner({ role: 'ADMIN', ownerEmail: 'sumitchinara@gmail.com' }), true);
  // A legacy admin account with no verified email can no longer use the API.
  assert.equal(isVerifiedOwner({ role: 'ADMIN' }), false);
  // A normal user is never an owner, whatever they claim.
  assert.equal(isVerifiedOwner({ role: 'USER', ownerEmail: 'officeaipro6@gmail.com' }), false);
  assert.equal(isVerifiedOwner({ role: 'USER' }), false);
  assert.equal(isVerifiedOwner(null), false);
  // Revoking an email from the allowlist revokes access immediately.
  const previous = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = 'someone-else@example.com';
  try {
    assert.equal(isVerifiedOwner({ role: 'ADMIN', ownerEmail: 'officeaipro6@gmail.com' }), false);
  } finally {
    if (previous === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = previous;
  }
});

test('notification recipients come from the server allowlist, never the client', () => {
  delete process.env.OWNER_EMAILS;
  assert.deepEqual(ownerNotificationRecipients().slice().sort(), DEFAULT_OWNER_EMAILS.slice().sort());
  const previous = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = 'only@example.com';
  try {
    assert.deepEqual(ownerNotificationRecipients(), ['only@example.com']);
  } finally {
    if (previous === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = previous;
  }
});

test('rejection messages never echo the submitted secret', () => {
  const secretish = 'super-secret-token-value';
  for (const code of ['NO_ADMIN_SECRET', 'BAD_TOKEN', 'EMAIL_NOT_ALLOWED'] as const) {
    const message = ownerRejectionMessage(code);
    assert.ok(!message.includes(secretish));
    assert.ok(message.length > 0);
  }
});

/**
 * Source-level guarantees for the HTTP surface (the runtime behaviour above is
 * unit-tested; these assertions lock the wiring so it cannot regress silently).
 */
test('every admin route is behind auth() + requireAdmin, and no route trusts a body email/role', () => {
  const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const adminRoutes = [
    ...src.matchAll(
      /app\.(get|post|put|patch)\(\s*['"`](\/api\/admin[^'"`]*)['"`]\s*,([\s\S]{0,200}?)=>/g
    ),
  ];
  assert.ok(adminRoutes.length >= 8, `expected several admin routes, found ${adminRoutes.length}`);
  for (const [, method, path, tail] of adminRoutes) {
    assert.match(
      tail,
      /auth\(\),\s*requireAdmin/,
      `${method.toUpperCase()} ${path} must run auth() + requireAdmin`
    );
  }
  // The credit-adjustment handler resolves the admin from res.locals only.
  const adjust = src.slice(src.indexOf('const applyAdminAdjustment'));
  assert.match(adjust, /const admin = res\.locals\.user/);
  assert.doesNotMatch(adjust, /req\.body\??\.\s*adminEmail|req\.body\.email/);
  // No public route may set a role/credit mode from the request body.
  assert.doesNotMatch(src, /role:\s*req\.body/);
  assert.doesNotMatch(src, /creditMode:\s*req\.body/);
  assert.doesNotMatch(src, /setRole\([^)]*req\.body/);
});

test('no route lets a client write a balance, trial count or purchase directly', () => {
  const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /req\.body\??\.\s*credits\s*:/);
  assert.doesNotMatch(src, /req\.body\??\.\s*freeTrialsUsed/);
  assert.doesNotMatch(src, /bumpCredits\([^)]*req\.body/);
  // Manual credits can only enter through the audited adjustment service.
  assert.match(src, /adminAdjustCredits/);
});
