/**
 * Repository layer over DataStore.
 *
 * All persistence for users, jobs and the credit ledger lives here. Swapping
 * the JSON-file backend for SQL/cloud later only changes these functions (and
 * the store), never the API/queue/credit callers.
 */
import { randomUUID } from 'crypto';
import { DataStore, normalizeProviderSafety } from './store';
  import {
    type UserRecord,
    type JobRecord,
    type CreditTransactionRecord,
    type JobStatus,
    type UserRole,
    type CreditMode,
    type ProviderSafetyRecord,
    type ProviderSafetyStatus,
    type CommunityMessageRecord,
    type CommunityRestrictionRecord,
    type ModerationCaseRecord,
    type ModerationAction,
    type ModerationConfidence,
    type SupportCategory,
    type ViolationCategory,
    type LoginActivityRecord,
    type LoginAlertRecord,
  } from './types';

export function newId(): string {
  return randomUUID();
}

export class UserRepo {
  constructor(private readonly store: DataStore) {}

  createUser(tokenHash: string, initialCredits: number, role: UserRole = 'USER', creditMode: CreditMode = 'NORMAL'): UserRecord {
    const now = new Date().toISOString();
    return this.store.mutate((db) => {
      const user: UserRecord = {
        id: newId(),
        tokenHashes: [tokenHash],
        credits: initialCredits,
        role,
        creditMode,
        createdAt: now,
        lastSeenAt: now,
        freeTrialsUsed: 0,
      };
      db.users.push(user);
      return structuredClone(user);
    });
  }

  /**
   * Create an authenticated email/password account. Always a plain USER
   * (creditMode NORMAL) — ADMIN is NEVER granted through this path. The scrypt
   * hash is provided by the caller (services/accountService).
   */
  createAccount(opts: { email: string; passwordHash: string; initialCredits?: number }): UserRecord {
    const now = new Date().toISOString();
    return this.store.mutate((db) => {
      const user: UserRecord = {
        id: newId(),
        tokenHashes: [],
        credits: opts.initialCredits ?? 0,
        role: 'USER',
        creditMode: 'NORMAL',
        email: opts.email.trim().toLowerCase(),
        passwordHash: opts.passwordHash,
        createdAt: now,
        lastSeenAt: now,
        lastLoginAt: now,
        freeTrialsUsed: 0,
      };
      db.users.push(user);
      return structuredClone(user);
    });
  }

  getByToken(tokenHash: string): UserRecord | null {
    return this.store.snapshot().users.find((u) => u.tokenHashes.includes(tokenHash)) ?? null;
  }

  /** Account lookup by normalized email (accounts only; admin ownerEmail is separate). */
  getByEmail(email: string): UserRecord | null {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    return this.store.snapshot().users.find((u) => u.email === normalized) ?? null;
  }

  getById(userId: string): UserRecord | null {
    return this.store.snapshot().users.find((u) => u.id === userId) ?? null;
  }

