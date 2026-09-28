import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bootstrapTokenChangedMessage,
  fingerprintToken,
  verifyBootstrapTokenIntegrity,
  type GuardAlert,
} from './bootstrapTokenGuard.ts';

/**
 * All tokens here are SYNTHETIC test values. The real ADMIN_BOOTSTRAP_TOKEN is
 * never read, printed or asserted on by this suite.
 */
const TOKEN_A = 'synthetic-test-token-aaaa';
const TOKEN_B = 'synthetic-test-token-bbbb';
const PROJECT_DIR = 'E:\\Odia-SRT-App';

function tempStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btg-'));
  return path.join(dir, 'bootstrap-token-guard.json');
}

function collectLog() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  return {
    lines,
    log: {
      info: (message: string, fields?: Record<string, unknown>) => lines.push({ level: 'info', message, fields }),
      warn: (message: string, fields?: Record<string, unknown>) => lines.push({ level: 'warn', message, fields }),
    },
  };
}

test('first run records a baseline fingerprint and raises NO alert', async () => {
  const stateFile = tempStateFile();
  const { log, lines } = collectLog();
  const res = await verifyBootstrapTokenIntegrity({
    token: TOKEN_A,
    stateFile,
    projectDir: PROJECT_DIR,
    log,
  });
  assert.equal(res.status, 'BASELINE_RECORDED');
  assert.equal(res.alert, null);
  assert.ok(fs.existsSync(stateFile));
  // The stored state must never contain the token itself.
  const stored = fs.readFileSync(stateFile, 'utf8');
  assert.ok(!stored.includes(TOKEN_A), 'state file must not contain the token');
  assert.ok(JSON.parse(stored).fingerprint.length === 64, 'fingerprint is a sha256 hex digest');
  assert.ok(lines.every((l) => !JSON.stringify(l.fields ?? {}).includes(TOKEN_A)));
});

test('same token on restart -> UNCHANGED, no alert (token is never rotated)', async () => {
  const stateFile = tempStateFile();
  const { log } = collectLog();
  const first = await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  assert.equal(first.status, 'BASELINE_RECORDED');

  // Simulate two restarts with the identical token.
  const second = await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  const third = await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  assert.equal(second.status, 'UNCHANGED');
  assert.equal(third.status, 'UNCHANGED');
  assert.equal(second.alert, null);
  assert.equal(third.alert, null);

  // lastVerifiedAt advances, proving the file is genuinely re-read each start.
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(stored.lastVerifiedAt >= stored.recordedAt);
  assert.ok(!fs.readFileSync(stateFile, 'utf8').includes(TOKEN_A));
});

test('changed token -> security alert with the exact required message, token never included', async () => {
  const stateFile = tempStateFile();
  const { log, lines } = collectLog();
  await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  const res = await verifyBootstrapTokenIntegrity({ token: TOKEN_B, stateFile, projectDir: PROJECT_DIR, log });

  assert.equal(res.status, 'CHANGED');
  const alert = res.alert as GuardAlert;
  assert.equal(alert.code, 'BOOTSTRAP_TOKEN_CHANGED');
  assert.ok(
    alert.body.includes(
      'SECURITY ALERT: ADMIN_BOOTSTRAP_TOKEN has changed in E:\\Odia-SRT-App. Please verify the server configuration.'
    ),
    'alert must carry the exact required sentence'
  );
  // Neither token may appear anywhere in the alert, result or logs.
  assert.ok(!alert.body.includes(TOKEN_B), 'alert must not contain the new token');
  assert.ok(!JSON.stringify(alert).includes(TOKEN_A), 'alert must not contain the old token');
  assert.ok(!lines.some((l) => JSON.stringify(l.fields ?? {}).includes(TOKEN_B)));
  // The recorded baseline is preserved so the change stays visible.
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.notEqual(stored.fingerprint, fingerprintToken(TOKEN_B, stored.pepper));
});

