import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDays, exportRangeError, maxExportEnd } from '../src/lib/exportRange.js';
import { buildXlsx, colName, crc32, sheetNames } from '../src/lib/xlsx.js';

test('export range: 1 day to 1 month, not in the future', () => {
  const today = '2026-11-11';
  assert.equal(exportRangeError('2026-11-11', '2026-11-11', today), '');
  assert.equal(exportDays('2026-11-11', '2026-11-11'), 1);
  assert.equal(exportRangeError('2026-10-01', '2026-10-31', today), '');
  assert.equal(exportDays('2026-10-01', '2026-10-31'), 31);
  assert.match(exportRangeError('2026-10-01', '2026-11-01', today), /1 month/);
  assert.equal(exportRangeError('2026-10-15', '2026-11-11', today), '');
  assert.match(exportRangeError('2026-10-10', '2026-10-09', today), /before the start/);
  assert.match(exportRangeError('2026-11-01', '2026-11-12', today), /after today/);
  assert.match(exportRangeError('', '2026-11-01', today), /Pick/);
  assert.equal(maxExportEnd('2026-01-31'), '2026-02-27');
  assert.equal(maxExportEnd('2026-02-01'), '2026-02-28');
});

test('xlsx helpers', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  assert.deepEqual(sheetNames(['Day/Book', 'Day Book', 'x'.repeat(40)]), ['Day Book', 'Day Book 2', 'x'.repeat(31)]);
});

test('xlsx file is a valid zip with numbers kept as numbers', (t) => {
  const bytes = buildXlsx([
    { name: 'Day Book', columns: [{ label: 'Party', value: (r) => r.p }, { label: 'Amount', value: (r) => r.a }], rows: [{ p: 'NIRANJAN <PRESS> & "Co" ₹ नमस्ते', a: 290 }, { p: null, a: '' }] },
    { name: 'Empty', columns: [{ label: 'X', value: () => 1 }], rows: [] },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'a.xlsx');
  writeFileSync(file, bytes);
  try {
    execFileSync('unzip', ['-tq', file]);
    execFileSync('unzip', ['-q', file, '-d', join(dir, 'x')]);
  } catch {
    t.skip('unzip not available');
    return;
  }
  const s1 = readFileSync(join(dir, 'x/xl/worksheets/sheet1.xml'), 'utf8');
  assert.match(s1, /<c r="B2"><v>290<\/v><\/c>/);
  assert.match(s1, /NIRANJAN &lt;PRESS&gt; &amp; &quot;Co&quot; ₹ नमस्ते/);
  assert.doesNotMatch(s1, /r="A3"/); // empty cells are left out
  assert.match(readFileSync(join(dir, 'x/xl/workbook.xml'), 'utf8'), /name="Empty"/);
});

test('loan stage in plain words', async () => {
  const { loanStage, daysBehind, loanStageLine } = await import('../src/lib/loanStage.js');
  const today = '2026-11-11';
  const run = { status: 'active', outstanding: 8880, overdue: 4560, daily_installment: 240, expected_end_date: '2026-11-29', progress_pct: 63, penalty_due: 3450, loan_no: 125, frequency: 'daily' };
  assert.equal(loanStage(run, today), 'Behind');
  assert.equal(daysBehind(run), 19);
  assert.equal(loanStageLine(run, today), '#125 Behind · 63% paid · ₹8,880 left · overdue ₹4,560 (19 days) · penalty ₹3,450');
  assert.equal(loanStage({ ...run, overdue: 0 }, today), 'On time');
  assert.equal(loanStage({ ...run, expected_end_date: '2026-10-31' }, today), 'Time over');
  assert.equal(loanStage({ ...run, outstanding: 0 }, today), 'Paid, not closed');
  assert.equal(loanStage({ ...run, status: 'closed' }, today), 'Closed');
  assert.equal(loanStage({ ...run, status: 'renewed' }, today), 'Renewed');
  assert.equal(loanStage({ ...run, status: 'defaulted' }, today), 'Defaulter');
  assert.equal(daysBehind({ overdue: 130, daily_installment: 120 }), 2);
});
