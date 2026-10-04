/**
 * ADMIN Excel export of the credit/purchase ledger.
 *
 * Pure builder: it takes already-loaded rows and returns an .xlsx buffer, so it
 * is fully unit-testable without a database, a server or the filesystem.
 *
 * The database/ledger is the ONLY source of truth. Nothing here invents a
 * purchase: fields the system has never recorded (a payment gateway, a gateway
 * payment id, an expiry, a real plan purchase) are written as empty cells
 * rather than fabricated. There is no payment gateway in this product, so those
 * columns are intentionally blank.
 *
 * SECURITY: rows are assembled from an EXPLICIT whitelist of fields. Secrets
 * (API keys, admin bootstrap tokens, password hashes, session token hashes) are
 * never read, so they cannot reach the workbook.
 */
import ExcelJS from 'exceljs';
import type { CreditTransactionRecord } from '../db/types';
import { CREDIT_PACKS, type CreditPack } from './creditPolicy';

/** Minimal user projection needed for the export. */
export interface ExportUser {
  id: string;
  email?: string;
  ownerEmail?: string;
  credits: number;
}

/** Per-user lifetime aggregates, supplied by the caller (repo-backed). */
export interface ExportUserTotals {
  granted: number;
  used: number;
}

export interface WorkbookInput {
  /** EVERY transaction, any order (the builder sorts). */
  transactions: CreditTransactionRecord[];
  users: ExportUser[];
  totals: Record<string, ExportUserTotals>;
  /** Defaults to CREDIT_PACKS; injectable for tests. */
  packs?: readonly CreditPack[];
  generatedAt?: Date;
}

const BLANK = '—';

/**
 * Grant/usage classification MIRRORS CreditRepo.sumGrants / CreditRepo.sumUsed
 * exactly, so the export can never disagree with the balances the app itself
 * reports. Do not invent a different rule here.
 */
const GRANT_TYPES = new Set(['ADMIN_ADJUSTMENT', 'ADMIN_GRANT', 'PURCHASE']);
const GRANT_CREDIT_REASONS = new Set(['initial_grant', 'purchase']);
const USED_TYPES = new Set(['DEBIT', 'ADMIN_DEBIT', 'USAGE']);
/** A reservation holds credits; a release gives that hold back. */
const HOLD_TYPE = 'RESERVATION';

function isGrant(t: CreditTransactionRecord): boolean {
  if (GRANT_TYPES.has(t.type)) return true;
  return t.type === 'CREDIT' && GRANT_CREDIT_REASONS.has(t.reason);
}

/** Ledger "Credits In": real grants, plus released holds and refunds. */
function isCreditIn(t: CreditTransactionRecord): boolean {
  return isGrant(t) || t.type === 'RELEASE' || t.type === 'REFUND';
}

/** Ledger "Credits Out": real spend, plus holds taken on a job. */
function isCreditOut(t: CreditTransactionRecord): boolean {
  return USED_TYPES.has(t.type) || t.type === HOLD_TYPE;
}

/**
 * A "purchase" is a real credit grant or a refund. A RELEASED reservation hold
 * is deliberately NOT a purchase: it is the return of credits the user was
 * never charged for.
 */
function isPurchase(t: CreditTransactionRecord): boolean {
  return isGrant(t) || t.type === 'REFUND';
}

const PURCHASE_SHEET = 'Purchase History';
const LEDGER_SHEET = 'Credit Ledger';
const PLAN_SHEET = 'Plan Reference';

/** Rupee format with a literal symbol so Excel shows "₹" without locale games. */
const INR_FMT = '"\u20B9"#,##0';
const NUM_FMT = '#,##0';
const DATE_FMT = 'yyyy-mm-dd';
const TIME_FMT = 'hh:mm:ss';

function parseDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function describe(t: CreditTransactionRecord): string {
  const label = t.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  return t.reason ? `${label} — ${t.reason}` : label;
}

