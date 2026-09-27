/**
 * Durable domain records for users, credit ledger and transcription jobs.
 *
 * These are the persistent shapes backing the whole API. The store that
 * persists them is intentionally swappable (JSON file today -> SQL/cloud DB
 * later WITHOUT changing these types). No field here is secret: bearer-token
 * values are stored ONLY as sha256 hashes, and provider keys never appear.
 */

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Who may access the admin API. Only the server ever assigns ADMIN. */
export type UserRole = 'USER' | 'ADMIN';

/**
 * How credit charging behaves for a user account.
 *  - NORMAL: every job is charged `creditsPerJob` against the balance.
 *  - UNLIMITED: charges are bypassed server-side for the authorised ADMIN
 *    account (no DEBIT transaction, balance never drops to a fake sentinel
 *    value). Never assigned via a public/browser path.
 */
export type CreditMode = 'NORMAL' | 'UNLIMITED';

export type CreditTransactionType =
  | 'CREDIT'
  | 'DEBIT'
  | 'REFUND'
  | 'ADMIN_GRANT'
  | 'ADMIN_DEBIT';

export interface UserRecord {
  id: string;
  /** sha256 hashes of all bearer tokens ever issued to this user. */
  tokenHashes: string[];
  /** Denormalized current balance (authoritative value, server-maintained). */
  credits: number;
  role: UserRole;
  creditMode: CreditMode;
  createdAt: string;
  lastSeenAt?: string;
  /** PAYMENT-READY (future only; never populated by this implementation):
   * lifetime purchased credits and lifetime bonus credits. */
  purchasedCredits?: number;
  bonusCredits?: number;
  /**
   * Successful free audio-processing trials already consumed. Server-maintained
   * (incremented ONLY after a successful legacy pipeline run) so failed uploads
   * / API errors never consume a trial and a browser refresh cannot reset it.
   */
  freeTrialsUsed?: number;
}

export interface CreditTransactionRecord {
  id: string;
  userId: string;
  /** Positive magnitude; sign conveyed by `type`. */
  amount: number;
  type: CreditTransactionType;
  reason: string;
  jobId?: string;
  /** Admin user id that performed an ADMIN_GRANT / ADMIN_DEBIT. */
  adminUserId?: string;
  /**
   * Client/operator-supplied idempotency key. When present and already applied
   * for the same user+type, a duplicate admin credit operation is a safe no-op
   * that returns the existing transaction instead of double-applying.
   */
  idempotencyKey?: string;
  createdAt: string;
  /** Balance after applying this transaction — audit-friendly ledger. */
  balanceAfter: number;
  /** PAYMENT-READY (future only; never populated by this implementation):
   * are used for real-payment purchases later. */
  paymentId?: string;
  paymentStatus?: string;
  packageId?: string;
  expiresAt?: string;
}

export interface JobInputRef {
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Client-supplied duration hint; may be 0 when unknown. */
  durationSeconds: number;
}

export interface JobOutputRef {
  srtKey: string;
  rawSrt: string;
  segmentCount: number;
  wordCount: number;
  provider: string;
}

export interface JobRecord {
  id: string;
  userId: string;
  status: JobStatus;
  /** Active provider at enqueue time. */
  provider: string;
  input: JobInputRef;
  output?: JobOutputRef;
  /** DEBIT transaction id for this job (idempotency key). */
  creditTxnId?: string;
  creditsCharged?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  errorCode?: string;
  /** Auto-retries already consumed for this job. */
  retryCount: number;
  /** Not before-UTC timestamp for transient retry backoff. */
  nextRetryAt?: string;
}

export interface DbShape {
  version: number;
  users: UserRecord[];
  jobs: JobRecord[];
  transactions: CreditTransactionRecord[];
}

export const DB_VERSION = 1;

export function emptyDbShape(): DbShape {
  return { version: DB_VERSION, users: [], jobs: [], transactions: [] };
}

export function isJobStatus(v: string): v is JobStatus {
  return v === 'QUEUED' || v === 'PROCESSING' || v === 'COMPLETED' || v === 'FAILED' || v === 'CANCELLED';
}