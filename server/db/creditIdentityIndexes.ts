/**
 * Stage 5D — database-level defence for money identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every idempotency guarantee in the credit layer is enforced in application
 * code: "look for an existing row, and if there is none, insert one". That is a
 * check-then-act sequence. It is correct only while nothing else can write to the
 * same table, and it is enforced by a mutex that is *per process*. A second
 * application instance, a manual fix-up in the Turso console, or a future code
 * path that forgets the lookup can all produce two rows for one real payment.
 *
 * The Stage 5D mutex closes the single-process race. These indexes close the
 * rest: they make double-crediting *impossible to express*, so a bug becomes a
 * rejected INSERT rather than a financial defect.
 *
 * WHY PARTIAL INDEXES (`WHERE col IS NOT NULL`)
 * --------------------------------------------
 * All three identity columns are nullable, because most transaction rows have no
 * payment reference, no admin idempotency key, or no job. Two facts make a plain
 * UNIQUE index the wrong tool:
 *
 *  1. SQLite already treats NULLs as distinct from each other in a unique index,
 *     so `UNIQUE(paymentId)` would not reject two NULL rows. That behaviour is
 *     correct for us, but implicit.
 *  2. A partial index states the intent explicitly and is smaller and faster,
 *     because it only contains the rows that can actually collide. Admin rows
 *     with `jobId IS NULL` are the common case and are excluded outright.
 *
 * The alternative that was rejected: adding `NOT NULL` or sentinel values
 * (e.g. `paymentId = ''`) to force uniqueness. Both would rewrite or reject
 * existing user data, which is exactly what this migration must not do.
 *
 * SAFETY CONTRACT
 * ---------------
 * - Additive only. Nothing is dropped, altered, or rewritten.
 * - Conflict-detecting. If existing rows already violate a proposed index the
 *   migration reports them and changes NOTHING, rather than picking a winner or
 *   deleting a row. Silently deleting financial history is never acceptable.
 * - Dry-run capable, with genuinely zero writes.
 * - Idempotent. Re-running is a no-op, and safe after a partial failure.
 */
import type { Client } from '@libsql/client';

export interface CreditIdentityIndex {
  /** Index name, as recorded in sqlite_master. */
  readonly name: string;
  /** Always `transactions` today; kept open for future identity columns. */
  readonly table: string;
  /** The identity columns, in index order. */
  readonly columns: readonly string[];
  /** Human-readable statement of what this index prevents. */
  readonly prevents: string;
}

/**
 * The identity keys Stage 5D settled on, matching the three lookups the credit
 * layer already performs.
 *
 * - `paymentId`: one row per gateway payment. Guards webhook replays and the
 *   client-side verify call racing the same webhook.
 * - `(userId, idempotencyKey, type)`: one row per admin-intended operation.
 *   `type` is included so a grant and a debit that happen to share a key are
 *   both legitimate.
 * - `(userId, jobId, type)`: at most one row of each type per job, which is what
 *   makes charge/settle/refund idempotent. `type` is required here: a job has a
 *   DEBIT and later a REFUND, and both are correct.
 */
export const CREDIT_IDENTITY_INDEXES: readonly CreditIdentityIndex[] = [
  {
    name: 'ux_transactions_payment_id',
    table: 'transactions',
    columns: ['paymentId'],
    prevents: 'two ledger rows for one payment (double credit on webhook replay)',
  },
  {
    name: 'ux_transactions_idempotency',
    table: 'transactions',
    columns: ['userId', 'idempotencyKey', 'type'],
    prevents: 'an admin adjustment being applied twice under one idempotencyKey',
  },
  {
    name: 'ux_transactions_job_type',
    table: 'transactions',
    columns: ['userId', 'jobId', 'type'],
    prevents: 'a job being charged or refunded twice for the same operation',
  },
];

export interface IdentityConflict {
  readonly index: string;
  /** The colliding identity value, rendered for a human. */
  readonly key: string;
  /** How many rows currently share it. */
  readonly count: number;
  readonly prevents: string;
}

export interface MigrationPlan {
  /** Index names that do not exist yet and would be created. */
  readonly missing: readonly string[];
  /** Index names that already exist. */
  readonly present: readonly string[];
  /** Existing rows that would violate a proposed index. */
  readonly conflicts: readonly IdentityConflict[];
}

export interface MigrationResult extends MigrationPlan {
  /** Index names actually created. Empty for a dry run. */
  readonly created: readonly string[];
  /** True when nothing at all was written. */
  readonly dryRun: boolean;
}

