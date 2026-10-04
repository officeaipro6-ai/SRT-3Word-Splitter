/**
 * Production Migration Tooling
 * 
 * Safe, idempotent migration from JSON file storage to Turso/libSQL and local files to Cloudflare R2.
 * 
 * Usage:
 *   npx tsx scripts/migrate-to-production.ts --dry-run       # Dry run (default)
 *   npx tsx scripts/migrate-to-production.ts --execute       # Execute actual migration
 *   npx tsx scripts/migrate-to-production.ts --verify        # Verify only
 *   npx tsx scripts/migrate-to-production.ts --storage-dry-run  # Storage dry-run only
 *   npx tsx scripts/migrate-to-production.ts --storage-verify   # Storage verify only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, createReadStream, statSync as statSyncFs } from 'fs';
import { resolve, join, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname as getDirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = getDirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');
const SOURCE_DB_PATH = resolve(DATA_DIR, 'app.db.json');
const SOURCE_STORAGE_DIR = resolve(DATA_DIR, 'storage');

// ============================================================
// Types and Interfaces
// ============================================================

interface MigrationArgs {
  dryRun: boolean;
  execute: boolean;
  verify: boolean;
  storageDryRun: boolean;
  storageVerify: boolean;
  help: boolean;
}

interface MigrationManifest {
  timestamp: string;
  gitCommit?: string;
  database: {
    sourceCounts: Record<string, number>;
    destinationCounts: Record<string, number>;
    inserted: number;
    alreadyPresent: number;
    conflicts: ConflictRecord[];
    missing: string[];
    unexpected: string[];
  };
  storage: {
    sourceFiles: number;
    sourceKeys: string[];
    sourceSizes: Record<string, number>;
    sourceHashes: Record<string, string>;
    destinationFiles: number;
    destinationKeys: string[];
    matched: number;
    mismatched: MismatchRecord[];
    missing: string[];
  };
  verification: {
    database: VerificationResult;
    storage: VerificationResult;
  };
  overallStatus: 'READY' | 'PASS' | 'PARTIAL' | 'FAILED';
}

interface ConflictRecord {
  table: string;
  id: string;
  source: unknown;
  destination: unknown;
  fields: string[];
}

interface MismatchRecord {
  key: string;
  sourceHash: string;
  destinationHash: string;
  sourceSize: number;
  destinationSize: number;
}

interface VerificationResult {
  status: 'PASS' | 'MISSING' | 'CONFLICT' | 'UNEXPECTED' | 'ERROR';
  details: string[];
}

type TableName = 
  | 'users' 
  | 'jobs' 
  | 'transactions' 
  | 'providerSafety' 
  | 'moderationCases' 
  | 'communityRestrictions' 
  | 'communityMessages' 
  | 'loginActivity' 
  | 'loginAlerts';

/** The 9 entities migrated from the JSON database. */
export type MigrationEntity = TableName;

const TABLES: TableName[] = [
  'users', 'jobs', 'transactions', 'providerSafety',
  'moderationCases', 'communityRestrictions', 'communityMessages',
  'loginActivity', 'loginAlerts'
];

// ============================================================
// Utility Functions
// ============================================================

