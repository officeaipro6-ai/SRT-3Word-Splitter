import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { CreditTransactionRecord } from '../db/types.ts';
import { buildCreditExportWorkbook, exportFileName } from './excelExport.ts';
import { CREDIT_PACKS } from './creditPolicy.ts';

const AT = '2026-03-04T10:20:30.000Z';

function txn(over: Partial<CreditTransactionRecord> & { id: string }): CreditTransactionRecord {
  return {
    userId: 'u1',
    amount: 1,
    type: 'RESERVATION',
    reason: 'reserve_transcription',
    createdAt: AT,
    balanceAfter: 4,
    balanceBefore: 5,
    ...over,
  } as CreditTransactionRecord;
}

const users = [
  { id: 'u1', email: 'one@example.com', credits: 4 },
  { id: 'u2', email: 'two@example.com', ownerEmail: 'owner@example.com', credits: 80 },
];

/** Read a generated workbook back through exceljs (proves it parses as real OOXML). */
async function readBack(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

function headers(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.getRow(1).eachCell((c) => out.push(String(c.value)));
  return out;
}

test('E1. the export is a real .xlsx (ZIP/OOXML) with the three required sheets', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 't1' })],
    users,
    totals: { u1: { granted: 5, used: 1 } },
  });

  assert.ok(Buffer.isBuffer(buf), 'must return a Buffer');
  assert.ok(buf.length > 1000, `a real xlsx is never this small (${buf.length} bytes)`);
  // Local file header magic: "PK\x03\x04".
  assert.deepEqual([...buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'must be a ZIP container');

  const wb = await readBack(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [
    'Purchase History',
    'Credit Ledger',
    'Plan Reference',
  ]);
  // The OOXML parts Excel needs are really in there.
  const xml = buf.toString('latin1');
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(xml.includes(part), `missing OOXML part ${part}`);
  }
});

test('E2. the export contains EVERY transaction, not just the visible page', async () => {
  // 250 > the dashboard's 200 default page size, so a truncated export fails here.
  const many = Array.from({ length: 250 }, (_, i) =>
    txn({ id: `t${String(i).padStart(3, '0')}`, userId: i % 2 ? 'u1' : 'u2' })
  );

  const buf = await buildCreditExportWorkbook({
    transactions: many,
    users,
    totals: { u1: { granted: 1, used: 1 }, u2: { granted: 1, used: 0 } },
  });
  const wb = await readBack(buf);
  const ledger = wb.getWorksheet('Credit Ledger')!;

  // 1 header row + every transaction row.
  assert.equal(ledger.rowCount, 251, 'all 250 transactions must be present');
  const ids = new Set<string>();
  ledger.eachRow((row, n) => {
    if (n > 1) ids.add(String(row.getCell(2).value));
  });
  assert.equal(ids.size, 250);
  assert.ok(ids.has('t000') && ids.has('t249'));
});

test('E3. sheets carry the exact requested columns in the requested order', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 't1' })],
    users,
    totals: {},
  });
  const wb = await readBack(buf);

  assert.deepEqual(headers(wb.getWorksheet('Purchase History')!), [
    'Transaction ID',
    'User ID',
    'Name',
    'Email',
    'Plan',
    'Credits Purchased',
    'Amount (₹)',
    'Payment Status',
    'Payment Gateway',
    'Gateway Payment ID',
    'Purchase Date',
    'Purchase Time',
    'Credits Added',
    'Credits Used',
    'Credits Remaining',
    'Expiry',
    'Refund Status',
    'Refund Date',
    'Notes',
  ]);

  assert.deepEqual(headers(wb.getWorksheet('Credit Ledger')!), [
    'Ledger ID',
    'Transaction ID',
    'User ID',
    'Name',
    'Date',
    'Time',
    'Type',
    'Description',
    'Credits In',
    'Credits Out',
    'Balance After',
    'Notes',
  ]);

  assert.deepEqual(headers(wb.getWorksheet('Plan Reference')!), [
    'Plan',
    'Amount (₹)',
    'Credits',
    'Notes',
  ]);
});

test('E4. every sheet freezes row 1 and has an auto-filter on the header', async () => {
  const buf = await buildCreditExportWorkbook({ transactions: [txn({ id: 't1' })], users, totals: {} });
  const wb = await readBack(buf);
  for (const name of ['Purchase History', 'Credit Ledger', 'Plan Reference']) {
    const ws = wb.getWorksheet(name)!;
    assert.equal(ws.views[0]?.state, 'frozen', `${name} must freeze the header`);
    assert.equal(ws.views[0]?.ySplit, 1, `${name} must freeze exactly row 1`);
    assert.ok(ws.autoFilter, `${name} must have an auto-filter`);
    assert.match(String(ws.autoFilter), /A1:/, `${name} auto-filter must start at the header row`);
  }
});

