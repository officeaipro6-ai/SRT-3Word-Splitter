/**
 * Transaction-scoped repository facade for the Turso/libSQL provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * `server/db/repos.ts` is synchronous and built from exactly two primitives
 * (`snapshot()` / `mutate()`), so it cannot run against libSQL. The credit
 * flows, however, are read-modify-write sequences whose safety depends on them
 * being atomic. This module supplies the smallest thing that makes them atomic
 * without a synchronous facade over a promise.
 *
 * DESIGN RULES ENFORCED HERE
 * --------------------------
 * 1. Genuinely async. Every method returns a real Promise. Nothing polls, spins,
 *    deasyncs, or pretends a promise is a value.
 * 2. Business logic never sees a libSQL handle. `SqlExecutor` has exactly one
 *    method, `execute`, and no `commit`/`rollback`. A caller therefore cannot
 *    commit early, roll back someone else's work, or issue an unprepared query
 *    that skips the JSON-blob decoding the rest of the provider enforces.
 * 3. Atomicity comes from SQL, not from application sequencing. The balance
 *    update is ONE conditional `UPDATE ... RETURNING` statement, so the
 *    "never negative" rule and the `balanceBefore`/`balanceAfter` audit pair are
 *    decided by the database in a single step. There is no read-then-write window
 *    for a concurrent transaction to slip into.
 * 4. No silent provider fallback. This facade only ever talks to libSQL; there is
 *    no path here that quietly degrades to the JSON file.
 * 5. The scope exposes only the operations the credit and provider-safety flows
 *    need. It is not a general-purpose "run any SQL" escape hatch.
 *
 * The raw transaction handle stays inside `TursoStore.runInTransaction()`; this
 * file never receives `commit` or `rollback`.
 */
import { randomUUID } from 'crypto';
import type { InValue } from '@libsql/client';
import type { UnitOfWork } from './dataStore';
import type { CreditTransactionRecord, ProviderSafetyRecord, UserRecord } from './types';
import { normalizeProviderSafety } from './store';

/**
 * The one capability a scope needs from libSQL: run a statement and read rows.
 *
 * Deliberately narrower than the driver's own client type: it exposes no
 * `batch`, no `executeMultiple`, no `transaction`, and no lifecycle methods.
 * `InValue` is libSQL's own parameter type, used here as a TYPE only, so a plain
 * `Client` satisfies this interface structurally and the conversion between them
 * needs no cast.
 */
export interface SqlExecutor {
  execute(opts: { sql: string; args: InValue[] }): Promise<{ rows: unknown[] }>;
}

/** The ledger column list, kept identical to `TursoStore.addTransaction`. */
const TXN_COLUMNS =
  'id, userId, type, amount, reason, balanceBefore, balanceAfter, idempotencyKey, createdAt, adminUserId, adminEmail, jobId, paymentId, extra';

/**
 * Result of an atomic balance change.
 *
 * `INSUFFICIENT` is deliberately distinct from `NO_USER`: the JSON service
 * reports `NO_USER` for an unknown id and `INSUFFICIENT_BALANCE` for a real
 * shortfall, and callers map those to different HTTP statuses.
 */
export type CreditDeltaResult =
  | { status: 'ok'; balanceBefore: number; balanceAfter: number }
  | { status: 'insufficient'; balance: number }
  | { status: 'no_user' };

/**
 * A ledger row as PERSISTED.
 *
 * `CreditTransactionRecord` describes the typed application contract, but the
 * `transactions.extra` column is an overflow bag for fields that are not part of
 * that interface (the Excel export reads several of them). Preserving `extra`
 * across a read/write round trip is what keeps this provider lossless, so the
 * stored shape is expressed here rather than loosened with a cast.
 *
 * Two typed fields that the table has no column for — `packageId` and
 * `paymentStatus` — are transported in this bag and lifted back out on read
 * (see `transactionExtraColumn` / `liftTransactionMetadata`), so they are part
 * of the stored shape through the record fields, not through `extra`.
 */
type StoredTransaction = CreditTransactionRecord & {
  extra?: Record<string, unknown> | null;
};

/** A ledger row awaiting insert; id/createdAt are assigned by the scope. */
export type NewTransaction = Omit<StoredTransaction, 'id' | 'createdAt'> &
  Partial<Pick<StoredTransaction, 'id' | 'createdAt'>>;

