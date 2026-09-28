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
 * Provider safety state.
 *  - AVAILABLE: the provider may be called.
 *  - WARNING   : recent provider failures were observed; calls are still allowed.
 *  - BLOCKED   : the provider reported an exhausted balance/quota (HTTP 402) or
 *                the operator kill-switch is on. NO ASR call may be made and no
 *                automatic recharge/retry/fallback is ever attempted. Cleared
 *                only by an explicit admin reset.
 */
export type ProviderSafetyStatus = 'AVAILABLE' | 'WARNING' | 'BLOCKED';

/** Why the provider is currently gated (auditable, operator-visible). */
export type ProviderBlockReason = 'KILL_SWITCH' | 'QUOTA_EXHAUSTED' | null;

/** Provider balance information — only ever populated from a REAL source. */
export interface ProviderBalanceInfo {
  /**
   * Remaining balance/quota as a percentage, ONLY when a verified provider
   * balance/quota API exists. `known: false` means "unknown": we display no
   * number rather than inventing one (see notifications.PROVIDER_BALANCE_THRESHOLDS).
   */
  known: boolean;
  percent?: number;
  unit?: string;
  source?: string;
  updatedAt?: string;
}

export interface ProviderSafetyRecord {
  provider: string;
  status: ProviderSafetyStatus;
  reason: ProviderBlockReason;
  /** Redacted last provider error text (never a secret, truncated). */
  lastError?: string;
  lastHttpStatus?: number;
  lastErrorAt?: string;
  /** ISO timestamp of the last AVAILABLE -> BLOCKED transition. */
  blockedAt?: string;
  /** ISO timestamp of the last state change. */
  updatedAt: string;
  /** Consecutive observed provider failures (drives AVAILABLE <-> WARNING). */
  consecutiveFailures: number;
  lastSuccessAt?: string;
  /** ISO timestamp of the last admin reset to AVAILABLE. */
  lastResetAt?: string;
  lastResetBy?: string;
  balance: ProviderBalanceInfo;
}

/**
 * How credit charging behaves for a user account.
 *  - NORMAL: every job is charged `creditsPerJob` against the balance.
 *  - UNLIMITED: charges are bypassed server-side for the authorised ADMIN
 *    account (no DEBIT transaction, balance never drops to a fake sentinel
 *    value). Never assigned via a public/browser path.
 */
export type CreditMode = 'NORMAL' | 'UNLIMITED';

// ---------------------------------------------------------------------------
// Community & Support moderation (server-side enforcement only)
//
// Privacy: these records deliberately store a user id, a category, a decision
// and a short truncated excerpt. They never store IP addresses, device data or
// any credential, and a user's private details are only ever exposed through
// the already-protected admin surface.
// ---------------------------------------------------------------------------

/** Violation families the community rules cover. */
export type ViolationCategory = 'ABUSIVE' | 'VULGAR' | 'INSULT' | 'HARASSMENT' | 'THREAT' | 'HATEFUL';

/** What the server decided to do. Always server-decided, never client-supplied. */
export type ModerationAction = 'WARNING' | 'RESTRICTED' | 'ADMIN_REVIEW' | 'RESTRICTION_EXTENDED' | 'RESTRICTION_RELEASED';

/**
 * Classifier confidence. UNCERTAIN never punishes: it is routed to an admin
 * instead, which is the false-positive protection.
 */
export type ModerationConfidence = 'CONFIRMED' | 'UNCERTAIN';

/** User-facing support/report buckets. */
export type SupportCategory = 'TRANSCRIPTION' | 'TIMING' | 'TAGGING' | 'SRT' | 'CREDITS' | 'LOGIN' | 'OTHER';

export interface ModerationCaseRecord {
  id: string;
  /** Account the decision applies to. */
  userId: string;
  category: ViolationCategory;
  action: ModerationAction;
  /** CONFIRMED = server is sure; UNCERTAIN = routed to an admin, not punished. */
  confidence: ModerationConfidence;
  /** True when the system decided this without a human. */
  automatic: boolean;
  createdAt: string;
  /** Present only when the action involved an active restriction. */
  restrictionStartedAt?: string;
  restrictionExpiresAt?: string;
  /** Admin who reviewed/manually acted, and what they did. */
  adminUserId?: string;
  /** Server-verified owner email of the acting admin (never client-supplied). */
  adminEmail?: string;
  adminNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  /**
   * Short, truncated excerpt of the submitted text so an admin can judge the
   * case. Never the full message, and never any credential.
   */
  excerpt?: string;
  /** Why the classifier decided this (category-level, not a raw word list). */
  reason?: string;
}

