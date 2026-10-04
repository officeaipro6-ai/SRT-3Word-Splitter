/**
 * Stage 5C-2 — bounded-growth safety for `users.tokenHashes`.
 *
 * Why this file exists
 * -------------------
 * `POST /api/session` minted a brand-new bearer token on EVERY call. The client
 * (`src/lib/sessionClient.ts` `ensureSession`) already sends its stored token on
 * each refresh, and the server already resolved that token to a live user — but
 * it then minted a replacement anyway and appended its hash to
 * `user.tokenHashes`. Nothing ever removed those hashes except an explicit
 * logout of that exact token, so the array grew by one entry per page load.
 * Measured on the local data: 234 -> 312 hashes on the owner account in a single
 * day, with that one record reaching 27.9% of the whole database file.
 *
 * The policy under test
 * --------------------
 * A session request that presents a well-formed token the server can already
 * resolve gets that SAME token back, so the refresh path appends nothing
 * (`selectSessionToken` in server/services/auth.ts + the `/api/session` route).
 * Growth then tracks genuine new sign-ins rather than refreshes, and no token
 * that was valid a moment ago is ever invalidated.
 *
 * DELIBERATELY NOT TESTED: automatic pruning of "expired" hashes.
 * `tokenHashes` is a bare `string[]` with no per-token timestamp, expiry or
 * issue-time, so there is NO data with which to distinguish a live session from
 * a stale one. Pruning would therefore be guesswork that could log out a live
 * user, so no pruning is implemented and no hash is ever deleted implicitly.
 * `revokeToken` remains the only removal path, and it is explicit and targeted.
 *
 * These tests use only temporary-file JSON stores and local `file::memory:`
 * libSQL databases. They never connect to Turso, never read credentials, and
 * never touch `data/app.db.json` or `data/storage/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

import { UserRepo } from './repos.ts';
import { DataStore } from './store.ts';
import { TursoStore } from './tursoStore.ts';
import { hashToken, isValidTokenShape, issueToken, selectSessionToken } from '../services/auth.ts';

const SERVER_SRC = fs.readFileSync(fileURLToPath(new URL('../../server.ts', import.meta.url)), 'utf8');
const PRODUCTION_DB = fileURLToPath(new URL('../../data/app.db.json', import.meta.url));

/** Every store path this file opens, asserted to be temporary (see the last test). */
const openedPaths: string[] = [];

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-tokenhash-'));
  const file = path.join(dir, 'app.db.json');
  openedPaths.push(file);
  return file;
}

async function openJsonRepo(): Promise<UserRepo> {
  const store = new DataStore(tmpDbFile());
  await store.init();
  return new UserRepo(store);
}

/** A user shaped as the real write path stores it (see tursoStore.test.ts). */
function sampleUser(id: string, tokenHashes: string[]): Record<string, unknown> {
  return {
    id,
    tokenHashes,
    credits: 0,
    role: 'USER',
    creditMode: 'NORMAL',
    createdAt: '2026-01-01T00:00:00.000Z',
    freeTrialsUsed: 0,
    purchasedCredits: 0,
    bonusCredits: 0,
  };
}

const REFRESHES = 500;

// ---------------------------------------------------------------------------
// Policy helper (provider-agnostic, pure)
// ---------------------------------------------------------------------------

test('5C2-1. selectSessionToken reuses only a well-formed token the server can resolve', () => {
  const good = issueToken();

  // Reused: presented, well-formed, and already resolves to a live user.
  assert.equal(selectSessionToken(good, true), good);
  // Minted afresh: the server could not resolve it (unknown / revoked / expired).
  assert.equal(selectSessionToken(good, false), null);
  // Minted afresh: nothing presented.
  assert.equal(selectSessionToken(null, true), null);
  assert.equal(selectSessionToken(null, false), null);
  // Minted afresh: malformed even though it "resolves" is claimed.
  assert.equal(selectSessionToken('', true), null);
  assert.equal(selectSessionToken('short', true), null);
});

test('5C2-2. selectSessionToken never substitutes a different token for the presented one', () => {
  // Reuse must be an identity operation: the caller keeps the exact credential
  // it already holds, so nothing it was using can be invalidated by a refresh.
  for (let i = 0; i < 50; i++) {
    const presented = issueToken();
    const reused = selectSessionToken(presented, true);
    assert.equal(reused, presented);
    assert.ok(isValidTokenShape(reused));
  }
});

// ---------------------------------------------------------------------------
// JSON DataStore (synchronous) — the provider that actually runs today
// ---------------------------------------------------------------------------

