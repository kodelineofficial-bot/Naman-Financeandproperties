import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedLedgerAmount, loanMoneyOnDate, withPayoutAmounts } from '../src/lib/ledgerAmounts.js';
import { counted, round2, sum } from '../src/lib/format.js';

test('Karan #225 shows actual UPI 2450, separates 100 advance and 2250 old dues', () => {
  const rows = withPayoutAmounts([
    { id: 'upi', kind: 'disbursement', ref_id: 'karan', mode: 'upi', amount: 2550 },
    { id: 'cut67', kind: 'disbursement', ref_id: 'karan', mode: 'renewal', amount: 1350 },
    { id: 'cut68', kind: 'disbursement', ref_id: 'karan', mode: 'renewal', amount: 900 },
    { id: 'advance', kind: 'loan_advance', ref_id: 'karan', mode: 'upi', amount: 100 },
  ], [{ id: 'upi', amount: 2450 }]);
  assert.equal(rows[0].handed_over, 2450);
  assert.equal(rows[0].advance_included, 100);
  assert.equal(rows[0].amount, 2550);
  assert.deepEqual(loanMoneyOnDate(rows, 'karan'), { handedOver: 2450, adjusted: 2250, payoutAdvance: 0 });
  assert.equal(rows.filter((r) => r.kind === 'disbursement').reduce((n, r) => n + r.amount, 0) - rows[3].amount, 4700);
});

test('cash keeps gross book out while UPI shows only the transfer', () => {
  const rows = withPayoutAmounts([
    { id: 'cash', kind: 'disbursement', mode: 'cash', amount: 3700 },
    { id: 'upi', kind: 'disbursement', mode: 'upi', amount: 3550 },
    { id: 'legacy-upi', kind: 'disbursement', mode: 'upi', amount: 3700 },
  ], [{ id: 'cash', amount: 3550 }, { id: 'upi', amount: 3550 }, { id: 'legacy-upi', amount: 3550 }]);
  assert.deepEqual(rows.map(displayedLedgerAmount), [3700, 3550, 3550]);
});

test('advance applies only to its original payout, including several payouts on the same day', () => {
  const rows = withPayoutAmounts([
    { id: 'first', kind: 'disbursement', ref_id: 'loan', mode: 'cash', amount: 1600 },
    { id: 'second', kind: 'disbursement', ref_id: 'loan', mode: 'cash', amount: 2000 },
    { id: 'other', kind: 'disbursement', ref_id: 'other', mode: 'upi', amount: 500 },
  ], [{ id: 'first', amount: 1500 }, { id: 'second', amount: 2000 }, { id: 'other', amount: 500 }]);
  assert.deepEqual(rows.map((r) => [r.handed_over, r.advance_included]), [[1500, 100], [2000, 0], [500, 0]]);
  assert.deepEqual(loanMoneyOnDate(rows, 'loan'), { handedOver: 3500, adjusted: 0, payoutAdvance: 0 });
  assert.deepEqual(loanMoneyOnDate(rows, 'no-payout-today'), { handedOver: 0, adjusted: 0, payoutAdvance: 0 });
});

test('3550 UPI plus 150 retained Cash advance shows cut and income without inventing cash', () => {
  const rows = withPayoutAmounts([
    { id: 'payout', ref_id: 'karan', kind: 'disbursement', direction: 'out', mode: 'upi', amount: 3550 },
    { id: 'karan', ref_id: 'karan', kind: 'loan_advance_cut', direction: 'out', mode: 'cash', amount: 150 },
    { id: 'karan', ref_id: 'karan', kind: 'loan_advance', direction: 'in', mode: 'cash', amount: 150 },
  ], [{ id: 'payout', amount: 3550 }]);
  assert.equal(displayedLedgerAmount(rows[0]), 3550);
  assert.deepEqual(loanMoneyOnDate(rows, 'karan'), { handedOver: 3550, adjusted: 0, payoutAdvance: 0 });
  const cashIn = sum(counted(rows.filter((r) => r.direction === 'in')), 'amount');
  const cashOut = sum(counted(rows.filter((r) => r.direction === 'out')), 'amount');
  assert.deepEqual([cashIn, cashOut, cashIn - cashOut], [150, 150, 0]);
});

test('advance kept from a later payout: 3000 given = 2000 handed over + 1000 advance income (migration 028)', () => {
  const rows = withPayoutAmounts([
    { id: 'part2', kind: 'disbursement', ref_id: 'loan', mode: 'cash', amount: 2000 },
    { id: 'adv', kind: 'disbursement', ref_id: 'loan', mode: 'renewal', amount: 1000 },
    { id: 'adv', kind: 'loan_advance', ref_id: 'loan', mode: 'renewal', amount: 1000, direction: 'in' },
  ], [{ id: 'part2', amount: 2000 }]);
  assert.deepEqual(loanMoneyOnDate(rows, 'loan'), { handedOver: 2000, adjusted: 0, payoutAdvance: 1000 });
  const out = sum(rows.filter((r) => r.kind === 'disbursement'), 'amount');
  const inn = sum(rows.filter((r) => r.kind === 'loan_advance'), 'amount');
  assert.equal(out, 3000);
  assert.equal(round2(out - inn), 2000);
});
