/**
 * Boot-recovery regression tests for server/services/queue.ts.
 *
 * Production crashed on Render with
 *   TypeError: Cannot read properties of undefined (reading 'filter')
 *   at JobRepo.listProcessing()
 * thrown out of JobQueue.rehydrate() during boot, because JobRepo read the
 * async libSQL provider synchronously. rehydrate() has no prior test coverage,
 * so the boot path this app depends on was entirely unverified.
 *
 * These run against the real in-memory libSQL engine (file::memory:) via
 * TursoStore + the real JobRepo, so they exercise the same async dispatch the
 * Turso deployment uses. They never touch the network, real credentials,
 * data/app.db.json or data/storage/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';

import { JobRepo } from '../db/repos';
import { TursoStore } from '../db/tursoStore';
import { JobQueue, type JobQueueDeps } from './queue';
import type { AsyncCreditService } from './creditFacade';
import type { StorageProvider } from './storage';
import type { TranscriptionProvider } from '../providers/types';

function job(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    userId: 'u1',
    status,
    provider: 'sarvam',
    input: {
      storageKey: `uploads/${id}.mp3`,
      originalName: `${id}.mp3`,
      mimeType: 'audio/mpeg',
      sizeBytes: 1,
      sha256: 'x',
      durationSeconds: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    retryCount: 0,
    ...extra,
  } as any;
}

/** Records every refund so the money-movement ORDER can be asserted. */
function recordingCredits() {
  const refunds: Array<{ userId: string; jobId: string; reason: string }> = [];
  const credits = {
    async refundFinishedJob(userId: string, jobId: string, reason: string) {
      refunds.push({ userId, jobId, reason });
      return { transaction: null, charged: true };
    },
    async isUnlimited() {
      return false;
    },
    async getBalance() {
      return 0;
    },
    async getTransactions() {
      return [];
    },
    async getAllTransactions() {
      return [];
    },
    async getAllTransactionsUnbounded() {
      return [];
    },
    async sumGrants() {
      return 0;
    },
    async sumUsed() {
      return 0;
    },
    async assertCanPay() {},
    async chargeJob() {
      throw new Error('not used by rehydrate');
    },
    async reserveJob() {
      throw new Error('not used by rehydrate');
    },
    async settleJobReservation() {
      return null;
    },
    async releaseJobReservation() {
      return null;
    },
    async recordPurchase() {
      throw new Error('not used by rehydrate');
    },
    async adminAdjustCredits() {
      throw new Error('not used by rehydrate');
    },
    async adminGrantCredits() {
      throw new Error('not used by rehydrate');
    },
    async adminDebitCredits() {
      throw new Error('not used by rehydrate');
    },
    async registerUserWithCredits() {
      throw new Error('not used by rehydrate');
    },
    async incrementFreeTrialsUsed() {
      return null;
    },
  } as unknown as AsyncCreditService;
  return { credits, refunds };
}

async function openQueue(): Promise<{
  queue: JobQueue;
  repo: JobRepo;
  store: TursoStore;
  refunds: Array<{ userId: string; jobId: string; reason: string }>;
}> {
  const client = createClient({ url: 'file::memory:' });
  const store = new TursoStore(client);
  await store.init();
  await store.createUser({
    id: 'u1',
    email: 'u1@example.test',
    role: 'USER',
    credits: 0,
    tokenHashes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  } as any);

  const repo = new JobRepo(store as unknown as import('../db/store').DataStore);
  const { credits, refunds } = recordingCredits();
  const deps: JobQueueDeps = {
    repo,
    credits,
    storage: {} as StorageProvider,
    getProvider: (() => {
      throw new Error('not used by rehydrate');
    }) as unknown as (name: string) => TranscriptionProvider,
    runPipeline: async () => {
      throw new Error('not used by rehydrate');
    },
    providerSafety: {} as JobQueueDeps['providerSafety'],
  };
  return { queue: new JobQueue(deps), repo, store, refunds };
}

test('6B-Q1. rehydrate() resolves on an empty libSQL jobs table (the exact boot crash)', async () => {
  // This is the production crash: an empty jobs table made the sync snapshot
  // read return undefined, and `.filter` on it killed the boot. It must now
  // resolve to a no-op rather than reject.
  const { queue, refunds } = await openQueue();
  await queue.rehydrate();
  assert.deepEqual(refunds, [], 'nothing to refund on a clean boot');
});

test('6B-Q2. rehydrate() refunds each interrupted job, then marks it FAILED', async () => {
  const { queue, repo, refunds } = await openQueue();
  await repo.create(job('j-p1', 'PROCESSING', { startedAt: '2026-01-02T00:00:00.000Z' }));
  await repo.create(job('j-p2', 'PROCESSING'));

  await queue.rehydrate();

  assert.deepEqual(refunds.map((r) => r.jobId).sort(), ['j-p1', 'j-p2']);
  for (const id of ['j-p1', 'j-p2']) {
    const rehydrated = (await repo.get(id))!;
    assert.equal(rehydrated.status, 'FAILED');
    assert.equal(rehydrated.errorCode, 'INTERRUPTED');
    assert.ok(rehydrated.completedAt, 'the failure is timestamped');
  }
  assert.deepEqual(await repo.listProcessing(), [], 'no job is left stuck in PROCESSING');
});

test('6B-Q3. rehydrate() leaves QUEUED/COMPLETED/FAILED jobs untouched', async () => {
  const { queue, repo, refunds } = await openQueue();
  await repo.create(job('j-q', 'QUEUED'));
  await repo.create(job('j-d', 'COMPLETED', { completedAt: '2026-01-03T00:00:00.000Z' }));
  await repo.create(job('j-f', 'FAILED', { completedAt: '2026-01-03T00:00:00.000Z' }));

  await queue.rehydrate();

  assert.deepEqual(refunds, [], 'only PROCESSING jobs are refunded');
  assert.equal((await repo.get('j-q'))!.status, 'QUEUED', 'a queued job stays queued for the worker');
  assert.equal((await repo.get('j-d'))!.status, 'COMPLETED');
  assert.equal((await repo.get('j-f'))!.status, 'FAILED');
  assert.deepEqual((await repo.listQueued()).map((j) => j.id), ['j-q']);
});

test('6B-Q4. rehydrate() is idempotent across restarts (a job is never refunded twice)', async () => {
  const { queue, repo, refunds } = await openQueue();
  await repo.create(job('j-p', 'PROCESSING'));

  await queue.rehydrate();
  const firstRefundCount = refunds.length;
  // A second boot must not pay the user again for the same interrupted job.
  await queue.rehydrate();

  assert.equal(refunds.length, firstRefundCount, 'no second refund');
  assert.equal((await repo.get('j-p'))!.status, 'FAILED');
});