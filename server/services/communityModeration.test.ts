import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../db/store.ts';
import { ModerationRepo } from '../db/repos.ts';
import {
  CommunityModerationService,
  RESTRICTION_DURATION_MS,
  MAX_ADMIN_EXTENSION_MS,
  formatRemaining,
} from './communityModeration.ts';

/** Fresh isolated store per test; never touches the real data directory. */
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-test-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const repo = new ModerationRepo(store);
  return { store, repo, dir, service: new CommunityModerationService(repo) };
}

const ABUSE = 'you are a pathetic loser and I hate you';
const ADMIN = { adminUserId: 'admin-1', adminEmail: 'admin@example.com' };

test('A. a clean message is accepted with no record and no punishment', async () => {
  const { repo, service } = await setup();
  const r = service.reviewSubmission({ userId: 'u1', kind: 'SUPPORT', body: 'My SRT timings are off by 300ms.' });
  assert.equal(r.outcome, 'ACCEPTED');
  assert.equal(r.status, 201);
  assert.equal(r.accepted, true);
  assert.equal(repo.confirmedCaseCount('u1'), 0);
  assert.equal(repo.casesForUser('u1').length, 0);
  assert.equal(service.statusFor('u1').restricted, false);
});

test('B. the FIRST confirmed violation warns only, never restricts', async () => {
  const { repo, service } = await setup();
  const r = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  assert.equal(r.outcome, 'WARNING');
  assert.equal(r.status, 422);
  assert.equal(r.accepted, false);
  assert.match(r.message, /first warning/i);
  // Warning recorded in the audit trail, but no restriction applied.
  const cases = repo.casesForUser('u1');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].action, 'WARNING');
  assert.equal(cases[0].confidence, 'CONFIRMED');
  assert.equal(cases[0].automatic, true);
  assert.equal(service.statusFor('u1').restricted, false);
  // No restriction record written at all.
  assert.equal(repo.restrictionsForUser('u1').length, 0);
});

test('C. a REPEATED confirmed violation applies a server-side 2-hour restriction', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE }); // first -> warning
  const r2 = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE }); // repeat

  assert.equal(r2.outcome, 'RESTRICTED');
  assert.equal(r2.status, 403);
  assert.equal(r2.accepted, false);
  assert.equal(r2.restriction?.restricted, true);

  const restrictions = repo.restrictionsForUser('u1');
  assert.equal(restrictions.length, 1);
  const r = restrictions[0];
  assert.equal(r.violationCount, 2);
  assert.equal(r.automatic, true);
  assert.equal(r.extendedCount, 0);

  // Exactly 2 hours, computed server-side.
  const duration = new Date(r.expiresAt).getTime() - new Date(r.startedAt).getTime();
  assert.equal(duration, RESTRICTION_DURATION_MS);
  assert.equal(RESTRICTION_DURATION_MS, 2 * 60 * 60 * 1000);
});

test('D. while restricted, submissions are refused SERVER-SIDE before storing content', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });

  const before = repo.messagesForUser('u1').length;
  const blocked = service.reviewSubmission({
    userId: 'u1',
    kind: 'COMMUNITY',
    body: 'I am writing a perfectly friendly message',
  });
  assert.equal(blocked.outcome, 'BLOCKED');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.accepted, false);
  // Nothing was stored: the check happens before content handling.
  assert.equal(repo.messagesForUser('u1').length, before);
});

test('E. a client cannot bypass or forge the restriction (E. client bypass rejected)', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  assert.equal(service.statusFor('u1').restricted, true);

  // The submission input has no field to override status/times, and any
  // client-supplied extras are ignored entirely.
  const hostile = {
    userId: 'u1',
    kind: 'COMMUNITY',
    body: 'hello',
    restricted: false,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    restrictionMinutes: 0,
  } as unknown as Parameters<typeof service.reviewSubmission>[0];
  const bypass = service.reviewSubmission(hostile);
  assert.equal(bypass.outcome, 'BLOCKED');
  assert.equal(bypass.status, 403);
  assert.equal(repo.activeRestriction('u1') !== null, true);
});

