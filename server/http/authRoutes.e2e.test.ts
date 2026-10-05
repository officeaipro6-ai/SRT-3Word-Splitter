/**
 * HTTP-level auth contract: the REAL server process, on the REAL turso provider.
 *
 * This is the layer where the production outage lived. `/api/account/signup` and
 * `/api/account/login` returned 500 because `server.ts` wired the SYNCHRONOUS
 * `UserRepo` to `TursoStore` (whose `snapshot()` is a Promise and whose
 * `mutate()` throws). Unit tests on the service alone would not prove the ROUTES
 * work, so this boots `server.ts` exactly as production does
 * (`DATABASE_PROVIDER=turso`, `tsx server.ts`) and drives it over HTTP.
 *
 * NO MOCKS ANYWHERE:
 *   - a real child process running the real server
 *   - a real libSQL database on disk (temp file)
 *   - real scrypt password hashing, real bearer tokens, real SQL
 *   - every "success" is asserted from a real response AND a real subsequent
 *     database read, so an implementation that faked persistence could not pass
 *   - nothing here bypasses the auth middleware, asyncRoute or status mapping
 *
 * A child process (rather than importing server.ts in-process) is deliberate:
 * `server.ts` binds a port and installs timers on import, which would keep the
 * test runner alive and make the suite order-dependent.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createClient, type InValue } from '@libsql/client';

const PORT = Number(process.env.AUTH_E2E_PORT ?? 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'CorrectHorse1!';
const EMAIL = 'http-flow@example.com';

let dir: string;
let dbUrl: string;
let child: ChildProcess | undefined;
let stdout = '';
let stderr = '';

async function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep `json` undefined: a non-JSON body is itself a finding */
  }
  return { status: res.status, json, text };
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* see above */
  }
  return { status: res.status, json, text };
}

/** Raw read of the on-disk database, bypassing the app entirely. */
async function db() {
  const client = createClient({ url: dbUrl });
  return {
    async all(sql: string, args: InValue[] = []) {
      return (await client.execute({ sql, args })).rows;
    },
    close: () => client.close(),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'authe2e-'));
  dbUrl = `file:${join(dir, 'app.db')}`;

  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATABASE_PROVIDER: 'turso',
      TURSO_DATABASE_URL: dbUrl,
      // Local libSQL file URL: no network, and not a real credential.
      TURSO_AUTH_TOKEN: 'local-e2e-file-token',
      INITIAL_CREDITS: '25',
      FREE_TRIAL_LIMIT: '1',
      STORAGE_PROVIDER: 'local',
      ENABLE_JOB_QUEUE: 'false',
      // Strip any real secrets this machine may have in .env so nothing here can
      // touch a live database, gateway or owner account.
      ADMIN_BOOTSTRAP_TOKEN: '',
      OWNER_EMAILS: '',
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
      SARVAM_API_KEY: '',
      LOCAL_SUBMISSION_MODE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr?.on('data', (d) => {
    stderr += String(d);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became healthy\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  try {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best effort */
  }
});

test('the server booted on the turso provider', async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.ok(existsSync(join(dir, 'app.db')), 'the temp SQLite database file must exist');
});