test('missing token -> safe failure, alert raised, nothing generated or replaced', async () => {
  const stateFile = tempStateFile();
  const { log } = collectLog();
  await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });

  for (const missing of ['', '   ', null, undefined]) {
    const res = await verifyBootstrapTokenIntegrity({
      token: missing,
      stateFile,
      projectDir: PROJECT_DIR,
      log,
    });
    assert.equal(res.status, 'MISSING');
    assert.equal(res.alert?.code, 'BOOTSTRAP_TOKEN_MISSING');
    assert.equal(res.fingerprintPrefix, null);
    assert.ok(res.notificationPending, 'no channel configured -> setup pending');
    assert.match(res.summary, /not configured/i);
  }

  // A missing token must not have altered the recorded baseline.
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.fingerprint, fingerprintToken(TOKEN_A, stored.pepper));
  // Restoring the same token afterwards is still UNCHANGED (no rotation).
  const back = await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  assert.equal(back.status, 'UNCHANGED');
  assert.equal(back.alert, null);
});

test('unconfigured channel reports notification setup as PENDING without inventing credentials', async () => {
  const stateFile = tempStateFile();
  const { log } = collectLog();
  await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  const res = await verifyBootstrapTokenIntegrity({ token: TOKEN_B, stateFile, projectDir: PROJECT_DIR, log });

  assert.equal(res.notificationPending, true);
  assert.equal(res.alert?.delivered, false);
  assert.deepEqual(res.alert?.deliveries, []);
  assert.match(res.alert?.note ?? '', /PENDING/);
  assert.match(res.alert?.note ?? '', /WhatsApp is NOT connected/);
  assert.match(res.alert?.note ?? '', /no credentials were invented/i);
});

test('a configured transport receives the alert and marks it delivered', async () => {
  const stateFile = tempStateFile();
  const { log } = collectLog();
  await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });

  const seen: GuardAlert[] = [];
  const res = await verifyBootstrapTokenIntegrity({
    token: TOKEN_B,
    stateFile,
    projectDir: PROJECT_DIR,
    log,
    transports: {
      testChannel: (alert) => {
        seen.push(alert);
        return true;
      },
    },
  });

  assert.equal(res.notificationPending, false);
  assert.equal(res.alert?.delivered, true);
  assert.deepEqual(res.alert?.deliveries, ['testChannel']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'BOOTSTRAP_TOKEN_CHANGED');
  assert.ok(!JSON.stringify(seen[0]).includes(TOKEN_B), 'transport never receives the token');
});

test('a failing transport never breaks startup safety', async () => {
  const stateFile = tempStateFile();
  const { log } = collectLog();
  await verifyBootstrapTokenIntegrity({ token: TOKEN_A, stateFile, projectDir: PROJECT_DIR, log });
  const res = await verifyBootstrapTokenIntegrity({
    token: TOKEN_B,
    stateFile,
    projectDir: PROJECT_DIR,
    log,
    transports: {
      broken: () => {
        throw new Error(`transport exploded ${TOKEN_B}`);
      },
    },
  });
  assert.equal(res.status, 'CHANGED');
  assert.equal(res.alert?.delivered, false);
});

test('the guard never writes the token and exposes no token-returning API', async () => {
  const src = fs.readFileSync(new URL('./bootstrapTokenGuard.ts', import.meta.url), 'utf8');
  // No network call, no messaging URL, no new dependency: transport-neutral.
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\/(api\.)?(twilio|whatsapp|meta|graph\.facebook)/i);
  // The public result carries only a non-reversible fingerprint prefix.
  assert.match(src, /fingerprintPrefix/);
  // The exact required alert sentence is present.
  assert.equal(
    bootstrapTokenChangedMessage(PROJECT_DIR),
    'SECURITY ALERT: ADMIN_BOOTSTRAP_TOKEN has changed in E:\\Odia-SRT-App. Please verify the server configuration.'
  );
  // Guard must not be able to write to the .env / config surface.
  assert.doesNotMatch(src, /process\.env\.[A-Z_]+\s*=/);
});