function parseArgs(): MigrationArgs {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run') || !process.argv.includes('--execute'),
    execute: args.includes('--execute'),
    verify: args.includes('--verify'),
    storageDryRun: args.includes('--storage-dry-run'),
    storageVerify: args.includes('--storage-verify'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp(): void {
  console.log(`
Migration Tooling for Odia-SRT Production Deployment

Usage:
  npx tsx scripts/migrate-to-production.ts [options]

Options:
  --dry-run              Database dry-run (default: true if --execute not specified)
  --execute              Execute actual migration (requires confirmation)
  --verify               Verify migration (compare source vs destination)
  --storage-dry-run      Storage dry-run only
  --storage-verify       Storage verification only
  --help, -h             Show this help

Examples:
  npx tsx scripts/migrate-to-production.ts --dry-run
  npx tsx scripts/migrate-to-production.ts --execute
  npx tsx scripts/migrate-to-production.ts --verify
  npx tsx scripts/migrate-to-production.ts --storage-dry-run
  npx tsx scripts/migrate-to-production.ts --storage-verify

Safety:
- Default mode is DRY RUN (read-only)
- --execute required for actual writes
- No DROP/TRUNCATE/DELETE operations ever
- Conflicts are reported, never silently overwritten
- Source files never deleted
  `);
}

function loadSourceDb(): any {
  if (!existsSync(SOURCE_DB_PATH)) {
    throw new Error(`Source database not found: ${SOURCE_DB_PATH}`);
  }
  const raw = readFileSync(SOURCE_DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function getGitCommit(): string | undefined {
  try {
    const { execSync } = require('child_process');
    const commit = execSync('git rev-parse --short HEAD', { 
      cwd: PROJECT_ROOT, 
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

function computeSHA256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function computeFileSHA256(filePath: string): string {
  const buffer = readFileSync(filePath);
  return computeSHA256(buffer);
}

function getAllStorageFiles(dir: string, basePath: string = ''): { key: string; path: string; size: number; hash: string }[] {
  const results: { key: string; path: string; size: number; hash: string }[] = [];
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    const key = basePath ? `${basePath}/${entry}` : entry;
    
    if (stat.isDirectory()) {
      results.push(...getAllStorageFiles(fullPath, key));
    } else if (stat.isFile()) {
      const hash = computeFileSHA256(fullPath);
      results.push({ key, path: fullPath, size: stat.size, hash });
    }
  }
  return results;
}

// ============================================================
// Source Database Loading & Validation
// ============================================================

export interface SourceData {
  users: any[];
  jobs: any[];
  transactions: any[];
  providerSafety: any;
  moderationCases: any[];
  communityRestrictions: any[];
  communityMessages: any[];
  loginActivity: any[];
loginAlerts: any[];
}

function loadAndValidateSource(): any {
  const raw = loadSourceDb();
  
  const requiredTables = [
    'users', 'jobs', 'transactions', 'providerSafety',
    'moderationCases', 'communityRestrictions', 'communityMessages',
    'loginActivity', 'loginAlerts'
  ];
  
  const missing = requiredTables.filter(t => !(t in raw));
  if (missing.length > 0) {
    throw new Error(`Source DB missing required tables: ${missing.join(', ')}`);
  }
  
  const source: any = {
    users: raw.users || [],
    jobs: raw.jobs || [],
    transactions: raw.transactions || [],
    providerSafety: raw.providerSafety || null,
    moderationCases: raw.moderationCases || [],
    communityRestrictions: raw.communityRestrictions || [],
    communityMessages: raw.communityMessages || [],
    loginActivity: raw.loginActivity || [],
    loginAlerts: raw.loginAlerts || [],
  };
  
  // Every record must carry the identity fields the destination uses as its
  // primary key, otherwise it could never be matched or inserted safely.
  for (const [table, records] of Object.entries(source)) {
    const spec = ENTITY_SPECS[table as MigrationEntity];
    if (!spec || !Array.isArray(records)) continue;
    for (const record of records) {
      for (const key of spec.primaryKey) {
        const value = record && typeof record === 'object' ? record[key] : undefined;
        if (value === undefined || value === null || value === '') {
          throw new Error(`Missing required '${key}' field in ${table}`);
        }
      }
    }
  }
  
  return source;
}

// ============================================================
// Database Migration Core
// ============================================================

/**
 * How one source record compares to the destination.
 *
 * NEW      - the destination has no record with this primary key.
 * SAME     - the destination already holds a field-equivalent record.
 * CONFLICT - the destination holds a *different* record under this key (or
 *            under a declared UNIQUE column). NEVER overwritten silently.
 */
export type MigrationClassification = 'NEW' | 'SAME' | 'CONFLICT';

/** Overall outcome of a database migration run. */
export type MigrationStatus = 'READY' | 'PASS' | 'PARTIAL' | 'BLOCKED' | 'FAILED';

/** One destination column and exactly which source field feeds it. */
export interface ColumnSpec {
  /** Destination column name. */
  column: string;
  /**
   * Source field feeding this column. Dotted paths read nested source objects
   * (e.g. `balance.known`). `undefined` means the column has no source field:
   * either it is schema-defaulted or the destination cannot supply it (a gap).
   */
  source?: string;
  /** The column stores a JSON blob (preserved verbatim as text). */
  json?: boolean;
  /** The column stores a boolean as SQLite 0/1. */
  bool?: boolean;
  /** Canonical value used when the source field is absent (schema default). */
  defaultValue?: unknown;
  /**
   * The destination column is NOT NULL with no default, so an INSERT cannot
   * succeed unless the source supplies it. Unmapped required columns are
   * reported as a blocking schema gap rather than being invented.
   */
  required?: boolean;
}

export interface EntitySpec {
  entity: MigrationEntity;
  table: string;
  /** Source field(s) forming the record identity. Composite when >1. */
  primaryKey: string[];
  /**
   * Destination columns the database itself enforces as UNIQUE, used for safe
   * lookups. Only declare what the schema actually constrains — listing a
   * column here that has no UNIQUE index would report phantom CONFLICTs.
   */
  uniqueColumns: string[];
  columns: ColumnSpec[];
}

/**
 * Explicit, per-entity mapping from the JSON source shape to the destination
 * relational schema declared in `server/db/tursoStore.ts`.
 *
 * This table is the single source of truth for the migration. Anything the
 * schema cannot represent is reported as a gap instead of being dropped,
 * renamed or guessed.
 */
export const ENTITY_SPECS: Record<MigrationEntity, EntitySpec> = {
  users: {
    entity: 'users',
    table: 'users',
    primaryKey: ['id'],
    uniqueColumns: ['email'],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'tokenHashes', source: 'tokenHashes', json: true },
      { column: 'credits', source: 'credits', required: true },
      { column: 'role', source: 'role', defaultValue: 'USER', required: true },
      { column: 'creditMode', source: 'creditMode', defaultValue: 'NORMAL', required: true },
      { column: 'createdAt', source: 'createdAt', required: true },
      { column: 'lastSeenAt', source: 'lastSeenAt' },
      { column: 'freeTrialsUsed', source: 'freeTrialsUsed', defaultValue: 0, required: true },
      { column: 'ownerEmail', source: 'ownerEmail' },
      { column: 'email', source: 'email' },
      { column: 'passwordHash', source: 'passwordHash' },
      { column: 'lastLoginAt', source: 'lastLoginAt' },
      { column: 'purchasedCredits', source: 'purchasedCredits', defaultValue: 0, required: true },
      { column: 'bonusCredits', source: 'bonusCredits', defaultValue: 0, required: true },
    ],
  },
  jobs: {
    entity: 'jobs',
    table: 'jobs',
    primaryKey: ['id'],
    uniqueColumns: [],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'userId', source: 'userId', required: true },
      { column: 'status', source: 'status', required: true },
      { column: 'createdAt', source: 'createdAt', required: true },
      { column: 'startedAt', source: 'startedAt' },
      { column: 'completedAt', source: 'completedAt' },
      { column: 'nextRetryAt', source: 'nextRetryAt' },
      { column: 'provider', source: 'provider', required: true },
      { column: 'input', source: 'input', json: true, required: true },
      { column: 'output', source: 'output', json: true },
      { column: 'lastError', source: 'lastError' },
      { column: 'errorCode', source: 'errorCode' },
      { column: 'creditsCharged', source: 'creditsCharged' },
      { column: 'creditTxnId', source: 'creditTxnId' },
      { column: 'retryCount', source: 'retryCount', defaultValue: 0, required: true },
    ],
  },
  transactions: {
    entity: 'transactions',
    table: 'transactions',
    primaryKey: ['id'],
    // The schema declares no UNIQUE on idempotencyKey (duplicate admin keys are
    // prevented by an application-level pre-check), so identity comes from id.
    uniqueColumns: [],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'userId', source: 'userId', required: true },
      { column: 'type', source: 'type', required: true },
      { column: 'amount', source: 'amount', required: true },
      { column: 'reason', source: 'reason', required: true },
      { column: 'balanceBefore', source: 'balanceBefore' },
      { column: 'balanceAfter', source: 'balanceAfter', required: true },
      // Optional in CreditTransactionRecord and only supplied by ADMIN_*
      // operations, so the destination column is nullable and an absent key
      // stays NULL. Never synthesise one.
      { column: 'idempotencyKey', source: 'idempotencyKey' },
      { column: 'createdAt', source: 'createdAt', required: true },
      { column: 'adminUserId', source: 'adminUserId' },
      { column: 'adminEmail', source: 'adminEmail' },
      // Load-bearing: per-job idempotency (debitForJob/refundForJob/...) looks
      // transactions up by (userId, jobId, type).
      { column: 'jobId', source: 'jobId' },
      // Mirrors CreditTransactionRecord.paymentId, the canonical field every
      // purchase write path sets and both stores look up (CreditRepo
      // .findByPaymentId matches it; TursoStore queries this column directly).
      // Kept as its own nullable column so the payment-ID lookup is a plain
      // comparison and NULL ids cannot collide.
      { column: 'paymentId', source: 'paymentId' },
      // Legacy free-form bag, preserved verbatim so a source record's unknown
      // fields are never dropped. No application write path populates it and no
      // source record carries it today; nothing is derived into it.
      { column: 'extra', source: 'extra', json: true },
    ],
  },
  providerSafety: {
    entity: 'providerSafety',
    table: 'providerSafety',
    primaryKey: ['provider'],
    uniqueColumns: [],
    columns: [
      { column: 'provider', source: 'provider', required: true },
      { column: 'status', source: 'status', defaultValue: 'AVAILABLE', required: true },
      { column: 'reason', source: 'reason' },
      { column: 'lastError', source: 'lastError' },
      { column: 'lastHttpStatus', source: 'lastHttpStatus' },
      { column: 'lastErrorAt', source: 'lastErrorAt' },
      { column: 'blockedAt', source: 'blockedAt' },
      { column: 'updatedAt', source: 'updatedAt', required: true },
      { column: 'consecutiveFailures', source: 'consecutiveFailures', defaultValue: 0, required: true },
      { column: 'lastSuccessAt', source: 'lastSuccessAt' },
      { column: 'balanceKnown', source: 'balance.known', bool: true, defaultValue: false, required: true },
      { column: 'balancePercent', source: 'balance.percent' },
      { column: 'balanceUnit', source: 'balance.unit' },
      { column: 'balanceSource', source: 'balance.source' },
      { column: 'balanceUpdatedAt', source: 'balance.updatedAt' },
      { column: 'lastResetAt', source: 'lastResetAt' },
      { column: 'lastResetBy', source: 'lastResetBy' },
    ],
  },
  moderationCases: {
    entity: 'moderationCases',
    table: 'moderationCases',
    primaryKey: ['id'],
    uniqueColumns: [],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'userId', source: 'userId', required: true },
      { column: 'category', source: 'category', required: true },
      { column: 'action', source: 'action', required: true },
      { column: 'confidence', source: 'confidence', required: true },
      { column: 'automatic', source: 'automatic', bool: true, defaultValue: true, required: true },
      { column: 'createdAt', source: 'createdAt', required: true },
      { column: 'reason', source: 'reason' },
      { column: 'excerpt', source: 'excerpt' },
      { column: 'restrictionStartedAt', source: 'restrictionStartedAt' },
      { column: 'restrictionExpiresAt', source: 'restrictionExpiresAt' },
      { column: 'adminUserId', source: 'adminUserId' },
      { column: 'adminEmail', source: 'adminEmail' },
      { column: 'adminNote', source: 'adminNote' },
      { column: 'reviewedAt', source: 'reviewedAt' },
      { column: 'reviewedBy', source: 'reviewedBy' },
    ],
  },
  communityRestrictions: {
    entity: 'communityRestrictions',
    table: 'communityRestrictions',
    // CommunityRestrictionRecord has no `id`. The destination now uses the same
    // composite key the app already queries by, so migration identity is
    // (userId, startedAt) — deterministic and derived purely from source fields,
    // which makes a retried run classify the row as SAME instead of duplicating
    // it. No id is generated or invented.
    primaryKey: ['userId', 'startedAt'],
    uniqueColumns: [],
    columns: [
      { column: 'userId', source: 'userId', required: true },
      { column: 'startedAt', source: 'startedAt', required: true },
      { column: 'expiresAt', source: 'expiresAt', required: true },
      { column: 'violationCount', source: 'violationCount', defaultValue: 1, required: true },
      { column: 'automatic', source: 'automatic', bool: true, defaultValue: true, required: true },
      { column: 'extendedCount', source: 'extendedCount', defaultValue: 0, required: true },
      { column: 'releasedAt', source: 'releasedAt' },
      { column: 'releasedBy', source: 'releasedBy' },
    ],
  },
  communityMessages: {
    entity: 'communityMessages',
    table: 'communityMessages',
    primaryKey: ['id'],
    uniqueColumns: [],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'userId', source: 'userId', required: true },
      { column: 'kind', source: 'kind', required: true },
      { column: 'category', source: 'category' },
      { column: 'body', source: 'body', required: true },
      { column: 'accepted', source: 'accepted', bool: true, defaultValue: false, required: true },
      { column: 'createdAt', source: 'createdAt', required: true },
      { column: 'moderationCaseId', source: 'moderationCaseId' },
      { column: 'attachmentName', source: 'attachmentName' },
      { column: 'attachmentMime', source: 'attachmentMime' },
      { column: 'attachmentBytes', source: 'attachmentBytes' },
      { column: 'attachmentKey', source: 'attachmentKey' },
    ],
  },
  loginActivity: {
    entity: 'loginActivity',
    table: 'loginActivity',
    primaryKey: ['id'],
    uniqueColumns: [],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'userId', source: 'userId', required: true },
      { column: 'email', source: 'email' },
      { column: 'loginDate', source: 'loginDate', required: true },
      { column: 'loginTime', source: 'loginTime' },
      { column: 'istDateTime', source: 'istDateTime', required: true },
      { column: 'month', source: 'month', required: true },
      { column: 'occurredAt', source: 'occurredAt', required: true },
      { column: 'method', source: 'method', required: true },
      { column: 'outcome', source: 'outcome', required: true },
      { column: 'failureCode', source: 'failureCode' },
      { column: 'ip', source: 'ip' },
      { column: 'userAgent', source: 'userAgent' },
    ],
  },
  loginAlerts: {
    entity: 'loginAlerts',
    table: 'loginAlerts',
    primaryKey: ['id'],
    // `periodDate` is the alert's business key: loginAlertService.ts keys the
    // daily summary by it, guards on it before dispatching a transport, and
    // expects re-issuing to replace rather than append. The schema now declares
    // UNIQUE(periodDate), so the database enforces one alert per period.
    uniqueColumns: ['periodDate'],
    columns: [
      { column: 'id', source: 'id', required: true },
      { column: 'alertDate', source: 'alertDate', required: true },
      { column: 'periodDate', source: 'periodDate', required: true },
      { column: 'month', source: 'month', required: true },
      { column: 'generatedAt', source: 'generatedAt', required: true },
      { column: 'totalLogins', source: 'totalLogins', defaultValue: 0, required: true },
      { column: 'uniqueUsers', source: 'uniqueUsers', defaultValue: 0, required: true },
      { column: 'newUsers', source: 'newUsers', defaultValue: 0, required: true },
      { column: 'activeUsers', source: 'activeUsers', defaultValue: 0, required: true },
      { column: 'failedLogins', source: 'failedLogins', defaultValue: 0, required: true },
      { column: 'topUsers', source: 'topUsers', json: true },
      { column: 'deliveryStatus', source: 'deliveryStatus', defaultValue: 'NOT_CONFIGURED', required: true },
      { column: 'statusMessage', source: 'statusMessage' },
    ],
  },
};