/** `CREATE UNIQUE INDEX ... WHERE <col> IS NOT NULL`, idempotent by name. */
function createIndexSql(index: CreditIdentityIndex): string {
  const cols = index.columns.join(', ');
  const predicate = index.columns.map((c) => `${c} IS NOT NULL`).join(' AND ');
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${cols}) WHERE ${predicate}`;
}

/**
 * Duplicate detection for one proposed index.
 *
 * `GROUP BY <identity columns> HAVING COUNT(*) > 1` over exactly the rows the
 * partial index would cover. Read-only by construction.
 */
function conflictSql(index: CreditIdentityIndex): string {
  const cols = index.columns.join(', ');
  const predicate = index.columns.map((c) => `${c} IS NOT NULL`).join(' AND ');
  // COALESCE-free concatenation: every column is guaranteed non-NULL by the
  // predicate above, so `||` cannot yield NULL and hide a conflict.
  const keyExpr = index.columns.map((c) => `${c}`).join(` || ' | ' || `);
  return (
    `SELECT ${keyExpr} AS identityKey, COUNT(*) AS n FROM ${index.table} ` +
    `WHERE ${predicate} GROUP BY ${cols} HAVING COUNT(*) > 1`
  );
}

async function listIndexNames(client: Client): Promise<Set<string>> {
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
  return new Set(res.rows.map((r) => String(r.name)));
}

async function findConflicts(client: Client, index: CreditIdentityIndex): Promise<IdentityConflict[]> {
  const res = await client.execute(conflictSql(index));
  return res.rows.map((r) => ({
    index: index.name,
    key: String(r.identityKey),
    count: Number(r.n),
    prevents: index.prevents,
  }));
}

/**
 * Inspect without writing anything. Safe to run against production.
 *
 * This is the function to call before a deploy: it answers "would this migration
 * succeed, and if not, which rows are in the way?"
 */
export async function planCreditIdentityMigration(client: Client): Promise<MigrationPlan> {
  const existing = await listIndexNames(client);
  const missing: string[] = [];
  const present: string[] = [];
  const conflicts: IdentityConflict[] = [];

  for (const index of CREDIT_IDENTITY_INDEXES) {
    if (existing.has(index.name)) {
      present.push(index.name);
      continue;
    }
    missing.push(index.name);
    conflicts.push(...(await findConflicts(client, index)));
  }
  return { missing, present, conflicts };
}

/** Human-readable conflict report for an error message or a CLI. */
export function formatConflicts(conflicts: readonly IdentityConflict[]): string {
  if (conflicts.length === 0) return 'none';
  return conflicts
    .map((c) => `${c.index}: identity "${c.key}" appears ${c.count}x (prevents ${c.prevents})`)
    .join('; ');
}

/**
 * Create the missing identity indexes.
 *
 * Behaviour:
 * - dryRun: computes the plan and writes nothing at all.
 * - conflicts present: throws and writes NOTHING. Not even the indexes that
 *   would have succeeded. A migration that half-applies is harder to reason
 *   about than one that refuses, so the all-or-nothing check happens first.
 * - clean: creates every missing index, then re-reads to prove they exist.
 *
 * Callers get atomicity from the surrounding transaction (DDL is transactional
 * in SQLite); this function deliberately does not open one, so it can be called
 * from `init()` as well as from a standalone migration entry point.
 */
export async function applyCreditIdentityMigration(
  client: Client,
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun === true;
  const plan = await planCreditIdentityMigration(client);

  if (plan.conflicts.length > 0) {
    throw new Error(
      `Credit identity migration ABORTED: existing rows already violate the required ` +
        `uniqueness, so no index was created and no data was changed. Conflicts: ` +
        `${formatConflicts(plan.conflicts)}. Resolve these duplicates deliberately ` +
        `(inspect them first — do not delete financial history blindly), then re-run.`,
    );
  }

  if (dryRun) {
    return { ...plan, created: [], dryRun: true };
  }

  const created: string[] = [];
  for (const index of CREDIT_IDENTITY_INDEXES) {
    if (!plan.missing.includes(index.name)) continue;
    await client.execute(createIndexSql(index));
    created.push(index.name);
  }

  // Prove the result rather than trusting the CREATE. A silently-ignored
  // constraint would leave the database unprotected while reporting success.
  const after = await listIndexNames(client);
  const notCreated = created.filter((n) => !after.has(n));
  if (notCreated.length > 0) {
    throw new Error(
      `Credit identity migration reported success but these indexes are absent: ` +
        `${notCreated.join(', ')}. The database is still unprotected.`,
    );
  }

  return { ...plan, created, dryRun: false };
}