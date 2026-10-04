/**
 * Centralised, read-only server configuration.
 *
 * All knobs come from environment variables with safe defaults so the app runs
 * out-of-the-box without any .env changes. Nothing here is secret-safe to log;
 * only names/booleans should leave this module.
 */
import path from 'path';

export type ProviderName = 'sarvam' | 'olive' | 'groq' | 'azure';
export type DatabaseProvider = 'json' | 'turso';
export type StorageProviderType = 'local' | 'r2';

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
   * Optional operator-only bootstrap secret. When a session is created with
   * `adminBootstrapToken` matching this value, that user is granted the ADMIN
   * role + UNLIMITED credit mode (persisted server-side). Never returned to any
   * client; role is never read from the browser. Set it in .env, create your
   * admin session, then remove it.
   */
  get adminBootstrapToken(): string | null {
    const v = (process.env.ADMIN_BOOTSTRAP_TOKEN || '').trim();
    return v.length >= 16 ? v : null;
  },

  /**
   * HARD provider-spending protection kill-switch. When true, NO provider job
   * is ever started for ANY caller (including ADMIN/UNLIMITED). Purpose:
   * prevent uncontrolled spending from the operator's ASR account while the app
   * is not yet generating revenue. The user-facing copy is "Processing
   * temporarily unavailable. Please try again later."
   *
   * This MUST stay a getter: `server.ts` calls `dotenv.config()` in its module
   * body, which runs AFTER every static import has been evaluated. A static
   * field would capture the value before `.env` was ever read, so the
   * production setting in `.env` would be silently ignored. Reading it lazily
   * also means the switch can never be "forgotten" by a load-order change.
   */
  get providerSpendingProtection(): boolean {
    return envBool('PROVIDER_SPENDING_PROTECTION', false);
  },

  /**
   * Legacy cooldown window (ms) kept for backward compatibility of the env
   * surface. The provider safety state is now PERSISTED: a 402 blocks the
   * provider until an admin resets it, so no cooldown is required to keep the
   * gate closed.
   */
  providerQuotaCooldownMs: envInt('PROVIDER_QUOTA_COOLDOWN_MS', 10 * 60 * 1000),

  /**
   * How many consecutive transient provider failures move the locally stored
   * state from AVAILABLE to WARNING. WARNING still allows calls; only a reliable
   * 402 (exhausted quota) blocks the provider. Getter for the same load-order
   * reason as `providerSpendingProtection`.
   */
  get providerWarningAfterFailures(): number {
    return envInt('PROVIDER_WARNING_AFTER_FAILURES', 2);
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

  /** Database provider: 'json' (local file) or 'turso' (libSQL via Turso). */
  get databaseProvider(): DatabaseProvider {
    const raw = (process.env.DATABASE_PROVIDER || 'json').trim().toLowerCase();
    if (raw === 'turso') return 'turso';
    return 'json';
  },

  /** Turso database URL (e.g., libsql://my-db.turso.io). */
  get tursoDatabaseUrl(): string | null {
    const v = (process.env.TURSO_DATABASE_URL || '').trim();
    return v || null;
  },

  /** Turso authentication token. */
  get tursoAuthToken(): string | null {
    const v = (process.env.TURSO_AUTH_TOKEN || '').trim();
    return v || null;
  },

  /** Storage provider: 'local' (local filesystem) or 'r2' (Cloudflare R2). */
  get storageProvider(): StorageProviderType {
    const raw = (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
    if (raw === 'r2') return 'r2';
    return 'local';
  },

  /** Cloudflare R2 account ID. */
  get r2AccountId(): string | null {
    const v = (process.env.R2_ACCOUNT_ID || '').trim();
    return v || null;
  },

  /** Cloudflare R2 access key ID. */
  get r2AccessKeyId(): string | null {
    const v = (process.env.R2_ACCESS_KEY_ID || '').trim();
    return v || null;
  },

  /** Cloudflare R2 secret access key. */
  get r2SecretAccessKey(): string | null {
    const v = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
    return v || null;
  },

  /** Cloudflare R2 bucket name. */
  get r2Bucket(): string | null {
    const v = (process.env.R2_BUCKET || '').trim();
    return v || null;
  },

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

/**
 * Stage 6B — the ONLY database and storage providers a production process may
 * use.
 *
 * The local alternatives (`json` file, local filesystem) are not "safe defaults":
 * on a host with no persistent disk they lose the entire ledger on every restart
 * or redeploy. They remain the development default via the getters above, which
 * is why this is enforced by an explicit assertion rather than by changing them.
 */
export const PRODUCTION_DATABASE_PROVIDER: DatabaseProvider = 'turso';
export const PRODUCTION_STORAGE_PROVIDER: StorageProviderType = 'r2';

/** True only when NODE_ENV is exactly "production" (trimmed, case-insensitive). */
export function isProduction(): boolean {
  return (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Values of DATABASE_PROVIDER / STORAGE_PROVIDER are safe to quote back in an
 * error. Anything outside this shape is reported without echoing it, so an
 * operator cannot accidentally copy a secret into a log by setting one of these
 * variables to the wrong thing.
 */
const SAFE_PROVIDER_ECHO = /^[A-Za-z0-9_.:-]{1,32}$/;

function describeProviderValue(raw: string): string {
  return SAFE_PROVIDER_ECHO.test(raw) ? `"${raw}"` : 'an unrecognised value';
}

/**
 * Stage 6B — refuse to START a production process whose provider selection would
 * silently fall back to local, ephemeral storage.
 *
 * WHY THIS IS AN ASSERTION AND NOT A GETTER CHANGE
 * `config.databaseProvider` and `config.storageProvider` must keep defaulting to
 * `json`/`local` for development and for the existing test suite. So the getters
 * stay permissive and the production contract is enforced here, once, before any
 * provider is constructed. Every bad input is rejected, not just the defaults:
 *
 *   - missing variable, empty variable, a typo such as "tursoo", an unsupported
 *     value, or an explicit `json`/`local`.
 *
 * With `NODE_ENV` unset or set to anything else this is a no-op, so `npm run dev`
 * and the test suite are unaffected. `npm start` sets NODE_ENV=production and is
 * therefore covered.
 *
 * This check is about WHICH backend is selected, not whether its credentials are
 * present: the existing credential gates in server.ts still run afterwards and
 * still throw on missing Turso or R2 credentials. No secret is read or named here.
 */
export function assertProductionProviderSelection(): void {
  if (!isProduction()) return;

  const problems: string[] = [];
  const rawDatabase = (process.env.DATABASE_PROVIDER ?? '').trim();
  const rawStorage = (process.env.STORAGE_PROVIDER ?? '').trim();

  if (rawDatabase.length === 0) {
    problems.push(
      `DATABASE_PROVIDER is not set (production requires DATABASE_PROVIDER=${PRODUCTION_DATABASE_PROVIDER})`
    );
  } else if (rawDatabase.toLowerCase() !== PRODUCTION_DATABASE_PROVIDER) {
    problems.push(
      `DATABASE_PROVIDER=${describeProviderValue(rawDatabase)} is not permitted in production ` +
        `(set DATABASE_PROVIDER=${PRODUCTION_DATABASE_PROVIDER}; the local json store is not durable on this host)`
    );
  }

  if (rawStorage.length === 0) {
    problems.push(
      `STORAGE_PROVIDER is not set (production requires STORAGE_PROVIDER=${PRODUCTION_STORAGE_PROVIDER})`
    );
  } else if (rawStorage.toLowerCase() !== PRODUCTION_STORAGE_PROVIDER) {
    problems.push(
      `STORAGE_PROVIDER=${describeProviderValue(rawStorage)} is not permitted in production ` +
        `(set STORAGE_PROVIDER=${PRODUCTION_STORAGE_PROVIDER}; local filesystem storage is not durable on this host)`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      'Unsafe production provider configuration, refusing to start. ' +
        `${problems.join('. ')}. There is no silent fallback: a production process ` +
        'must name its production providers explicitly.'
    );
  }
}

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