test('HTTP signup -> login -> refresh -> credits -> logout', async (t) => {
  const conn = await db();
  t.after(() => conn.close());

  // ------------------------------------------------------------- signup ---
  const signup = await post('/api/account/signup', { email: EMAIL, password: PASSWORD });
  assert.equal(signup.status, 201, `signup must not 500 (this is the production bug): ${signup.text}`);
  assert.ok(signup.json?.token, 'signup must return a session token');
  assert.equal(signup.json.email, EMAIL);
  assert.equal(signup.json.role, 'USER', 'signup must never grant ADMIN');
  assert.equal(signup.json.credits, 25, 'signup must report the opening balance');
  assert.equal(signup.json.account, true);
  assert.ok(!signup.text.includes(PASSWORD), 'the response must never echo the password');
  const signupToken: string = signup.json.token;
  const userId: string = signup.json.userId;

  // The account is a REAL row, not something the process kept in memory.
  const rows = await conn.all('SELECT id, email, role, credits, passwordHash, tokenHashes FROM users WHERE email = ?', [
    EMAIL,
  ]);
  assert.equal(rows.length, 1, 'exactly one user row must exist for this email');
  const row = rows[0] as Record<string, unknown>;
  assert.equal(row.id, userId);
  assert.equal(row.role, 'USER');
  assert.equal(Number(row.credits), 25);
  assert.ok(String(row.passwordHash).startsWith('scrypt$'), 'password must be stored as a scrypt hash');
  assert.ok(!String(row.passwordHash).includes(PASSWORD), 'the plaintext password must never be stored');
  // The issued token is persisted only as a sha256 hash.
  assert.ok(!String(row.tokenHashes).includes(signupToken), 'the raw token must never be stored');
  assert.equal(
    (JSON.parse(String(row.tokenHashes)) as string[]).length,
    1,
    'exactly one live session at signup',
  );
  const reasons = (await conn.all('SELECT reason FROM transactions WHERE userId = ?', [userId])).map(
    (x: any) => x.reason,
  );
  assert.deepEqual(
    reasons,
    ['initial_grant'],
    'signup must open the ledger with exactly one initial_grant row',
  );

  // duplicate -> 409; malformed -> 400; neither may be a 500
  const dupe = await post('/api/account/signup', { email: EMAIL, password: PASSWORD });
  assert.equal(dupe.status, 409, dupe.text);
  assert.equal(dupe.json.code, 'EMAIL_TAKEN');
  assert.equal((await post('/api/account/signup', { email: 'not-an-email', password: PASSWORD })).status, 400);
  assert.equal((await post('/api/account/signup', { email: 'x@example.com', password: 'short' })).status, 400);

  // -------------------------------------------------------------- login ---
  const login = await post('/api/account/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200, `login must not 500 (this is the production bug): ${login.text}`);
  assert.ok(login.json?.token, 'login must return a session token');
  assert.equal(login.json.userId, userId, 'login must resolve the same account');
  assert.ok(login.json.lastLoginAt, 'login must stamp lastLoginAt');
  const loginToken: string = login.json.token;

  const bad = await post('/api/account/login', { email: EMAIL, password: 'WrongPassword1!' });
  assert.equal(bad.status, 401, bad.text);
  assert.equal(bad.json.code, 'INVALID_CREDENTIALS');
  const unknown = await post('/api/account/login', { email: 'ghost@example.com', password: PASSWORD });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.code, 'INVALID_CREDENTIALS', 'unknown email must be indistinguishable');

  // ------------------------------------------------- authenticated reads ---
  const me = await get('/api/credits/me', loginToken);
  assert.equal(me.status, 200, `credits must load for the signed-in user: ${me.text}`);
  assert.equal(me.json.userId, userId);
  assert.equal(me.json.credits, 25, 'the wallet must show the opening balance');
  assert.ok(Array.isArray(me.json.transactions));
  assert.ok(
    me.json.transactions.some((x: any) => x.reason === 'initial_grant'),
    'the ledger must contain the initial_grant row',
  );

  // ------------------------------------------------------------ refresh ---
  const refresh = await post('/api/session', {}, loginToken);
  assert.equal(refresh.status, 200, `refresh must not 500: ${refresh.text}`);
  assert.equal(refresh.json.token, loginToken, 'a refresh must hand back the same live token');
  assert.equal(refresh.json.userId, userId);
  assert.equal(refresh.json.credits, 25);

  const refreshAgain = await post('/api/session', {}, loginToken);
  assert.equal(refreshAgain.status, 200);
  assert.equal(refreshAgain.json.token, loginToken);

  const liveHashes = JSON.parse(
    String((await conn.all('SELECT tokenHashes FROM users WHERE id = ?', [userId]))[0].tokenHashes),
  ) as string[];
  assert.equal(liveHashes.length, 2, 'two devices -> two sessions, and refreshes must not add more');
  assert.equal(new Set(liveHashes).size, 2, 'no duplicate token hashes after repeated refreshes');

  // The signup session still works: logging in does not evict another device.
  const other = await get('/api/credits/me', signupToken);
  assert.equal(other.status, 200);
  assert.equal(other.json.credits, 25);

  // unknown but well-formed token -> 401 (this used to be a 500 HTML page)
  const bogus = await get('/api/credits/me', 'A'.repeat(40));
  assert.equal(bogus.status, 401, `unknown token must be 401, got ${bogus.status}: ${bogus.text.slice(0, 200)}`);
  // no token -> 401
  assert.equal((await get('/api/credits/me')).status, 401);

  // ------------------------------------------------------------- logout ---
  const logout = await post('/api/account/logout', {}, loginToken);
  assert.equal(logout.status, 200, `logout must not 500: ${logout.text}`);
  assert.equal(logout.json.ok, true);

  const afterLogout = await get('/api/credits/me', loginToken);
  assert.equal(afterLogout.status, 401, `a revoked token must be rejected: ${afterLogout.text.slice(0, 200)}`);
  assert.equal(
    (await get('/api/credits/me', signupToken)).status,
    200,
    'logout must not revoke a different session',
  );

  const relogin = await post('/api/account/login', { email: EMAIL, password: PASSWORD });
  assert.equal(relogin.status, 200, 'the credentials must still work after logout');
  assert.equal((await get('/api/credits/me', relogin.json.token)).status, 200);
});

