import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalFileStorageProvider } from './storage.ts';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'odia-storage-'));
}

test('storage roundtrip: put/get/exists/delete', async () => {
  const storage = new LocalFileStorageProvider(makeRoot());
  const key = 'uploads/u1.mp3';
  await storage.put(key, Buffer.from('hello-odia'));
  assert.equal(await storage.exists(key), true);
  assert.equal((await storage.get(key))?.toString('utf8'), 'hello-odia');
  await storage.delete(key);
  assert.equal(await storage.exists(key), false);
  assert.equal(await storage.get(key), null);
});

test('storage survives concurrent-ish writes without corruption', async () => {
  const storage = new LocalFileStorageProvider(makeRoot());
  const keys = Array.from({ length: 10 }, (_, i) => `srt/j${i}.srt`);
  await Promise.all(keys.map((k, i) => storage.put(k, Buffer.from(`data-${i}`))));
  for (let i = 0; i < keys.length; i++) {
    assert.equal((await storage.get(keys[i]))?.toString('utf8'), `data-${i}`);
  }
});

test('storage sanitizes traversal and rejects empty keys', async () => {
  const storage = new LocalFileStorageProvider(makeRoot());
  await assert.rejects(() => storage.put('..', Buffer.from('x')));
  await assert.rejects(() => storage.put('././.', Buffer.from('x')));
  // A hostile key is sanitized into the root (never escapes it).
  await storage.put('../uploads/evil.txt', Buffer.from('safe'));
  assert.equal(await storage.exists('../uploads/evil.txt'), true);
});