/** Outcome of one entity's classification + (optional) insert pass. */
export interface EntityMigrationResult {
  entity: MigrationEntity;
  table: string;
  sourceCount: number;
  destinationCount: number;
  /** Source records with no destination record. */
  new: number;
  /** Source records already present and field-equivalent. */
  same: number;
  /** Source records whose destination counterpart differs. Never overwritten. */
  conflict: number;
  /** Primary keys present in source but absent from the destination. */
  missingIds: string[];
  /** Primary keys present in the destination but absent from the source. */
  unexpectedIds: string[];
  /** Source fields the destination schema cannot represent (data loss if ignored). */
  unmappedSourceFields: string[];
  /** Required destination columns the source cannot supply. */
  unmappableRequiredColumns: string[];
  /** Fields that differ on each CONFLICT record. Empty unless there are conflicts. */
  conflictFields: { id: string; fields: string[] }[];
  /** Exact per-record failures, e.g. `{ id, message }`. Empty unless something failed. */
  failures: { id: string; message: string }[];
  /** True when this entity cannot be migrated without data loss or an INSERT failure. */
  blocked: boolean;
  /** Rows actually written (always 0 in dry-run). */
  inserted: number;
}

/** Aggregate database migration result, embedded in the manifest. */
export interface DbMigrationResult {
  mode: 'dry-run' | 'execute';
  destination: string;
  entities: EntityMigrationResult[];
  totals: {
    sourceCount: number;
    destinationCount: number;
    new: number;
    same: number;
    conflict: number;
    inserted: number;
    failures: number;
  };
  status: MigrationStatus;
  /** Human-readable blockers; empty when the run may proceed. */
  blockers: string[];
}

