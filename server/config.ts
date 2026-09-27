/**
 * Centralised, read-only server configuration.
 *
 * All knobs come from environment variables with safe defaults so the app runs
 * out-of-the-box without any .env changes. Nothing here is secret-safe to log;
 * only names/booleans should leave this module.
 */
import path from 'path';

export type ProviderName = 'sarvam' | 'olive' | 'groq' | 'azure';

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

function envInt(name: string, def: number, min = 0): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : def;
}

export const config = {
  /**
   * Canonical ASR provider selector. `ASR_PROVIDER` is the new name;
   * `TRANSCRIPTION_PROVIDER` remains a backward-compatible fallback. Default:
   * sarvam (the ACTIVE provider, unchanged).
   */
  get asrProvider(): ProviderName {
    const raw = (process.env.ASR_PROVIDER || process.env.TRANSCRIPTION_PROVIDER || 'sarvam')
      .trim()
      .toLowerCase();
    if (raw === 'olive') return 'olive';
    if (raw === 'groq') return 'groq';
    if (raw === 'azure') return 'azure';
    return 'sarvam';
  },

  /** Root for all durable local state (DB file + uploaded audio + SRTs). */
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), 'data'),

  /** DB file inside DATA_DIR. */
  get dbFile(): string {
    return path.join(config.dataDir, 'app.db.json');
  },

  /** Storage root for uploaded audio + generated SRT files. */
  get storageDir(): string {
    return path.join(config.dataDir, 'storage');
  },

  /** Credits given to each newly created user (monetization prep; 0 = free trial off). */
  initialCredits: envInt('INITIAL_CREDITS', 0),

  /**
   * Number of successful free audio-processing trials a NORMAL user gets before
   * the legacy /api/process-audio pipeline is blocked (0 disables the cap).
   * Counted server-side, only for successfully-processed audios; never for
   * failed uploads/API errors. UNLIMITED (operator/ADMIN) accounts are exempt.
   */
  freeTrialLimit: envInt('FREE_TRIAL_LIMIT', 2),

  /**
   * OPTIONAL operator-only bootstrap secret. When a session is created with
   * `adminBootstrapToken` matching this value, that user is granted the ADMIN
   * role + UNLIMITED credit mode (persisted server-side). Never returned to any
   * client; role is never read from the browser. Set it in .env, create your
   * admin session, then remove it.
   */
  get adminBootstrapToken(): string | null {
    const v = (process.env.ADMIN_BOOTSTRAP_TOKEN || '').trim();
    return v.length >= 16 ? v : null;
  },

  /** Credits charged per transcription job (server-side, never client-supplied). */
  creditsPerJob: envInt('CREDITS_PER_JOB', 1),

  /** Hard cap on a single uploaded file. */
  maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 100 * 1024 * 1024),

  /** Per-user simultaneous QUEUED+PROCESSING job cap. */
  perUserActiveJobs: envInt('PER_USER_ACTIVE_JOBS', 3),

  /** Max wall-clock a job may take before it is marked FAILED (transient). */
  jobTimeoutMs: envInt('JOB_TIMEOUT_MS', 15 * 60 * 1000),

  /** Automatic retries only for transient failures (503/network). */
  maxJobRetries: envInt('MAX_JOB_RETRIES', 1),

  /** Backoff base for transient retries (ms). */
  retryBackoffBaseMs: envInt('RETRY_BACKOFF_BASE_MS', 5000),

  /** Enable the local durable job queue + worker. */
  enableJobQueue: envBool('ENABLE_JOB_QUEUE', true),

  /** Upload request rate limit (per identity, naive in-memory, not authoritative). */
  uploadRateLimitMax: envInt('UPLOAD_RATE_LIMIT_MAX', 10),
  uploadRateLimitWindowMs: envInt('UPLOAD_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),

  /** Whether the optional Azure Speech credentials are even present. */
  get azureConfigured(): boolean {
    const key = (process.env.AZURE_SPEECH_KEY || '').trim();
    const region = (process.env.AZURE_SPEECH_REGION || '').trim();
    return Boolean(key && region);
  },
};

/** MIME allowlist for audio/video uploads (validated server-side). */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/mpg',
  'audio/ogg',
  'audio/oga',
  'audio/flac',
  'audio/webm',
  'audio/m4a',
  'audio/mp4',
  'audio/aac',
  'audio/aiff',
  'audio/x-m4a',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
]);

/** Map a MIME type to the extension the ASR providers expect. */
export function extForMimeType(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('m4a')) return 'm4a';
  if (m.includes('aac')) return 'aac';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('wav')) return 'wav';
  return 'wav';
}