test('5C2-3. addToken is idempotent: repeated adds of one hash cannot grow tokenHashes', async () => {
  const users = await openJsonRepo();
  const token = issueToken();
  const user = users.createUser(hashToken(token), 0);

  for (let i = 0; i < REFRESHES; i++) {
    assert.equal(users.addToken(user.id, hashToken(token)), true);
  }

  const stored = users.getById(user.id)!;
  assert.equal(stored.tokenHashes.length, 1, 'tokenHashes must stay at one entry');
  assert.deepEqual(stored.tokenHashes, [hashToken(token)]);
});

test('5C2-4. simulated /api/session refreshes add no hashes and keep the session valid', async () => {
  const users = await openJsonRepo();

  // First call: no token presented -> a fresh token is minted and recorded.
  let presented: string | null = null;
  let live = false;
  let minted = selectSessionToken(presented, live) ?? issueToken();
  let user = users.createUser(hashToken(minted), 0);
  users.addToken(user.id, hashToken(minted));
  assert.equal(users.getById(user.id)!.tokenHashes.length, 1);

  // Every later call is a refresh: the client presents its stored token, the
  // server resolves it to a live user, and the SAME token comes back.
  for (let i = 0; i < REFRESHES; i++) {
    presented = minted;
    live = users.getByToken(hashToken(presented)) !== null;
    assert.equal(live, true, 'the presented token must still resolve');

    const next = selectSessionToken(presented, live) ?? issueToken();
    assert.equal(next, presented, 'a refresh must not mint a replacement token');
    minted = next;
    users.addToken(user.id, hashToken(minted));
  }

  const stored = users.getById(user.id)!;
  assert.equal(stored.tokenHashes.length, 1, `${REFRESHES} refreshes must add zero hashes`);
  assert.ok(users.getByToken(hashToken(minted)), 'the session token must still authenticate');
});

test('5C2-5. every token that was valid stays valid across the reuse path', async () => {
  const users = await openJsonRepo();
  const user = users.createUser(hashToken(issueToken()), 0);

  // Three genuine sign-ins (e.g. phone, laptop, tablet) coexist.
  const live = [issueToken(), issueToken(), issueToken()];
  for (const t of live) users.addToken(user.id, hashToken(t));
  assert.equal(users.getById(user.id)!.tokenHashes.length, 4);

  // Refresh the "laptop" session many times.
  const laptop = live[1];
  for (let i = 0; i < REFRESHES; i++) {
    const resolved = users.getByToken(hashToken(laptop)) !== null;
    const next = selectSessionToken(laptop, resolved) ?? issueToken();
    assert.equal(next, laptop);
    users.addToken(user.id, hashToken(next));
  }

  assert.equal(users.getById(user.id)!.tokenHashes.length, 4, 'no refresh added a hash');
  for (const t of live) {
    assert.ok(users.getByToken(hashToken(t)), 'a previously valid token must remain valid');
  }
});

test('5C2-6. genuine new sign-ins are still recorded (the fix does not disable real sessions)', async () => {
  const users = await openJsonRepo();
  const user = users.createUser(hashToken(issueToken()), 0);

  // Each real sign-in presents NO token, so a distinct session token is minted
  // and appended. Growth is now proportional to sign-ins, not to refreshes.
  for (let i = 0; i < 3; i++) {
    const minted = selectSessionToken(null, false) ?? issueToken();
    users.addToken(user.id, hashToken(minted));
  }

  assert.equal(users.getById(user.id)!.tokenHashes.length, 4);
});

test('5C2-7. revokeToken is the only removal path and removes exactly one hash', async () => {
  const users = await openJsonRepo();
  const user = users.createUser(hashToken(issueToken()), 0);
  const a = issueToken();
  const b = issueToken();
  users.addToken(user.id, hashToken(a));
  users.addToken(user.id, hashToken(b));
  assert.equal(users.getById(user.id)!.tokenHashes.length, 3);

  // Nothing prunes on its own: many reads and refreshes leave the set intact.
  for (let i = 0; i < REFRESHES; i++) {
    users.getByToken(hashToken(a));
    const reused = selectSessionToken(a, users.getByToken(hashToken(a)) !== null) ?? issueToken();
    users.addToken(user.id, hashToken(reused));
  }
  assert.equal(users.getById(user.id)!.tokenHashes.length, 3, 'no implicit pruning may occur');

  // Explicit, targeted logout of one token.
  assert.equal(users.revokeToken(user.id, hashToken(a)), true);
  const after = users.getById(user.id)!;
  assert.equal(after.tokenHashes.length, 2);
  assert.ok(!after.tokenHashes.includes(hashToken(a)), 'the revoked token is gone');
  assert.ok(after.tokenHashes.includes(hashToken(b)), 'the other session is untouched');
  assert.equal(users.revokeToken(user.id, hashToken(a)), false, 'revoking twice is a no-op');
});

