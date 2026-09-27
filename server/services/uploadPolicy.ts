/**
 * Upload validation + limits for public deployment safety.
 *
 * No dependencies (frameworks/rate-limit packages are NOT part of this repo).
 * The rate limiter is a coarse in-memory sliding window — fine as a transient
 * guard for an MVP, never authoritative (documented).
 */
import { ALLOWED_MIME_TYPES, config } from '../config';

export class UploadError extends Error {
  readonly code: 'BAD_MIME' | 'FILE_TOO_LARGE' | 'NO_FILE' | 'TOO_MANY_ACTIVE_JOBS' | 'RATE_LIMITED';
  readonly httpStatus: number;
  constructor(code: UploadError['code'], message: string, httpStatus = 400) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface UploadMetadata {
  mimeType: string;
  sizeBytes: number;
}

export function validateUpload(meta: UploadMetadata, maxBytes: number = config.maxUploadBytes): void {
  const mime = (meta.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
    throw new UploadError(
      'BAD_MIME',
      `Unsupported file type "${mime}". Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`
    );
  }
  if (meta.sizeBytes <= 0) {
    throw new UploadError('NO_FILE', 'Empty file upload.');
  }
  if (meta.sizeBytes > maxBytes) {
    throw new UploadError(
      'FILE_TOO_LARGE',
      `File is ${Math.round(meta.sizeBytes / 1024 / 1024)}MB; the limit is ${Math.round(maxBytes / 1024 / 1024)}MB.`,
      413
    );
  }
}

/** In-memory sliding-window rate limiter (transient guard, not authoritative). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  /** Returns true when allowed, false when the limit has been reached. */
  isAllowed(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export function assertWithinActiveJobLimit(activeCount: number): void {
  if (activeCount >= config.perUserActiveJobs) {
    throw new UploadError(
      'TOO_MANY_ACTIVE_JOBS',
      `You already have ${activeCount} active transcription job(s). Cancel or wait for completion before uploading more.`,
      429
    );
  }
}