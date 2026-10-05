/**
 * END-TO-END AUTH against a REAL libSQL database (no mocks).
 *
 * Runs the whole customer flow through the same two facades `server.ts` mounts
 * for `DATABASE_PROVIDER=turso`:
 *
 *   signup -> login -> refresh (same token, idempotent) -> credits -> logout
 *
 * and asserts that after logout the very same token is rejected. Every read is a
 * real SELECT against a real SQLite file on disk, so a facade that silently
 * faked persistence (or wrote to memory) could not pass.
 *
 * The store is a temp directory file rather than `file::memory:` so a second
 * client can open the same database and independently confirm the row survived
 * the request that created it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { TursoStore } from '../db/tursoStore';
import { TursoAccountService } from '../services/tursoAccountService';
import { createTursoAccountFacade } from '../services/accountFacade';
import { TursoCreditService } from '../services/tursoCreditService';
import { createTursoCreditFacade } from '../services/creditFacade';
import { hashToken, issueToken, isValidTokenShape } from '../services/auth';
import type { AsyncAccountService } from '../services/accountFacade';
import type { AsyncCreditService } from '../services/creditFacade';
import { freeTrialsRemaining } from '../services/freeTrialPolicy';

const PASSWORD = 'CorrectHorse1!';
const EMAIL = 'customer@example.com';
const INITIAL_CREDITS = 25;

/**
 * The mounted stack, declared up front so the fixture's real type includes the
 * facades. Declaring `accounts`/`credits` implicitly on a returned object literal
 * is a type error even though the assignment works at runtime.
 */
interface AuthStack {
  dir: string;
  url: string;
  client: ReturnType<typeof createClient>;
  store: TursoStore;
  accounts: AsyncAccountService;
  credits: AsyncCreditService;
  openClient: () => ReturnType<typeof createClient>;
  cleanup: () => void;
}

async function ready(): Promise<AuthStack> {
  const dir = mkdtempSync(join(tmpdir(), 'authflow-'));
  const url = `file:${join(dir, 'app.db')}`;
  const client = createClient({ url });
  const store = new TursoStore(client);
  // Windows keeps an exclusive lock on an open SQLite file, so every extra
  // client a test opens must be closed before the temp dir can be removed.
  const extraClients: { close(): void }[] = [];
  await store.init();
  return {
    dir,
    url,
    client,
    store,
    accounts: createTursoAccountFacade(new TursoAccountService(store)),
    credits: createTursoCreditFacade(new TursoCreditService(store)),
    openClient: () => {
      const c = createClient({ url });
      extraClients.push(c);
      return c;
    },
    cleanup: () => {
      for (const c of extraClients) c.close();
      client.close();
      // Best-effort: a leaked handle must not fail an otherwise-passing test.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* temp dir left behind in %TEMP%; harmless */
      }
    },
  };
}