/**
 * The narrow destination port the migration needs. It is NOT a second database
 * abstraction: the real implementation is a thin adapter over the existing
 * libSQL client used by `server/db/tursoStore.ts`, and the in-memory
 * implementation exists only so dry-run and unit tests need no credentials.
 */
export interface MigrationDestination {
  readonly label: string;
  /** All destination rows for an entity, as raw column values. */
  readAll(entity: MigrationEntity): Promise<Record<string, unknown>[]>;
  /** Insert exactly one row. Implementations MUST NOT upsert or overwrite. */
  insert(entity: MigrationEntity, values: Record<string, unknown>): Promise<void>;
}

/** Read a possibly dotted source path (`balance.known`). */
function readSourcePath(record: unknown, path: string): unknown {
  if (path.indexOf('.') === -1) {
    return record && typeof record === 'object'
      ? (record as Record<string, unknown>)[path]
      : undefined;
  }
  let cursor: unknown = record;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** `undefined` and `null` both mean "no value" and are compared as equal. */
function toComparable(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toComparable);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = toComparable(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return String(value);
}

/**
 * Canonical, storage-agnostic view of a record. Both the source JSON record and
 * a raw destination row are projected through this, so equality is a genuine
 * field-by-field comparison rather than a string/blob coincidence.
 */
export function canonicalize(spec: EntitySpec, input: unknown, from: 'source' | 'row'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const record = (input ?? {}) as Record<string, unknown>;
  for (const col of spec.columns) {
    let raw: unknown;
    if (col.source === undefined) {
      raw = col.defaultValue;
    } else if (from === 'source') {
      raw = readSourcePath(record, col.source);
      if (raw === undefined || raw === null) raw = col.defaultValue;
    } else if (col.json) {
      const text = record[col.column];
      if (typeof text === 'string' && text.length > 0) {
        try {
          raw = JSON.parse(text);
        } catch {
          raw = text;
        }
      } else if (text !== undefined && text !== null) {
        raw = text;
      }
    } else {
      raw = record[col.column];
    }
    const value = toComparable(raw);
    if (value !== undefined) out[col.column] = value;
  }
  return out;
}

/** Stable structural equality for canonical records. */
function canonicalEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => canonicalEquals(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) =>
    canonicalEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/** Dotted field paths that differ between two canonical records. */
function canonicalDiff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff: string[] = [];
  for (const key of [...keys].sort()) {
    if (!canonicalEquals(a[key], b[key])) diff.push(key);
  }
  return diff;
}

/** Stable identity string for a record, built from the entity's primary key. */
export function recordIdentity(spec: EntitySpec, record: unknown): string {
  const values = spec.primaryKey.map((key) => {
    const found = readSourcePath(record, key);
    return found === undefined || found === null ? '' : String(found);
  });
  return values.join('|');
}

/** Column values for one INSERT. Never contains an UPDATE or a delete clause. */
export function buildInsertRow(spec: EntitySpec, record: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const col of spec.columns) {
    let raw: unknown;
    if (col.source === undefined) {
      raw = col.defaultValue;
    } else {
      raw = readSourcePath(record, col.source);
      if (raw === undefined || raw === null) raw = col.defaultValue;
    }
    if (raw === undefined || raw === null) {
      values[col.column] = null;
    } else if (col.json) {
      values[col.column] = JSON.stringify(raw);
    } else if (col.bool) {
      values[col.column] = raw === true || raw === 1 || raw === '1' ? 1 : 0;
    } else {
      values[col.column] = raw;
    }
  }
  return values;
}

/**
 * Build the literal INSERT statement for one row. Plain `INSERT INTO` only:
 * there is deliberately no `ON CONFLICT DO UPDATE`, so an existing row can
 * never be overwritten by this tool.
 */