test('E5. the Plan Reference sheet mirrors the locked plans in code', async () => {
  const buf = await buildCreditExportWorkbook({ transactions: [], users, totals: {} });
  const wb = await readBack(buf);
  const plans = wb.getWorksheet('Plan Reference')!;

  const rows: Array<[string, number, number]> = [];
  plans.eachRow((row, n) => {
    if (n > 1 && typeof row.getCell(2).value === 'number') {
      rows.push([String(row.getCell(1).value), row.getCell(2).value as number, row.getCell(3).value as number]);
    }
  });

  assert.deepEqual(
    rows,
    CREDIT_PACKS.map((p) => [p.name, p.priceInr, p.credits]),
    'the sheet must be derived from CREDIT_PACKS, never hand-typed'
  );
  assert.deepEqual(
    rows.map((r) => r[1]),
    [69, 129, 299, 599, 1199, 4499]
  );
});

test('E6. amounts are rupee-formatted and credit columns are real numbers', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 't1', type: 'CREDIT', amount: 15, reason: 'manual' })],
    users,
    totals: { u1: { granted: 15, used: 2 } },
  });
  const wb = await readBack(buf);
  const plans = wb.getWorksheet('Plan Reference')!;
  assert.match(String(plans.getCell('B2').numFmt), /₹/, 'plan price must carry the rupee symbol');
  assert.ok(plans.getCell('C2').numFmt.includes('#,##0'), 'credits must be a thousands-separated number');

  const ledger = wb.getWorksheet('Credit Ledger')!;
  // Credits In / Credits Out / Balance After are numeric cells, not text.
  assert.equal(typeof ledger.getCell('I2').value, 'number');
  assert.equal(typeof ledger.getCell('J2').value, 'number');
  assert.equal(typeof ledger.getCell('K2').value, 'number');
  assert.equal(ledger.getCell('E2').numFmt, 'yyyy-mm-dd', 'date must be formatted, not a raw string');
  assert.equal(ledger.getCell('F2').numFmt, 'hh:mm:ss', 'time must be split out and formatted');
});

test('E7. the ledger classifies credits in/out exactly as the repo does', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [
      txn({ id: 'a', type: 'RESERVATION', amount: 1 }),
      txn({ id: 'b', type: 'RELEASE', amount: 1 }),
      txn({ id: 'c', type: 'CREDIT', amount: 35, reason: 'initial_grant' }),
      txn({ id: 'c2', type: 'CREDIT', amount: 7, reason: 'adjustment' }),
      txn({ id: 'd', type: 'USAGE', amount: 2 }),
      txn({ id: 'd2', type: 'DEBIT', amount: 3 }),
      txn({ id: 'e', type: 'REFUND', amount: 5 }),
      txn({ id: 'f', type: 'FREE_TRIAL', amount: 4 }),
    ],
    users,
    totals: {},
  });
  const wb = await readBack(buf);
  const ledger = wb.getWorksheet('Credit Ledger')!;
  const byId = new Map<string, ExcelJS.Row>();
  ledger.eachRow((row, n) => {
    if (n > 1) byId.set(String(row.getCell(2).value), row);
  });
  const cin = (id: string) => byId.get(id)!.getCell(9).value;
  const cout = (id: string) => byId.get(id)!.getCell(10).value;

  assert.equal(cout('a'), 1, 'a reservation holds (out) credits');
  assert.equal(cin('a'), 0);
  assert.equal(cin('b'), 1, 'a release returns (in) the hold');
  assert.equal(cin('c'), 35, 'CREDIT with reason initial_grant is a grant, per sumGrants');
  assert.equal(cin('c2'), 0, 'a CREDIT with any other reason is NOT a grant');
  assert.equal(cout('d'), 2, 'USAGE is a debit, per sumUsed');
  assert.equal(cout('d2'), 3, 'DEBIT is a debit');
  assert.equal(cin('e'), 5, 'a refund credits');
  assert.equal(cin('f'), 0, 'FREE_TRIAL usage is not a grant and not a debit here');
  assert.equal(cout('f'), 0);
});

test('E8. Purchase History lists only real purchases, newest first', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [
      txn({ id: 'old', type: 'CREDIT', reason: 'purchase', amount: 10, userId: 'u2', createdAt: '2026-01-01T00:00:00.000Z' }),
      txn({ id: 'new', type: 'ADMIN_GRANT', amount: 20, userId: 'u2', createdAt: '2026-05-05T00:00:00.000Z' }),
      txn({ id: 'skip', type: 'RESERVATION', amount: 1, userId: 'u2', createdAt: '2026-06-06T00:00:00.000Z' }),
      // A released hold is the return of credits the user was never charged for,
      // so it must NOT appear as a purchase.
      txn({ id: 'skip2', type: 'RELEASE', amount: 1, userId: 'u2', createdAt: '2026-07-07T00:00:00.000Z' }),
    ],
    users,
    totals: { u2: { granted: 30, used: 4 } },
  });
  const wb = await readBack(buf);
  const sheet = wb.getWorksheet('Purchase History')!;

  assert.equal(sheet.rowCount, 3, 'header + 2 purchase rows; reservation and release are not purchases');
  assert.equal(sheet.getCell('A2').value, 'new', 'newest purchase first');
  assert.equal(sheet.getCell('A3').value, 'old');
  // Per-user aggregates, not invented per-row numbers.
  assert.equal(sheet.getCell('N2').value, 4, 'credits used comes from the caller totals');
  assert.equal(sheet.getCell('O2').value, 80, 'credits remaining comes from the user record');
  assert.equal(sheet.getCell('D2').value, 'two@example.com');
  assert.match(String(sheet.getCell('S2').value), /manual\/admin credit/, 'an admin grant must say it is not a paid purchase');
});

