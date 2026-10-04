import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

/** Every app.<method>('/path', ...middleware, handler) registration, keyed by
 *  "METHOD /path" (so GET and POST on the same path stay distinct), with the
 *  value being just the MIDDLEWARE CHAIN (everything between the path string
 *  and the handler body) so the assertions see the full chain. */
function registeredRoutes(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const afterPath = m.index + m[0].length;
    // The chain ends at the handler's arrow function, or at the statement's
    // semicolon when a named function is used as the handler.
    const arrow = src.indexOf('=>', afterPath);
    const semi = src.indexOf(';', afterPath);
    let end: number;
    if (semi !== -1 && (arrow === -1 || semi < arrow)) end = semi;
    else end = arrow === -1 ? afterPath : arrow;
    out.set(`${m[1].toUpperCase()} ${m[2]}`, src.slice(afterPath, end));
  }
  return out;
}

const routes = registeredRoutes(serverSrc);

function chainFor(method: string, pathname: string): string {
  const raw = routes.get(`${method} ${pathname}`);
  assert.ok(raw, `server must register ${method} ${pathname}`);
  return raw;
}

test('O1. all pre-existing production routes are still registered and unchanged', () => {
  const required = [
    '/api/health',
    '/api/process-audio',
    '/api/detect-language',
    '/api/session',
    '/api/account/signup',
    '/api/account/login',
    '/api/account/logout',
    '/api/jobs',
    '/api/jobs/:id',
    '/api/jobs/:id/srt',
    '/api/jobs/:id/cancel',
    '/api/credits/me',
    '/api/credits/packs',
    '/api/admin/users',
    '/api/admin/users/:id',
    '/api/admin/transactions',
'/api/admin/login-activity',
    '/api/admin/login-alerts',
    '/api/admin/login-alerts/run',
    '/api/admin/jobs',
    '/api/admin/credits/adjust',
    '/api/admin/credits/grant',
    '/api/admin/credits/debit',
    '/api/admin/provider/safety',
    '/api/admin/provider/safety/reset',
    '/api/admin/alerts',
  ];
  for (const r of required) {
    // Each of these must still be registered under at least one method.
    const has =
      routes.has(`GET ${r}`) ||
      routes.has(`POST ${r}`) ||
      routes.has(`PUT ${r}`) ||
      routes.has(`DELETE ${r}`);
    assert.ok(has, `server must still register ${r}`);
  }

  // The critical production pipelines keep their exact middleware chain.
  assert.match(
    chainFor('POST', '/api/process-audio'),
    /upload\.single\('mediaFile'\)/,
    'the ASR upload policy must be untouched'
  );
  assert.match(chainFor('POST', '/api/jobs'), /auth\(\), upload\.single\('mediaFile'\)/);
  assert.match(chainFor('GET', '/api/credits/me'), /auth\(\)/);
  // Admin routes keep auth() + requireAdmin in that order, on every method.
  for (const r of required.filter((x) => x.startsWith('/api/admin/'))) {
    for (const m of ['GET', 'POST']) {
      if (!routes.has(`${m} ${r}`)) continue;
      assert.match(chainFor(m, r), /auth\(\), requireAdmin/, `${m} ${r} must stay owner-gated`);
    }
  }
});

