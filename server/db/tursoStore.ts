/**
 * Turso/libSQL-backed data store implementing the same interface as DataStore.
 *
 * This provides a persistent, distributed SQLite backend via Turso (libSQL)
 * while preserving the exact same mutation/snapshot/persistence semantics
 * as the JSON-file DataStore. Repositories in `repos.ts` consume the same
 * DataStore interface, so business logic is unchanged.
 *
 * Schema: The existing JSON structure maps 1:1 to relational tables.
 * Each top-level array in the JSON becomes a table. The table's primary key
 * mirrors the source record's identity exactly — a UUID where the JSON record
 * carries one (`id`), and the composite (userId, startedAt) for
 * communityRestrictions, whose source records have no `id`. Identity is never
 * invented: a column is only auto-generated where the source model does it.
 * All fields are stored as TEXT/INTEGER/REAL with JSON blobs for nested objects.
 */

import { createClient, type InArgs as LibsqlInArgs } from '@libsql/client';

type SqlArgs = LibsqlInArgs;
import {
  DB_VERSION,
  type CommunityMessageRecord,
  type CommunityRestrictionRecord,
  type DbShape,
  type LoginActivityRecord,
  type LoginAlertRecord,
  type ModerationCaseRecord,
  type ProviderSafetyRecord,
  type UserRecord,
  emptyDbShape,
} from './types';
import {
  normalizeUser,
  normalizeProviderSafety,
  normalizeModerationCases,
  normalizeRestrictions,
  normalizeCommunityMessages,
  normalizeLoginActivity,
  normalizeLoginAlerts,
} from './store';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '@libsql/client';
import { TursoScope, liftTransactionMetadata, transactionExtraColumn } from './tursoScope';
import { WriteMutex } from './writeMutex';
import {
  applyCreditIdentityMigration,
  CREDIT_IDENTITY_INDEXES,
} from './creditIdentityIndexes';

/**
 * Column definitions per table, without the surrounding parentheses, so
 * `init()` can build `CREATE TABLE IF NOT EXISTS <table> (<columns>)` directly
 * instead of parsing DDL text.
 *
 * Column types mirror the source JSON model: a field that is optional or
 * simply absent on most records is declared nullable, and a required field that
 * the application always supplies gets `NOT NULL DEFAULT 0` / `NOT NULL` so
 * rows written before a column existed still load.
 */
const TABLE_COLUMNS: Record<string, string> = {
  users: `
    id TEXT PRIMARY KEY,
    tokenHashes TEXT NOT NULL DEFAULT '[]',
    credits INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'USER',
    creditMode TEXT NOT NULL DEFAULT 'NORMAL',
    createdAt TEXT NOT NULL,
    lastSeenAt TEXT,
    freeTrialsUsed INTEGER NOT NULL DEFAULT 0,
    ownerEmail TEXT,
    email TEXT,
    passwordHash TEXT,
    lastLoginAt TEXT,
    purchasedCredits INTEGER NOT NULL DEFAULT 0,
    bonusCredits INTEGER NOT NULL DEFAULT 0,
    UNIQUE(email)
  `,
  // `creditTxnId` links a job to its DEBIT ledger entry and `retryCount` drives
  // auto-retry bookkeeping; both exist on JobRecord and were written by the
  // server but had no column, so they would have been silently dropped.
  jobs: `
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    nextRetryAt TEXT,
    provider TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    lastError TEXT,
    errorCode TEXT,
    creditsCharged INTEGER,
    creditTxnId TEXT,
    retryCount INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(userId) REFERENCES users(id)
  `,
  // `jobId` is load-bearing: forJobAndType() (debitForJob/refundForJob/
  // reservationForJob/usageForJob/releaseForJob) selects by (userId, jobId,
  // type) and that per-job lookup is what makes charging a job idempotent.
  // `idempotencyKey` is nullable because only ADMIN_* operations supply one;
  // every other transaction type omits it, so NOT NULL was wrong.
  // `paymentId` is the canonical application field on CreditTransactionRecord:
  // every purchase write path sets it and the Excel export reads it from there,
  // and CreditRepo.findByPaymentId() matches on exactly this field, so the JSON
  // and Turso stores resolve a gateway payment id identically. It is a
  // first-class nullable column; nothing is derived into `extra`.
  // `extra` is the legacy free-form bag: kept because the migration must carry a
  // source record's unknown fields across without dropping them, and it is
  // declared as a JSON blob, but no application write path populates it.
  transactions: `
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    balanceBefore INTEGER,
    balanceAfter INTEGER NOT NULL,
    idempotencyKey TEXT,
    createdAt TEXT NOT NULL,
    adminUserId TEXT,
    adminEmail TEXT,
    jobId TEXT,
    paymentId TEXT,
    extra TEXT,
    FOREIGN KEY(userId) REFERENCES users(id)
  `,
  providerSafety: `
    provider TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'AVAILABLE',
    reason TEXT,
    lastError TEXT,
    lastHttpStatus INTEGER,
    lastErrorAt TEXT,
    blockedAt TEXT,
    updatedAt TEXT NOT NULL,
    consecutiveFailures INTEGER NOT NULL DEFAULT 0,
    lastSuccessAt TEXT,
    balanceKnown INTEGER NOT NULL DEFAULT 0,
    balancePercent REAL,
    balanceUnit TEXT,
    balanceSource TEXT,
    balanceUpdatedAt TEXT,
    lastResetAt TEXT,
    lastResetBy TEXT
  `,
  moderationCases: `
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    confidence TEXT NOT NULL,
    automatic INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    reason TEXT,
    excerpt TEXT,
    restrictionStartedAt TEXT,
    restrictionExpiresAt TEXT,
    adminUserId TEXT,
    adminEmail TEXT,
    adminNote TEXT,
    reviewedAt TEXT,
    reviewedBy TEXT
  `,
  // CommunityRestrictionRecord has no `id` and nothing in the application ever
  // generated, read or looked one up, so the previous `id TEXT PRIMARY KEY`
  // could only ever be filled with an invented value. The record's identity is
  // the (userId, startedAt) pair it is always queried by; both columns are
  // immutable in the app (extend/release only mutate expiresAt/releasedAt), so
  // they are a deterministic, retry-safe primary key derived purely from source
  // fields. See scripts/migrate-to-production.ts ENTITY_SPECS.
  communityRestrictions: `
    userId TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    violationCount INTEGER NOT NULL,
    automatic INTEGER NOT NULL DEFAULT 1,
    extendedCount INTEGER NOT NULL DEFAULT 0,
    releasedAt TEXT,
    releasedBy TEXT,
    PRIMARY KEY (userId, startedAt)
  `,
  communityMessages: `
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT,
    body TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    moderationCaseId TEXT,
    attachmentName TEXT,
    attachmentMime TEXT,
    attachmentBytes INTEGER,
    attachmentKey TEXT
  `,
  loginActivity: `
    id TEXT PRIMARY KEY,
    userId TEXT,
    email TEXT,
    loginDate TEXT NOT NULL,
    loginTime TEXT,
    istDateTime TEXT NOT NULL,
    month TEXT NOT NULL,
    occurredAt TEXT NOT NULL,
    method TEXT NOT NULL,
    outcome TEXT NOT NULL,
    failureCode TEXT,
    ip TEXT,
    userAgent TEXT
  `,
  // `generatedAt` used to be declared twice, which makes CREATE TABLE fail with
  // "duplicate column name". One declaration, still NOT NULL.
  // `periodDate` is the alert's real business key: loginAlertService.ts keys
  // "yesterday's logins" by it, guards on it before dispatching a transport, and
  // documents that re-issuing replaces rather than appends. UNIQUE(periodDate)
  // makes the database enforce that, so two alert ids can never become two
  // business records for one day. saveAlert() therefore upserts on periodDate.
  loginAlerts: `
    id TEXT PRIMARY KEY,
    alertDate TEXT NOT NULL,
    periodDate TEXT NOT NULL,
    month TEXT NOT NULL,
    generatedAt TEXT NOT NULL,
    totalLogins INTEGER NOT NULL DEFAULT 0,
    uniqueUsers INTEGER NOT NULL DEFAULT 0,
    newUsers INTEGER NOT NULL DEFAULT 0,
    activeUsers INTEGER NOT NULL DEFAULT 0,
    failedLogins INTEGER NOT NULL DEFAULT 0,
    topUsers TEXT,
    deliveryStatus TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    statusMessage TEXT,
    UNIQUE(periodDate)
  `,
};