function toNum(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Ledger fields persisted inside the `transactions.extra` overflow bag because
 * the table has no dedicated columns for them.
 *
 * `packageId`/`paymentStatus` are part of the typed `CreditTransactionRecord`
 * contract (the file provider stores them as ordinary record fields) and the
 * Excel purchase history reads both, so the Turso provider must round-trip them
 * too. Folding them into `extra` on write and lifting them back out on read
 * keeps rows lossless WITHOUT a schema change: `extra` stays, as documented
 * above, the place where fields with no column live, and a record returned to
 * business code never exposes the transport detail.
 */
const TRANSACTION_METADATA_FIELDS = ['packageId', 'paymentStatus'] as const;

type TransactionMetadata = Partial<Pick<CreditTransactionRecord, 'packageId' | 'paymentStatus'>>;

/**
 * Write side of the transport: the JSON text for the `extra` column of one
 * transaction row, or `null` when there is nothing to store.
 *
 * The caller's own `extra` bag is preserved byte-for-byte; the metadata fields
 * are only merged in when the record actually carries them (Razorpay PURCHASE
 * rows), so every non-purchase row writes exactly what it wrote before.
 */
export function transactionExtraColumn(
  record: { extra?: Record<string, unknown> | null } & TransactionMetadata
): string | null {
  const bag: Record<string, unknown> = { ...(record.extra ?? {}) };
  let stored = Object.keys(bag).length > 0;
  for (const field of TRANSACTION_METADATA_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && bag[field] !== value) {
      bag[field] = value;
      stored = true;
    }
  }
  return stored ? JSON.stringify(bag) : null;
}

/**
 * Read side of the transport: lift the transported metadata out of a decoded
 * `extra` value so the row reads back as a plain `CreditTransactionRecord`.
 *
 * - Metadata keys are MOVED (removed from `extra`), so `extra` keeps its
 *   documented meaning of "fields with no column of their own" and a
 *   write-read-write cycle is stable instead of accumulating duplicates.
 * - A non-string value under a metadata key is left in `extra` untouched:
 *   it cannot populate the typed field, and silently discarding unknown data
 *   would be worse than keeping it in the bag.
 * - Non-object `extra` (null, an array) is returned as-is with no metadata.
 */
export function liftTransactionMetadata(decodedExtra: unknown): {
  extra: Record<string, unknown> | null;
  metadata: TransactionMetadata;
} {
  if (decodedExtra === null || decodedExtra === undefined) {
    return { extra: null, metadata: {} };
  }
  if (typeof decodedExtra !== 'object' || Array.isArray(decodedExtra)) {
    return { extra: decodedExtra as Record<string, unknown>, metadata: {} };
  }
  const bag = { ...(decodedExtra as Record<string, unknown>) };
  const metadata: TransactionMetadata = {};
  for (const field of TRANSACTION_METADATA_FIELDS) {
    const value = bag[field];
    if (typeof value === 'string') {
      metadata[field] = value;
      delete bag[field];
    }
  }
  return { extra: Object.keys(bag).length > 0 ? bag : null, metadata };
}

/**
 * Decode one ledger row. Mirrors the JSON `CreditRepo` return shape: the row is
 * returned as stored, with `extra` already decoded from its JSON text and the
 * transported metadata lifted back onto the typed fields.
 */
function toTransaction(row: unknown): StoredTransaction | null {
  if (row === null || row === undefined) return null;
  const r = row as Record<string, unknown>;
  const extraRaw = r.extra;
  const decodedExtra =
    extraRaw === null || extraRaw === undefined
      ? null
      : typeof extraRaw === 'string'
        ? (JSON.parse(extraRaw) as Record<string, unknown>)
        : (extraRaw as Record<string, unknown>);
  const { extra, metadata } = liftTransactionMetadata(decodedExtra);
  return {
    id: String(r.id),
    userId: String(r.userId),
    type: r.type as CreditTransactionRecord['type'],
    amount: toNum(r.amount, 0),
    reason: String(r.reason),
    balanceBefore: r.balanceBefore === null || r.balanceBefore === undefined ? null : toNum(r.balanceBefore, 0),
    balanceAfter: toNum(r.balanceAfter, 0),
    idempotencyKey:
      r.idempotencyKey === null || r.idempotencyKey === undefined ? null : String(r.idempotencyKey),
    createdAt: String(r.createdAt),
    adminUserId:
      r.adminUserId === null || r.adminUserId === undefined ? null : String(r.adminUserId),
    adminEmail: r.adminEmail === null || r.adminEmail === undefined ? null : String(r.adminEmail),
    jobId: r.jobId === null || r.jobId === undefined ? null : String(r.jobId),
    paymentId: r.paymentId === null || r.paymentId === undefined ? null : String(r.paymentId),
    extra,
    ...metadata,
  } as StoredTransaction;
}