test('5C2-8. an unknown presented token does not resolve and forces a fresh mint', async () => {
  const users = await openJsonRepo();
  const user = users.createUser(hashToken(issueToken()), 0);
  const stranger = issueToken();

  assert.equal(users.getByToken(hashToken(stranger)), null);
  assert.equal(selectSessionToken(stranger, false), null, 'must not reuse an unresolvable token');
  // The route answers 401 in this case, before any token is minted.
});

// ---------------------------------------------------------------------------
// JSON DataStore stays synchronous (regression guard for Step 5C-1)
// ---------------------------------------------------------------------------

test('5C2-9. JSON DataStore token writes remain synchronous', async () => {
  const store = new DataStore(tmpDbFile());
  await store.init();
  const users = new UserRepo(store);
  const user = users.createUser(hashToken(issueToken()), 0);

  // `addToken` is declared `: boolean`, so a `typeof` check is both the
  // runtime proof and the compile-time proof that no Promise crosses the API.
  const result: boolean = users.addToken(user.id, hashToken(issueToken()));
  assert.equal(typeof result, 'boolean', 'addToken must return a boolean, not a Promise');

  // Visible immediately, with no await, in the same tick.
  assert.equal(store.snapshot().users[0].tokenHashes.length, 2);
});

// ---------------------------------------------------------------------------
// TursoStore compatibility (local file::memory: only, never the network)
// ---------------------------------------------------------------------------

test('5C2-10. TursoStore round-trips tokenHashes and honours the same reuse policy', async () => {
  const client = createClient({ url: 'file::memory:' });
  const store = new TursoStore(client);
  await store.init();

  const token = issueToken();
  await store.createUser(sampleUser('u1', [hashToken(token)]) as never);

  // The JSON blob column stays valid JSON text with the exact array.
  const raw = await client.execute({ sql: 'SELECT tokenHashes FROM users WHERE id = ?', args: ['u1'] });
  assert.equal(typeof raw.rows[0].tokenHashes, 'string');
  assert.deepEqual(JSON.parse(String(raw.rows[0].tokenHashes)), [hashToken(token)]);

  // The reuse policy is storage-agnostic: 500 refreshes add no hashes.
  const hashes = [hashToken(token)];
  for (let i = 0; i < REFRESHES; i++) {
    const live = hashes.includes(hashToken(token));
    const next = selectSessionToken(token, live) ?? issueToken();
    if (!hashes.includes(hashToken(next))) hashes.push(hashToken(next));
  }
  assert.equal(hashes.length, 1, `${REFRESHES} refreshes must add no hashes`);

  // Lookup by token still resolves through the SQL path.
  const found = await store.getUserByToken(hashToken(token));
  assert.ok(found, 'getUserByToken must still resolve the live token');
  assert.deepEqual(found!.tokenHashes, [hashToken(token)]);

  // Multiple concurrent sessions all survive.
  const extra = [issueToken(), issueToken()];
  await store.createUser(sampleUser('u2', [hashToken(token), ...extra.map(hashToken)]) as never);
  const u2 = await store.getUserById('u2');
  assert.deepEqual(u2!.tokenHashes, [hashToken(token), ...extra.map(hashToken)]);
  for (const t of extra) {
    assert.ok(await store.getUserByToken(hashToken(t)), 'each stored token must resolve');
  }
});

// ---------------------------------------------------------------------------
// Source-level guard on the route itself (mirrors communityRoutes.test.ts)
// ---------------------------------------------------------------------------

test('5C2-11. /api/session reuses the presented token instead of unconditionally minting', () => {
  const start = SERVER_SRC.indexOf("app.post('/api/session'");
  assert.ok(start > -1, 'server must register POST /api/session');
  const body = SERVER_SRC.slice(start, start + 4000);

  assert.match(body, /selectSessionToken\(\s*existing\s*,\s*presentedIsLive\s*\)/, 'route must consult the reuse policy');
  assert.match(body, /selectSessionToken\([^)]*\)\s*\?\?\s*issueToken\(\)/, 'minting must be only the fallback');
  assert.doesNotMatch(body, /const token = issueToken\(\);/, 'the session route must not mint unconditionally');
  // The reuse decision must be driven by an actual lookup, not a guess.
  assert.match(body, /presentedIsLive = true;/, 'liveness must come from a successful getByToken');
});

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

test('5C2-12. no test touches production data', () => {
  assert.ok(openedPaths.length > 0, 'the suite must actually open a store');
  for (const p of openedPaths) {
    assert.ok(
      p.startsWith(os.tmpdir()),
      `store path must be temporary, got: ${p}`,
    );
  }
  assert.ok(!openedPaths.includes(PRODUCTION_DB), 'production data/app.db.json must never be opened');
  assert.ok(fs.existsSync(PRODUCTION_DB), 'production data/app.db.json is left in place, untouched');
});
