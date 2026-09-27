/**
 * Minimal JSON-file-backed data store.
 *
 * Why a file store: the project has NO database dependency, and the rules say
 * not to introduce new DB tech unless absolutely necessary. Users/jobs/credits
 * CANNOT be served correctly without durable state, so this is that necessary
 * minimum — engineered to be swapped for SQL/cloud later:
 *
 *   - Callers go through repositories (`server/db/repos.ts`), never touch the
 *     file format.
 *   - Writes are atomic (temp file + rename), corruption-safe on the same fs.
 *   - Mutations run synchronously in the caller's tick (Node is single-threaded,
 *     so read-modify-write cannot interleave) and persists are strictly
 *     serialized through a promise chain, so the last write always wins.
 */
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  DB_VERSION,
  type DbShape,
  type ProviderSafetyRecord,
  type UserRecord,
  emptyDbShape,
} from './types';

function normalizeUser(u: any): UserRecord {
  return {
    ...u,
    role: u.role === 'ADMIN' ? 'ADMIN' : 'USER',
    creditMode: u.creditMode === 'UNLIMITED' ? 'UNLIMITED' : 'NORMAL',
    freeTrialsUsed: Number.isInteger(u.freeTrialsUsed) && (u.freeTrialsUsed as number) >= 0 ? (u.freeTrialsUsed as number) : 0,
    ownerEmail: typeof u.ownerEmail === 'string' && u.ownerEmail.trim() ? u.ownerEmail.trim().toLowerCase() : undefined,
  };
}

/**
 * Provider safety state written by an older build (or hand-edited) must never
 * crash the API: anything unrecognised is normalised to a safe AVAILABLE record
 * with `balance.known = false` (we never invent a balance).
 */
export function normalizeProviderSafety(value: any, provider: string): ProviderSafetyRecord {
  const status = value?.status === 'BLOCKED' || value?.status === 'WARNING' ? value.status : 'AVAILABLE';
  const reason = status === 'BLOCKED' ? (value?.reason === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'KILL_SWITCH') : null;
  const percent = Number(value?.balance?.percent);
  return {
    provider: typeof value?.provider === 'string' && value.provider.trim() ? value.provider : provider,
    status,
    reason,
    lastError: typeof value?.lastError === 'string' ? value.lastError.slice(0, 400) : undefined,
    lastHttpStatus: Number.isInteger(value?.lastHttpStatus) ? value.lastHttpStatus : undefined,
    lastErrorAt: typeof value?.lastErrorAt === 'string' ? value.lastErrorAt : undefined,
    blockedAt: typeof value?.blockedAt === 'string' ? value.blockedAt : undefined,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    consecutiveFailures: Number.isInteger(value?.consecutiveFailures) && value.consecutiveFailures > 0 ? value.consecutiveFailures : 0,
    lastSuccessAt: typeof value?.lastSuccessAt === 'string' ? value.lastSuccessAt : undefined,
    lastResetAt: typeof value?.lastResetAt === 'string' ? value.lastResetAt : undefined,
    lastResetBy: typeof value?.lastResetBy === 'string' ? value.lastResetBy : undefined,
    balance: {
      known: value?.balance?.known === true && Number.isFinite(percent),
      percent: value?.balance?.known === true && Number.isFinite(percent) ? percent : undefined,
      unit: typeof value?.balance?.unit === 'string' ? value.balance.unit : undefined,
      source: typeof value?.balance?.source === 'string' ? value.balance.source : undefined,
      updatedAt: typeof value?.balance?.updatedAt === 'string' ? value.balance.updatedAt : undefined,
    },
  };
}

export class DataStore {
  private readonly filePath: string;
  private current: DbShape;
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.current = emptyDbShape();
  }

  /** Load (or create) the database file. Must be called once before use. */
  async init(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
    } catch {
      raw = null;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<DbShape>;
        this.current = {
          version: typeof parsed.version === 'number' ? parsed.version : DB_VERSION,
          users: Array.isArray(parsed.users) ? parsed.users.map(normalizeUser) : [],
          jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
          transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        };
        if (parsed.providerSafety) {
          this.current.providerSafety = normalizeProviderSafety(parsed.providerSafety, 'sarvam');
        }
      } catch {
        // Corrupt file: preserve it for inspection, start fresh.
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(backup, raw ?? '', 'utf8');
        this.current = emptyDbShape();
      }
    } else {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    }
    await this.saveNow();
  }

  /**
   * Synchronous mutation. `fn` runs immediately on the in-memory copy (atomic
   * within the tick); the file write is queued and serialized behind prior
   * writes so the persisted state always converges to the latest mutation.
   */
  mutate<T>(fn: (db: DbShape) => T): T {
    const result = fn(this.current);
    this.enqueueSave();
    return result;
  }

  /** Async mutation + awaited persistence. */
  async mutateAsync<T>(fn: (db: DbShape) => T): Promise<T> {
    const result = fn(this.current);
    await this.enqueueSave();
    return result;
  }

  /** Read-only clone of the current shape (no mutation, no save). */
  snapshot(): DbShape {
    return structuredClone(this.current);
  }

  private enqueueSave(): Promise<void> {
    const next = this.saveChain.then(() => this.saveNow()).catch(() => undefined);
    this.saveChain = next;
    return next;
  }

  /** Atomic persist: write temp file then rename over the real one. */
  private async saveNow(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.db-${randomUUID()}.tmp`);
    const data = JSON.stringify(this.current, null, 2);
    await fsp.writeFile(tmp, data, 'utf8');
    try {
      await fsp.rename(tmp, this.filePath);
    } catch {
      // Windows may transiently fail rename; fall back to direct write.
      await new Promise((r) => setTimeout(r, 50));
      try {
        await fsp.rename(tmp, this.filePath);
      } catch {
        await fsp.writeFile(this.filePath, data, 'utf8');
        await fsp.unlink(tmp).catch(() => undefined);
      }
    }
  }

  /** Test helper: reload state from the file on disk. */
  async reloadForTest(): Promise<void> {
    const raw = await fsp.readFile(this.filePath, 'utf8').catch(() => null);
    this.current = raw ? (JSON.parse(raw) as DbShape) : emptyDbShape();
  }
}