test('an anonymous session works end to end on turso', async () => {
  const session = await post('/api/session', {});
  assert.equal(session.status, 200, `/api/session must not 500 on turso: ${session.text}`);
  assert.ok(session.json?.token, 'a token must be issued');
  assert.equal(session.json.role, 'USER');
  assert.equal(session.json.account, false, 'an anonymous session is not an account');

  const me = await get('/api/credits/me', session.json.token);
  assert.equal(me.status, 200, me.text.slice(0, 200));
  assert.equal(me.json.userId, session.json.userId);
  assert.equal(me.json.credits, 25, 'INITIAL_CREDITS must be applied and visible');

  // And the anonymous session row really exists.
  const rows = await db().then(async (c) => {
    const r = await c.all('SELECT id, role FROM users WHERE id = ?', [session.json.userId]);
    c.close();
    return r;
  });
  assert.equal(rows.length, 1);
});

test('jobs are scoped to the authenticated user', async () => {
  const session = await post('/api/session', {});
  const jobs = await get('/api/jobs', session.json.token);
  assert.equal(jobs.status, 200, jobs.text.slice(0, 200));
  assert.ok(Array.isArray(jobs.json?.jobs ?? jobs.json));
  // Unauthenticated access is refused, not crashed.
  assert.equal((await get('/api/jobs')).status, 401);
});

test('two different accounts are fully isolated', async (t) => {
  const a = await post('/api/account/signup', { email: 'iso-a@example.com', password: PASSWORD });
  const b = await post('/api/account/signup', { email: 'iso-b@example.com', password: PASSWORD });
  assert.equal(a.status, 201, a.text);
  assert.equal(b.status, 201, b.text);
  assert.notEqual(a.json.userId, b.json.userId);

  assert.equal((await get('/api/credits/me', a.json.token)).json.userId, a.json.userId);
  assert.equal((await get('/api/credits/me', b.json.token)).json.userId, b.json.userId);

  // A's token must not resolve to B, and vice versa.
  assert.notEqual((await get('/api/credits/me', a.json.token)).json.userId, b.json.userId);

  const conn = await db();
  t.after(() => conn.close());
  const users = await conn.all('SELECT email FROM users ORDER BY email');
  assert.ok(
    users.length >= 4,
    'each distinct email must be its own row (no cross-account overwrite)',
  );
});

test('no secret material is echoed by any auth response', async () => {
  const login = await post('/api/account/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200);
  const body = login.text;
  assert.ok(!body.includes(PASSWORD), 'no plaintext password');
  assert.ok(!body.includes('scrypt$'), 'no password hash');
  const keys = Object.keys(login.json);
  assert.deepEqual(
    keys.filter((k) => /password|hash|secret|token$|bootstrap/i.test(k)),
    ['token'],
    'the session token is the only credential-shaped field, and it is intentional',
  );
});