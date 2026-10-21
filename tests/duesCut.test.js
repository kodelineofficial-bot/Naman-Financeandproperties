import test from 'node:test';
import assert from 'node:assert/strict';
import { duesCutCall, duesCutErrors, duesCutRows, duesCutStart } from '../src/lib/duesCut.js';

// G2 comes with Dave when Dave renews: ₹4,000 balance, ₹600 overdue, ₹300 penalty.
const g2 = { id: 'G2', loan_no: 7, borrower_name: 'G2', outstanding: 4000, overdue: 600, penalty_due: 300 };

test('keep running starts at the overdue; close starts at the full balance; penalty apart', () => {
  assert.deepEqual(duesCutStart(g2), { close: false, amount: '600', penalty: '300' });
  assert.deepEqual(duesCutStart(g2, true), { close: true, amount: '4000', penalty: '300' });
});

test('close with less: the rest of installments and penalty is forgiven (छूट)', () => {
  const [r] = duesCutRows([{ loan: g2, close: true, amount: '3800', penalty: '200' }]);
  assert.equal(r.total, 4000);
  assert.equal(r.forgiveInst, 200);
  assert.equal(r.forgivePen, 100);
  assert.equal(r.forgiven, 300);
  assert.deepEqual(duesCutCall(r, 'NEW', '2026-10-21'), ['cut_and_close_into_loan',
    { p_old: 'G2', p_new: 'NEW', p_amount: 3800, p_penalty: 200, p_date: '2026-10-21' }]);
});

test('keep running forgives nothing and uses the plain cut', () => {
  const [r] = duesCutRows([{ loan: g2, amount: '600', penalty: '0' }]);
  assert.equal(r.forgiven, 0);
  assert.equal(duesCutCall(r, 'NEW', '2026-10-21')[0], 'cut_dues_into_loan');
});

test('checks: over the balance / penalty due, and closing with nothing cut', () => {
  const rows = duesCutRows([
    { loan: g2, amount: '4100', penalty: '400' },
    { loan: { ...g2, id: 'X', loan_no: 8 }, close: true, amount: '0', penalty: '0' },
  ]);
  const errs = duesCutErrors(rows);
  assert.equal(errs.length, 3);
  assert.match(errs[2], /enter an amount to cut to close it/);
});
