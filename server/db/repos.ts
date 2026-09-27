/**
 * Repository layer over DataStore.
 *
 * All persistence for users, jobs and the credit ledger lives here. Swapping
 * the JSON-file backend for SQL/cloud later only changes these functions (and
 * the store), never the API/queue/credit callers.
 */
import { randomUUID } from 'crypto';
import { DataStore } from './store';
import {
  type UserRecord,
  type JobRecord,
  type CreditTransactionRecord,
  type JobStatus,
  type UserRole,
  type CreditMode,
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

  getByToken(tokenHash: string): UserRecord | null {
    return this.store.snapshot().users.find((u) => u.tokenHashes.includes(tokenHash)) ?? null;
  }

  getById(userId: string): UserRecord | null {
    return this.store.snapshot().users.find((u) => u.id === userId) ?? null;
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
    return (
      this.store.snapshot().transactions.find(
        (t) => t.userId === userId && t.jobId === jobId && t.type === 'DEBIT'
      ) ?? null
    );
  }

  refundForJob(userId: string, jobId: string): CreditTransactionRecord | null {
    return (
      this.store.snapshot().transactions.find(
        (t) => t.userId === userId && t.jobId === jobId && t.type === 'REFUND'
      ) ?? null
    );
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

  /** Find a prior transaction that already used this idempotency key. */
  findByIdempotencyKey(key: string, userId?: string): CreditTransactionRecord | null {
    const txn = this.store
      .snapshot()
      .transactions.find(
        (t) => t.idempotencyKey === key && (!userId || t.userId === userId)
      );
    return txn ? structuredClone(txn) : null;
  }

  /** Net granted credits (ADMIN_GRANT + initial CREDIT grants, positive). */
  sumGrants(userId: string): number {
    return this.store
      .snapshot()
      .transactions.filter(
        (t) =>
          t.userId === userId &&
          (t.type === 'ADMIN_GRANT' ||
            (t.type === 'CREDIT' && (t.reason === 'initial_grant' || t.reason === 'purchase')))
      )
      .reduce((sum, t) => sum + t.amount, 0);
  }

  /** Net consumed credits (DEBIT + ADMIN_DEBIT, positive magnitude). */
  sumUsed(userId: string): number {
    return this.store
      .snapshot()
      .transactions.filter((t) => t.userId === userId && (t.type === 'DEBIT' || t.type === 'ADMIN_DEBIT'))
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
      Object.assign(job, patch);
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