test('F. an expired restriction automatically allows submissions again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-test-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  await store.init();
  const repo = new ModerationRepo(store);

  // Inject a clock so expiry is deterministic and does not need a 2h wait.
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const service = new CommunityModerationService(repo, { now: () => now });

  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  assert.equal(service.statusFor('u1').restricted, true);

  // Just before expiry: still restricted.
  now += RESTRICTION_DURATION_MS - 1000;
  assert.equal(service.statusFor('u1').restricted, true);
  const stillBlocked = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'hello' });
  assert.equal(stillBlocked.outcome, 'BLOCKED');

  // Past expiry: allowed again, with no admin action required.
  now += 2000;
  const after = service.statusFor('u1');
  assert.equal(after.restricted, false);
  assert.equal(after.remainingMs, 0);
  const ok = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'thanks, that worked' });
  assert.equal(ok.outcome, 'ACCEPTED');
});

test('G. ambiguous messages are flagged for ADMIN_REVIEW and never punish', async () => {
  const { repo, service } = await setup();
  const r = service.reviewSubmission({
    userId: 'u1',
    kind: 'COMMUNITY',
    body: 'someone called me an idiot and I reported him',
  });
  assert.equal(r.outcome, 'ADMIN_REVIEW');
  assert.equal(r.status, 202);
  assert.equal(r.accepted, false);
  assert.match(r.message, /review/i);
  // No punishment of any kind.
  assert.equal(service.statusFor('u1').restricted, false);
  assert.equal(repo.restrictionsForUser('u1').length, 0);
  const cases = repo.casesForUser('u1');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].action, 'ADMIN_REVIEW');
  assert.equal(cases[0].confidence, 'UNCERTAIN');
  // UNCERTAIN cases do not count toward the violation threshold.
  assert.equal(repo.confirmedCaseCount('u1'), 0);
  // Repeating an ambiguous message still never restricts.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(service.statusFor('u1').restricted, false);
    service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'someone called me an idiot' });
  }
  assert.equal(repo.restrictionsForUser('u1').length, 0);
  assert.equal(repo.confirmedCaseCount('u1'), 0);
});

test('H. an admin can extend and release a restriction, each audited', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  const base = repo.activeRestriction('u1')!;
  const baseExpiry = new Date(base.expiresAt).getTime();

  // Extend by 1 hour.
  const ext = service.extendRestriction({ userId: 'u1', additionalMs: 60 * 60 * 1000, ...ADMIN, note: 'repeat offence' });
  assert.equal(ext.ok, true);
  const extended = repo.activeRestriction('u1')!;
  assert.equal(new Date(extended.expiresAt).getTime() - baseExpiry, 60 * 60 * 1000);
  assert.equal(extended.extendedCount, 1);

  // Extension is server-bounded, so a huge/hostile value is clamped.
  const clamped = service.extendRestriction({ userId: 'u1', additionalMs: 999 * 24 * 60 * 60 * 1000, ...ADMIN });
  assert.equal(clamped.ok, true);
  const after = repo.activeRestriction('u1')!;
  assert.equal(after.extendedCount, 2);
  assert.ok(new Date(after.expiresAt).getTime() - baseExpiry <= 60 * 60 * 1000 + MAX_ADMIN_EXTENSION_MS);
  // Invalid input is rejected rather than trusted.
  assert.equal(service.extendRestriction({ userId: 'u1', additionalMs: -5, ...ADMIN }).ok, false);
  assert.equal(service.extendRestriction({ userId: 'u1', additionalMs: Number.NaN, ...ADMIN }).ok, false);

  // Admin actions are audited as manual, not automatic.
  const cases = repo.casesForUser('u1');
  const extendedCase = cases.find((c) => c.action === 'RESTRICTION_EXTENDED')!;
  assert.equal(extendedCase.automatic, false);
  assert.equal(extendedCase.adminUserId, 'admin-1');

  // Release: allowed again immediately.
  const rel = service.releaseRestriction({ userId: 'u1', ...ADMIN, note: 'first appeal' });
  assert.equal(rel.ok, true);
  assert.equal(service.statusFor('u1').restricted, false);
  const releasedCase = repo.casesForUser('u1').find((c) => c.action === 'RESTRICTION_RELEASED')!;
  assert.equal(releasedCase.automatic, false);
  // Post-release submission is accepted.
  const afterRelease = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'thanks for lifting it' });
  assert.equal(afterRelease.outcome, 'ACCEPTED');
});