function packById(packs: readonly CreditPack[], id: string | undefined): CreditPack | undefined {
  return id ? packs.find((p) => p.id === id) : undefined;
}

/** Add a worksheet with frozen header row + auto-filter across the header. */
function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Array<Partial<ExcelJS.Column>>,
  lastColumn: string
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns as ExcelJS.Column[];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  ws.autoFilter = `A1:${lastColumn}1`;
  return ws;
}

function fmt(row: ExcelJS.Row, key: string, format: string) {
  row.getCell(key).numFmt = format;
}

/**
 * Build the workbook. Returns a Node Buffer containing a real .xlsx (a ZIP of
 * OOXML parts) — ready to be streamed to the browser as a download.
 *
 * Each call builds its OWN workbook, so exports never contaminate each other.
 */
export async function buildCreditExportWorkbook(input: WorkbookInput): Promise<Buffer> {
  const packs = input.packs ?? CREDIT_PACKS;
  const generatedAt = input.generatedAt ?? new Date();
  const userById = new Map(input.users.map((u) => [u.id, u]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'OdiaSRT Admin';
  wb.created = generatedAt;

  const all = input.transactions.slice().sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );

  // Purchase History is created FIRST so it is the workbook's first tab.
  const purchaseRows = all
    .filter(isPurchase)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  const purchases = addSheet(
    wb,
    PURCHASE_SHEET,
    [
      { header: 'Transaction ID', key: 'txnId', width: 40 },
      { header: 'User ID', key: 'userId', width: 40 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Plan', key: 'plan', width: 16 },
      { header: 'Credits Purchased', key: 'creditsPurchased', width: 17 },
      { header: 'Amount (\u20B9)', key: 'amount', width: 14 },
      { header: 'Payment Status', key: 'paymentStatus', width: 16 },
      { header: 'Payment Gateway', key: 'gateway', width: 16 },
      { header: 'Gateway Payment ID', key: 'gatewayId', width: 22 },
      { header: 'Purchase Date', key: 'date', width: 14 },
      { header: 'Purchase Time', key: 'time', width: 10 },
      { header: 'Credits Added', key: 'creditsAdded', width: 14 },
      { header: 'Credits Used', key: 'creditsUsed', width: 13 },
      { header: 'Credits Remaining', key: 'creditsRemaining', width: 18 },
      { header: 'Expiry', key: 'expiry', width: 14 },
      { header: 'Refund Status', key: 'refundStatus', width: 15 },
      { header: 'Refund Date', key: 'refundDate', width: 14 },
      { header: 'Notes', key: 'notes', width: 44 },
    ],
    'S'
  );

  for (const t of purchaseRows) {
    const u = userById.get(t.userId);
    const tot = input.totals[t.userId] ?? { granted: 0, used: 0 };
    const d = parseDate(t.createdAt);
    const pack = packById(packs, t.packageId);
    const manual = t.type !== 'PURCHASE';
    const notes: string[] = [`type=${t.type}`, `reason=${t.reason}`];
    if (manual) notes.push('manual/admin credit (not a paid purchase)');
    if (t.adminEmail) notes.push(`admin=${t.adminEmail}`);
    if (t.jobId) notes.push(`job=${t.jobId}`);
    if (!u) notes.push('user not found');

    const row = purchases.addRow({
      txnId: t.id,
      userId: t.userId,
      name: BLANK,
      email: u?.email ?? u?.ownerEmail ?? BLANK,
      plan: pack ? pack.name : BLANK,
      creditsPurchased: pack ? pack.credits : null,
      amount: null,
      paymentStatus: t.paymentStatus ?? BLANK,
      gateway: BLANK,
      gatewayId: t.paymentId ?? BLANK,
      date: d,
      time: d,
      creditsAdded: t.amount,
      creditsUsed: tot.used,
      creditsRemaining: u?.credits ?? null,
      expiry: t.expiresAt ? parseDate(t.expiresAt) : null,
      refundStatus: 'N/A',
      refundDate: null,
      notes: notes.join('; '),
    });
    fmt(row, 'creditsPurchased', NUM_FMT);
    fmt(row, 'amount', INR_FMT);
    fmt(row, 'date', DATE_FMT);
    fmt(row, 'time', TIME_FMT);
    fmt(row, 'creditsAdded', NUM_FMT);
    fmt(row, 'creditsUsed', NUM_FMT);
    fmt(row, 'creditsRemaining', NUM_FMT);
    fmt(row, 'expiry', DATE_FMT);
    fmt(row, 'refundDate', DATE_FMT);
  }

  // ---------------------------------------------------------------- Ledger
  const ledger = addSheet(
    wb,
    LEDGER_SHEET,
    [
      { header: 'Ledger ID', key: 'ledgerId', width: 12 },
      { header: 'Transaction ID', key: 'txnId', width: 40 },
      { header: 'User ID', key: 'userId', width: 40 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Time', key: 'time', width: 10 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Description', key: 'description', width: 46 },
      { header: 'Credits In', key: 'in', width: 12 },
      { header: 'Credits Out', key: 'out', width: 12 },
      { header: 'Balance After', key: 'balanceAfter', width: 14 },
      { header: 'Notes', key: 'notes', width: 40 },
    ],
    'L'
  );

  all.forEach((t, i) => {
    const u = userById.get(t.userId);
    const d = parseDate(t.createdAt);
    const inCredits = isCreditIn(t) ? t.amount : 0;
    const outCredits = isCreditOut(t) ? t.amount : 0;
    const notes: string[] = [];
    if (t.jobId) notes.push(`job=${t.jobId}`);
    if (t.adminEmail) notes.push(`admin=${t.adminEmail}`);
    else if (t.adminUserId) notes.push(`admin=${t.adminUserId}`);
    if (t.paymentId) notes.push(`paymentId=${t.paymentId}`);
    if (t.expiresAt) notes.push(`expiresAt=${t.expiresAt}`);
    if (!u) notes.push('user not found');

    const row = ledger.addRow({
      ledgerId: i + 1,
      txnId: t.id,
      userId: t.userId,
      name: BLANK,
      date: d,
      time: d,
      type: t.type,
      description: describe(t),
      in: inCredits,
      out: outCredits,
      balanceAfter: t.balanceAfter,
      notes: notes.join('; '),
    });
    fmt(row, 'date', DATE_FMT);
    fmt(row, 'time', TIME_FMT);
    fmt(row, 'in', NUM_FMT);
    fmt(row, 'out', NUM_FMT);
    fmt(row, 'balanceAfter', NUM_FMT);
  });

  // ---------------------------------------------------------- Plan reference
  const plans = addSheet(
    wb,
    PLAN_SHEET,
    [
      { header: 'Plan', key: 'name', width: 18 },
      { header: 'Amount (\u20B9)', key: 'price', width: 14 },
      { header: 'Credits', key: 'credits', width: 12 },
      { header: 'Notes', key: 'notes', width: 60 },
    ],
    'D'
  );
  for (const p of packs) {
    const row = plans.addRow({
      name: p.name,
      price: p.priceInr,
      credits: p.credits,
      notes: [
        `id=${p.id}`,
        'Locked plan (product definition)',
        p.annual ? 'Annual — never auto-renewed' : 'One-time',
        'Payments not enabled — no purchase can be made',
      ].join('; '),
    });
    fmt(row, 'price', INR_FMT);
    fmt(row, 'credits', NUM_FMT);
  }
  const meta = plans.addRow({ name: 'Exported at', price: null, credits: null, notes: generatedAt.toISOString() });
  meta.getCell('notes').font = { italic: true, color: { argb: 'FF64748B' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Filename used by the download response. */
export function exportFileName(now = new Date()): string {
  return `credit-export-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xlsx`;
}