  /**
   * Persist the scrypt password hash backing email login. Returns false when the
   * user is missing or the hash is empty.
   */
  setPasswordHash(userId: string, passwordHash: string): boolean {
    const hash = (passwordHash || '').trim();
    if (!hash) return false;
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.passwordHash = hash;
      return true;
    });
  }

  /** Mark a successful email/password login (sets lastLoginAt + lastSeenAt). */
  recordLogin(userId: string): boolean {
    const now = new Date().toISOString();
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.lastLoginAt = now;
      user.lastSeenAt = now;
      return true;
    });
  }

  /** Revoke one bearer token so future requests with it are rejected. */
  revokeToken(userId: string, tokenHash: string): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      const idx = user.tokenHashes.indexOf(tokenHash);
      if (idx === -1) return false;
      user.tokenHashes.splice(idx, 1);
      return true;
    });
  }

  addToken(userId: string, tokenHash: string): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      if (!user.tokenHashes.includes(tokenHash)) user.tokenHashes.push(tokenHash);
      user.lastSeenAt = new Date().toISOString();
      return true;
    });
  }

  bumpCredits(userId: string, delta: number): number | null {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return null;
      user.credits += delta;
      return user.credits;
    });
  }

  /** Count one more successful free trial; returns the new count (null if no user). */
  incrementFreeTrialsUsed(userId: string): number | null {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return null;
      user.freeTrialsUsed = (user.freeTrialsUsed ?? 0) + 1;
      return user.freeTrialsUsed;
    });
  }

  touch(userId: string): void {
    this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (user) user.lastSeenAt = new Date().toISOString();
    });
  }

  /** Promote/demote a user's role. Server-side only; never from client input. */
  setRole(userId: string, role: UserRole): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.role = role;
      return true;
    });
  }

  /** Set credit mode. Server-side only; never from browser-provided claims. */
  setCreditMode(userId: string, creditMode: CreditMode): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.creditMode = creditMode;
      return true;
    });
  }

  setPurchasedCredits(userId: string, purchasedCredits: number): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.purchasedCredits = purchasedCredits;
      return true;
    });
  }

  setBonusCredits(userId: string, bonusCredits: number): boolean {
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.bonusCredits = bonusCredits;
      return true;
    });
  }

  /** Ordered by most recently active first (admin user listing). */
  listUsers(): UserRecord[] {
    return this.store
      .snapshot()
      .users.slice()
      .sort((a, b) => (b.lastSeenAt || b.createdAt).localeCompare(a.lastSeenAt || a.createdAt))
      .map((u) => structuredClone(u));
  }

  /**
   * Admin user search: match on the user id prefix, a full id, a server-side
   * account email, or a verified owner email. Account emails are only matched
   * server-side and only surfaced through the protected admin listing.
   */
  searchUsers(query: string, limit = 50): UserRecord[] {
    const q = (query || '').trim().toLowerCase();
    const all = this.listUsers();
    if (!q) return all.slice(0, limit);
    return all
      .filter(
        (u) =>
          u.id.toLowerCase().includes(q) ||
          (typeof u.email === 'string' && u.email.toLowerCase().includes(q)) ||
          (typeof u.ownerEmail === 'string' && u.ownerEmail.toLowerCase().includes(q))
      )
      .slice(0, limit);
  }

  /** Persist the server-verified owner email for an admin account. */
  setOwnerEmail(userId: string, ownerEmail: string): boolean {
    const email = ownerEmail.trim().toLowerCase();
    if (!email) return false;
    return this.store.mutate((db) => {
      const user = db.users.find((u) => u.id === userId);
      if (!user) return false;
      user.ownerEmail = email;
      return true;
    });
  }
}

/**
 * Locally stored provider safety state (survives restarts so a BLOCKED provider
 * stays blocked until an admin resets it — a process restart must never silently
 * re-enable billing calls).
 */
export class ProviderSafetyRepo {
  constructor(private readonly store: DataStore) {}

  get(provider: string): ProviderSafetyRecord {
    const current = this.store.snapshot().providerSafety;
    if (!current) {
      return {
        provider,
        status: 'AVAILABLE',
        reason: null,
        updatedAt: new Date(0).toISOString(),
        consecutiveFailures: 0,
        balance: { known: false },
      };
    }
    return normalizeProviderSafety(current, provider);
  }

  /** Apply a partial state update and persist it. */
  patch(provider: string, patch: Partial<ProviderSafetyRecord>): ProviderSafetyRecord {
    return this.store.mutate((db) => {
      const next = normalizeProviderSafety({ ...(db.providerSafety ?? {}), ...patch, provider }, provider);
      db.providerSafety = next;
      return structuredClone(next);
    });
  }

  /** Convenience for the state machine: set status + reason together. */
  setStatus(
    provider: string,
    status: ProviderSafetyStatus,
    reason: ProviderSafetyRecord['reason'],
    patch: Partial<ProviderSafetyRecord> = {}
  ): ProviderSafetyRecord {
    return this.patch(provider, { ...patch, status, reason });
  }
}