test('H2. extending or releasing with no restriction fails safely', async () => {
  const { service } = await setup();
  assert.equal(service.extendRestriction({ userId: 'nobody', additionalMs: 1000, ...ADMIN }).ok, false);
  assert.equal(service.releaseRestriction({ userId: 'nobody', ...ADMIN }).ok, false);
});

test('I. an admin can mark a case reviewed, and an unknown case is handled', async () => {
  const { repo, service } = await setup();
  const flagged = service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'someone called me an idiot' });
  const caseId = flagged.case!.id;
  assert.equal(repo.getCase(caseId)!.reviewedAt, undefined);

  const reviewed = service.reviewCase({ caseId, ...ADMIN, note: 'legitimate complaint' });
  assert.equal(reviewed.ok, true);
  const after = repo.getCase(caseId)!;
  assert.ok(after.reviewedAt);
  assert.equal(after.reviewedBy, 'admin-1');
  assert.equal(after.adminNote, 'legitimate complaint');

  assert.equal(service.reviewCase({ caseId: 'does-not-exist', ...ADMIN }).ok, false);
});

test('J. a full audit trail is recorded for every decision', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'SUPPORT', body: 'clean question about tags' });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service.reviewSubmission({ userId: 'u2', kind: 'COMMUNITY', body: 'someone called me an idiot' });
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });

  const all = repo.listCases();
  assert.ok(all.length >= 3, `expected audit cases, got ${all.length}`);
  for (const c of all) {
    assert.ok(c.id, 'case must have an id');
    assert.ok(c.userId, 'case must have a userId');
    assert.ok(c.createdAt, 'case must be timestamped server-side');
    assert.ok(c.reason && c.reason.length > 0, 'case must explain itself');
  }
  // Excerpts are stored, but truncated, and only from confirmed/flagged messages.
  const warned = all.find((c) => c.action === 'WARNING')!;
  assert.ok(warned.excerpt && warned.excerpt.length > 0);
  assert.ok((warned.excerpt ?? '').length <= 301);

  // Admin-facing listing keeps user separation and is newest-first.
  assert.ok(repo.listCases()[0].createdAt >= repo.listCases()[1].createdAt);
  // Messages are retrievable per user for admin review.
  assert.ok(repo.messagesForUser('u1').length >= 2);
  assert.ok(repo.messagesForUser('u2').length >= 1);
});

test('J2. no IP, device, or credential data is stored on messages/cases', async () => {
  const { repo, service } = await setup();
  service.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  const serialized = JSON.stringify([...repo.listCases(), ...repo.listMessages()]);
  for (const forbidden of ['ip', 'ipAddress', 'userAgent', 'deviceId', 'password', 'token', 'bootstrap']) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `must not store ${forbidden}`);
  }
});

test('moderation state survives a store restart (DataStore.init wiring)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-test-'));
  const file = path.join(dir, 'app.db.json');

  const first = new DataStore(file);
  await first.init();
  const service1 = new CommunityModerationService(new ModerationRepo(first));
  service1.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  service1.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: ABUSE });
  assert.equal(service1.statusFor('u1').restricted, true);

  // Flush the queued write so the restart reads a fully persisted file.
  await first.mutateAsync(() => undefined);

  // Simulate a server restart: brand new store over the same file.
  const second = new DataStore(file);
  await second.init();
  const repo2 = new ModerationRepo(second);
  const service2 = new CommunityModerationService(repo2);

  // The restriction must still be enforced, not silently dropped.
  assert.equal(service2.statusFor('u1').restricted, true);
  assert.equal(service2.reviewSubmission({ userId: 'u1', kind: 'COMMUNITY', body: 'hi' }).outcome, 'BLOCKED');
  // Audit trail and messages are preserved for admin review.
  assert.equal(repo2.confirmedCaseCount('u1'), 2);
  assert.ok(repo2.listCases().length >= 2);
  assert.ok(repo2.messagesForUser('u1').length >= 2);
  // A fresh user is unaffected.
  assert.equal(service2.statusFor('someone-else').restricted, false);
});

test('formatRemaining is human friendly and never negative', async () => {
  assert.equal(formatRemaining(0), '0 minute(s)');
  assert.equal(formatRemaining(60_000), '1 minute(s)');
  assert.equal(formatRemaining(2 * 60 * 60 * 1000), '2h');
  assert.equal(formatRemaining(90 * 60 * 1000), '1h 30m');
  assert.equal(formatRemaining(-5000), '0 minute(s)');
});
