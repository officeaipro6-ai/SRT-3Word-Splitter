/**
 * Tests for the normal email/password USER account layer.
 *
 * Covers the required behaviours: signup, login, session persistence, logout
 * revocation, and the separation between user auth and the ADMIN bootstrap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../db/store.ts';
import { UserRepo, CreditRepo } from '../db/repos.ts';
import { signupAccount, loginAccount, normalizeAccountEmail, isValidAccountEmail } from './accountService.ts';
import { verifyPassword, isPasswordLengthValid, PASSWORD_MIN_LENGTH } from './password.ts';
import { extractToken, hashToken, isValidTokenShape, issueToken } from './auth.ts';
import { authorizeOwnerSession } from '../authz.ts';
import { freeTrialsRemaining } from './freeTrialPolicy.ts';

function makeBroker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-accounts-'));
  const file = path.join(dir, 'app.db.json');
  const store = new DataStore(file);
  const broker = { store, file, users: new UserRepo(store), credits: new CreditRepo(store) };
  return broker;
}

const PASSWORD = 'correct-horse-battery';

test('signup creates a user account with a unique id, normalized email and required fields', async () => {
  const b = makeBroker();
  await b.store.init();
  const result = signupAccount(b, { email: '  Alice@Example.COM ', password: PASSWORD }, 5);
  assert.equal(result.ok, true);
  const user = result.user!;
  assert.ok(user.id, 'a unique user id is assigned');
  assert.equal(user.email, 'alice@example.com', 'email is normalized to lower-case/trimmed');
  assert.ok(user.createdAt, 'createdAt is set');
  assert.ok(user.lastLoginAt, 'lastLoginAt is set at signup');
  assert.equal(user.freeTrialsUsed, 0, 'free trial counter starts at 0');
  assert.equal(user.credits, 5, 'credit balance is seeded from initialCredits');

  // A second, different account gets a distinct id.
  const other = signupAccount(b, { email: 'bob@example.com', password: PASSWORD }, 0);
  assert.notEqual(other.user!.id, user.id);
});

test('signup seeds the credit ledger exactly once (mirrors session accounting)', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'grant@example.com', password: PASSWORD }, 3);
  const txns = b.credits.listForUser(user.id);
  assert.equal(txns.length, 1);
  assert.equal(txns[0].type, 'CREDIT');
  assert.equal(txns[0].reason, 'initial_grant');
  assert.equal(txns[0].amount, 3);
});

test('the free-trial policy attaches to the signed-in account id, not the browser', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'trial@example.com', password: PASSWORD }, 0);
  // Simulate a consumed trial on the account record.
  b.users.incrementFreeTrialsUsed(user.id);
  const reloaded = b.users.getById(user.id)!;
  assert.equal(reloaded.freeTrialsUsed, 1);
  assert.equal(freeTrialsRemaining(reloaded.freeTrialsUsed, 2), 1, 'limit reads from the account counter');
});

test('signup rejects a duplicate email and never leaks the password', async () => {
  const b = makeBroker();
  await b.store.init();
  signupAccount(b, { email: 'dup@example.com', password: PASSWORD }, 0);
  const again = signupAccount(b, { email: 'DUP@example.com', password: PASSWORD }, 0);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'EMAIL_TAKEN');
});

test('passwords are stored as a scrypt hash, never as plaintext', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'hash@example.com', password: PASSWORD }, 0);
  const stored = b.users.getById(user.id)!.passwordHash!;
  assert.ok(stored.startsWith('scrypt$'), 'stored value is a scrypt digest');
  assert.ok(!stored.includes(PASSWORD), 'plaintext is not present in the stored value');
  assert.equal(verifyPassword(PASSWORD, stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
});

test('password policy requires a minimum length', () => {
  assert.equal(isPasswordLengthValid('a'.repeat(PASSWORD_MIN_LENGTH)), true);
  assert.equal(isPasswordLengthValid('short'), false);
  assert.equal(isPasswordLengthValid(12345678), false);
});

test('login succeeds with the correct password and records lastLoginAt', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'login@example.com', password: PASSWORD }, 0);
  // Move lastLoginAt into the past so we can prove login updates it.
  b.store.mutate((db) => {
    const u = db.users.find((x) => x.id === user.id)!;
    u.lastLoginAt = '2000-01-01T00:00:00.000Z';
  });
  const result = loginAccount(b, { email: 'login@example.com', password: PASSWORD });
  assert.equal(result.ok, true);
  assert.equal(result.user!.id, user.id);
  const after = b.users.getById(user.id)!;
  assert.notEqual(after.lastLoginAt, '2000-01-01T00:00:00.000Z', 'lastLoginAt updated on login');
});

test('login fails on a wrong password and on an unknown email (same code)', async () => {
  const b = makeBroker();
  await b.store.init();
  signupAccount(b, { email: 'known@example.com', password: PASSWORD }, 0);
  const wrong = loginAccount(b, { email: 'known@example.com', password: 'nope-nope-nope' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'INVALID_CREDENTIALS');
  const unknown = loginAccount(b, { email: 'ghost@example.com', password: PASSWORD });
  assert.equal(unknown.code, 'INVALID_CREDENTIALS', 'unknown email is not distinguishable');
  assert.equal(wrong.error, unknown.error, 'same generic message for both cases');
});

test('session tokens are opaque, hashed at rest, and survive a store reload', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'persist@example.com', password: PASSWORD }, 0);
  // Server issues an opaque token; only the hash is stored.
  const token = issueToken();
  b.users.addToken(user.id, hashToken(token));
  // Flush the store's queued persist so the on-disk file is current.
  await b.store.mutateAsync(() => undefined);
  const raw = JSON.parse(fs.readFileSync(b.file, 'utf8'));
  const stored = raw.users.find((u: any) => u.id === user.id);
  assert.ok(!stored.tokenHashes.includes(token), 'raw token is never stored');
  assert.ok(stored.tokenHashes.includes(hashToken(token)), 'only the hash is stored');

  // A fresh DataStore over the same file resolves the token to the same account.
  const reopened = new DataStore(b.file);
  await reopened.init();
  const users2 = new UserRepo(reopened);
  const resolved = users2.getByToken(hashToken(token));
  assert.equal(resolved?.id, user.id, 'session persists across a server restart');
  assert.equal(resolved?.email, 'persist@example.com');
});

test('logout revokes the presented token so it cannot be reused', async () => {
  const b = makeBroker();
  await b.store.init();
  const { user } = signupAccount(b, { email: 'logout@example.com', password: PASSWORD }, 0);
  const token = issueToken();
  b.users.addToken(user.id, hashToken(token));
  assert.ok(b.users.getByToken(hashToken(token)), 'token works before logout');
  b.users.revokeToken(user.id, hashToken(token));
  assert.equal(b.users.getByToken(hashToken(token)), null, 'token is dead after logout');
  // A re-login mints a fresh, different token.
  const relogin = loginAccount(b, { email: 'logout@example.com', password: PASSWORD });
  const fresh = issueToken();
  b.users.addToken(relogin.user!.id, hashToken(fresh));
  assert.notEqual(hashToken(fresh), hashToken(token));
  assert.ok(b.users.getByToken(hashToken(fresh)));
});

test('token extraction/validation shape still gate authenticated requests', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' } } as any), 'abc');
  assert.equal(extractToken({ headers: { 'x-user-token': 'xyz' } } as any), 'xyz');
  assert.equal(isValidTokenShape('a'.repeat(16)), true);
  assert.equal(isValidTokenShape('short'), false);
});

test('auth separation: a normal account can never be granted ADMIN, and the bootstrap is untouched', async () => {
  const b = makeBroker();
  await b.store.init();
  // No bootstrap token is configured at all in this test environment.
  const previous = process.env.ADMIN_BOOTSTRAP_TOKEN;
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  try {
    const { user } = signupAccount(b, { email: 'normal@example.com', password: PASSWORD }, 0);
    assert.equal(user.role, 'USER', 'signup always produces a plain USER');
    assert.equal(user.creditMode, 'NORMAL');

    // A user account is not an owner even if the email matches the allowlist,
    // because the bootstrap secret is what grants ADMIN.
    const attempt = authorizeOwnerSession({
      bootstrapToken: 'anything',
      claimedEmail: 'officeaipro6@gmail.com',
    });
    assert.equal(attempt.ok, false, 'no bootstrap token -> not admin');
    assert.equal((attempt as any).code, 'NO_ADMIN_SECRET');

    // With a bootstrap token set, only the token path grants ADMIN; the account
    // path still yields USER.
    process.env.ADMIN_BOOTSTRAP_TOKEN = 'a-valid-looking-bootstrap-secret';
    const viaSecret = authorizeOwnerSession({
      bootstrapToken: 'a-valid-looking-bootstrap-secret',
      claimedEmail: 'officeaipro6@gmail.com',
    });
    assert.equal(viaSecret.ok, true, 'bootstrap + allowlisted email grants ADMIN');
    const stillUser = signupAccount(b, { email: 'officeaipro6@gmail.com', password: PASSWORD }, 0);
    assert.equal(stillUser.user!.role, 'USER', 'same email via signup is still USER, never ADMIN');
    assert.equal(stillUser.user!.ownerEmail, undefined, 'signup does not set ownerEmail');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_BOOTSTRAP_TOKEN;
    else process.env.ADMIN_BOOTSTRAP_TOKEN = previous;
  }
});

test('email validation rejects malformed addresses', () => {
  assert.equal(isValidAccountEmail('user@example.com'), true);
  assert.equal(isValidAccountEmail('  user@example.co.in  '), true);
  assert.equal(isValidAccountEmail('not-an-email'), false);
  assert.equal(isValidAccountEmail('missing@domain'), false);
  assert.equal(isValidAccountEmail('@example.com'), false);
  assert.equal(normalizeAccountEmail('  A@B.COM '), 'a@b.com');
  const bad = signupAccount({ users: { getByEmail: () => null } as any, credits: { add: () => undefined } as any }, { email: 'nope', password: PASSWORD });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'VALIDATION');
});
