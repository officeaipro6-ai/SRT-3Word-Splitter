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
  const a = await jobs.create(sampleJob('u1'));
  const b = await jobs.create(sampleJob('u2'));
  await jobs.update(a.id, { status: 'PROCESSING' });
  assert.equal((await jobs.getForUser(a.id, 'u1'))?.status, 'PROCESSING');
  assert.equal(await jobs.getForUser(a.id, 'u2'), null); // other user cannot see it
  assert.equal(await jobs.countActiveForUser('u1'), 1);
  assert.equal((await jobs.listForUser('u2')).length, 1);
  await jobs.update(a.id, { status: 'COMPLETED', output: { srtKey: 'srt/a.srt', rawSrt: '', segmentCount: 1, wordCount: 3, provider: 'sarvam' } });
  assert.equal(await jobs.countActiveForUser('u1'), 0);
  assert.equal((await jobs.listForUser('u1', 'COMPLETED')).length, 1);
  assert.equal(isJobStatus('FAILED'), true);
  assert.equal(isJobStatus('wat'), false);
});

test('jobs: retry backoff gates queue eligibility', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const queued = await jobs.create(sampleJob('u1'));
  const pending = await jobs.create(sampleJob('u2'));
  await jobs.update(pending.id, { nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
  const eligible = (await jobs.listEligibleQueued(new Date().toISOString())).map((j) => j.id);
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

// ---------------------------------------------------------------------------
// Stage 5C-5 Part A: JobRepo.update() must not let a patch rewrite the job
// primary key. Previously `Object.assign(job, patch)` copied patch.id straight
// over the row id, which produced two records sharing one id on disk. Parity
// target: TursoStore.updateJob() (Stage 5C-4) already refuses this.
// ---------------------------------------------------------------------------

/** Two jobs with distinct, assertable field values. */
async function seedJobs(jobs: JobRepo) {
  const a = await jobs.create(sampleJob('u1'));
  const b = await jobs.create(sampleJob('u2'));
  return { a, b };
}

test('5C5-A1. a normal job update still works end to end', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a, b } = await seedJobs(jobs);

  const updated = await jobs.update(a.id, { status: 'PROCESSING', startedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(updated!.id, a.id);
  assert.equal(updated!.status, 'PROCESSING');
  assert.equal(updated!.startedAt, '2026-01-02T00:00:00.000Z');
  assert.equal((await jobs.get(a.id))!.status, 'PROCESSING', 'the write is readable back');
  assert.equal((await jobs.get(b.id))!.status, 'QUEUED', 'the other job is untouched');
});

test('5C5-A2. patch.id cannot rewrite the job primary key', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a, b } = await seedJobs(jobs);

  // The patch names b while the argument names a.
  const updated = await jobs.update(a.id, { id: b.id, status: 'FAILED' } as Partial<JobRecord>);

  assert.equal(updated!.id, a.id, 'the ARGUMENT id is authoritative');
  assert.equal(updated!.status, 'FAILED', 'the other fields still merge');
  assert.equal((await jobs.get(a.id))!.id, a.id, 'a keeps its own id');
  assert.equal((await jobs.get(b.id))!.id, b.id, 'b keeps its own id');
  assert.equal((await jobs.get(b.id))!.status, 'QUEUED', 'b is not redirected-to or modified');
  assert.equal((await jobs.listAll()).length, 2, 'no record is created or lost');
});

test('5C5-A3. an id-only patch is a no-op', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a } = await seedJobs(jobs);
  const before = (await jobs.get(a.id))!;

  const updated = await jobs.update(a.id, { id: 'someone-else' } as Partial<JobRecord>);

  assert.equal(updated!.id, a.id);
  assert.deepEqual(await jobs.get(a.id), before, 'nothing about the job changed');
});

test('5C5-A4. unrelated fields remain unchanged', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a } = await seedJobs(jobs);
  const before = (await jobs.get(a.id))!;

  await jobs.update(a.id, { status: 'COMPLETED', completedAt: '2026-01-03T00:00:00.000Z' });

  const after = (await jobs.get(a.id))!;
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.completedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(after.userId, before.userId, 'userId untouched');
  assert.equal(after.provider, before.provider, 'provider untouched');
  assert.deepEqual(after.input, before.input, 'input untouched');
  assert.equal(after.retryCount, before.retryCount, 'retryCount untouched');
  assert.equal(after.createdAt, before.createdAt, 'createdAt untouched');
  assert.equal(after.output, before.output, 'output untouched');
});

test('5C5-A5. an unknown job id changes nothing', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a } = await seedJobs(jobs);
  const before = await jobs.listAll();

  const updated = await jobs.update('no-such-job', { status: 'COMPLETED' });

  assert.equal(updated, null, 'unknown id returns null, as before');
  assert.deepEqual(await jobs.listAll(), before, 'no record was added or modified');
  assert.equal((await jobs.get(a.id))!.status, 'QUEUED');
});

test('5C5-A6. input/output and other JSON-ish fields still merge unchanged', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a } = await seedJobs(jobs);
  const output = { srtKey: 'srt/a.srt', rawSrt: '1\nx\n', segmentCount: 1, wordCount: 1, provider: 'sarvam' };
  const input = { storageKey: 'uploads/y.mp3', originalName: 'y.mp3', mimeType: 'audio/mpeg', sizeBytes: 20, sha256: 'h2', durationSeconds: 3 };

  const updated = await jobs.update(a.id, { output, input, retryCount: 2, nextRetryAt: undefined, lastError: 'boom' } as Partial<JobRecord>);

  assert.deepEqual(updated!.output, output, 'output merges verbatim');
  assert.deepEqual(updated!.input, input, 'input merges verbatim');
  assert.equal(updated!.retryCount, 2);
  assert.equal(updated!.nextRetryAt, undefined, 'explicit undefined still clears the field');
  assert.equal(updated!.lastError, 'boom');
  assert.equal((await jobs.get(a.id))!.retryCount, 2, 'persisted');
});

test('5C5-A7. the returned record is a defensive clone, not the live row', async () => {
  const { store, jobs } = makeRepos();
  await store.init();
  const { a } = await seedJobs(jobs);

  const first = (await jobs.update(a.id, { status: 'PROCESSING' }))!;
  first.status = 'FAILED';
  first.retryCount = 999;

  const fresh = (await jobs.get(a.id))!;
  assert.equal(fresh.status, 'PROCESSING', 'mutating the clone must not affect storage');
  assert.equal(fresh.retryCount, 0);
});