test('E9. unrecorded payment facts are left blank, never fabricated', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 't1', type: 'ADMIN_GRANT', amount: 10, reason: 'manual_grant' })],
    users,
    totals: {},
  });
  const wb = await readBack(buf);
  const sheet = wb.getWorksheet('Purchase History')!;
  const row = sheet.getRow(2);

  // There is no payment gateway in this product, so nothing may claim a payment.
  assert.equal(row.getCell(5).value, '—', 'no plan can be inferred from a manual credit');
  assert.equal(row.getCell(6).value, null, 'no invented credits-purchased figure');
  assert.equal(row.getCell(7).value, null, 'no invented rupee amount');
  assert.equal(row.getCell(9).value, '—', 'no invented payment gateway');
  assert.equal(row.getCell(10).value, '—', 'no invented gateway payment id');
  assert.equal(row.getCell(16).value, null, 'no invented expiry');
  assert.match(String(row.getCell(19).value), /manual\/admin credit/, 'the row must say what it really is');
});

test('E10. no secret can reach the workbook', async () => {
  // A user record full of the things that must never be exported.
  const secretUsers = [
    {
      id: 'u1',
      email: 'one@example.com',
      credits: 4,
      ...({ tokenHashes: ['SUPER_SECRET_TOKEN_HASH'], passwordHash: 'scrypt$SALT$HASH' } as object),
    },
  ];
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 't1', type: 'ADMIN_GRANT', amount: 5, reason: 'manual' })],
    users: secretUsers,
    totals: { u1: { granted: 5, used: 0 } },
  });

  // Search the raw bytes of every part, not just the parsed values.
  const raw = buf.toString('latin1') + buf.toString('utf16le');
  for (const forbidden of [
    'SUPER_SECRET_TOKEN_HASH',
    'scrypt$SALT$HASH',
    'tokenHash',
    'passwordHash',
    'SARVAM_API_KEY',
    'adminBootstrapToken',
    'X-Admin-Token',
  ]) {
    assert.ok(!raw.includes(forbidden), `the workbook must not contain ${forbidden}`);
  }
});

test('E11. an empty ledger still produces a valid workbook with headers', async () => {
  const buf = await buildCreditExportWorkbook({ transactions: [], users: [], totals: {} });
  assert.deepEqual([...buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const wb = await readBack(buf);
  const ledger = wb.getWorksheet('Credit Ledger')!;
  assert.equal(ledger.rowCount, 1, 'header only');
  assert.equal(headers(ledger).length, 12);
  // Plans are a product definition, so they exist even with zero transactions.
  assert.ok(wb.getWorksheet('Plan Reference')!.rowCount > 1);
});

test('E12. two exports never contaminate each other', async () => {
  // Regression: a shared module-level workbook would accumulate sheets/rows here.
  const first = await buildCreditExportWorkbook({
    transactions: [txn({ id: 'a1' })],
    users,
    totals: {},
  });
  const second = await buildCreditExportWorkbook({
    transactions: [txn({ id: 'b1' }), txn({ id: 'b2' })],
    users,
    totals: {},
  });

  const wb1 = await readBack(first);
  const wb2 = await readBack(second);
  assert.equal(wb1.worksheets.length, 3, 'the first workbook must have exactly 3 sheets');
  assert.equal(wb2.worksheets.length, 3, 'the second workbook must have exactly 3 sheets');
  assert.equal(wb1.getWorksheet('Credit Ledger')!.rowCount, 2);
  assert.equal(wb2.getWorksheet('Credit Ledger')!.rowCount, 3);
});

test('E13. a transaction for a deleted user does not crash the export', async () => {
  const buf = await buildCreditExportWorkbook({
    transactions: [txn({ id: 'orphan', userId: 'ghost' })],
    users,
    totals: {},
  });
  const wb = await readBack(buf);
  const ledger = wb.getWorksheet('Credit Ledger')!;
  assert.equal(ledger.rowCount, 2);
  assert.match(String(ledger.getCell('L2').value), /user not found/);
  // Purchase History must skip the unresolved user rather than print "undefined".
  const sheet = wb.getWorksheet('Purchase History')!;
  assert.equal(sheet.rowCount, 1);
});

test('E14. the download filename is a safe .xlsx name', () => {
  const name = exportFileName(new Date('2026-03-04T10:20:30.000Z'));
  assert.match(name, /^credit-export-[\d-]+\.xlsx$/);
  assert.ok(!name.includes(':'), 'a colon is illegal in a Windows filename');
  assert.ok(!name.includes('/') && !name.includes('\\'));
});