export function buildInsertStatement(spec: EntitySpec, values: Record<string, unknown>): { sql: string; args: unknown[] } {
  const columns = spec.columns.map((c) => c.column);
  const args = columns.map((c) => (values[c] === undefined ? null : values[c]));
  const sql = `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  return { sql, args };
}

/**
 * Report what the destination schema cannot carry for this entity.
 * A non-empty result means the entity would lose data or fail to insert, so it
 * must be reported rather than migrated.
 */
export function analyzeSchemaGaps(spec: EntitySpec, records: unknown[]): {
  unmappedSourceFields: string[];
  unmappableRequiredColumns: string[];
} {
  const mapped = new Set(
    spec.columns.map((c) => c.source).filter((s): s is string => typeof s === 'string')
  );
  // A source object whose leaves are all mapped (e.g. `balance` -> `balance.known`)
  // is represented, not a gap. Only fields nothing maps are reported.
  const isMapped = (key: string): boolean => {
    if (mapped.has(key)) return true;
    for (const path of mapped) {
      if (path.startsWith(`${key}.`)) return true;
    }
    return false;
  };

  const seen = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const key of Object.keys(record as Record<string, unknown>)) {
      if (!isMapped(key)) seen.add(key);
    }
  }
  const unmappableRequiredColumns: string[] = [];
  for (const record of records) {
    for (const col of spec.columns) {
      if (!col.required || col.source !== undefined) continue;
      const supplied = readSourcePath(record, col.column);
      if (supplied === undefined || supplied === null) {
        if (!unmappableRequiredColumns.includes(col.column)) unmappableRequiredColumns.push(col.column);
      }
    }
  }
  return {
    unmappedSourceFields: [...seen].sort(),
    unmappableRequiredColumns: unmappableRequiredColumns.sort(),
  };
}

/**
 * In-memory destination. Used for dry-run (read-only) and by unit tests, so
 * classification can be exercised with no Turso credentials and no network.
 */
export class InMemoryMigrationDestination implements MigrationDestination {
  readonly label: string;
  private readonly tables = new Map<MigrationEntity, Map<string, Record<string, unknown>>>();
  private readonly writable: boolean;
  /** Number of attempted inserts, so tests can assert dry-run wrote nothing. */
  insertAttempts = 0;
  writes = 0;

  constructor(options: { label?: string; writable?: boolean; seed?: Partial<Record<MigrationEntity, Record<string, unknown>[]>> } = {}) {
    this.label = options.label ?? 'in-memory';
    this.writable = options.writable ?? false;
    for (const entity of TABLES) {
      const rows = options.seed?.[entity] ?? [];
      const table = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        table.set(this.keyFor(entity, row), { ...row });
      }
      this.tables.set(entity, table);
    }
  }

  private keyFor(entity: MigrationEntity, row: Record<string, unknown>): string {
    return ENTITY_SPECS[entity].primaryKey.map((k) => String(row[k] ?? '')).join('|');
  }

  async readAll(entity: MigrationEntity): Promise<Record<string, unknown>[]> {
    return [...(this.tables.get(entity)?.values() ?? [])].map((row) => ({ ...row }));
  }

  async insert(entity: MigrationEntity, values: Record<string, unknown>): Promise<void> {
    this.insertAttempts += 1;
    if (!this.writable) {
      throw new Error(`Destination "${this.label}" is read-only: refusing to insert into ${entity}.`);
    }
    const table = this.tables.get(entity)!;
    const key = this.keyFor(entity, values);
    if (table.has(key)) {
      // Primary-key collision. Refuse rather than overwrite.
      throw new Error(`${entity} already contains a record with primary key ${key}.`);
    }
    // Mirror the destination's declared UNIQUE constraints so this stand-in
    // rejects exactly what a real table would reject.
    for (const column of ENTITY_SPECS[entity].uniqueColumns) {
      const value = values[column];
      if (value === undefined || value === null || value === '') continue;
      for (const existing of table.values()) {
        if (existing[column] === value) {
          throw new Error(`${entity} violates UNIQUE(${column}) for ${String(value)}.`);
        }
      }
    }
    table.set(key, { ...values });
    this.writes += 1;
  }
}

/** Result of classifying a single record, before any write is attempted. */
export interface RecordClassification {
  id: string;
  classification: MigrationClassification;
  fields: string[];
}

function classifyRecord(
  spec: EntitySpec,
  record: unknown,
  destinationRows: Map<string, Record<string, unknown>>,
  uniqueIndex: Map<string, { id: string; column: string }>
): RecordClassification {
  const id = recordIdentity(spec, record);
  const existing = destinationRows.get(id);
  const sourceCanonical = canonicalize(spec, record, 'source');

  if (!existing) {
    // No row under this primary key. Check columns the destination declares
    // UNIQUE so a duplicate email is a CONFLICT rather than a second row.
    for (const column of spec.uniqueColumns) {
      const value = sourceCanonical[column];
      if (value === undefined || value === null || value === '') continue;
      const clash = uniqueIndex.get(`${column}=${String(value)}`);
      if (clash) {
        return { id, classification: 'CONFLICT', fields: [column] };
      }
    }
    return { id, classification: 'NEW', fields: [] };
  }

  const fields = canonicalDiff(sourceCanonical, canonicalize(spec, existing, 'row'));
  return { id, classification: fields.length === 0 ? 'SAME' : 'CONFLICT', fields };
}

/**
 * Classify every source record of one entity, then insert the NEW ones.
 *
 * Idempotency: only NEW records are written, always with a plain INSERT under
 * the destination's own primary key, so a re-run finds the row already present
 * and reports SAME instead of creating a duplicate.
 *
 * Conflicts are never overwritten and never resolved automatically.
 */
export async function migrateEntity(
  entity: MigrationEntity,
  sourceRecords: unknown[],
  destination: MigrationDestination,
  options: { execute: boolean }
): Promise<EntityMigrationResult> {
  const spec = ENTITY_SPECS[entity];
  const rows = await destination.readAll(entity);

  const destinationRows = new Map<string, Record<string, unknown>>();
  const uniqueIndex = new Map<string, { id: string; column: string }>();
  for (const row of rows) {
    const canonical = canonicalize(spec, row, 'row');
    destinationRows.set(recordIdentity(spec, canonical), row);
    for (const column of spec.uniqueColumns) {
      const value = canonical[column];
      if (value === undefined || value === null || value === '') continue;
      uniqueIndex.set(`${column}=${String(value)}`, {
        id: recordIdentity(spec, canonical),
        column,
      });
    }
  }

  const gaps = analyzeSchemaGaps(spec, sourceRecords);
  const result: EntityMigrationResult = {
    entity,
    table: spec.table,
    sourceCount: sourceRecords.length,
    destinationCount: rows.length,
    new: 0,
    same: 0,
    conflict: 0,
    missingIds: [],
    unexpectedIds: [],
    unmappedSourceFields: gaps.unmappedSourceFields,
    unmappableRequiredColumns: gaps.unmappableRequiredColumns,
    conflictFields: [],
    failures: [],
    blocked: false,
    inserted: 0,
  };

  const seenIds = new Set<string>();
  const claimedUnique = new Map<string, string>();
  const classified: RecordClassification[] = [];
  for (const record of sourceRecords) {
    const outcome = classifyRecord(spec, record, destinationRows, uniqueIndex);
    seenIds.add(outcome.id);

    let final = outcome;
    if (outcome.classification === 'NEW') {
      // Two source records claiming the same declared-UNIQUE value could never
      // both exist in the destination (e.g. two login alerts for one
      // periodDate). The destination would reject the second insert, so report
      // it as a CONFLICT now: a dry run must surface the problem rather than
      // only failing later during execute.
      const sourceCanonical = canonicalize(spec, record, 'source');
      for (const column of spec.uniqueColumns) {
        const value = sourceCanonical[column];
        if (value === undefined || value === null || value === '') continue;
        const uniqueKey = `${column}=${String(value)}`;
        if (claimedUnique.has(uniqueKey)) {
          final = { id: outcome.id, classification: 'CONFLICT', fields: [column] };
          break;
        }
        claimedUnique.set(uniqueKey, outcome.id);
      }
    }

    classified.push(final);
    if (final.classification === 'NEW') {
      result.new += 1;
      result.missingIds.push(final.id);
    } else if (final.classification === 'SAME') {
      result.same += 1;
    } else {
      result.conflict += 1;
      result.conflictFields.push({ id: final.id, fields: final.fields });
    }
  }

  for (const [key] of destinationRows) {
    if (!seenIds.has(key)) result.unexpectedIds.push(key);
  }

  // A schema gap means data would be lost or the INSERT would fail. Report it
  // and refuse; never silently drop or invent a value.
  result.blocked = result.unmappedSourceFields.length > 0 || result.unmappableRequiredColumns.length > 0;

  if (!options.execute) {
    // Dry-run: classification only. Zero writes, by construction.
    return result;
  }

  if (result.blocked) return result;

  for (let i = 0; i < sourceRecords.length; i += 1) {
    const { id, classification } = classified[i];
    if (classification !== 'NEW') continue;
    const values = buildInsertRow(spec, sourceRecords[i]);
    try {
      await destination.insert(entity, values);
      destinationRows.set(id, values);
      result.inserted += 1;
    } catch (error: any) {
      // Report the exact record that failed and keep going: rows already
      // written stay written and a retry classifies them as SAME.
      result.failures.push({ id, message: error?.message ?? String(error) });
    }
  }

  return result;
}

/** Source records for one entity, normalised to an array. */
function sourceRecordsFor(entity: MigrationEntity, source: SourceData): unknown[] {
  const value = (source as unknown as Record<string, unknown>)[entity];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/**
 * Real destination: a thin adapter over the same libSQL client that
 * `server/db/tursoStore.ts` uses. It is constructed only from the `--execute`
 * path, so dry-run never opens a connection.
 *
 * Every statement is a plain `INSERT INTO`. There is deliberately no
 * `ON CONFLICT DO UPDATE`, no `UPDATE`, no `DELETE`, `DROP` or `TRUNCATE`
 * anywhere in this class: an existing row can never be overwritten.
 */
export class LibsqlMigrationDestination implements MigrationDestination {
  readonly label: string;
  private readonly client: {
    execute: (opts: { sql: string; args?: unknown[] }) => Promise<{ rows: any[] }>;
  };

  constructor(client: LibsqlMigrationDestination['client'], label = 'turso') {
    this.client = client;
    this.label = label;
  }

  async readAll(entity: MigrationEntity): Promise<Record<string, unknown>[]> {
    const result = await this.client.execute({ sql: `SELECT * FROM ${ENTITY_SPECS[entity].table}` });
    return (result.rows ?? []) as Record<string, unknown>[];
  }

  async insert(entity: MigrationEntity, values: Record<string, unknown>): Promise<void> {
    const { sql, args } = buildInsertStatement(ENTITY_SPECS[entity], values);
    await this.client.execute({ sql, args });
  }
}

/**
 * Migrate all 9 entities from the validated JSON source into a destination.
 *
 * In dry-run the destination is an in-memory store, so nothing is read from or
 * written to Turso and no credentials are needed.
 */
export async function migrateDatabase(
  source: SourceData,
  destination: MigrationDestination,
  options: { execute: boolean }
): Promise<DbMigrationResult> {
  const entities: EntityMigrationResult[] = [];
  const blockers: string[] = [];

  for (const entity of TABLES) {
    const records = sourceRecordsFor(entity, source);
    let entityResult: EntityMigrationResult;
    try {
      entityResult = await migrateEntity(entity, records, destination, options);
    } catch (error: any) {
      entityResult = {
        entity,
        table: ENTITY_SPECS[entity].table,
        sourceCount: records.length,
        destinationCount: 0,
        new: 0,
        same: 0,
        conflict: 0,
        missingIds: [],
        unexpectedIds: [],
        unmappedSourceFields: [],
        unmappableRequiredColumns: [],
        conflictFields: [],
        failures: [{ id: '(entity)', message: error?.message ?? String(error) }],
        blocked: true,
        inserted: 0,
      };
    }
    entities.push(entityResult);
    if (entityResult.blocked) {
      const details = [
        entityResult.unmappedSourceFields.length
          ? `source fields with no destination column: ${entityResult.unmappedSourceFields.join(', ')}`
          : '',
        entityResult.unmappableRequiredColumns.length
          ? `required destination columns the source cannot supply: ${entityResult.unmappableRequiredColumns.join(', ')}`
          : '',
      ].filter(Boolean);
      blockers.push(`${entity}: ${details.join('; ')}`);
    }
  }

  const totals = entities.reduce(
    (acc, e) => ({
      sourceCount: acc.sourceCount + e.sourceCount,
      destinationCount: acc.destinationCount + e.destinationCount,
      new: acc.new + e.new,
      same: acc.same + e.same,
      conflict: acc.conflict + e.conflict,
      inserted: acc.inserted + e.inserted,
      failures: acc.failures + e.failures.length,
    }),
    { sourceCount: 0, destinationCount: 0, new: 0, same: 0, conflict: 0, inserted: 0, failures: 0 }
  );

  let status: MigrationStatus;
  if (totals.failures > 0) status = 'FAILED';
  else if (blockers.length > 0) status = 'BLOCKED';
  else if (!options.execute) status = totals.conflict > 0 ? 'PARTIAL' : 'READY';
  else status = totals.conflict > 0 ? 'PARTIAL' : 'PASS';

  return {
    mode: options.execute ? 'execute' : 'dry-run',
    destination: destination.label,
    entities,
    totals,
    status,
    blockers,
  };
}

// ============================================================
// Storage Migration
// ============================================================

interface StorageFileInfo {
  key: string;
  path: string;
  size: number;
  hash: string;
}

interface StorageMigrationResult {
  sourceFiles: number;
  sourceKeys: string[];
  sourceSizes: Record<string, number>;
  sourceHashes: Record<string, string>;
  destinationFiles: number;
  destinationKeys: string[];
  matched: number;
  mismatched: MismatchRecord[];
  missing: string[];
}

async function migrateStorage(
  r2Provider: any,
  execute: boolean
): Promise<any> {
  const sourceFiles = getAllStorageFiles(SOURCE_STORAGE_DIR);
  
  const result: any = {
    sourceFiles: sourceFiles.length,
    sourceKeys: sourceFiles.map(f => f.key),
    sourceSizes: {},
    sourceHashes: {},
    destinationFiles: 0,
    destinationKeys: [],
    matched: 0,
    mismatched: [],
    missing: [],
  };
  
  for (const file of sourceFiles) {
    result.sourceSizes[file.key] = file.size;
    result.sourceHashes[file.key] = file.hash;
  }
  
  if (!execute) {
    console.log('\n=== STORAGE DRY RUN ===');
    console.log(`Source files: ${result.sourceFiles}`);
    for (const file of sourceFiles) {
      console.log(`  ${file.key} (${file.size} bytes, ${file.hash.slice(0,16)}...)`);
    }
    return result;
  }
  
  console.log('\n=== STORAGE EXECUTION NOT IMPLEMENTED ===');
  console.log('R2 credentials required for actual migration.');
  console.log('Use --storage-dry-run for validation only.');
  
  return result;
}

// ============================================================
// Verification
// ============================================================

async function verifyDatabase(): Promise<any> {
  console.log('\n=== DATABASE VERIFICATION ===');
  console.log('Note: Requires Turso credentials to be set in environment.');
  
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    return {
      status: 'ERROR',
      details: ['Turso credentials not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.']
    };
  }
  
  return {
    status: 'ERROR',
    details: ['Verification not implemented yet. Turso credentials required.']
  };
}

async function verifyStorage(): Promise<any> {
  console.log('\n=== STORAGE VERIFICATION ===');
  console.log('Note: Requires R2 credentials to be set in environment.');
  
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || 
      !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    return {
      status: 'ERROR',
      details: ['R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.']
    };
  }
  
  return {
    status: 'ERROR',
    details: ['Verification not implemented yet. R2 credentials required.']
  };
}

// ============================================================
// Manifest Generation
// ============================================================

/**
 * Build the migration manifest. Counts are derived from the migration result,
 * never hardcoded, and only identifiers and counts are recorded: no record
 * bodies, no tokens, no passwords, no keys.
 */
function generateManifest(
  dbResult: DbMigrationResult,
  storageResult: any,
  dbVerification: any,
  storageVerification: any
): any {
  const sourceCounts: Record<string, number> = {};
  const destinationCounts: Record<string, number> = {};
  const missing: string[] = [];
  const unexpected: string[] = [];
  const conflicts: ConflictRecord[] = [];

  for (const entity of dbResult.entities) {
    sourceCounts[entity.entity] = entity.sourceCount;
    destinationCounts[entity.entity] = entity.destinationCount;
    for (const id of entity.missingIds) missing.push(`${entity.entity}:${id}`);
    for (const id of entity.unexpectedIds) unexpected.push(`${entity.entity}:${id}`);
    for (const c of entity.conflictFields) {
      conflicts.push({ table: entity.entity, id: c.id, source: null, destination: null, fields: c.fields });
    }
  }

  const manifest: any = {
    timestamp: new Date().toISOString(),
    gitCommit: getGitCommit(),
    mode: dbResult.mode,
    database: {
      status: dbResult.status,
      destination: dbResult.destination,
      sourceCounts,
      destinationCounts,
      new: dbResult.totals.new,
      same: dbResult.totals.same,
      conflict: dbResult.totals.conflict,
      inserted: dbResult.totals.inserted,
      failures: dbResult.totals.failures,
      // Identifiers and differing field names only. Record bodies are never
      // written to the manifest.
      conflicts,
      missing,
      unexpected,
      blockers: dbResult.blockers,
      entities: dbResult.entities,
    },
    storage: {
      sourceFiles: storageResult.sourceFiles,
      sourceKeys: storageResult.sourceKeys,
      sourceSizes: storageResult.sourceSizes,
      sourceHashes: storageResult.sourceHashes,
      destinationFiles: storageResult.destinationFiles,
      destinationKeys: storageResult.destinationKeys,
      matched: storageResult.matched,
      mismatched: storageResult.mismatched,
      missing: storageResult.missing,
    },
    verification: {
      database: dbVerification,
      storage: storageVerification,
    },
    overallStatus: dbResult.status,
  };

  return manifest;
}

function writeManifest(manifest: any): void {
  const manifestPath = resolve(PROJECT_ROOT, `migration-manifest-${Date.now()}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to: ${manifestPath}`);
}

function printManifestSummary(manifest: any): void {
  console.log('\n=== MIGRATION MANIFEST ===');
  console.log(`Timestamp: ${manifest.timestamp}`);
  if (manifest.gitCommit) console.log(`Git Commit: ${manifest.gitCommit}`);
  console.log(`Mode: ${manifest.mode}`);
  console.log(`Overall Status: ${manifest.overallStatus}`);
  
  console.log('\n--- DATABASE ---');
  console.log('Status:', manifest.database.status);
  console.log('Destination:', manifest.database.destination);
  console.log('Source Counts:', manifest.database.sourceCounts);
  console.log('Destination Counts:', manifest.database.destinationCounts);
  console.log('NEW:', manifest.database.new);
  console.log('SAME:', manifest.database.same);
  console.log('CONFLICT:', manifest.database.conflict);
  console.log('Inserted:', manifest.database.inserted);
  console.log('Missing:', manifest.database.missing.length);
  console.log('Unexpected:', manifest.database.unexpected.length);
  for (const entity of manifest.database.entities) {
    const flags = [
      `new=${entity.new}`,
      `same=${entity.same}`,
      `conflict=${entity.conflict}`,
      `inserted=${entity.inserted}`,
    ];
    if (entity.blocked) flags.push('BLOCKED');
    console.log(`  ${entity.entity}: ${flags.join(' ')}`);
    if (entity.unmappedSourceFields.length) {
      console.log(`    unmapped source fields: ${entity.unmappedSourceFields.join(', ')}`);
    }
    if (entity.unmappableRequiredColumns.length) {
      console.log(`    required columns not supplied by source: ${entity.unmappableRequiredColumns.join(', ')}`);
    }
    for (const failure of entity.failures) {
      console.log(`    FAILED ${entity.entity} ${failure.id}: ${failure.message}`);
    }
  }
  if (manifest.database.blockers.length) {
    console.log('\n--- BLOCKERS (migration cannot proceed) ---');
    for (const blocker of manifest.database.blockers) console.log(`  ${blocker}`);
  }
  
  console.log('\n--- STORAGE ---');
  console.log('Source Files:', manifest.storage.sourceFiles);
  console.log('Destination Files:', manifest.storage.destinationFiles);
  console.log('Matched:', manifest.storage.matched);
  console.log('Mismatched:', manifest.storage.mismatched.length);
  console.log('Missing:', manifest.storage.missing.length);
  
  console.log('\n--- VERIFICATION ---');
  console.log('Database:', manifest.verification.database.status);
  console.log('Storage:', manifest.verification.storage.status);
}

// ============================================================
// Main Entry Point
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();
  
  if (args.help) {
    printHelp();
    return;
  }
  
  console.log('=== ODIA-SRT PRODUCTION MIGRATION TOOLING ===');
  console.log(`Mode: ${args.execute ? 'EXECUTE' : (args.verify ? 'VERIFY' : 'DRY RUN')}`);
  console.log(`Storage mode: ${args.storageDryRun ? 'dry-run' : (args.storageVerify ? 'verify' : 'normal')}`);
  
  // Load and validate source
  console.log('\n=== LOADING SOURCE DATA ===');
  let sourceData: any;
  try {
    sourceData = loadAndValidateSource();
    console.log('Source database loaded successfully.');
    console.log('Source counts:');
    for (const [table, records] of Object.entries(sourceData)) {
      if (Array.isArray(records)) {
        console.log(`  ${table}: ${records.length}`);
      } else if (table === 'providerSafety' && records) {
        console.log('  providerSafety: 1');
      }
    }
  } catch (e: any) {
    console.error('Failed to load source data:', e.message);
    process.exit(1);
  }
  
  // Storage info
  console.log('\n=== STORAGE INFO ===');
  const storageFiles = getAllStorageFiles(SOURCE_STORAGE_DIR);
  console.log(`Source storage files: ${storageFiles.length}`);
  for (const file of storageFiles) {
    console.log(`  ${file.key} (${file.size} bytes)`);
  }
  
  // Handle different modes
  if (args.verify) {
    console.log('\n=== VERIFICATION MODE ===');
    const dbVerification = await verifyDatabase();
    const storageVerification = await verifyStorage();
    console.log('Database:', dbVerification.status);
    console.log('Storage:', storageVerification.status);
    return;
  }
  
  if (args.storageVerify) {
    const storageVerification = await verifyStorage();
    console.log('Storage:', storageVerification.status);
    return;
  }
  
  if (args.storageDryRun) {
    await migrateStorage(null, false);
    return;
  }
  
  // Default: dry-run mode
  const dryRun = !process.argv.includes('--execute');
  
  if (dryRun) {
    console.log('\n=== DRY RUN MODE ===');
    console.log('No writes will be performed.');
    
    // Database dry run: classify against an in-memory destination. No Turso
    // connection is opened and no credentials are needed or read.
    console.log('\n--- DATABASE DRY RUN ---');
    const dryRunDestination = new InMemoryMigrationDestination({ label: 'in-memory (dry run)', writable: false });
    const dbResult = await migrateDatabase(sourceData, dryRunDestination, { execute: false });
    for (const entity of dbResult.entities) {
      console.log(
        `  ${entity.entity}: ${entity.sourceCount} source, ${entity.destinationCount} destination, ` +
        `new=${entity.new}, same=${entity.same}, conflict=${entity.conflict}` +
        (entity.blocked ? ' [BLOCKED]' : '')
      );
    }
    console.log(`  status: ${dbResult.status}, writes: ${dryRunDestination.writes}`);
    
    console.log('\n--- STORAGE DRY RUN ---');
    const storageResult = await migrateStorage(null, false);
    console.log(`Source files: ${storageFiles.length}`);
    for (const file of storageFiles) {
      console.log(`  ${file.key} (${file.size} bytes)`);
    }
    
    console.log('\n--- DRY RUN COMPLETE ---');
    console.log('No changes made. Use --execute to perform actual migration.');
    
    const manifest = generateManifest(
      dbResult,
      storageResult,
      { status: 'SKIPPED', details: ['Dry run - no verification'] },
      { status: 'SKIPPED', details: ['Dry run - no verification'] }
    );
    
    writeManifest(manifest);
    printManifestSummary(manifest);
    return;
  }
  
  // Execute mode
  console.log('\n=== EXECUTE MODE ===');
  console.log('WARNING: This will perform actual migration!');
  console.log('Make sure you have configured:');
  console.log('  - TURSO_DATABASE_URL and TURSO_AUTH_TOKEN');
  console.log('  - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
  console.log('  - DATABASE_PROVIDER=turso');
  console.log('  - STORAGE_PROVIDER=r2');
  console.log('  - PROVIDER_SPENDING_PROTECTION=true');
  
  console.log('\nMigration execution not yet implemented.');
  console.log('Use --dry-run to validate migration plan.');
}

/**
 * Only run the CLI when this file is the entry point. Tests import the
 * migration core directly, and must never trigger a run or a manifest write.
 */
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}