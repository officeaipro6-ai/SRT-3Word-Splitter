import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DataStore } from './store.ts';

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odia-db-'));
  return path.join(dir, 'app.db.json');
}

test('store mutates and persists atomically', async () => {
  const store = new DataStore(tmpDbFile());
  await store.init();
  store.mutate((db) => db.users.push({ id: 'u1', tokenHashes: ['a'], credits: 5, role: 'USER', creditMode: 'NORMAL', createdAt: 't' }));
  await store.mutateAsync((db) => {
    db.jobs.push({ id: 'j1', userId: 'u1', status: 'QUEUED', provider: 'sarvam', input: { storageKey: 'k', originalName: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 1, sha256: 'x', durationSeconds: 0 }, createdAt: 't', retryCount: 0 });
  });
  const reloaded = new DataStore((store as any).filePath);
  await reloaded.init();
  assert.equal(reloaded.snapshot().users.length, 1);
  assert.equal(reloaded.snapshot().jobs.length, 1);
  assert.equal(reloaded.snapshot().jobs[0].status, 'QUEUED');
});

test('store survives a corrupt file by starting fresh and backing up', async () => {
  const file = tmpDbFile();
  fs.writeFileSync(file, '{ not valid json');
  const store = new DataStore(file);
  await store.init();
  assert.equal(store.snapshot().users.length, 0);
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
  assert.ok(backups.length >= 1);
});

test('mutations are strictly ordered (last write wins on disk)', async () => {
  const store = new DataStore(tmpDbFile());
  await store.init();
  store.mutate((db) => { db.users.push({ id: 'x', tokenHashes: [], credits: 1, role: 'USER', creditMode: 'NORMAL', createdAt: '1' }); });
  store.mutate((db) => { db.users[0].credits = 42; });
  await store.mutateAsync(() => undefined);
  assert.equal(store.snapshot().users[0].credits, 42);
  const reloaded = new DataStore((store as any).filePath);
  await reloaded.init();
  assert.equal(reloaded.snapshot().users[0].credits, 42);
});

test('store migrates legacy user records to USER/NORMAL by default', async () => {
  const file = tmpDbFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      users: [{ id: 'legacy', tokenHashes: ['h'], credits: 3, createdAt: 't' }],
      jobs: [],
      transactions: [],
    })
  );
  const store = new DataStore(file);
  await store.init();
  const user = store.snapshot().users[0];
  assert.equal(user.role, 'USER');
  assert.equal(user.creditMode, 'NORMAL');
  assert.equal(user.credits, 3);
});