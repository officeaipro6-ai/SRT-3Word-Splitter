import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../db/store.ts';
import { UserRepo } from '../db/repos.ts';
import {
  freeTrialBlockMessage,
  freeTrialsRemaining,
  freeTrialsUsedFor,
  isFreeTrialExempt,
  isFreeTrialExhausted,
} from './freeTrialPolicy.ts';

test('freeTrialPolicy: block message matches the required UX copy', () => {
  assert.equal(
    freeTrialBlockMessage(2),
    'You have used your 2 free audio trials. Please choose a plan to continue.'
  );
  assert.match(freeTrialBlockMessage(5), /5 free audio trials/);
});

test('freeTrialPolicy: exhaustion decision counts only from actual usage', () => {
  assert.equal(isFreeTrialExhausted(0, 2), false); // audio #1 allowed
  assert.equal(isFreeTrialExhausted(1, 2), false); // audio #2 allowed
  assert.equal(isFreeTrialExhausted(2, 2), true); // audio #3 blocked
  assert.equal(isFreeTrialExhausted(3, 2), true);
  assert.equal(isFreeTrialExhausted(2, 0), false); // cap disabled
});

test('freeTrialPolicy: used/remaining derive from the persisted counter', () => {
  assert.equal(freeTrialsUsedFor(null), 0);
  assert.equal(freeTrialsUsedFor({ creditMode: 'UNLIMITED', freeTrialsUsed: 9 }), 0);
  assert.equal(freeTrialsUsedFor({ creditMode: 'NORMAL' }), 0);
  assert.equal(freeTrialsUsedFor({ creditMode: 'NORMAL', freeTrialsUsed: 1 }), 1);
  assert.equal(freeTrialsRemaining(1, 2), 1);
  assert.equal(freeTrialsRemaining(2, 2), 0);
  assert.equal(freeTrialsRemaining(1, 0), -1);
});

test('freeTrialPolicy: UNLIMITED (operator) accounts are exempt, NORMAL are not', () => {
  assert.equal(isFreeTrialExempt(null), true);
  assert.equal(isFreeTrialExempt({ creditMode: 'UNLIMITED' }), true);
  assert.equal(isFreeTrialExempt({ creditMode: 'NORMAL' }), false);
});

test('freeTrialsUsed increments persist through the file-backed store (refresh-safe)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-free-trial-'));
  const file = path.join(dir, 'app.db.json');
  const store1 = new DataStore(file);
  await store1.init();
  const users = new UserRepo(store1);
  const u = users.createUser('hash-token', 0);

  assert.equal(users.getById(u.id)?.freeTrialsUsed, 0);
  assert.equal(users.incrementFreeTrialsUsed(u.id), 1);
  assert.equal(users.incrementFreeTrialsUsed(u.id), 2);
  assert.equal(users.incrementFreeTrialsUsed('missing-user'), null);

  // Flush the async file-backed persist queue before reloading.
  await store1.mutateAsync(() => undefined);

  // A fresh store (simulating a server restart / new connection = page refresh)
  // reloads the SAME user with the SAME counter.
  const store2 = new DataStore(file);
  await store2.init();
  const users2 = new UserRepo(store2);
  assert.equal(users2.getByToken('hash-token')?.freeTrialsUsed, 2);
  assert.equal(users2.getById(u.id)?.freeTrialsUsed, 2);
});

test('freeTrialsUsed back-compat: legacy user rows without the field normalize to 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-free-trial-migrate-'));
  const file = path.join(dir, 'app.db.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      users: [
        { id: 'u1', tokenHashes: ['h1'], credits: 0, role: 'USER', creditMode: 'NORMAL', createdAt: new Date().toISOString() },
      ],
      jobs: [],
      transactions: [],
    })
  );
  const store = new DataStore(file);
  await store.init();
  const users = new UserRepo(store);
  assert.equal(users.getById('u1')?.freeTrialsUsed, 0);
});