/**
 * A repository bound to either the root libSQL connection or one open write
 * transaction. Constructed only by `TursoStore`; business code receives the
 * instance through `TursoStore.unitOfWork()` and never builds one itself.
 */
export class TursoScope implements UnitOfWork<TursoScope> {
  /**
   * @param exec    statement runner: the root client, or an open write
   *                transaction's handle.
   * @param begin   supplied only by `TursoStore`, and only for the root scope.
   *                It opens a real write transaction, so nesting is rejected by
   *                the store rather than silently allowed here.
   */
  constructor(
    private readonly exec: SqlExecutor,
    private readonly begin?: <T>(fn: (scope: TursoScope) => Promise<T>) => Promise<T>
  ) {}

  /**
   * Re-open a write transaction from inside a scope.
   *
   * Present so this class genuinely satisfies the declared
   * `UnitOfWork<TursoScope>` contract. A scope obtained from `unitOfWork()` has no
   * `begin`, so calling this there throws instead of pretending to nest: the
   * work belongs in the enclosing callback, which already commits atomically.
   */
  async transaction<T>(fn: (scoped: TursoScope) => Promise<T>): Promise<T> {
    if (!this.begin) {
      throw new Error(
        'TursoScope.transaction() is only available on the root scope. ' +
          'A scope handed to unitOfWork() is already inside a transaction; ' +
          'put the work in the existing callback rather than opening a nested one.'
      );
    }
    return this.begin(fn);
  }

  // ---------------------------------------------------------------- users ---

  async getUserById(id: string): Promise<UserRecord | null> {
    const res = await this.exec.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    const row = res.rows[0];
    return row === undefined ? null : (row as UserRecord);
  }

  /**
   * Apply `delta` to a user's balance in ONE atomic statement.
   *
   * `RETURNING` yields the post-update balance, and `credits - delta` recovers
   * the pre-update value from the same row, so the ledger's audit pair is
   * guaranteed to describe a real transition rather than a value that a
   * concurrent writer changed in between.
   *
   * When `allowNegative` is false the guard lives in the WHERE clause, so two
   * concurrent charges cannot both pass a balance check: the loser simply
   * matches zero rows.
   */
  async applyCreditDelta(
    userId: string,
    delta: number,
    opts: { allowNegative: boolean }
  ): Promise<CreditDeltaResult> {
    const sql = opts.allowNegative
      ? 'UPDATE users SET credits = credits + ? WHERE id = ? RETURNING credits AS balanceAfter, credits - ? AS balanceBefore'
      : 'UPDATE users SET credits = credits + ? WHERE id = ? AND credits + ? >= 0 RETURNING credits AS balanceAfter, credits - ? AS balanceBefore';
    const args: InValue[] = opts.allowNegative
      ? [delta, userId, delta]
      : [delta, userId, delta, delta];

    const res = await this.exec.execute({ sql, args });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row !== undefined) {
      const balanceAfter = toNum(row.balanceAfter, 0);
      const balanceBefore = toNum(row.balanceBefore, balanceAfter);
      return { status: 'ok', balanceBefore, balanceAfter };
    }

