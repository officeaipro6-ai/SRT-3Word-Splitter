import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/sessionClient.ts'), 'utf8');
const ui = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AdminDashboard.tsx'), 'utf8');
const widget = fs.readFileSync(path.resolve(process.cwd(), 'src/components/CreditsWidget.tsx'), 'utf8');
const server = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');

const ADMIN_ROUTES = [
  '/api/admin/users',
  '/api/admin/transactions',
  '/api/admin/jobs',
  '/api/admin/credits/adjust',
  '/api/admin/credits/grant',
  '/api/admin/credits/debit',
  '/api/admin/provider/safety',
  '/api/admin/provider/safety/reset',
  '/api/admin/alerts',
];

test('the admin client calls exactly the documented admin endpoints', () => {
  for (const route of ADMIN_ROUTES) {
    assert.ok(src.includes(route), `sessionClient must call ${route}`);
    assert.ok(server.includes(route), `server must expose ${route}`);
  }
});

test('every admin client call is authenticated (authFetch, never bare fetch)', () => {
  // The only bare fetch() calls in the client are the public ones: the session
  // bootstrap, owner sign-in and the public credit-pack catalog.
  const bareFetches = src.match(/await fetch\(/g) || [];
  assert.equal(bareFetches.length, 3, 'only ensureSession, signInAsOwner and fetchCreditPacks may call fetch directly');
  for (const fn of [
    'fetchAdminUsers',
    'fetchAdminUser',
    'fetchAdminTransactions',
    'fetchAdminJobs',
    'adjustCredits',
    'debitCredits',
    'fetchProviderSafety',
    'resetProviderSafety',
    'fetchAdminAlerts',
  ]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf('export ', src.indexOf(`export async function ${fn}`) + 10));
    assert.match(body, /authFetch\(/, `${fn} must use authFetch`);
  }
});

test('manual credit additions go through the canonical adjustment endpoint', () => {
  assert.match(src, /export async function adjustCredits[\s\S]*?\/api\/admin\/credits\/adjust/);
  // The UI must not still use the legacy grant path for additions.
  assert.ok(!/grantCredits/.test(ui), 'AdminDashboard should use adjustCredits, not grantCredits');
  assert.match(ui, /adjustCredits\(\{/);
  assert.match(ui, /ADMIN_ADJUSTMENT/);
  // The before/after balance and the acting admin must be visible to the operator.
  assert.match(ui, /balanceBefore/);
  assert.match(ui, /adminEmail/);
  assert.match(ui, /t\.balanceBefore != null \? `\$\{t\.balanceBefore\} → \$\{t\.balanceAfter\}`/);
});

test('the dashboard shows provider safety, an explicit reset and honest balance copy', () => {
  assert.match(ui, /fetchProviderSafety/);
  assert.match(ui, /resetProviderSafety/);
  assert.match(ui, /Reset to AVAILABLE/);
  assert.match(ui, /never recharges automatically/i);
  assert.match(ui, /unknown — this provider exposes no verified balance\/quota API/);
  assert.match(ui, /not sent \(no channel connected\)/);
  // A blocked provider must not be presented as usable.
  assert.match(ui, /all ASR calls are blocked/);
});

test('owner sign-in sends the bootstrap token once and never persists it', () => {
  assert.match(src, /export async function signInAsOwner/);
  assert.match(src, /adminBootstrapToken: opts\.adminBootstrapToken\.trim\(\)/);
  assert.match(src, /ownerEmail: opts\.ownerEmail\.trim\(\)\.toLowerCase\(\)/);
  assert.ok(!/localStorage\.setItem\([^)]*adminBootstrapToken/i.test(src), 'bootstrap token must not be stored');
  assert.ok(!/sessionStorage/.test(src), 'bootstrap token must not be persisted at all');
  assert.match(widget, /signInAsOwner/);
  assert.match(widget, /setOwnerToken\(''\)/);
});

test('the UI never claims a working WhatsApp integration', () => {
  for (const file of [ui, widget, src, server]) {
    assert.doesNotMatch(file, /api\.whatsapp|graph\.facebook|wa\.me|twilio/i);
  }
});