test('the ASR upload MIME allowlist was NOT widened for community screenshots', () => {
  const uploadPolicy = fs.readFileSync(
    path.resolve(process.cwd(), 'server/services/uploadPolicy.ts'),
    'utf8'
  );
  // Images must not have leaked into the transcription upload policy.
  assert.doesNotMatch(uploadPolicy, /image\//, 'the ASR policy must stay audio/video only');
  // And the ASR middleware itself is untouched.
  assert.match(serverSrc, /const upload = multer\(\{\s*storage: multer\.memoryStorage\(\),\s*limits: \{ fileSize: 100 \* 1024 \* 1024 \}/);
  // Community attachments use their own, separate uploader.
  assert.match(serverSrc, /const communityUpload = multer\(\{/);
});

test('O2. every community submission route is authenticated', () => {
  for (const r of ['/api/community/messages', '/api/community/reports', '/api/community/support']) {
    assert.match(chainFor('POST', r), /auth\(\)/, `${r} must require a session`);
  }
  assert.match(chainFor('GET', '/api/community/status'), /auth\(\)/);
  // The guidelines route is intentionally public and returns no user data.
  const g = chainFor('GET', '/api/community/guidelines');
  assert.doesNotMatch(g, /auth\(\)/);
});

test('O3. every moderation admin route requires auth() AND requireAdmin', () => {
  const adminModeration: Array<[string, string]> = [
    ['GET', '/api/admin/moderation'],
    ['POST', '/api/admin/moderation/cases/:id/review'],
    ['POST', '/api/admin/moderation/restrictions/extend'],
    ['POST', '/api/admin/moderation/restrictions/release'],
    ['GET', '/api/admin/moderation/attachments/:userId/*key'],
  ];
  for (const [m, r] of adminModeration) {
    assert.match(chainFor(m, r), /auth\(\), requireAdmin/, `${m} ${r} must require a verified owner`);
  }
});

test('O4. the submission kind comes from the route, never the request body', () => {
  // A client cannot relabel a support request as a community post (or the
  // reverse) by sending kind/category fields.
  assert.match(serverSrc, /res\.locals\.communityKind = 'COMMUNITY'/);
  assert.match(serverSrc, /res\.locals\.communityKind = 'SUPPORT'/);
  assert.match(serverSrc, /res\.locals\.communityKind = 'REPORT'/);
  assert.match(serverSrc, /const kind: 'COMMUNITY' \| 'SUPPORT' \| 'REPORT' = \(res\.locals\.communityKind/);
  // No route may read a body-supplied kind.
  assert.doesNotMatch(serverSrc, /req\.body\?\.kind|req\.body\.kind/);
});

test('O5. the 2-hour restriction is a server-side constant, not a client value', () => {
  const svc = fs.readFileSync(
    path.resolve(process.cwd(), 'server/services/communityModeration.ts'),
    'utf8'
  );
  assert.match(svc, /export const RESTRICTION_DURATION_MS = 2 \* 60 \* 60 \* 1000/);
  // The route never accepts a raw duration for the automatic penalty.
  assert.doesNotMatch(serverSrc, /req\.body\?\.durationMs|req\.body\.durationMs/);
  // The admin extension is clamped server-side.
  assert.match(svc, /Math\.min\(requested, MAX_ADMIN_EXTENSION_MS\)/);
  // There is no permanent-ban action in the schema at all, so one cannot even
  // be recorded. (A prose mention in a comment is fine; the type is the truth.)
  const types = fs.readFileSync(path.resolve(process.cwd(), 'server/db/types.ts'), 'utf8');
  const actionUnion = types.match(/export type ModerationAction =([^;]+);/)?.[1] ?? '';
  assert.ok(actionUnion, 'the ModerationAction union must exist');
  assert.doesNotMatch(actionUnion, /PERMANENT|BAN\b/i, 'no permanent-ban action may exist');
  assert.match(actionUnion, /'WARNING'/);
  assert.match(actionUnion, /'RESTRICTED'/);
  assert.match(actionUnion, /'ADMIN_REVIEW'/);
});

test('O6. no IP, device or credential data is collected by the community routes', () => {
  const communitySrc = serverSrc.slice(
    serverSrc.indexOf('// COMMUNITY & SUPPORT (additive)'),
    serverSrc.indexOf('// ADMIN API')
  );
  assert.ok(communitySrc.length > 0, 'the community block must exist');
  for (const forbidden of [
    'req.ip',
    'req.headers[\'user-agent\']',
    'x-forwarded-for',
    'deviceId',
    'password',
    'adminBootstrapToken',
  ]) {
    assert.ok(!communitySrc.includes(forbidden), `must not collect ${forbidden}`);
  }
});

test('O7. Telegram moderation is honestly reported as NOT active', () => {
  const svc = fs.readFileSync(
    path.resolve(process.cwd(), 'server/services/communityModeration.ts'),
    'utf8'
  );
  assert.match(svc, /export const TELEGRAM_MODERATION_NOTE/);
  assert.match(svc, /NOT active/);
  assert.match(svc, /Telegram Bot API/);
  // No fabricated Telegram HTTP calls anywhere in the codebase.
  assert.doesNotMatch(serverSrc, /api\.telegram\.org|t\.me\/bot/i);
  assert.doesNotMatch(svc, /telegram.*fetch\(/i);
});