export interface CommunityRestrictionRecord {
  userId: string;
  startedAt: string;
  expiresAt: string;
  /** Server-maintained count of CONFIRMED violations behind this restriction. */
  violationCount: number;
  /** True when applied automatically, false when an admin applied it. */
  automatic: boolean;
  /** How many times an admin has extended it. */
  extendedCount: number;
  releasedAt?: string;
  releasedBy?: string;
}

export interface CommunityMessageRecord {
  id: string;
  userId: string;
  kind: 'COMMUNITY' | 'SUPPORT';
  category?: SupportCategory;
  /** Full submitted text, stored server-side and only surfaced to admins. */
  body: string;
  createdAt: string;
  /** False when the server withheld it (warning, restriction or admin review). */
  accepted: boolean;
  moderationCaseId?: string;
  /** Attachment metadata only; bytes live in the community storage dir. */
  attachmentName?: string;
  attachmentMime?: string;
  attachmentBytes?: number;
  /** Private storage key. Only ever readable through an admin-authenticated route. */
  attachmentKey?: string;
}

export type CreditTransactionType =
  | 'CREDIT'
  | 'DEBIT'
  | 'REFUND'
  | 'ADMIN_GRANT'
  | 'ADMIN_DEBIT'
  | 'FREE_TRIAL'
  | 'PURCHASE'
  | 'RESERVATION'
  | 'USAGE'
  | 'RELEASE'
  | 'ADMIN_ADJUSTMENT';

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
  /**
   * Normalized account email (lower-cased, trimmed) for the optional
   * email/password USER account layer. Normal users rely on this + the scrypt
   * passwordHash; ADMIN accounts keep their separate, allowlist-backed
   * `ownerEmail`. One user can carry both, but neither field derives from the
   * other. Never user-searchable by non-admins.
   */
  email?: string;
  /** scrypt hash (`scrypt$<saltB64>$<hashB64>`) backing email login. Never stored in plaintext. */
  passwordHash?: string;
  /** ISO timestamp of the last successful email/password login. */
  lastLoginAt?: string;
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
  /**
   * Server-verified owner email backing an ADMIN role (canonical, lower-cased,
   * checked against the server-side allowlist on every admin request). Never
   * read from the browser as proof of anything; a client claim is only accepted
   * together with the server-held admin secret (see server/authz.ts).
   */
  ownerEmail?: string;
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
  /** Balance immediately before this transaction (audit-friendly ledger). */
  balanceBefore?: number;
  /**
   * Server-verified owner email that performed an ADMIN_ADJUSTMENT /
   * ADMIN_GRANT / ADMIN_DEBIT. Denormalised from the admin's account so the
   * audit trail survives role changes. Never a browser-supplied value.
   */
  adminEmail?: string;
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
  /**
   * Locally stored provider safety state. Optional so databases written before
   * this feature keep loading unchanged; `store.ts` normalises it on load.
   */
  providerSafety?: ProviderSafetyRecord;
  /**
   * Community moderation state. All optional so databases written before this
   * feature keep loading unchanged; `store.ts` normalises them on load.
   * These tables are independent of jobs/credits/provider safety.
   */
  moderationCases?: ModerationCaseRecord[];
  communityRestrictions?: CommunityRestrictionRecord[];
  communityMessages?: CommunityMessageRecord[];
}

export const DB_VERSION = 4;

export function emptyDbShape(): DbShape {
  return { version: DB_VERSION, users: [], jobs: [], transactions: [] };
}

export function isJobStatus(v: string): v is JobStatus {
  return v === 'QUEUED' || v === 'PROCESSING' || v === 'COMPLETED' || v === 'FAILED' || v === 'CANCELLED';
}