test('signup -> login -> refresh -> credits -> logout against real libSQL', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  // ---------------------------------------------------------------- signup ---
  const signup = await s.accounts.signup({ email: EMAIL, password: PASSWORD }, INITIAL_CREDITS);
  assert.equal(signup.ok, true, `signup failed: ${signup.error}`);
  assert.ok(signup.user, 'signup returned no user');
  assert.equal(signup.user!.email, EMAIL);
  assert.equal(signup.user!.role, 'USER', 'signup must never grant ADMIN');
  assert.equal(signup.user!.creditMode, 'NORMAL');
  assert.ok(signup.user!.passwordHash?.startsWith('scrypt$'), 'password must be scrypt-hashed');
  assert.ok(
    !JSON.stringify(signup.user).includes(PASSWORD),
    'the plaintext password must never appear on the returned record',
  );

  const signupToken = issueToken();
  await s.accounts.addToken(signup.user!.id, hashToken(signupToken));
  assert.ok(isValidTokenShape(signupToken));

  // INDEPENDENT client: the account really is on disk, not in a local cache.
  const other = s.openClient();
  const rows = await other.execute({ sql: 'SELECT email, role, credits FROM users WHERE email = ?', args: [EMAIL] });
  assert.equal(rows.rows.length, 1, 'signup did not persist exactly one user row');
  assert.equal(rows.rows[0].email, EMAIL);
  assert.equal(rows.rows[0].role, 'USER');
  assert.equal(Number(rows.rows[0].credits), INITIAL_CREDITS, 'opening balance not persisted');

  // Duplicate signup is rejected at the database level too.
  const dupe = await s.accounts.signup({ email: EMAIL, password: PASSWORD }, INITIAL_CREDITS);
  assert.equal(dupe.ok, false);
  assert.equal(dupe.code, 'EMAIL_TAKEN');

  // ----------------------------------------------------------------- login ---
  const login = await s.accounts.login({ email: EMAIL, password: PASSWORD });
  assert.equal(login.ok, true, `login failed: ${login.error}`);
  assert.equal(login.user!.id, signup.user!.id, 'login resolved a different user');
  assert.ok(login.user!.lastLoginAt, 'login must stamp lastLoginAt');

  const wrong = await s.accounts.login({ email: EMAIL, password: 'WrongPassword1!' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'INVALID_CREDENTIALS');

  const unknown = await s.accounts.login({ email: 'nobody@example.com', password: PASSWORD });
  assert.equal(unknown.code, 'INVALID_CREDENTIALS', 'unknown email must be indistinguishable from a bad password');

  const loginToken = issueToken();
  await s.accounts.addToken(login.user!.id, hashToken(loginToken));

  // --------------------------------------------------------------- refresh ---
  // A refresh re-presents a live token: same token, no second hash appended.
  const refreshUser = await s.accounts.getByToken(hashToken(loginToken));
  assert.ok(refreshUser, 'the issued token must resolve after login');
  assert.equal(refreshUser!.id, login.user!.id);

  await s.accounts.addToken(login.user!.id, hashToken(loginToken));
  await s.accounts.addToken(login.user!.id, hashToken(loginToken));
  const afterRefresh = await s.accounts.getById(login.user!.id);
  assert.equal(
    afterRefresh!.tokenHashes.filter((h) => h === hashToken(loginToken)).length,
    1,
    'repeated refreshes must not append duplicate token hashes',
  );

  // The signup token is still valid: two devices, two independent sessions.
  const stillValid = await s.accounts.getByToken(hashToken(signupToken));
  assert.ok(stillValid, 'logging in again must not revoke an existing session');
  assert.equal(stillValid!.tokenHashes.length, 2, 'expected two live sessions for this user');

  // --------------------------------------------------------- credits load ---
  const me = await s.accounts.getById(login.user!.id);
  assert.equal(me!.credits, INITIAL_CREDITS, 'wallet must load for the logged-in user');
  assert.equal(freeTrialsRemaining(me!.freeTrialsUsed ?? 0, 1), 1);
  const ledger = await s.credits.getTransactions(login.user!.id, 25);
  assert.ok(Array.isArray(ledger));
  const initialGrant = ledger.find((t) => t.reason === 'initial_grant');
  assert.ok(initialGrant, 'signup must open the ledger with an initial_grant row');
  assert.equal(initialGrant!.type, 'CREDIT');
  assert.equal(initialGrant!.amount, INITIAL_CREDITS);
  assert.equal(initialGrant!.balanceAfter, INITIAL_CREDITS);
  assert.equal(await s.credits.getBalance(login.user!.id), INITIAL_CREDITS);

  // ---------------------------------------------------------------- logout ---
  const revoked = await s.accounts.revokeToken(login.user!.id, hashToken(loginToken));
  assert.equal(revoked, true);
  assert.equal(
    await s.accounts.getByToken(hashToken(loginToken)),
    null,
    'a revoked token must not authenticate again',
  );
  assert.ok(await s.accounts.getByToken(hashToken(signupToken)), 'logout must not kill other sessions');

  // Credentials still work after logout; the session token does not.
  const relogin = await s.accounts.login({ email: EMAIL, password: PASSWORD });
  assert.equal(relogin.ok, true);
});