export class CreditRepo {
  constructor(private readonly store: DataStore) {}

  add(txn: Omit<CreditTransactionRecord, 'id' | 'createdAt'>): CreditTransactionRecord {
    return this.store.mutate((db) => {
      const record: CreditTransactionRecord = {
        ...txn,
        id: newId(),
        createdAt: new Date().toISOString(),
      };
      db.transactions.push(record);
      return structuredClone(record);
    });
  }

  debitForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return this.forJobAndType(userId, jobId, 'DEBIT');
  }

  refundForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return this.forJobAndType(userId, jobId, 'REFUND');
  }

  /** Generic lookup of the first transaction of `type` for a user+job. */
  forJobAndType(
    userId: string,
    jobId: string,
    type: CreditTransactionRecord['type']
  ): CreditTransactionRecord | null {
    return (
      this.store.snapshot().transactions.find(
        (t) => t.userId === userId && t.jobId === jobId && t.type === type
      ) ?? null
    );
  }

  reservationForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return this.forJobAndType(userId, jobId, 'RESERVATION');
  }

  usageForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return this.forJobAndType(userId, jobId, 'USAGE');
  }

  releaseForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return this.forJobAndType(userId, jobId, 'RELEASE');
  }

  listForUser(userId: string, limit = 50): CreditTransactionRecord[] {
    return this.store
      .snapshot()
      .transactions.filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  /** Latest transactions across all users (admin Transaction History). */
  listAll(limit = 200): CreditTransactionRecord[] {
    return this.store
      .snapshot()
      .transactions.slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }

  /**
   * EVERY transaction across every user, oldest first, with NO limit and NO
   * slicing. Used by the admin Excel export, which must never be truncated to
   * the number of rows currently visible in the dashboard.
   */
  listAllUnbounded(): CreditTransactionRecord[] {
    return this.store
      .snapshot()
      .transactions.slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((t) => structuredClone(t));
  }

  /**
   * Find a prior transaction that already used this idempotency key. When `type`
   * is given, only that type matches, so reusing a key across operations
   * (e.g. an adjustment and a debit) can never cross-apply.
   */
  findByIdempotencyKey(
    key: string,
    userId?: string,
    type?: CreditTransactionRecord['type']
  ): CreditTransactionRecord | null {
    const txn = this.store
      .snapshot()
      .transactions.find(
        (t) =>
          t.idempotencyKey === key &&
          (!userId || t.userId === userId) &&
          (!type || t.type === type)
      );
return txn ? structuredClone(txn) : null;
  }

  /**
   * Find a purchase transaction by Razorpay payment ID.
   * Used for idempotency protection against duplicate webhooks/verifications.
   *
   * `paymentId` is the canonical application field: it is declared on
   * CreditTransactionRecord, written by every purchase path
   * (FileCreditService.purchase, razorpayService.verifyPayment and the webhook
   * handlers) and read back by the Excel export. Matching on it is what makes
   * this store agree with TursoStore's dedicated `transactions.paymentId`
   * column, so the same lookup semantics hold on both backends.
   *
   * This used to match `extra.gatewayPaymentId`, which no write path ever set
   * and which appears in no source record, so it could only ever return null and
   * the duplicate-purchase guard in creditService/server.ts never fired. The
   * `extra` column itself is left untouched in both stores.
   */
  findByPaymentId(paymentId: string): CreditTransactionRecord | null {
    const txn = this.store
      .snapshot()
      .transactions.find((t) => t.paymentId === paymentId);
return txn ? structuredClone(txn) : null;
  }

  /**
   * Check if a user has already received an ADMIN_ADJUSTMENT giveaway on the given IST date.
   * Returns true if the user has already received any admin adjustment giveaway on that date.
   */
  hasAdminGiveawayToday(userId: string, istDate: string): boolean {
    const snapshot = this.store.snapshot();
    return snapshot.transactions.some(
      (t) =>
        t.userId === userId &&
        t.type === 'ADMIN_ADJUSTMENT' &&
        t.createdAt.startsWith(istDate)
    );
  }

  /**
   * Net granted credits: manual ADMIN_ADJUSTMENT + ADMIN_GRANT + PURCHASE +
   * initial CREDIT grants (positive only). Manual admin credits ARE lifetime
   * grants, so they count here.
   */
  sumGrants(userId: string): number {
    return this.store
      .snapshot()
      .transactions.filter(
        (t) =>
          t.userId === userId &&
          (t.type === 'ADMIN_ADJUSTMENT' ||
            t.type === 'ADMIN_GRANT' ||
            t.type === 'PURCHASE' ||
            (t.type === 'CREDIT' && (t.reason === 'initial_grant' || t.reason === 'purchase')))
      )
      .reduce((sum, t) => sum + t.amount, 0);
  }

  /** Net consumed credits (final USAGE + DEBIT + ADMIN_DEBIT, positive magnitude). */
  sumUsed(userId: string): number {
    return this.store
      .snapshot()
      .transactions.filter(
        (t) => t.userId === userId && (t.type === 'DEBIT' || t.type === 'ADMIN_DEBIT' || t.type === 'USAGE')
      )
      .reduce((sum, t) => sum + t.amount, 0);
  }
}

