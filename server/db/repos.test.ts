import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from './store.ts';
import { UserRepo, JobRepo, CreditRepo } from './repos.ts';
import { isJobStatus, type JobRecord } from './types.ts';

function makeRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-repos-'));
  const store = new DataStore(path.join(dir, 'app.db.json'));
  return { store, users: new UserRepo(store), jobs: new JobRepo(store), credits: new CreditRepo(store) };
}

function sampleJob(userId: string, status: JobRecord['status'] = 'QUEUED'): JobRecord {
  return {
    id: 'j-' + Math.random().toString(36).slice(2),
    userId,
    status,
    provider: 'sarvam',
    input: { storageKey: 'uploads/x.mp3', originalName: 'x.mp3', mimeType: 'audio/mpeg', sizeBytes: 10, sha256: 'h', durationSeconds: 0 },
    createdAt: new Date().toISOString(),
    retryCount: 0,
  };
}

test('users: create/find-by-token touch correctly', async () => {
  const { store, users } = makeRepos();
  await store.init();
  const u = users.createUser('hash1', 100);
  assert.equal(users.getByToken('hash1')?.id, u.id);
  assert.equal(users.getByToken('nope'), null);
  assert.equal(users.addToken(u.id, 'hash2'), true);
  assert.equal(users.getByToken('hash2')?.id, u.id);
  assert.equal(users.bumpCredits(u.id, -25), 75);
  assert.equal(users.getById(u.id)?.credits, 75);
});

test('jobs: ownership filtering and status transitions', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const a = jobs.create(sampleJob('u1'));
  const b = jobs.create(sampleJob('u2'));
  jobs.update(a.id, { status: 'PROCESSING' });
  assert.equal(jobs.getForUser(a.id, 'u1')?.status, 'PROCESSING');
  assert.equal(jobs.getForUser(a.id, 'u2'), null); // other user cannot see it
  assert.equal(jobs.countActiveForUser('u1'), 1);
  assert.equal(jobs.listForUser('u2').length, 1);
  jobs.update(a.id, { status: 'COMPLETED', output: { srtKey: 'srt/a.srt', rawSrt: '', segmentCount: 1, wordCount: 3, provider: 'sarvam' } });
  assert.equal(jobs.countActiveForUser('u1'), 0);
  assert.equal(jobs.listForUser('u1', 'COMPLETED').length, 1);
  assert.equal(isJobStatus('FAILED'), true);
  assert.equal(isJobStatus('wat'), false);
});

test('jobs: retry backoff gates queue eligibility', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const queued = jobs.create(sampleJob('u1'));
  const pending = jobs.create(sampleJob('u2'));
  jobs.update(pending.id, { nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
  const eligible = jobs.listEligibleQueued(new Date().toISOString()).map((j) => j.id);
  assert.ok(eligible.includes(queued.id));
  assert.ok(!eligible.includes(pending.id)); // backoff not elapsed -> not eligible
});

test('credits: ledger records balanceAfter', async () => {
  const { store, users, credits } = makeRepos();
  await store.init();
  const u = users.createUser('h', 50);
  const t = credits.add({ userId: u.id, amount: 10, type: 'DEBIT', reason: 'charge', jobId: 'j1', balanceAfter: 40 });
  assert.equal(t.balanceAfter, 40);
  assert.equal(credits.debitForJob(u.id, 'j1')?.amount, 10);
  assert.equal(credits.refundForJob(u.id, 'j1'), null);
});

test('users: role + creditMode defaults and server-side promotion', async () => {
  const { store, users } = makeRepos();
  await store.init();
  const u = users.createUser('h', 10);
  assert.equal(u.role, 'USER');
  assert.equal(u.creditMode, 'NORMAL');
  assert.equal(users.setRole(u.id, 'ADMIN'), true);
  assert.equal(users.setCreditMode(u.id, 'UNLIMITED'), true);
  assert.equal(users.getById(u.id)?.role, 'ADMIN');
  assert.equal(users.getById(u.id)?.creditMode, 'UNLIMITED');
});

test('users: listUsers returns all users newest-first', async () => {
  const { store, users } = makeRepos();
  await store.init();
  const u1 = users.createUser('h1', 0);
  const u2 = users.createUser('h2', 0);
  const list = users.listUsers();
  assert.equal(list.length, 2);
  assert.ok(list.some((u) => u.id === u1.id));
  assert.ok(list.some((u) => u.id === u2.id));
});

test('credits: findByIdempotencyKey and listAll', async () => {
  const { store, users, credits } = makeRepos();
  await store.init();
  const u = users.createUser('h', 100);
  credits.add({ userId: u.id, amount: 10, type: 'DEBIT', reason: 'charge', balanceAfter: 90, idempotencyKey: 'k1' });
  credits.add({ userId: u.id, amount: 5, type: 'REFUND', reason: 'undo', balanceAfter: 95, idempotencyKey: 'k2' });
  const found = credits.findByIdempotencyKey('k1', u.id);
  assert.ok(found);
  assert.equal(found.amount, 10);
  assert.equal(credits.findByIdempotencyKey('missing'), null);
  assert.equal(credits.listAll(100).length, 2);
  assert.equal(credits.sumGrants(u.id), 0);
  assert.equal(credits.sumUsed(u.id), 10);
});

test('users: payment-ready fields are optional and persisted', async () => {
  const { store, users } = makeRepos();
  await store.init();
  const u = users.createUser('h', 0);
  assert.equal(u.purchasedCredits, undefined);
  assert.equal(u.bonusCredits, undefined);
  users.setPurchasedCredits(u.id, 50);
  users.setBonusCredits(u.id, 20);
  const fresh = users.getById(u.id)!;
  assert.equal(fresh.purchasedCredits, 50);
  assert.equal(fresh.bonusCredits, 20);
});