/**
 * Columns that hold a JSON blob encoded as TEXT, per table.
 *
 * This is the read-side mirror of the `JSON.stringify(...)` call sites below
 * (createUser/updateUser, createJob/updateJob, the transaction `extra` writer,
 * saveAlert) and of the `json: true` flags in scripts/migrate-to-production.ts
 * ENTITY_SPECS. Every
 * other TEXT column (communityMessages.body, moderationCases.excerpt,
 * jobs.lastError, loginActivity.userAgent, ...) is plain text and must stay a
 * string, so it is deliberately absent from this list.
 */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  users: ['tokenHashes'],
  jobs: ['input', 'output'],
  transactions: ['extra'],
  loginAlerts: ['topUsers'],
};

/**
 * Decode one JSON column value.
 *
 * - `null`/`undefined` stay `null`: an absent blob must not become `{}`/`[]`.
 * - A non-string is already a decoded value and is returned untouched, so a
 *   value is never parsed twice.
 * - Malformed JSON throws, naming the table, column and offending text, rather
 *   than silently degrading to `undefined` and losing the record's data.
 * - JSON types are preserved: arrays stay arrays, objects stay objects, and
 *   nested numbers/booleans/null keep their type instead of arriving as text.
 */
function decodeJsonColumn(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(
      `TursoStore: ${table}.${column} does not hold valid JSON ` +
        `(stored value: ${JSON.stringify(value)}): ${(err as Error).message}`
    );
  }
}

/** Decode every JSON blob column of `table` present on one row. */
function decodeJsonRow<T>(table: string, row: T): T {
  const columns = JSON_COLUMNS[table];
  if (!columns || row === null || typeof row !== 'object') return row;
  const decoded: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const column of columns) {
    if (!(column in decoded)) continue;
    decoded[column] = decodeJsonColumn(table, column, decoded[column]);
  }
  if (table === 'transactions') {
    // The ledger table persists packageId/paymentStatus inside `extra` (they
    // have no column), so every read of a transaction row lifts them back onto
    // the typed fields. This is the single choke point for the store-level
    // read paths (queryTable feeds getTransactions*, getTransactionBy* and
    // snapshot()), mirroring TursoScope.toTransaction for the scope paths.
    // A real column value, if the schema ever gains one, wins over the bag.
    const { extra, metadata } = liftTransactionMetadata(decoded.extra);
    decoded.extra = extra;
    for (const [field, value] of Object.entries(metadata)) {
      if (decoded[field] === undefined) decoded[field] = value;
    }
  }
  return decoded as T;
}

/**
 * Schema contract version recorded in the `schema_migrations` marker table.
 *
 * Bump this whenever TABLE_COLUMNS, JSON_COLUMNS or the declared UNIQUE keys
 * change, so an already-provisioned database with an older shape is reported
 * instead of silently accepted. `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so this marker is the only way to notice.
 */
export const SCHEMA_VERSION = 3;

/**
 * First schema contract version that PROMISES database-level money-identity
 * uniqueness, and therefore requires the three identity indexes to exist.
 *
 * Tracked separately from SCHEMA_VERSION so validateSchema() can be asked about
 * an older contract without hard-coding "3": a database validated against a
 * pre-Stage-5D version predates the indexes, so demanding them there would
 * reject a shape that is legitimately not supposed to have them.
 */
const IDENTITY_INDEX_SCHEMA_VERSION = 3;

/**
 * How long a queued writer waits for its slot before failing loudly.
 *
 * Deliberately well under any plausible client/gateway timeout: a credit write
 * that commits after the caller has already given up is worse than a fast,
 * visible failure, because the gateway would consider the payment taken while
 * the ledger row appeared with nobody left to reconcile it.
 */
const TURSO_WRITE_LOCK_TIMEOUT_MS = 15_000;

/**
 * Message for the two unsupported whole-database entry points. Single source of
 * truth so mutate() and mutateAsync() cannot drift apart in what they promise.
 */
const TURSO_SNAPSHOT_WRITE_UNSUPPORTED =
  'TursoStore cannot persist a whole-database snapshot: mutate()/mutateAsync() are not ' +
  'supported because the repository layer in server/db/repos.ts is synchronous. Use the ' +
  'per-entity async methods (createUser, updateUser, addTransaction, saveAlert, ...) instead.';

/** True for a table-level constraint rather than a column definition. */
function isConstraintKeyword(token: string): boolean {
  return /^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(token);
}

/**
 * Split a column list on top-level commas only, so a comma inside
 * `PRIMARY KEY (userId, startedAt)` or `UNIQUE(periodDate)` is not treated as a
 * column separator.
 */