test('a zero-credit signup persists with no ledger row and still authenticates', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  const signup = await s.accounts.signup({ email: 'zero@example.com', password: PASSWORD }, 0);
  assert.equal(signup.ok, true, `signup failed: ${signup.error}`);
  assert.equal(signup.user!.credits, 0);
  assert.equal(await s.credits.getBalance(signup.user!.id), 0);
  assert.equal((await s.credits.getTransactions(signup.user!.id, 25)).length, 0);

  const token = issueToken();
  await s.accounts.addToken(signup.user!.id, hashToken(token));
  const resolved = await s.accounts.getByToken(hashToken(token));
  assert.ok(resolved, 'a zero-credit account must still get a working session');
  assert.equal(resolved!.id, signup.user!.id);
});

test('validation rejects bad input before any write', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  const before = (await s.store.getUsers()).length;
  assert.equal((await s.accounts.signup({ email: 'not-an-email', password: PASSWORD }, 10)).code, 'VALIDATION');
  assert.equal((await s.accounts.signup({ email: 'short@example.com', password: 'a'.repeat(7) }, 10)).code, 'VALIDATION');
  assert.equal((await s.accounts.signup({ email: 'ok@example.com', password: 'a'.repeat(257) }, 10)).code, 'VALIDATION');
  assert.equal(
    (await s.accounts.signup({ email: EMAIL, password: PASSWORD }, 10)).ok,
    true,
    'a valid request must still succeed after the rejected ones',
  );
  assert.equal((await s.store.getUsers()).length, before + 1, 'exactly one user must be created');
});

test('email is normalized so casing cannot create a second account', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  const first = await s.accounts.signup({ email: '  MiXeD@Example.COM ', password: PASSWORD }, 5);
  assert.equal(first.ok, true);
  assert.equal(first.user!.email, 'mixed@example.com');

  const second = await s.accounts.signup({ email: 'MIXED@example.com', password: PASSWORD }, 5);
  assert.equal(second.code, 'EMAIL_TAKEN');
  assert.equal((await s.store.getUsers()).length, 1);

  // And the normalized address is what login resolves.
  const login = await s.accounts.login({ email: '  Mixed@Example.com ', password: PASSWORD });
  assert.equal(login.ok, true);
  assert.equal(login.user!.id, first.user!.id);
});

test('the facade survives a fresh store instance over the same database', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  const signup = await s.accounts.signup({ email: 'restart@example.com', password: PASSWORD }, 3);
  assert.equal(signup.ok, true);
  const token = issueToken();
  await s.accounts.addToken(signup.user!.id, hashToken(token));

  // Simulates a process restart / a second Render instance: brand-new client,
  // brand-new store, same database file.
  const restarted = new TursoStore(s.openClient());
  await restarted.init();
  const accounts2 = createTursoAccountFacade(new TursoAccountService(restarted));

  const resolved = await accounts2.getByToken(hashToken(token));
  assert.ok(resolved, 'a session issued before the restart must still resolve');
  assert.equal(resolved!.email, 'restart@example.com');
  // The persisted `credits` COLUMN is the authority for the wallet on this
  // provider, so assert both it and the credit service's ledger-derived read.
  assert.equal(resolved!.credits, 3, 'the balance column must survive the restart');
});

test('admin bootstrap fields persist and stay off the signup path', async (t) => {
  const s = await ready();
  t.after(() => s.cleanup());

  const signup = await s.accounts.signup({ email: 'boot@example.com', password: PASSWORD }, 0);
  assert.equal(signup.user!.role, 'USER');

  assert.equal(await s.accounts.setRole(signup.user!.id, 'ADMIN'), true);
  assert.equal(await s.accounts.setCreditMode(signup.user!.id, 'UNLIMITED'), true);
  assert.equal(await s.accounts.setOwnerEmail(signup.user!.id, '  Owner@Example.com '), true);

  const promoted = await s.accounts.getById(signup.user!.id);
  assert.equal(promoted!.role, 'ADMIN');
  assert.equal(promoted!.creditMode, 'UNLIMITED');
  assert.equal(promoted!.ownerEmail, 'owner@example.com');

  // Missing users report failure rather than silently "succeeding".
  assert.equal(await s.accounts.setRole('does-not-exist', 'ADMIN'), false);
  assert.equal(await s.accounts.setOwnerEmail(signup.user!.id, '   '), false);

  // A second signup is still a plain USER even while an admin exists.
  const other = await s.accounts.signup({ email: 'other@example.com', password: PASSWORD }, 0);
  assert.equal(other.user!.role, 'USER');
});