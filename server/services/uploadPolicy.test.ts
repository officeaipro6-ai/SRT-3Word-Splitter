import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload, SlidingWindowLimiter, assertWithinActiveJobLimit, UploadError } from './uploadPolicy.ts';

test('valid MIME types pass; unknown types are rejected', () => {
  validateUpload({ mimeType: 'audio/mpeg', sizeBytes: 1000 });
  validateUpload({ mimeType: 'audio/wav', sizeBytes: 1000 });
  validateUpload({ mimeType: 'video/mp4; codecs="h264"', sizeBytes: 1000 }); // params stripped
  assert.throws(() => validateUpload({ mimeType: 'text/html', sizeBytes: 1000 }), (e: unknown) => e instanceof UploadError && e.code === 'BAD_MIME');
  assert.throws(() => validateUpload({ mimeType: '', sizeBytes: 1000 }), (e: unknown) => e instanceof UploadError && e.code === 'BAD_MIME');
});

test('files over the cap are rejected with 413', () => {
  assert.throws(
    () => validateUpload({ mimeType: 'audio/wav', sizeBytes: 200 }, 100),
    (e: unknown) => e instanceof UploadError && e.httpStatus === 413
  );
});

test('empty file uploads are rejected', () => {
  assert.throws(() => validateUpload({ mimeType: 'audio/wav', sizeBytes: 0 }), (e: unknown) => e instanceof UploadError && e.code === 'NO_FILE');
});

test('sliding window limiter allows up to max then blocks', () => {
  const limiter = new SlidingWindowLimiter(60_000, 3);
  assert.equal(limiter.isAllowed('k'), true);
  assert.equal(limiter.isAllowed('k'), true);
  assert.equal(limiter.isAllowed('k'), true);
  assert.equal(limiter.isAllowed('k'), false);
  // Different keys are independent.
  assert.equal(limiter.isAllowed('other'), true);
});

test('sliding window limiter expires old hits over time', () => {
  const limiter = new SlidingWindowLimiter(1_000, 1);
  assert.equal(limiter.isAllowed('k', 1000), true);
  assert.equal(limiter.isAllowed('k', 1000), false);
  assert.equal(limiter.isAllowed('k', 2001), true); // window elapsed
});

test('active job limit guard throws 429-style error', () => {
  process.env.PER_USER_ACTIVE_JOBS = '3';
  assert.throws(() => assertWithinActiveJobLimit(3), (e: unknown) => e instanceof UploadError && e.code === 'TOO_MANY_ACTIVE_JOBS');
  assert.doesNotThrow(() => assertWithinActiveJobLimit(2));
});