function splitTopLevel(declaration: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of declaration) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * Create a TursoStore instance.
 * @param url Turso database URL (e.g., libsql://my-db.turso.io)
 * @param authToken Turso authentication token
 */
export async function createTursoStore(url: string, authToken: string): Promise<TursoStore> {
  const client = createClient({ url, authToken });
  const store = new TursoStore(client);
  await store.init();
  return store;
}

export class TursoStore {
  private readonly client: ReturnType<typeof createClient>;

  /**
   * Serializes write transactions in-process, FIFO. Required because libSQL opens
   * each transaction on a fresh connection with `busy_timeout = 0`, so
   * overlapping writers would otherwise fail instantly with `SQLITE_BUSY` — and
   * for a paid webhook that means money taken with no ledger row.
   *
   * Only WRITES are queued. Every read path uses the pool directly and never
   * enters this queue, so read latency is unaffected.
   */
  private readonly writeLock = new WriteMutex(TURSO_WRITE_LOCK_TIMEOUT_MS);

  /**
   * Depth of the write transaction owning the CURRENT async execution context.
   *
   * This replaces a plain instance-wide boolean, which could not tell a genuinely
   * nested `unitOfWork()` (a programming error that must fail loudly) from an
   * unrelated concurrent request (which must simply wait its turn). AsyncLocal
   * storage gives per-request context, so the two cases are finally separable.
   */
  private readonly txDepth = new AsyncLocalStorage<number>();

  /**
   * Whether foreign-key enforcement was confirmed active for this connection.
   * See enableForeignKeys(); exposed so a caller (and the tests) can tell an
   * enforced database from one where the driver ignored the pragma.
   */
  private foreignKeysEnforced = false;

  constructor(client: ReturnType<typeof createClient>) {
    this.client = client;
  }

  /** True when the last init() confirmed `PRAGMA foreign_keys` is ON. */
  get foreignKeysActive(): boolean {
    return this.foreignKeysEnforced;
  }

  /** Initialize tables and load any existing data. */
  async init(): Promise<void> {
    // journal_mode/synchronous are connection settings of the local file driver.
    // A remote libsql:// endpoint (Turso) has no local journal file, so issuing
    // them there is meaningless; `EXPLAIN PRAGMA journal_mode` is the cheapest
    // probe for "is this an embedded SQLite connection".
    if (await this.isEmbeddedDriver()) {
      // Both are tuning settings, not correctness: a database that refuses them
      // still works (with less write concurrency), so a driver quirk here must
      // never stop the server from starting.
      await this.client.execute('PRAGMA journal_mode=WAL').catch(() => undefined);
      await this.client.execute('PRAGMA synchronous=NORMAL').catch(() => undefined);
      // Helps contention on the ROOT connection only. It is NOT transaction
      // protection: @libsql/client's `transaction()` sets `this.#db = null` and
      // begins on a freshly created connection, which starts from SQLite's
      // default busy_timeout of 0. The driver exposes no way to change that
      // (no timeout/busy handling in its sqlite3 backend), so two concurrent
      // write transactions on an embedded `file:` database fail fast with
      // SQLITE_BUSY rather than queueing. That is safe (the loser rolls back
      // having written nothing) but it means write serialisation for the local
      // driver must come from the caller. Recorded in the Stage 5D report.
      await this.client.execute('PRAGMA busy_timeout=5000').catch(() => undefined);
    }

    // Meaningful on every SQLite connection, so unlike the journal settings it
    // is not gated on the driver. Verified by read-back; a driver that refuses
    // it is reported rather than guessed at.
    this.foreignKeysEnforced = await this.enableForeignKeys();

    // Create all tables. `IF NOT EXISTS` never alters an existing table, so an
    // older database keeps its old shape; validateSchema() below reports that
    // rather than letting the mismatch surface later as a failed INSERT.
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      await this.client.execute(`CREATE TABLE IF NOT EXISTS ${table} (${columns.trim()})`);
    }

    // Marker table recording which schema contract this database was built with.
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`
    );

    // Stage 5D: money-identity uniqueness.
    //
    // Ordering matters. `CREATE TABLE IF NOT EXISTS` above can never add a
    // constraint to a table that already exists, so an older database would keep
    // running with no uniqueness at all while the version marker claims this
    // build. Creating the indexes here closes that gap.
    //
    // This is additive only. If existing rows already violate an index, the
    // migration throws and changes nothing — it never picks a winner or deletes
    // a financial row. Set TURSO_SKIP_IDENTITY_MIGRATION=1 to skip creation for
    // inspection and use planCreditIdentityMigration() instead; see below for why
    // that flag can no longer leave the database stamped but unprotected.
    if (process.env.TURSO_SKIP_IDENTITY_MIGRATION === '1') {
      // Stage 6B: the bypass is an inspection aid, NOT a licence to run
      // unprotected. The marker at the end of init() is only written once the
      // indexes are genuinely present, so a skipped migration can never certify
      // a database that would accept a double credit. This throws BEFORE the
      // marker and before any write, so nothing is recorded and no row is touched.
      const missing = await this.missingIdentityIndexes();
      if (missing.length > 0) {
        throw new Error(
          `TURSO_SKIP_IDENTITY_MIGRATION=1 is set, but ${missing.length} of ` +
            `${CREDIT_IDENTITY_INDEXES.length} required money-identity indexes are absent, so ` +
            `schema version ${SCHEMA_VERSION} was NOT recorded. Missing: ${missing.join('; ')}. ` +
            `This flag skips index creation for inspection; it cannot make a database protected. ` +
            `Unset TURSO_SKIP_IDENTITY_MIGRATION and restart so the migration can create them, ` +
            `after reviewing the read-only planCreditIdentityMigration() output. No data was changed.`
        );
      }
    } else {
      await applyCreditIdentityMigration(this.client);
    }

    // The expected version is passed explicitly: v3 is only ever recorded after
    // the identity indexes have been created and re-verified above.
    const problems = await this.validateSchema(SCHEMA_VERSION);
    if (problems.length > 0) {
      // Reported, never repaired: no ALTER/DROP here. A human decides.
      throw new Error(
        `Turso schema is incompatible with this build (expected schema v${SCHEMA_VERSION}). ` +
          `No changes were made. Problems: ${problems.join('; ')}`
      );
    }

    await this.exec('INSERT OR IGNORE INTO schema_migrations (version, appliedAt) VALUES (?, ?)', [
      SCHEMA_VERSION,
      new Date().toISOString(),
    ]);
  }

  /**
   * True only for an embedded/local SQLite connection (e.g. `file::memory:` or a
   * `file:` path). Remote HTTP replicas and Turso return no journal mode here, so
   * driver-specific pragmas are skipped for them.
   *
   * The probe is a plain `PRAGMA journal_mode` read and must NOT be written as
   * `EXPLAIN PRAGMA journal_mode`: compiling a statement through EXPLAIN leaves
   * a read transaction open in @libsql/client's embedded driver, and the
   * `PRAGMA journal_mode=WAL` that follows then fails with "cannot change into
   * wal mode from within a transaction" on any real file-backed database. That
   * only shows up for a `file:` URL, because `file::memory:` silently ignores the
   * mode switch.
   */
  private async isEmbeddedDriver(): Promise<boolean> {
    try {
      const result = await this.client.execute('PRAGMA journal_mode');
      const row = result.rows[0] as { journal_mode?: unknown } | undefined;
      const mode = String(row?.journal_mode ?? '').toLowerCase();
      // SQLite answers with one of its journal modes. A driver that does not
      // implement the pragma answers with nothing, or throws above.
      return ['delete', 'truncate', 'persist', 'memory', 'wal', 'off'].includes(mode);
    } catch {
      return false;
    }
  }

  /**
   * Compare the live schema against TABLE_COLUMNS. Read-only: it inspects
   * `sqlite_master` and `PRAGMA table_info` and returns human-readable problems.
   * An empty array means the database matches this build.
   *
   * @param expectedVersion The schema contract the caller intends to rely on.
   *   Defaults to SCHEMA_VERSION. From IDENTITY_INDEX_SCHEMA_VERSION onwards the
   *   three money-identity indexes are part of that contract, so their absence is
   *   reported like any other incompatibility. Pass an older version to validate a
   *   pre-identity shape without demanding indexes it never promised to have.
   */
  async validateSchema(expectedVersion: number = SCHEMA_VERSION): Promise<string[]> {
    const problems: string[] = [];
    const existing = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    const present = new Set(existing.rows.map((r) => String(r.name)));

    for (const [table, declaration] of Object.entries(TABLE_COLUMNS)) {
      if (!present.has(table)) {
        problems.push(`missing table ${table}`);
        continue;
      }
      const info = await this.client.execute(`PRAGMA table_info(${table})`);
      const actual = info.rows as unknown as { name: string }[];
      const actualNames = new Set(actual.map((c) => c.name));

      // Every column the build expects, including UNIQUE(periodDate)'s column.
      const expected = new Set<string>();
      for (const part of splitTopLevel(declaration)) {
        const name = part.split(/\s+/)[0];
        if (name && !isConstraintKeyword(name)) expected.add(name);
      }
      for (const name of expected) {
        if (!actualNames.has(name)) problems.push(`${table} is missing column ${name}`);
      }

      // A declared UNIQUE key must really exist: an older table created before
      // the constraint was added would otherwise silently allow duplicates.
      for (const unique of declaration.matchAll(/UNIQUE\s*\(\s*([A-Za-z0-9_]+)\s*\)/gi)) {
        const column = unique[1];
        const ddl = await this.tableDdl(table);
        if (!new RegExp(`UNIQUE\\s*\\(\\s*${column}\\s*\\)`, 'i').test(ddl)) {
          problems.push(`${table}.${column} is missing its UNIQUE constraint`);
        }
      }
    }
    // Stage 6B: from IDENTITY_INDEX_SCHEMA_VERSION onwards the three identity
    // indexes are part of the contract, not an optional extra — the version
    // marker asserts this database cannot express a double credit. Detection is
    // delegated to missingIdentityIndexes() so init()'s pre-marker check and this
    // validation can never disagree about what "protected" means.
    if (expectedVersion >= IDENTITY_INDEX_SCHEMA_VERSION) {
      for (const entry of await this.missingIdentityIndexes()) {
        problems.push(`missing required money-identity index ${entry}`);
      }
    }

    return problems;
  }

  /**
   * Missing money-identity indexes, as `table: index` strings.
   *
   * The single source of truth for "is this database protected?", used both by
   * init() before the schema marker is written and by validateSchema(). An empty
   * array means the database cannot accept two rows for one payment, one admin
   * idempotency key, or one job+type.
   */
  private async missingIdentityIndexes(): Promise<string[]> {
    const res = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ux_transactions_%'"
    );
    const present = new Set(res.rows.map((r) => String(r.name)));
    return CREDIT_IDENTITY_INDEXES.filter((i) => !present.has(i.name)).map((i) => `${i.table}: ${i.name}`);
  }

  /** The stored CREATE TABLE text for a table, or '' when it is not a table. */
  private async tableDdl(table: string): Promise<string> {
    const rows = await this.client.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      args: [table] as SqlArgs,
    });
    return String(rows.rows[0]?.sql ?? '');
  }

  /** Execute a SELECT query and return rows. */
  private async query<T>(sql: string, args: readonly unknown[] = []): Promise<T[]> {
    const result = await this.client.execute({ sql, args: args as SqlArgs });
    return result.rows as T[];
  }

  /**
   * SELECT against one of the mapped tables, decoding its JSON blob columns.
   *
   * Every read path for a table listed in JSON_COLUMNS goes through here, so a
   * `SELECT *` can never hand a caller a raw JSON string where the DataStore
   * interface promises an array/object.
   */
  private async queryTable<T>(table: string, sql: string, args: readonly unknown[] = []): Promise<T[]> {
    return (await this.query<T>(sql, args)).map((row) => decodeJsonRow(table, row));
  }

  /** Single-row form of queryTable(); null when the query matched nothing. */
  private async queryTableRow<T>(table: string, sql: string, args: unknown[] = []): Promise<T | null> {
    const rows = await this.queryTable<T>(table, sql, args);
    return rows[0] ?? null;
  }

  /**
   * Turn foreign-key enforcement on and report whether it is actually active.
   *
   * `PRAGMA foreign_keys` is a per-connection setting that SQLite itself
   * defaults to OFF, so it is issued explicitly here rather than inherited from
   * whatever the driver happens to do. The embedded (`file:`) driver used by the
   * tests does enable it by default; the HTTP client used for a real
   * `libsql://` endpoint is a different code path and the server ultimately
   * decides, so the value is read back and reported instead of assumed. Nothing
   * is written or deleted either way — this only decides whether an INSERT that
   * references a missing parent is rejected.
   */
  private async enableForeignKeys(): Promise<boolean> {
    try {
      await this.client.execute('PRAGMA foreign_keys = ON');
      const probe = await this.client.execute('PRAGMA foreign_keys');
      const raw = probe.rows[0]?.foreign_keys;
      return raw !== undefined && raw !== null && Number(raw) === 1;
    } catch {
      // A driver that refuses the pragma still serves every other operation;
      // report "not enforced" rather than failing startup on it.
      return false;
    }
  }

  /** Execute a non-SELECT statement. */
  private async exec(sql: string, args: readonly unknown[] = []): Promise<void> {
    await this.client.execute({ sql, args: args as SqlArgs });
  }

  /**
   * Execute a non-SELECT statement and report how many rows it actually
   * changed.
   *
   * Needed for compare-and-set work (see `claimDailyLoginAlert`): `exec()`
   * throws the write result away, but "did my INSERT win the race, or did
   * another caller already own this row?" IS the answer we are after. SQLite
   * returns 0 affected rows for a no-op `ON CONFLICT DO NOTHING`, which is
   * precisely the losing case.
   */
  private async execCount(sql: string, args: readonly unknown[] = []): Promise<number> {
    const result: any = await this.client.execute({ sql, args: args as SqlArgs });
    return Number(result?.rowsAffected ?? 0);
  }

  /**
   * Run `fn` inside a single write transaction: committed when it resolves,
   * rolled back if it throws or rejects.
   *
   * `@libsql/client`'s own `transaction()` does NOT take a callback. Its
   * signature is `transaction(mode)`, and it returns a handle that the caller
   * must `commit()` or `rollback()` itself; passing a function as the first
   * argument is read as a mode and rejected with "Unknown transaction mode".
   * This wrapper is what makes atomic multi-statement work (recordLoginActivity's
   * insert + retention trim) actually run, and it guarantees the rollback path
   * so a failure cannot leave a half-applied transaction open.
   *
   * NESTING IS REJECTED, not silently tolerated. libSQL gives one connection one
   * open write transaction; a nested call would either fail obscurely deep in the
   * driver or commit the outer work early. Failing loudly at the boundary turns a
   * latent data bug into an immediate, attributable error.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    // NESTING IS REJECTED, not silently tolerated. libSQL gives one connection one
    // open write transaction; a nested call would either fail obscurely deep in the
    // driver or commit the outer work early. Failing loudly at the boundary turns a
    // latent data bug into an immediate, attributable error.
    //
    // The guard is scoped to the current async context, NOT the instance: a
    // concurrent-but-unrelated request waits its turn below instead of being
    // misreported as a nesting bug.
    if ((this.txDepth.getStore() ?? 0) > 0) {
      throw new Error(
        'TursoStore: nested transaction attempted. A write transaction is already open in ' +
          'this async context; move the inner work into the existing transaction() callback ' +
          'instead of opening a second one.',
      );
    }

    // Serialize writers. `fn` keeps full ownership of commit/rollback, so rollback
    // semantics are unchanged and a failure still propagates to the caller.
    return this.txDepth.run(1, () =>
      this.writeLock.runExclusive(async () => {
        const tx = (await this.client.transaction('write')) as unknown as Transaction;
        try {
          const result = await fn(tx);
          await tx.commit();
          return result;
        } catch (err) {
          try {
            await tx.rollback();
          } catch {
            // Already closed or never opened; the original failure is the one that
            // matters and is rethrown below.
          }
          throw err;
        }
      }),
    );
  }

  /**
   * Transaction-scoped Unit of Work: hand `fn` a repository facade bound to one
   * write transaction, and commit only when `fn` resolves.
   *
   * `fn` never sees the libSQL handle. It receives a `TursoScope`, which exposes
   * only the per-entity operations the credit and provider-safety flows need and
   * has no `commit`/`rollback`, so business logic cannot end the transaction
   * early or issue raw SQL that skips this provider's encoding rules.
   *
   * Guarantees, by construction:
   *   - commit happens only on success
   *   - any throw or rejection rolls back and rethrows the ORIGINAL error
   *   - a nested `unitOfWork()` is rejected (see `transaction()`)
   *   - there is no fallback to the JSON store: this path is libSQL only
   */
  async unitOfWork<T>(fn: (scope: TursoScope) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => fn(new TursoScope(tx)));
  }

  /**
   * A scope bound to the root connection, for read-only use outside a
   * transaction. Writes through it are NOT atomic with anything else; prefer
   * `unitOfWork()` for any flow that changes money or counters.
   *
   * This is the only scope that may open a transaction of its own, which is how
   * `UnitOfWork<TursoScope>` is satisfied without exposing the libSQL handle.
   */
  rootScope(): TursoScope {
    return new TursoScope(this.client, (fn) => this.unitOfWork(fn));
  }

  /** Get all users. */
  async getUsers(): Promise<UserRecord[]> {
    return this.queryTable<UserRecord>('users', 'SELECT * FROM users ORDER BY lastSeenAt DESC NULLS LAST, createdAt DESC');
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.queryTableRow<UserRecord>('users', 'SELECT * FROM users WHERE id = ?', [id]);
  }

  async getUserByToken(tokenHash: string): Promise<UserRecord | null> {
    // Matching happens against the stored JSON text (unchanged); only the row
    // that comes back needs decoding.
    return this.queryTableRow<UserRecord>('users', "SELECT * FROM users WHERE tokenHashes LIKE ?", [`%${tokenHash}%`]);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    return this.queryTableRow<UserRecord>('users', 'SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  }

  async createUser(user: UserRecord): Promise<void> {
    await this.exec(
      `INSERT INTO users (id, tokenHashes, credits, role, creditMode, createdAt, lastSeenAt, freeTrialsUsed, ownerEmail, email, passwordHash, lastLoginAt, purchasedCredits, bonusCredits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      JSON.stringify(user.tokenHashes ?? []),
      user.credits ?? 0,
      user.role ?? 'USER',
      user.creditMode ?? 'NORMAL',
      user.createdAt,
      user.lastSeenAt ?? null,
      // Optional on UserRecord and defaulted by normalizeUser(); apply the same
      // defaults here so a partial record cannot send `undefined` to the driver.
      user.freeTrialsUsed ?? 0,
      user.ownerEmail ?? null,
      user.email ?? null,
      user.passwordHash ?? null,
      user.lastLoginAt ?? null,
      user.purchasedCredits ?? 0,
      user.bonusCredits ?? 0,
    ]);
  }

  async updateUser(id: string, patch: Partial<UserRecord>): Promise<void> {
    const fields: string[] = [];
    const args: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      // `id` is the row identifier, not a patchable column: it selects the row
      // and must never be settable, or a patch could rewrite the primary key.
      if (key === 'id') continue;
      if (key === 'tokenHashes') {
        fields.push('tokenHashes = ?');
        args.push(JSON.stringify(value));
      } else if (key === 'email' || key === 'ownerEmail' || key === 'passwordHash' || key === 'lastLoginAt') {
        fields.push(`${key} = ?`);
        args.push(value ?? null);
      } else if (typeof value === 'number' || typeof value === 'string') {
        fields.push(`${key} = ?`);
        args.push(value);
      } else if (typeof value === 'boolean') {
        fields.push(`${key} = ?`);
        args.push(value ? 1 : 0);
      }
    }
    if (fields.length === 0) return;
    // Select the row by the `id` ARGUMENT (same convention as updateJob), never
    // by patch.id: the old `patch.id ?? ''` matched no row for a normal call and
    // silently redirected the write to whichever user a patch named.
    args.push(id);
    await this.exec(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, args);
  }

  // --- Jobs ---
  async getJobs(): Promise<any[]> {
    return this.queryTable('jobs', 'SELECT * FROM jobs ORDER BY createdAt DESC');
  }

  async getJobById(id: string): Promise<any | null> {
    return this.queryTableRow('jobs', 'SELECT * FROM jobs WHERE id = ?', [id]);
  }

  async createJob(job: any): Promise<void> {
    await this.exec(
      `INSERT INTO jobs (id, userId, status, createdAt, startedAt, completedAt, nextRetryAt, provider, input, output, lastError, errorCode, creditsCharged, creditTxnId, retryCount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, job.userId, job.status, job.createdAt, job.startedAt ?? null, job.completedAt ?? null, job.nextRetryAt ?? null, job.provider, JSON.stringify(job.input), job.output ? JSON.stringify(job.output) : null, job.lastError ?? null, job.errorCode ?? null, job.creditsCharged ?? null, job.creditTxnId ?? null, job.retryCount ?? 0]);
  }

  async updateJob(id: string, patch: Partial<any>): Promise<void> {
    const fields: string[] = [];
    const args: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      // Stage 5C-4: `id` is the row identifier, not a patchable column. A job id
      // is minted once (randomUUID at enqueue) and is load-bearing outside this
      // row: srtKey()/uploadKey() derive storage object paths from it and
      // creditTxnId/refundFinishedJob key on it. No production caller has ever
      // passed `id` in a patch, and no FK references jobs(id), so a rewrite here
      // would silently desynchronise the row from storage and the credit ledger
      // instead of failing loudly. Mirrors the updateUser() rule.
      if (key === 'id') continue;
      if (key === 'input' || key === 'output') {
        fields.push(`${key} = ?`);
        args.push(value ? JSON.stringify(value) : null);
      } else if (typeof value === 'string' || typeof value === 'number') {
        fields.push(`${key} = ?`);
        args.push(value);
      } else if (typeof value === 'boolean') {
        fields.push(`${key} = ?`);
        args.push(value ? 1 : 0);
      }
    }
    if (fields.length === 0) return;
    args.push(id);
    await this.exec(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, args);
  }

  async getJobsByUser(userId: string): Promise<any[]> {
    return this.queryTable('jobs', 'SELECT * FROM jobs WHERE userId = ? ORDER BY createdAt DESC', [userId]);
  }

  async getEligibleQueued(nowIso: string): Promise<any[]> {
    // Single-quoted SQL string literals: SQLite resolves a double-quoted token
    // as an identifier, so `status = "QUEUED"` fails with "no such column".
    return this.queryTable('jobs', `SELECT * FROM jobs WHERE status = 'QUEUED' AND (nextRetryAt IS NULL OR nextRetryAt <= ?)`, [nowIso]);
  }

  async getProcessingJobs(): Promise<any[]> {
    return this.queryTable('jobs', `SELECT * FROM jobs WHERE status = 'PROCESSING'`);
  }

  async getQueuedJobs(): Promise<any[]> {
    return this.queryTable('jobs', `SELECT * FROM jobs WHERE status = 'QUEUED'`);
  }

  async getAllJobs(limit = 200): Promise<any[]> {
    return this.queryTable('jobs', 'SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?', [limit]);
  }

  // --- Transactions ---
  async getTransactions(): Promise<any[]> {
    return this.queryTable('transactions', 'SELECT * FROM transactions ORDER BY createdAt DESC');
  }

  async addTransaction(txn: any): Promise<void> {
    await this.exec(
      `INSERT INTO transactions (id, userId, type, amount, reason, balanceBefore, balanceAfter, idempotencyKey, createdAt, adminUserId, adminEmail, jobId, paymentId, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      txn.id,
      txn.userId,
      txn.type,
      txn.amount,
      txn.reason,
      txn.balanceBefore ?? null,
      txn.balanceAfter,
      txn.idempotencyKey ?? null,
      txn.createdAt,
      txn.adminUserId ?? null,
      txn.adminEmail ?? null,
      txn.jobId ?? null,
      txn.paymentId ?? null,
      transactionExtraColumn(txn),
    ]);
  }

  async getTransactionByIdempotencyKey(key: string, userId?: string, type?: string): Promise<any | null> {
    let sql = 'SELECT * FROM transactions WHERE idempotencyKey = ?';
    const args: unknown[] = [key];
    if (userId) {
      sql += ' AND userId = ?';
      args.push(userId);
    }
    if (type) {
      sql += ' AND type = ?';
      args.push(type);
    }
    return this.queryTableRow('transactions', sql, args);
  }

  /**
   * Find the first transaction of `type` for a user+job.
   *
   * Stage 5C-5: this is the Turso half of `CreditRepo.forJobAndType()`, which the
   * JSON store answers with `transactions.find(t => t.userId && t.jobId && t.type)`.
   * Every per-job credit guarantee rides on it -- debitForJob/refundForJob (the
   * charge/refund pair) and reservationForJob/usageForJob/releaseForJob (the
   * reserve/consume/release state machine) -- and 12 production call sites in
   * creditService.ts depend on it. `getTransactionByIdempotencyKey` does NOT
   * cover it: only ADMIN_* writes carry an idempotencyKey, so job transactions
   * store NULL there and can never be found through it.
   *
   * `find()` returns the earliest insertion, so this orders oldest-first with the
   * same `id` tiebreak `CreditRepo.listAllUnbounded()` uses, and takes one row.
   */
  async getTransactionByJobAndType(userId: string, jobId: string, type: string): Promise<any | null> {
    return this.queryTableRow(
      'transactions',
      'SELECT * FROM transactions WHERE userId = ? AND jobId = ? AND type = ? ORDER BY createdAt ASC, id ASC LIMIT 1',
      [userId, jobId, type]
    );
  }

  /**
   * Find the purchase/credit transaction for a gateway payment id.
   *
   * `paymentId` is the canonical application field on CreditTransactionRecord:
   * every purchase write path sets it and the Excel export reads it from there,
   * and `CreditRepo.findByPaymentId()` in repos.ts matches on exactly this
   * field. Both backends therefore resolve the same id the same way. Matching a
   * dedicated column also keeps NULL ids from colliding with each other.
   */
  async getTransactionByPaymentId(paymentId: string): Promise<any | null> {
    return this.queryTableRow('transactions', 'SELECT * FROM transactions WHERE paymentId = ?', [paymentId]);
  }

  async getTransactionsByUser(userId: string, limit = 50): Promise<any[]> {
    return this.queryTable('transactions', 'SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT ?', [userId, limit]);
  }

  async getAllTransactions(limit = 200): Promise<any[]> {
    return this.queryTable('transactions', 'SELECT * FROM transactions ORDER BY createdAt DESC LIMIT ?', [limit]);
  }

  async getAllTransactionsUnbounded(): Promise<any[]> {
    return this.queryTable('transactions', 'SELECT * FROM transactions ORDER BY createdAt ASC');
  }

  // --- Provider Safety ---
  async getProviderSafety(provider: string): Promise<ProviderSafetyRecord | null> {
    const rows = await this.query('SELECT * FROM providerSafety WHERE provider = ?', [provider]);
    if (rows.length === 0) return null;
    return this.deserializeProviderSafety(rows[0]);
  }

  async upsertProviderSafety(record: ProviderSafetyRecord): Promise<void> {
    await this.exec(
      `INSERT INTO providerSafety (provider, status, reason, lastError, lastHttpStatus, lastErrorAt, blockedAt, updatedAt, consecutiveFailures, lastSuccessAt, balanceKnown, balancePercent, balanceUnit, balanceSource, balanceUpdatedAt, lastResetAt, lastResetBy)
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
    [
      record.provider,
      record.status,
      record.reason ?? null,
      record.lastError ?? null,
      record.lastHttpStatus ?? null,
      record.lastErrorAt ?? null,
      record.blockedAt ?? null,
      record.updatedAt,
      record.consecutiveFailures,
      record.lastSuccessAt ?? null,
      record.balance.known ? 1 : 0,
      record.balance.percent ?? null,
      record.balance.unit ?? null,
      record.balance.source ?? null,
      record.balance.updatedAt ?? null,
      record.lastResetAt ?? null,
      record.lastResetBy ?? null,
    ]);
  }

  private deserializeProviderSafety(row: any): ProviderSafetyRecord {
    return {
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
        known: row.balanceKnown === 1,
        percent: row.balancePercent,
        unit: row.balanceUnit,
        source: row.balanceSource,
        updatedAt: row.balanceUpdatedAt,
      },
      lastResetAt: row.lastResetAt,
      lastResetBy: row.lastResetBy,
    };
  }

  // --- Moderation Cases ---
  async getModerationCases(): Promise<any[]> {
    return this.query('SELECT * FROM moderationCases ORDER BY createdAt DESC');
  }

  async getModerationCaseById(id: string): Promise<any | null> {
    const rows = await this.query('SELECT * FROM moderationCases WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async addModerationCase(record: any): Promise<void> {
    await this.exec(
      `INSERT INTO moderationCases (id, userId, category, action, confidence, automatic, createdAt, reason, excerpt, restrictionStartedAt, restrictionExpiresAt, adminUserId, adminEmail, adminNote, reviewedAt, reviewedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.userId,
      record.category,
      record.action,
      record.confidence,
      record.automatic ? 1 : 0,
      record.createdAt,
      record.reason ?? null,
      record.excerpt ?? null,
      record.restrictionStartedAt ?? null,
      record.restrictionExpiresAt ?? null,
      record.adminUserId ?? null,
      record.adminEmail ?? null,
      record.adminNote ?? null,
      record.reviewedAt ?? null,
      record.reviewedBy ?? null,
    ]);
  }

  async markCaseReviewed(id: string, admin: { adminUserId: string; adminEmail?: string; note?: string }): Promise<void> {
    await this.exec(
      `UPDATE moderationCases SET reviewedAt = ?, reviewedBy = ?, adminUserId = ?, adminEmail = ?, adminNote = ? WHERE id = ?`,
    [new Date().toISOString(), admin.adminUserId, admin.adminUserId, admin.adminEmail ?? null, admin.note ?? null, id]);
  }

  async getCasesForUser(userId: string): Promise<any[]> {
    return this.query('SELECT * FROM moderationCases WHERE userId = ? ORDER BY createdAt DESC', [userId]);
  }

  async listCases(limit = 200): Promise<any[]> {
    return this.query('SELECT * FROM moderationCases ORDER BY createdAt DESC LIMIT ?', [limit]);
  }

  async getCaseById(id: string): Promise<any | null> {
    const rows = await this.query('SELECT * FROM moderationCases WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  // --- Community Restrictions ---
  async getCommunityRestrictions(): Promise<any[]> {
    return this.query('SELECT * FROM communityRestrictions');
  }

  async getActiveRestriction(userId: string, now = Date.now()): Promise<any | null> {
    const rows = await this.query(
      'SELECT * FROM communityRestrictions WHERE userId = ? AND releasedAt IS NULL AND datetime(expiresAt) > datetime(?)',
      [userId, new Date(now).toISOString()]
    );
    return rows[0] ?? null;
  }

  /**
   * Restrictions are keyed by (userId, startedAt) — the record's real identity.
   * No `id` is generated here; inventing one would break migration identity and
   * make a retried applyRestriction produce a second, duplicate row.
   */
  async applyRestriction(record: any): Promise<void> {
    await this.exec(
      `INSERT INTO communityRestrictions (userId, startedAt, expiresAt, violationCount, automatic, extendedCount, releasedAt, releasedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.userId, record.startedAt, record.expiresAt, record.violationCount, record.automatic ? 1 : 0, record.extendedCount ?? 0, record.releasedAt ?? null, record.releasedBy ?? null]);
  }

  async extendRestriction(userId: string, additionalMs: number, now = Date.now()): Promise<void> {
    await this.exec(
      `UPDATE communityRestrictions SET expiresAt = datetime(expiresAt, ?), extendedCount = extendedCount + 1
       WHERE userId = ? AND releasedAt IS NULL AND datetime(expiresAt) > datetime(?)`,
    [additionalMs, userId, new Date(now).toISOString()]);
  }

  async releaseRestriction(userId: string, releasedBy: string): Promise<void> {
    await this.exec(
      `UPDATE communityRestrictions SET releasedAt = ?, releasedBy = ? WHERE userId = ? AND releasedAt IS NULL`,
    [new Date().toISOString(), releasedBy, userId]);
  }

  async getActiveRestrictions(now = Date.now()): Promise<any[]> {
    return this.query('SELECT * FROM communityRestrictions WHERE releasedAt IS NULL AND datetime(expiresAt) > datetime(?)', [new Date(now).toISOString()]);
  }

  async getRestrictionsForUser(userId: string): Promise<any[]> {
    return this.query('SELECT * FROM communityRestrictions WHERE userId = ? ORDER BY startedAt DESC', [userId]);
  }

  // --- Community Messages ---
  async addMessage(record: any): Promise<void> {
    await this.exec(
      `INSERT INTO communityMessages (id, userId, kind, category, body, accepted, createdAt, moderationCaseId, attachmentName, attachmentMime, attachmentBytes, attachmentKey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.userId,
      record.kind,
      record.category ?? null,
      record.body,
      record.accepted ? 1 : 0,
      record.createdAt,
      record.moderationCaseId ?? null,
      record.attachmentName ?? null,
      record.attachmentMime ?? null,
      record.attachmentBytes ?? null,
      record.attachmentKey ?? null,
    ]);
  }

  async getMessagesForUser(userId: string, limit = 50): Promise<any[]> {
    return this.query('SELECT * FROM communityMessages WHERE userId = ? ORDER BY createdAt DESC LIMIT ?', [userId, limit]);
  }

  async getMessageByAttachmentKey(userId: string, key: string): Promise<any | null> {
    const rows = await this.query('SELECT * FROM communityMessages WHERE userId = ? AND attachmentKey = ?', [userId, key]);
    return rows[0] ?? null;
  }

  async listMessages(limit = 200): Promise<any[]> {
    return this.query('SELECT * FROM communityMessages ORDER BY createdAt DESC LIMIT ?', [limit]);
  }

  // --- Login Activity ---
  async recordLoginActivity(rec: any): Promise<void> {
    await this.transaction(async (tx) => {
      // Insert the new record
      await tx.execute({
        sql: `INSERT INTO loginActivity (id, userId, email, loginDate, loginTime, istDateTime, month, occurredAt, method, outcome, failureCode, ip, userAgent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          rec.id,
          rec.userId ?? '',
          rec.email ?? null,
          rec.loginDate,
          rec.loginTime ?? '',
          rec.istDateTime,
          rec.month,
          rec.occurredAt,
          rec.method,
          rec.outcome,
          rec.failureCode ?? null,
          rec.ip ?? null,
          rec.userAgent ?? null,
        ],
      });

      // Check and enforce retention cap
      const countResult = await tx.execute({ sql: 'SELECT COUNT(*) as count FROM loginActivity' });
      const count = countResult.rows[0]?.count ?? 0;
      if (count > 10000) {
        const excess = count - 10000;
        await tx.execute({
          sql: `DELETE FROM loginActivity WHERE id IN (
            SELECT id FROM loginActivity ORDER BY occurredAt ASC, id ASC LIMIT ?
          )`,
          args: [excess],
        });
      }
    });
  }

  async listLoginActivityForMonth(month?: string): Promise<any[]> {
    if (month) {
      return this.query('SELECT * FROM loginActivity WHERE month = ? ORDER BY occurredAt DESC', [month]);
    }
    return this.query('SELECT * FROM loginActivity ORDER BY occurredAt DESC');
  }

  async listLoginActivityForDate(date: string): Promise<any[]> {
    return this.query('SELECT * FROM loginActivity WHERE loginDate = ? ORDER BY occurredAt ASC', [date]);
  }

  async listAllLoginActivity(): Promise<any[]> {
    return this.query('SELECT * FROM loginActivity ORDER BY occurredAt ASC');
  }

  async lastForUserMethod(userId: string, method: string): Promise<any | null> {
    const rows = await this.query(
      'SELECT * FROM loginActivity WHERE userId = ? AND method = ? ORDER BY occurredAt DESC LIMIT 1',
      [userId, method]
    );
    return rows[0] ?? null;
  }

  async availableMonths(): Promise<string[]> {
    const rows = await this.query('SELECT DISTINCT month FROM loginActivity ORDER BY month DESC');
    return rows.map(r => r.month);
  }

  async availableMonthsFilled(): Promise<string[]> {
    const months = await this.availableMonths();
    if (months.length === 0) return [];
    const out: string[] = [];
    let [y, m] = months[months.length - 1].split('-').map(Number);
    const [ty, tm] = months[0].split('-').map(Number);
    const p2 = (n: number) => (n < 10 ? `0${n}` : String(n));
    for (; y < ty || (y === ty && m <= tm); m++) {
      out.push(`${y}-${p2(m)}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out.reverse();
  }

  async firstLoginFor(userId: string): Promise<any | null> {
    return this.queryTableRow(
      'loginActivity',
      `SELECT * FROM loginActivity WHERE userId = ? AND outcome = 'SUCCESS' ORDER BY occurredAt ASC LIMIT 1`,
      [userId]
    );
  }

  // --- Login Alerts ---
  async hasAlertFor(periodDate: string): Promise<boolean> {
    const rows = await this.query('SELECT 1 FROM loginAlerts WHERE periodDate = ? LIMIT 1', [periodDate]);
    return rows.length > 0;
  }

  async findAlertFor(periodDate: string): Promise<any | null> {
    return this.queryTableRow('loginAlerts', 'SELECT * FROM loginAlerts WHERE periodDate = ?', [periodDate]);
  }

  /**
   * ATOMIC, PERSISTED CLAIM on the daily login report for one IST date.
   *
   * WHY THIS EXISTS. The previous guard read `store.snapshot().loginAlerts`,
   * which on libSQL is a Promise: the `.loginAlerts` property was `undefined`,
   * `?? []` turned it into an empty array, and the guard therefore reported
   * "no alert for this day" FOREVER. The report was sent, the follow-up
   * `saveAlert()` threw (it used the unsupported whole-snapshot `mutate()`), and
   * the send was never recorded - so every tick and every restart re-sent the
   * same Telegram message. A check-then-act guard cannot fix that, because
   * there was nothing persisted to check.
   *
   * HOW THIS FIXES IT. This is ONE statement against the table's
   * UNIQUE(periodDate) constraint, so SQLite resolves it atomically for N
   * concurrent callers (ticks, restarts, several Render instances):
   *
   *   - no row for the date      -> INSERT, 1 row affected, caller WINS
   *   - row exists, DELIVERED / NOT_CONFIGURED -> the conditional DO UPDATE's
   *     WHERE does not match, 0 rows affected, caller LOSES and must not send
   *   - row exists, PENDING      -> another caller is mid-send, 0 rows, LOSES
   *   - row exists, FAILED       -> the message never arrived, so the date is
   *     re-claimed, 1 row, caller WINS and retries
   *
   * The state lives in the database, so it survives a restart, a redeploy and a
   * scale-out. There is no in-memory flag anywhere in this path.
   */
  async claimDailyLoginAlert(claim: {
    id: string;
    alertDate: string;
    periodDate: string;
    month: string;
    generatedAt: string;
  }): Promise<boolean> {
    const changed = await this.execCount(
      `INSERT INTO loginAlerts (id, alertDate, periodDate, month, generatedAt, totalLogins, uniqueUsers, newUsers, activeUsers, failedLogins, topUsers, deliveryStatus, statusMessage)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, 'PENDING', ?)
       ON CONFLICT(periodDate) DO UPDATE SET
         id = excluded.id,
         alertDate = excluded.alertDate,
         month = excluded.month,
         generatedAt = excluded.generatedAt,
         totalLogins = 0,
         uniqueUsers = 0,
         newUsers = 0,
         activeUsers = 0,
         failedLogins = 0,
         topUsers = NULL,
         deliveryStatus = 'PENDING',
         statusMessage = excluded.statusMessage
       WHERE loginAlerts.deliveryStatus = 'FAILED'`,
      [
        claim.id,
        claim.alertDate,
        claim.periodDate,
        claim.month,
        claim.generatedAt,
        'Claimed for delivery; no message sent yet.',
      ]
    );
    return changed > 0;
  }

  /**
   * Fill in the claimed row with the real summary and the real delivery result.
   * Only the caller that WON the claim may call this, and only for its own row.
   */
  async completeDailyLoginAlert(alert: any): Promise<void> {
    await this.exec(
      `UPDATE loginAlerts SET
         totalLogins = ?, uniqueUsers = ?, newUsers = ?, activeUsers = ?, failedLogins = ?,
         topUsers = ?, deliveryStatus = ?, statusMessage = ?
       WHERE periodDate = ?`,
      [
        alert.totalLogins,
        alert.uniqueUsers,
        alert.newUsers,
        alert.activeUsers,
        alert.failedLogins,
        JSON.stringify(alert.topUsers ?? []),
        alert.deliveryStatus,
        alert.statusMessage,
        alert.periodDate,
      ]
    );
  }

  /**
   * Give up an unfulfilled claim so a later tick can retry the same IST date.
   *
   * Only a PENDING row is removed. A row that already carries a real delivery
   * result is never deleted here, so a successful report stays recorded.
   */
  async releaseDailyLoginAlert(periodDate: string): Promise<void> {
    await this.exec(`DELETE FROM loginAlerts WHERE periodDate = ? AND deliveryStatus = 'PENDING'`, [periodDate]);
  }

  /**
   * Save the alert for a period, replacing any existing one for the same day.
   *
   * `periodDate` is the business key, so the conflict target is periodDate and
   * `id` is carried over from the row being replaced: re-issuing an alert for a
   * day can never leave two business records behind, and never invents an id.
   */
  async saveAlert(alert: any): Promise<void> {
    await this.exec(
      `INSERT INTO loginAlerts (id, alertDate, periodDate, month, generatedAt, totalLogins, uniqueUsers, newUsers, activeUsers, failedLogins, topUsers, deliveryStatus, statusMessage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(periodDate) DO UPDATE SET
         id = loginAlerts.id,
         alertDate = excluded.alertDate,
         month = excluded.month,
         generatedAt = excluded.generatedAt,
         totalLogins = excluded.totalLogins,
         uniqueUsers = excluded.uniqueUsers,
         newUsers = excluded.newUsers,
         activeUsers = excluded.activeUsers,
         failedLogins = excluded.failedLogins,
         topUsers = excluded.topUsers,
         deliveryStatus = excluded.deliveryStatus,
         statusMessage = excluded.statusMessage`,
    [
      alert.id,
      alert.alertDate,
      alert.periodDate,
      alert.month,
      alert.generatedAt,
      alert.totalLogins,
      alert.uniqueUsers,
      alert.newUsers,
      alert.activeUsers,
      alert.failedLogins,
      // `JSON.stringify(undefined)` is undefined, not a string, and the driver
      // rejects an undefined bind value. An absent blob is stored as NULL and
      // decodes back to null rather than throwing.
      alert.topUsers === undefined || alert.topUsers === null ? null : JSON.stringify(alert.topUsers),
      alert.deliveryStatus,
      alert.statusMessage ?? null,
    ]);
  }

  async listAlerts(limit = 60): Promise<any[]> {
    return this.queryTable('loginAlerts', 'SELECT * FROM loginAlerts ORDER BY generatedAt DESC LIMIT ?', [limit]);
  }

  async countLoginEvents(): Promise<number> {
    const result = await this.query('SELECT COUNT(*) as count FROM loginActivity');
    return Number(result[0]?.count ?? 0);
  }

  // --- Snapshot for compatibility with DataStore interface ---
  async snapshot(): Promise<DbShape> {
    const [
      users,
      jobs,
      transactions,
      providerSafety,
      moderationCases,
      communityRestrictions,
      communityMessages,
      loginActivity,
      loginAlerts,
    ] = await Promise.all([
      this.getUsers(),
      this.getJobs(),
      this.getTransactions(),
      this.getProviderSafety('sarvam'),
      // All nine go through the JSON-decoding reads, so snapshot() cannot hand
      // back a raw JSON string where DbShape promises an array or object. The
      // tables with no JSON blob column are passed through unchanged.
      this.queryTable('moderationCases', 'SELECT * FROM moderationCases ORDER BY createdAt DESC'),
      this.queryTable('communityRestrictions', 'SELECT * FROM communityRestrictions'),
      this.queryTable('communityMessages', 'SELECT * FROM communityMessages ORDER BY createdAt DESC'),
      this.queryTable('loginActivity', 'SELECT * FROM loginActivity ORDER BY occurredAt DESC'),
      this.queryTable('loginAlerts', 'SELECT * FROM loginAlerts ORDER BY generatedAt DESC'),
    ]);

    return {
      version: DB_VERSION,
      users: users.map(normalizeUser),
      jobs,
      transactions,
      providerSafety: providerSafety ?? null,
      moderationCases: normalizeModerationCases(moderationCases),
      communityRestrictions: normalizeRestrictions(communityRestrictions),
      communityMessages: normalizeCommunityMessages(communityMessages),
      loginActivity: normalizeLoginActivity(loginActivity),
      loginAlerts: normalizeLoginAlerts(loginAlerts),
    };
  }

  // --- Compatibility with the DataStore interface ---
  //
  // The two whole-database entry points below are deliberately unsupported, and
  // this is the audited reason rather than a stub left behind:
  //
  // - mutate() IS reachable in production. server/db/repos.ts constructs every
  //   repository (UserRepo, CreditRepo, JobRepo, ProviderSafetyRepo,
  //   ModerationRepo, LoginActivityRepo) with this store in server.ts, and those
  //   repositories are synchronous: they call store.mutate() and
  //   store.snapshot(). A relational backend cannot provide either. This is the
  //   documented Turso-vs-JSON-repository gap, and it is the single largest
  //   remaining blocker for running DATABASE_PROVIDER=turso (see the Step 5A
  //   report) — the repository layer needs an async port, which is a refactor
  //   beyond a compatibility step.
  // - mutateAsync() is NOT reachable in production. Its only callers are tests
  //   (db/store.test.ts, accountService, communityModeration, freeTrialPolicy),
  //   and nothing else referenced save().
  //
  // Both throw before doing anything, so a misuse can never look like a
  // successful write that silently vanished. Supported writes are the per-entity
  // async methods (createUser, updateUser, createJob, updateJob, addTransaction,
  // upsertProviderSafety, saveAlert, ...) — the same ones the migration uses.

  mutate<T>(fn: (db: DbShape) => T): T {
    throw new Error(TURSO_SNAPSHOT_WRITE_UNSUPPORTED);
  }

  async mutateAsync<T>(fn: (db: DbShape) => T): Promise<T> {
    throw new Error(TURSO_SNAPSHOT_WRITE_UNSUPPORTED);
  }
}

// Type for transaction
type Transaction = {
  execute: (opts: { sql: string; args: unknown[] }) => Promise<{ rows: any[] }>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};