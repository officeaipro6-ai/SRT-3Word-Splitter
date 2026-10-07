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
  '/api/admin/moderation',
  '/api/admin/moderation/cases/',
  '/api/admin/moderation/restrictions/extend',
  '/api/admin/moderation/restrictions/release',
];

test('the admin client calls exactly the documented admin endpoints', () => {
  for (const route of ADMIN_ROUTES) {
    assert.ok(src.includes(route), `sessionClient must call ${route}`);
    assert.ok(server.includes(route), `server must expose ${route}`);
  }
});

test('every admin client call is authenticated (authFetch, never bare fetch)', () => {
  // The only bare fetch() calls in the client are the public ones: the session
  // bootstrap, owner sign-in, the public credit-pack catalog, the public
  // email/password account signup + login + verification-link resend, and the
  // public community guidelines (static text/categories, no user data). Admin,
  // community submission, status and logout calls all go through authFetch.
  const bareFetches = src.match(/await fetch\(/g) || [];
  assert.equal(bareFetches.length, 7, 'only ensureSession, signInAsOwner, fetchCreditPacks, signupAccount, loginAccount, resendVerificationEmail and fetchCommunityGuidelines may call fetch directly');
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
    'fetchCommunityStatus',
    'fetchAdminModeration',
    'markModerationCaseReviewed',
    'extendRestriction',
    'releaseRestriction',
  ]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf('export ', src.indexOf(`export async function ${fn}`) + 10));
    assert.match(body, /authFetch\(/, `${fn} must use authFetch`);
  }
  // The three public submission wrappers share one authenticated transport, so
  // they must delegate to it rather than reaching for fetch() themselves.
  for (const fn of ['sendCommunityMessage', 'sendSupportRequest', 'reportProblem']) {
    const body = src.slice(src.indexOf(`export function ${fn}`), src.indexOf('export ', src.indexOf(`export function ${fn}`) + 10));
    assert.match(body, /submitCommunity\(/, `${fn} must submit through the authenticated helper`);
    assert.doesNotMatch(body, /await fetch\(/, `${fn} must never call fetch directly`);
  }
  const submitBody = src.slice(
    src.indexOf('async function submitCommunity'),
    src.indexOf('export function sendCommunityMessage')
  );
  assert.match(submitBody, /authFetch\(/, 'submitCommunity must use authFetch');
});

test('community submissions send only the message — never a verdict or penalty', () => {
  const submitBody = src.slice(
    src.indexOf('async function submitCommunity'),
    src.indexOf('export function sendCommunityMessage')
  );
  assert.ok(submitBody.length > 0, 'submitCommunity must exist');
  // Exactly what crosses the wire.
  assert.match(submitBody, /form\.append\('body', opts\.body\)/);
  assert.match(submitBody, /form\.append\('category', opts\.category\)/);
  assert.match(submitBody, /form\.append\('attachment', opts\.attachment\)/);
  // Nothing that would let a client influence its own moderation outcome.
  for (const forbidden of [
    'RESTRICTION_DURATION',
    'expiresAt',
    'expiresIn',
    'durationMs',
    'verdict',
    'violation',
    'penalty',
    'banned',
    'confidence',
  ]) {
    assert.ok(
      !submitBody.includes(forbidden),
      `the client must never send or compute ${forbidden}`
    );
  }
  // It only reads the server's decision back out.
  assert.match(submitBody, /data\.outcome/);
  assert.match(submitBody, /data\.restriction/);
});

test('the community UI states the required rules and never claims Telegram banning', () => {
  const communityUi = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/CommunitySupport.tsx'),
    'utf8'
  );
  // JSX wraps long copy across lines; whitespace is collapsed when rendering,
  // so assert against the collapsed form the user actually sees.
  const flat = communityUi.replace(/\s+/g, ' ');
  assert.match(communityUi, /💬 Community &amp; Support/);
  assert.match(communityUi, /🚫/);
  assert.match(flat, /No abusive language/);
  assert.match(flat, /Please communicate respectfully\./);
  assert.match(flat, /Abusive, vulgar, threatening, harassing, or insulting language is not allowed\./);
  assert.match(flat, /Violations may result in a temporary restriction\./);
  assert.match(
    flat,
    /Please communicate respectfully\. Abusive, threatening, vulgar, or insulting language may result in a temporary restriction\./
  );
  // The server supplies the guidelines; the UI must not soften them locally.
  assert.match(communityUi, /fetchCommunityGuidelines/);
  // No invented Telegram integration in the client either.
  assert.doesNotMatch(communityUi, /api\.telegram\.org|botToken/i);
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
