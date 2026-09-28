/**
 * PRODUCTION ROUTE SMOKE TEST
 *
 * Boots the real production server (the built bundle) on a free port and
 * checks the canonical route contract over HTTP:
 *
 *   GET /              -> 200, the app shell
 *   GET /admin         -> 200, the app shell (renders the Admin Dashboard only)
 *   GET /admin/...     -> 200, admin surface
 *   GET <anything else>-> 404, and never the transcription shell
 *
 * It also asserts the legacy test-preset copy ("Instant Rule Verification
 * Presets") is NOT present in the production bundle, and it never contacts any
 * transcription provider.
 *
 * Usage:  npm run build:clean && npm run verify:routes
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

const ROOT = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not come up at ${url} within ${timeoutMs}ms`);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  checks.push({ name, ok, detail });
}

async function main() {
  const indexHtml = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.error('No production build found. Run:  npm run build:clean');
    process.exit(1);
  }

  // The legacy test surface must not survive into a production bundle.
  const assetsDir = path.join(ROOT, 'dist', 'assets');
  const bundle = fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8'))
    .join('\n');
  check(
    'legacy "Instant Rule Verification Presets" absent from production bundle',
    !bundle.includes('Instant Rule Verification Presets'),
  );
  check(
    'new multilingual UI present in production bundle',
    bundle.includes('Transcription Language') && bundle.includes('hi-IN'),
  );
  check(
    'admin-only surface present in production bundle',
    bundle.includes('Admin Dashboard'),
  );

  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['-e', "process.env.NODE_ENV='production';require('./dist/server.cjs')"],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  child.stdout?.on('data', (d) => (serverLog += d.toString()));
  child.stderr?.on('data', (d) => (serverLog += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(`${base}/api/health`);

    // 1. Root is the new application.
    const root = await fetch(`${base}/`);
    const rootHtml = await root.text();
    check('GET / -> 200', root.status === 200, `status=${root.status}`);
    check('GET / is the SPA shell', /id="root"/.test(rootHtml));
    check(
      'GET / is served no-store (browser cannot pin an old shell)',
      /no-store/.test(root.headers.get('cache-control') || ''),
      `cache-control=${root.headers.get('cache-control')}`,
    );

    // 2. /admin serves the shell but is marked noindex.
    const admin = await fetch(`${base}/admin`);
    check('GET /admin -> 200', admin.status === 200, `status=${admin.status}`);
    check(
      'GET /admin is noindex,nofollow',
      /noindex/.test(admin.headers.get('x-robots-tag') || ''),
    );

    // 3. The admin subtree works too.
    const adminSub = await fetch(`${base}/admin/users`);
    check('GET /admin/users -> 200', adminSub.status === 200, `status=${adminSub.status}`);

    // 4. Nothing else may render a surface.
    for (const p of ['/legacy', '/old-ui', '/test', '/Admin', '/adminx', '/index.php']) {
      const r = await fetch(`${base}${p}`);
      check(`GET ${p} -> 404`, r.status === 404, `status=${r.status}`);
    }

    // 5. The API surface is untouched and still enforced.
    const health = await fetch(`${base}/api/health`);
    check('GET /api/health -> 200', health.status === 200);
    const adminApi = await fetch(`${base}/api/admin/users`);
    check('GET /api/admin/users without a token -> 401', adminApi.status === 401, `status=${adminApi.status}`);

    // 6. Duplicate servers cannot silently take over the port.
    const squatter = spawn(
      process.execPath,
      ['-e', "process.env.NODE_ENV='production';require('./dist/server.cjs')"],
      { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' },
    );
    const squatterExit = await new Promise<number | null>((resolve) => {
      squatter.on('exit', (c) => resolve(c));
      setTimeout(() => resolve(null), 20_000);
    });
    check(
      'a second server on the same port exits non-zero instead of silently serving',
      squatterExit !== null && squatterExit !== 0,
      `exit=${squatterExit}`,
    );
  } finally {
    child.kill();
  }

  console.log('');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\n--- server output ---\n' + serverLog.slice(-3000));
    process.exit(1);
  }
}

void main();