    // No row changed: either the user does not exist, or the non-negative guard
    // rejected the write. One read disambiguates so the caller can keep the two
    // error codes the JSON service already uses.
    const user = await this.getUserById(userId);
    if (user === null) return { status: 'no_user' };
    return { status: 'insufficient', balance: toNum((user as unknown as { credits?: unknown }).credits, 0) };
  }

  /** Count one more successful free trial; returns the new count. */
  async incrementFreeTrialsUsed(userId: string): Promise<number | null> {
    const res = await this.exec.execute({
      sql: 'UPDATE users SET freeTrialsUsed = COALESCE(freeTrialsUsed, 0) + 1 WHERE id = ? RETURNING freeTrialsUsed',
      args: [userId],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : toNum(row.freeTrialsUsed, 0);
  }

  /** Insert a user row. Used by the registration + initial-credit flow. */
  async createUser(user: UserRecord): Promise<void> {
    await this.exec.execute({
      sql: `INSERT INTO users (id, email, passwordHash, credits, role, creditMode, tokenHashes, ownerEmail, lastLoginAt, lastSeenAt, createdAt, freeTrialsUsed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        user.id,
        user.email ?? null,
        user.passwordHash ?? null,
        user.credits ?? 0,
        user.role ?? 'USER',
        user.creditMode ?? 'NORMAL',
        JSON.stringify(user.tokenHashes ?? []),
        user.ownerEmail ?? null,
        user.lastLoginAt ?? null,
        user.lastSeenAt ?? null,
        user.createdAt ?? new Date().toISOString(),
        user.freeTrialsUsed ?? 0,
      ],
    });
  }

  // ---------------------------------------------------------- transactions ---

  async addTransaction(txn: NewTransaction): Promise<StoredTransaction> {
    const record: StoredTransaction = {
      ...txn,
      id: txn.id ?? randomId(),
      createdAt: txn.createdAt ?? new Date().toISOString(),
    };
    await this.exec.execute({
      sql: `INSERT INTO transactions (${TXN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.userId,
        record.type,
        record.amount,
        record.reason,
        record.balanceBefore ?? null,
        record.balanceAfter,
        record.idempotencyKey ?? null,
        record.createdAt,
        record.adminUserId ?? null,
        record.adminEmail ?? null,
        record.jobId ?? null,
        record.paymentId ?? null,
        transactionExtraColumn(record),
      ],
    });
    return record;
  }

  /**
   * Canonical idempotency lookups.
   *
   * These are the keys Part 3 settled on: a gateway `paymentId`, an explicit
   * admin `idempotencyKey`, and the `(userId, jobId, type)` triple. They are read
   * INSIDE the caller's transaction, which is what makes "check, then insert"
   * atomic: libSQL serialises write transactions, so no second writer can insert
   * a conflicting row between the check and the insert.
   */
  async getTransactionByPaymentId(paymentId: string): Promise<CreditTransactionRecord | null> {
    const res = await this.exec.execute({
      sql: 'SELECT * FROM transactions WHERE paymentId = ? LIMIT 1',
      args: [paymentId],
    });
    return toTransaction(res.rows[0]);
  }

  async getTransactionByIdempotencyKey(
    key: string,
    userId?: string,
    type?: string
  ): Promise<CreditTransactionRecord | null> {
    let sql = 'SELECT * FROM transactions WHERE idempotencyKey = ?';
    const args: InValue[] = [key];
    if (userId) {
      sql += ' AND userId = ?';
      args.push(userId);
    }
    if (type) {
      sql += ' AND type = ?';
      args.push(type);
    }
    sql += ' LIMIT 1';
    const res = await this.exec.execute({ sql, args });
    return toTransaction(res.rows[0]);
  }

  async getTransactionByJobAndType(
    userId: string,
    jobId: string,
    type: string
  ): Promise<CreditTransactionRecord | null> {
    const res = await this.exec.execute({
      sql: 'SELECT * FROM transactions WHERE userId = ? AND jobId = ? AND type = ? ORDER BY createdAt ASC, id ASC LIMIT 1',
      args: [userId, jobId, type],
    });
    return toTransaction(res.rows[0]);
  }

  /**
   * Sum ledger amounts for a user across a given set of transaction types.
   *
   * Used for the admin lifetime aggregates. The type list is passed as bound
   * parameters rather than interpolated, so this stays a fixed query shape and
   * cannot become an injection point; an empty list sums nothing.
   */
  async sumAmountByTypes(userId: string, types: readonly string[]): Promise<number> {
    if (types.length === 0) return 0;
    const placeholders = types.map(() => '?').join(', ');
    const res = await this.exec.execute({
      sql: `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
            WHERE userId = ? AND type IN (${placeholders})`,
      args: [userId, ...types],
    });
    const total = (res.rows[0] as Record<string, unknown> | undefined)?.total;
    return toNum(total, 0);
  }

  /** True when a user already received an ADMIN_ADJUSTMENT giveaway on this IST date. */
  async hasAdminGiveawayToday(userId: string, istDate: string): Promise<boolean> {
    const res = await this.exec.execute({
      sql: `SELECT 1 AS hit FROM transactions
            WHERE userId = ? AND type = 'ADMIN_ADJUSTMENT'
              AND createdAt LIKE ?
            LIMIT 1`,
      args: [userId, `${istDate}%`],
    });
    return res.rows.length > 0;
  }

  // ------------------------------------------------------- provider safety ---

  /**
   * Read provider safety, SYNTHESISING the same AVAILABLE default the JSON store
   * produces when no row exists.
   *
   * This is the Part 4 parity fix. The raw libSQL read returns NULL for a
   * provider that has never been written; returning that null would make the
   * Turso path behave differently from production (a caller testing `!record`
   * would treat "never seen" as "blocked"). Normalisation also matches JSON, so
   * a hand-edited or legacy row still cannot crash the API.
   */
  async getProviderSafety(provider: string): Promise<ProviderSafetyRecord> {
    const res = await this.exec.execute({
      sql: 'SELECT * FROM providerSafety WHERE provider = ?',
      args: [provider],
    });
    const row = res.rows[0];
    if (row === undefined) {
      return defaultProviderSafety(provider);
    }
    return decodeProviderRow(row as Record<string, unknown>);
  }

  /** Apply a partial provider-safety update and persist it. */
  async patchProviderSafety(
    provider: string,
    patch: Partial<ProviderSafetyRecord>
  ): Promise<ProviderSafetyRecord> {
    const current = await this.getProviderSafety(provider);
    const next = normalizeProviderSafety(
      { ...(current as unknown as Record<string, unknown>), ...patch, provider },
      provider
    );
    const balance = next.balance;
    // Flattened balance columns, identical to TursoStore.upsertProviderSafety.
    await this.exec.execute({
      sql: `INSERT INTO providerSafety (provider, status, reason, lastError, lastHttpStatus, lastErrorAt, blockedAt, updatedAt, consecutiveFailures, lastSuccessAt, balanceKnown, balancePercent, balanceUnit, balanceSource, balanceUpdatedAt, lastResetAt, lastResetBy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
              status = excluded.status,
              reason = excluded.reason,
              lastError = excluded.lastError,
              lastHttpStatus = excluded.lastHttpStatus,
              lastErrorAt = excluded.lastErrorAt,
              blockedAt = excluded.blockedAt,
              updatedAt = excluded.updatedAt,
              consecutiveFailures = excluded.consecutiveFailures,
              lastSuccessAt = excluded.lastSuccessAt,
              balanceKnown = excluded.balanceKnown,
              balancePercent = excluded.balancePercent,
              balanceUnit = excluded.balanceUnit,
              balanceSource = excluded.balanceSource,
              balanceUpdatedAt = excluded.balanceUpdatedAt,
              lastResetAt = excluded.lastResetAt,
              lastResetBy = excluded.lastResetBy`,
      args: [
        provider,
        next.status,
        next.reason ?? null,
        next.lastError ?? null,
        next.lastHttpStatus ?? null,
        next.lastErrorAt ?? null,
        next.blockedAt ?? null,
        next.updatedAt,
        next.consecutiveFailures,
        next.lastSuccessAt ?? null,
        balance.known ? 1 : 0,
        balance.percent ?? null,
        balance.unit ?? null,
        balance.source ?? null,
        balance.updatedAt ?? null,
        next.lastResetAt ?? null,
        next.lastResetBy ?? null,
      ],
    });
    return next;
  }
}

/**
 * The exact record the JSON `ProviderSafetyRepo.get()` synthesises when no state
 * has ever been stored. Shared so the two providers cannot drift.
 */
export function defaultProviderSafety(provider: string): ProviderSafetyRecord {
  return {
    provider,
    status: 'AVAILABLE',
    reason: null,
    updatedAt: new Date(0).toISOString(),
    consecutiveFailures: 0,
    balance: { known: false },
  } as ProviderSafetyRecord;
}

/**
 * Rehydrate a `providerSafety` row. The table stores balance flattened across
 * `balanceKnown`/`balancePercent`/... rather than as a JSON blob, so the object
 * form is rebuilt here exactly as `TursoStore.deserializeProviderSafety` does.
 */
function decodeProviderRow(row: Record<string, unknown>): ProviderSafetyRecord {
  const known = toNum(row.balanceKnown, 0) === 1;
  return normalizeProviderSafety(
    {
      provider: row.provider,
      status: row.status,
      reason: row.reason,
      lastError: row.lastError,
      lastHttpStatus: row.lastHttpStatus,
      lastErrorAt: row.lastErrorAt,
      blockedAt: row.blockedAt,
      updatedAt: row.updatedAt,
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt,
      balance: {
        known,
        percent: row.balancePercent,
        unit: row.balanceUnit,
        source: row.balanceSource,
        updatedAt: row.balanceUpdatedAt,
      },
      lastResetAt: row.lastResetAt,
      lastResetBy: row.lastResetBy,
    } as unknown as ProviderSafetyRecord,
    String(row.provider)
  );
}

function randomId(): string {
  // Same id shape and source the JSON repositories emit (`repos.ts` `newId`).
  return randomUUID();
}