export class JobRepo {
  constructor(private readonly store: DataStore) {}

  create(job: JobRecord): JobRecord {
    this.store.mutate((db) => {
      db.jobs.push(structuredClone(job));
    });
    return structuredClone(job);
  }

  get(id: string): JobRecord | null {
    return this.store.snapshot().jobs.find((j) => j.id === id) ?? null;
  }

  getForUser(id: string, userId: string): JobRecord | null {
    const job = this.get(id);
    if (!job || job.userId !== userId) return null;
    return structuredClone(job);
  }

  listForUser(userId: string, status?: JobStatus): JobRecord[] {
    return this.store
      .snapshot()
      .jobs.filter((j) => j.userId === userId && (!status || j.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => structuredClone(j));
  }

  countActiveForUser(userId: string): number {
    return this.store
      .snapshot()
      .jobs.filter((j) => j.userId === userId && (j.status === 'QUEUED' || j.status === 'PROCESSING'))
      .length;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | null {
    return this.store.mutate((db) => {
      const job = db.jobs.find((j) => j.id === id);
      if (!job) return null;
      // A job id is minted once (randomUUID at enqueue) and is load-bearing
      // outside this record: srtKey()/uploadKey() derive storage object paths
      // from it, and creditTxnId / refundFinishedJob() key on it. Object.assign
      // would copy a patch.id straight over the primary key, which silently
      // orphans those storage objects and desynchronises the credit ledger.
      // The explicit `id` argument stays authoritative; every other field in
      // the patch is merged exactly as before. Mirrors TursoStore.updateJob().
      const { id: _ignoredPatchId, ...mergeable } = patch;
      Object.assign(job, mergeable);
      return structuredClone(job);
    });
  }

  /** All QUEUED jobs that are eligible now (respecting retry backoff). */
  listEligibleQueued(nowIso: string): JobRecord[] {
    return this.store
      .snapshot()
      .jobs.filter(
        (j) =>
          j.status === 'QUEUED' &&
          (!j.nextRetryAt || j.nextRetryAt <= nowIso)
      )
      .map((j) => structuredClone(j));
  }

  /** All PROCESSING jobs (for rehydration on boot). */
  listProcessing(): JobRecord[] {
    return this.store.snapshot().jobs.filter((j) => j.status === 'PROCESSING').map((j) => structuredClone(j));
  }

  listQueued(): JobRecord[] {
    return this.store.snapshot().jobs.filter((j) => j.status === 'QUEUED').map((j) => structuredClone(j));
  }

  /** All jobs across all users (admin Jobs dashboard), newest first. */
  listAll(limit = 200): JobRecord[] {
    return this.store
      .snapshot()
      .jobs.slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
}
/**
 * Community & Support moderation persistence.
 *
 * Deliberately separate from jobs/credits/provider safety: moderation state is
 * additive and optional, and nothing in the transcription, timing, tagging,
 * SRT, credit or provider-safety paths reads or writes it.
 */
export class ModerationRepo {
  constructor(private readonly store: DataStore) {}

  // ---- Cases (the audit trail) ------------------------------------------------

  addCase(input: {
    userId: string;
    category: ViolationCategory;
    action: ModerationAction;
    confidence: ModerationConfidence;
    automatic: boolean;
    reason?: string;
    excerpt?: string;
    restrictionStartedAt?: string;
    restrictionExpiresAt?: string;
    adminUserId?: string;
    adminEmail?: string;
    adminNote?: string;
  }): ModerationCaseRecord {
    return this.store.mutate((db) => {
      const record: ModerationCaseRecord = {
        id: newId(),
        userId: input.userId,
        category: input.category,
        action: input.action,
        confidence: input.confidence,
        automatic: input.automatic,
        createdAt: new Date().toISOString(),
        reason: input.reason,
        excerpt: input.excerpt,
        restrictionStartedAt: input.restrictionStartedAt,
        restrictionExpiresAt: input.restrictionExpiresAt,
        adminUserId: input.adminUserId,
        adminEmail: input.adminEmail,
        adminNote: input.adminNote,
      };
      db.moderationCases = db.moderationCases ?? [];
      db.moderationCases.push(record);
      return structuredClone(record);
    });
  }

  casesForUser(userId: string): ModerationCaseRecord[] {
    return (this.store.snapshot().moderationCases ?? [])
      .filter((c) => c.userId === userId)
      .map((c) => structuredClone(c));
  }

  /** CONFIRMED (i.e. punishable) cases only - UNCERTAIN ones never count. */
  confirmedCaseCount(userId: string): number {
    return (this.store.snapshot().moderationCases ?? []).filter(
      (c) => c.userId === userId && c.confidence === 'CONFIRMED'
    ).length;
  }

  listCases(limit = 200): ModerationCaseRecord[] {
    return (this.store.snapshot().moderationCases ?? [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  getCase(id: string): ModerationCaseRecord | null {
    const found = (this.store.snapshot().moderationCases ?? []).find((c) => c.id === id);
    return found ? structuredClone(found) : null;
  }

  /** Mark a case reviewed by an admin. */
  markReviewed(id: string, admin: { adminUserId: string; adminEmail?: string; note?: string }): ModerationCaseRecord | null {
    return this.store.mutate((db) => {
      const found = (db.moderationCases ?? []).find((c) => c.id === id);
      if (!found) return null;
      found.reviewedAt = new Date().toISOString();
      found.reviewedBy = admin.adminUserId;
      found.adminUserId = admin.adminUserId;
      found.adminEmail = admin.adminEmail;
      if (admin.note) found.adminNote = admin.note;
      return structuredClone(found);
    });
  }

  // ---- Restrictions -----------------------------------------------------------

  /** The current restriction for a user, or null when none / already expired. */
  activeRestriction(userId: string, now = Date.now()): CommunityRestrictionRecord | null {
    const found = (this.store.snapshot().communityRestrictions ?? []).find(
      (r) => r.userId === userId && !r.releasedAt && new Date(r.expiresAt).getTime() > now
    );
    return found ? structuredClone(found) : null;
  }

  applyRestriction(input: {
    userId: string;
    durationMs: number;
    violationCount: number;
    automatic: boolean;
  }, now = Date.now()): CommunityRestrictionRecord {
    return this.store.mutate((db) => {
      const record: CommunityRestrictionRecord = {
        userId: input.userId,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.durationMs).toISOString(),
        violationCount: input.violationCount,
        automatic: input.automatic,
        extendedCount: 0,
      };
      db.communityRestrictions = db.communityRestrictions ?? [];
      db.communityRestrictions.push(record);
      return structuredClone(record);
    });
  }

  /** Admin extension. Duration is computed server-side, never accepted raw. */
  extendRestriction(userId: string, additionalMs: number, now = Date.now()): CommunityRestrictionRecord | null {
    return this.store.mutate((db) => {
      const found = (db.communityRestrictions ?? []).find(
        (r) => r.userId === userId && !r.releasedAt && new Date(r.expiresAt).getTime() > now
      );
      if (!found) return null;
      found.expiresAt = new Date(new Date(found.expiresAt).getTime() + additionalMs).toISOString();
      found.extendedCount = (found.extendedCount ?? 0) + 1;
      return structuredClone(found);
    });
  }

  /** Admin release: the restriction stops applying immediately. */
  releaseRestriction(userId: string, releasedBy: string): CommunityRestrictionRecord | null {
    return this.store.mutate((db) => {
      const found = (db.communityRestrictions ?? []).find((r) => r.userId === userId && !r.releasedAt);
      if (!found) return null;
      found.releasedAt = new Date().toISOString();
      found.releasedBy = releasedBy;
      return structuredClone(found);
    });
  }

  activeRestrictions(now = Date.now()): CommunityRestrictionRecord[] {
    return (this.store.snapshot().communityRestrictions ?? [])
      .filter((r) => !r.releasedAt && new Date(r.expiresAt).getTime() > now)
      .map((r) => structuredClone(r));
  }

  restrictionsForUser(userId: string): CommunityRestrictionRecord[] {
    return (this.store.snapshot().communityRestrictions ?? [])
      .filter((r) => r.userId === userId)
      .map((r) => structuredClone(r));
  }

  // ---- Submitted messages -----------------------------------------------------

  addMessage(input: {
    userId: string;
    kind: 'COMMUNITY' | 'SUPPORT';
    category?: SupportCategory;
    body: string;
    accepted: boolean;
    moderationCaseId?: string;
    attachmentName?: string;
    attachmentMime?: string;
    attachmentBytes?: number;
    attachmentKey?: string;
  }): CommunityMessageRecord {
    return this.store.mutate((db) => {
      const record: CommunityMessageRecord = {
        id: newId(),
        userId: input.userId,
        kind: input.kind,
        category: input.category,
        body: input.body,
        accepted: input.accepted,
        createdAt: new Date().toISOString(),
        moderationCaseId: input.moderationCaseId,
        attachmentName: input.attachmentName,
        attachmentMime: input.attachmentMime,
        attachmentBytes: input.attachmentBytes,
        attachmentKey: input.attachmentKey,
      };
      db.communityMessages = db.communityMessages ?? [];
      db.communityMessages.push(record);
      return structuredClone(record);
    });
  }

  messagesForUser(userId: string, limit = 50): CommunityMessageRecord[] {
    return (this.store.snapshot().communityMessages ?? [])
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }

  /** Find a stored attachment by its exact private key (admin-only retrieval). */
  messageByAttachmentKey(userId: string, key: string): CommunityMessageRecord | null {
    const found = (this.store.snapshot().communityMessages ?? []).find(
      (m) => m.userId === userId && m.attachmentKey === key
    );
    return found ? structuredClone(found) : null;
  }

  listMessages(limit = 200): CommunityMessageRecord[] {
    return (this.store.snapshot().communityMessages ?? [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }
}

/**
 * Upper bound on retained login-activity rows.
 *
 * The database is a single JSON file that is rewritten on every mutation, so
 * this list is part of every write's cost. The cap keeps that bounded while
 * still covering many months of logins; the oldest rows are trimmed.
 *
 * The cap is a retention limit only - it never touches other tables.
 */
export const LOGIN_ACTIVITY_RETENTION = 10_000;

/**
 * Login analytics: month-bucketed activity plus the daily alert log.
 *
 * Separate from `CreditRepo` and `UserRepo` on purpose: this table is purely
 * observational and holds no wallet or credential state.
 */
export class LoginActivityRepo {
  constructor(private readonly store: DataStore) {}

  private all(): LoginActivityRecord[] {
    return this.store.snapshot().loginActivity ?? [];
  }

  /**
   * Append one event, trimming the oldest rows past the retention cap.
   * Returns the stored record.
   */
  record(rec: LoginActivityRecord): LoginActivityRecord {
    return this.store.mutate((db) => {
      const list = db.loginActivity ?? (db.loginActivity = []);
      list.push(rec);
      if (list.length > LOGIN_ACTIVITY_RETENTION) {
        // Oldest-first ordering is guaranteed by `sort`, so trim from the front.
        const excess = list.length - LOGIN_ACTIVITY_RETENTION;
        list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
        list.splice(0, excess);
      }
      return structuredClone(rec);
    });
  }

  /** Newest-first, optionally narrowed to one IST month bucket. */
  listForMonth(month?: string): LoginActivityRecord[] {
    const src = month ? this.all().filter((r) => r.month === month) : this.all();
    return src
      .slice()
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
      .map((r) => structuredClone(r));
  }

  /** Oldest-first, optionally narrowed to one IST civil date. */
  listForDate(date: string): LoginActivityRecord[] {
    return this.all()
      .filter((r) => r.loginDate === date)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(a.id))
      .map((r) => structuredClone(r));
  }

  /** Every retained event, oldest first. */
  listAll(): LoginActivityRecord[] {
    return this.all()
      .slice()
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(a.id))
      .map((r) => structuredClone(r));
  }

  /**
   * The most recent event for this (user, method) pair, if any. Used to collapse
   * a page-refresh storm into a single login event.
   */
  lastForUserMethod(userId: string, method: string): LoginActivityRecord | undefined {
    let best: LoginActivityRecord | undefined;
    for (const r of this.all()) {
      if (r.userId !== userId || r.method !== method) continue;
      if (!best || r.occurredAt > best.occurredAt) best = r;
    }
    return best ? structuredClone(best) : undefined;
  }

  /** Distinct month buckets that actually hold data, newest first. */
  availableMonths(): string[] {
    const set = new Set<string>();
    for (const r of this.all()) set.add(r.month);
    return [...set].sort((a, b) => b.localeCompare(a));
  }

  /**
   * Distinct month buckets that hold data, gap-filled between the oldest and
   * newest so the admin selector never silently omits an empty month.
   */
  availableMonthsFilled(): string[] {
    const months = this.availableMonths();
    if (months.length === 0) return [];
    const out: string[] = [];
    let [y, m] = months[months.length - 1].split('-').map(Number);
    const [ty, tm] = months[0].split('-').map(Number);
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${p2(m)}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out.reverse();
  }

  /** First ever successful login for a user, or undefined. */
  firstLoginFor(userId: string): LoginActivityRecord | undefined {
    const hits = this.all()
      .filter((r) => r.userId === userId && r.outcome === 'SUCCESS')
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return hits[0] ? structuredClone(hits[0]) : undefined;
  }

  // ------------------------------------------------------------ alert log

  hasAlertFor(periodDate: string): boolean {
    return (this.store.snapshot().loginAlerts ?? []).some((a) => a.periodDate === periodDate);
  }

  findAlertFor(periodDate: string): LoginAlertRecord | undefined {
    const hit = (this.store.snapshot().loginAlerts ?? []).find((a) => a.periodDate === periodDate);
    return hit ? structuredClone(hit) : undefined;
  }

  saveAlert(alert: LoginAlertRecord): LoginAlertRecord {
    return this.store.mutate((db) => {
      const list = db.loginAlerts ?? (db.loginAlerts = []);
      // Re-issuing an alert for a period replaces the old row rather than
      // appending a duplicate.
      const at = list.findIndex((a) => a.periodDate === alert.periodDate);
      if (at >= 0) list[at] = structuredClone(alert);
      else list.push(structuredClone(alert));
      return structuredClone(alert);
    });
  }

  /** Newest-first alert log. */
  listAlerts(limit = 60): LoginAlertRecord[] {
    return (this.store.snapshot().loginAlerts ?? [])
      .slice()
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((a) => structuredClone(a));
  }

  countEvents(): number {
    return this.all().length;
  }
}
