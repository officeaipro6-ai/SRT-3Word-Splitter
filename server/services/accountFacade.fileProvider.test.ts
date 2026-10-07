/**
 * The JSON provider must keep working EXACTLY as before the Turso account
 * facade existed.
 *
 * `createFileAccountFacade` is what `server.ts` mounts when
 * `DATABASE_PROVIDER` is not `turso`, so a behaviour difference here would be a
 * regression in local/dev and in any non-Turso deployment. These tests pin the
 * parity that matters: same signup/login/refresh/logout outcomes, same token
 * idempotency, same ledger row, same wallet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../db/store';
import { UserRepo, CreditRepo } from '../db/repos';
import { createFileAccountFacade } from './accountFacade';
import { FileCreditService } from './creditService';
import { createFileCreditFacade } from './creditFacade';
import { hashToken, issueToken } from './auth';
import { verifyPassword as verifyPw } from './password';

const PASSWORD = 'CorrectHorse1!';

function ready() {
  const dir = mkdtempSync(join(tmpdir(), 'fileacct-'));
  const store = new DataStore(join(dir, 'db.json'));
  const users = new UserRepo(store);
  const creditsRepo = new CreditRepo(store);
  return {
    accounts: createFileAccountFacade(users, creditsRepo),
    credits: createFileCreditFacade(new FileCreditService(users, creditsRepo)),
    users,
    store,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    },
  };
}

test('JSON provider: signup -> login -> refresh -> credits -> logout', async (t) => {
  const s = ready();
  t.after(() => s.cleanup());

  const signup = await s.accounts.signup({ email: 'a@example.com', password: PASSWORD }, 25);
  assert.equal(signup.ok, true, `signup failed: ${signup.error}`);
  assert.equal(signup.user!.role, 'USER');
  assert.equal(signup.user!.credits, 25);
  assert.equal(signup.user!.emailVerified, false, 'a fresh facade signup is unverified');

  const token = issueToken();
  await s.accounts.addToken(signup.user!.id, hashToken(token));

  // Refresh idempotency.
  await s.accounts.addToken(signup.user!.id, hashToken(token));
  await s.accounts.addToken(signup.user!.id, hashToken(token));
  const refreshed = await s.accounts.getById(signup.user!.id);
  assert.equal(refreshed!.tokenHashes.filter((h) => h === hashToken(token)).length, 1);

  // Unverified -> refused at login; wrong password stays INVALID_CREDENTIALS.
  assert.equal((await s.accounts.login({ email: 'a@example.com', password: PASSWORD })).code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await s.accounts.login({ email: 'a@example.com', password: 'nope1234' })).code, 'INVALID_CREDENTIALS');

  // Prove the inbox through the facade's own verification surface.
  assert.equal(await s.accounts.markEmailVerified(signup.user!.id), true);

  const login = await s.accounts.login({ email: 'a@example.com', password: PASSWORD });
  assert.equal(login.ok, true);
  assert.equal((await s.accounts.login({ email: 'a@example.com', password: 'nope1234' })).code, 'INVALID_CREDENTIALS');

  // Wallet + ledger.
  const me = await s.accounts.getById(login.user!.id);
  assert.equal(me!.credits, 25);
  const ledger = await s.credits.getTransactions(login.user!.id, 25);
  const grant = ledger.find((t2) => t2.reason === 'initial_grant');
  assert.ok(grant, 'initial_grant row missing on the JSON provider');
  assert.equal(grant!.balanceAfter, 25);

  // Logout revokes exactly one session.
  await s.accounts.revokeToken(login.user!.id, hashToken(token));
  assert.equal(await s.accounts.getByToken(hashToken(token)), null);
});

test('JSON provider: zero initial credits creates no ledger row', async (t) => {
  const s = ready();
  t.after(() => s.cleanup());

  const signup = await s.accounts.signup({ email: 'zero@example.com', password: PASSWORD }, 0);
  assert.equal(signup.ok, true);
  assert.equal((await s.credits.getTransactions(signup.user!.id, 25)).length, 0);

  const token = issueToken();
  await s.accounts.addToken(signup.user!.id, hashToken(token));
  assert.ok(await s.accounts.getByToken(hashToken(token)));
});

test('JSON provider: duplicate email is EMAIL_TAKEN, bad input is VALIDATION', async (t) => {
  const s = ready();
  t.after(() => s.cleanup());

  assert.equal((await s.accounts.signup({ email: 'd@example.com', password: PASSWORD }, 0)).ok, true);
  assert.equal((await s.accounts.signup({ email: 'd@example.com', password: PASSWORD }, 0)).code, 'EMAIL_TAKEN');
  assert.equal((await s.accounts.signup({ email: 'bad', password: PASSWORD }, 0)).code, 'VALIDATION');
  assert.equal((await s.accounts.signup({ email: 'x@example.com', password: 'short' }, 0)).code, 'VALIDATION');
});

test('JSON provider: anonymous session user gets its token hash up front', async (t) => {
  const s = ready();
  t.after(() => s.cleanup());

  const tokenHash = hashToken(issueToken());
  const user = await s.accounts.createSessionUser(tokenHash, 7);
  assert.equal(user.credits, 7);
  // `UserRepo.createUser` seeds tokenHashes with the hash it is given.
  const resolved = await s.accounts.getByToken(tokenHash);
  assert.ok(resolved, 'a freshly created session must be immediately resolvable');
  assert.equal(resolved!.id, user.id);
});

test('both facades agree on the signup -> login outcome for the same inputs', async (t) => {
  const s = ready();
  t.after(() => s.cleanup());

  const viaFacade = await s.accounts.signup({ email: 'parity@example.com', password: PASSWORD }, 12);
  assert.equal(viaFacade.ok, true);

  // Read the row back through the pre-existing synchronous repo and through the
  // facade: the persisted record must be identical either way.
  const viaRepo = s.users.getByEmail('parity@example.com')!;
  const viaFacadeRead = (await s.accounts.getByEmail('parity@example.com'))!;

  assert.equal(viaRepo.role, viaFacadeRead.role);
  assert.equal(viaRepo.credits, viaFacadeRead.credits);
  assert.equal(viaRepo.email, viaFacadeRead.email);
  assert.equal(viaRepo.creditMode, viaFacadeRead.creditMode);
  assert.equal(viaRepo.freeTrialsUsed, viaFacadeRead.freeTrialsUsed);

  // A facade signup is verifiable by the ORIGINAL scrypt verifier.
  assert.equal(verifyPw(PASSWORD, viaRepo.passwordHash), true);
  assert.equal(verifyPw('wrong-password', viaRepo.passwordHash), false);

  // And the facade's login agrees with a direct repo read + verify.
  assert.equal(await s.accounts.markEmailVerified(viaFacade.user!.id), true);
  const viaFacadeLogin = await s.accounts.login({ email: 'parity@example.com', password: PASSWORD });
  assert.equal(viaFacadeLogin.ok, true);
  assert.equal(viaFacadeLogin.user!.id, viaRepo.id);
  assert.equal(
    verifyPw(PASSWORD, s.users.getById(viaRepo.id)!.passwordHash),
    true,
    'the stored hash must verify after the facade wrote it',
  );
});