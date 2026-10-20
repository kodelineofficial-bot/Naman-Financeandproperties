import test from 'node:test';
import assert from 'node:assert/strict';
import { autoFill, received, splitModes } from '../src/lib/borrowerPay.js';

// The client's example: 2 × ₹20,000 (₹240/day), 2 × ₹10,000 (₹120/day), 2 days due + ₹140 overdue on one.
const loans = [
  { id: 'A', inst: 240, overdue: 480, outstanding: 20000 },
  { id: 'B', inst: 240, overdue: 480, outstanding: 20000 },
  { id: 'C', inst: 120, overdue: 380, outstanding: 10000 },
  { id: 'D', inst: 120, overdue: 240, outstanding: 10000 },
];

test('UPI 1000 + cash 600 − change 20 = 1580 received', () => {
  assert.deepEqual(received({ upi: '1000', cash: '600', change: '20' }), { upi: 1000, cash: 580, total: 1580 });
});

test('auto-fill puts 1580 on the overdue of all four loans', () => {
  assert.deepEqual(autoFill(loans, 1580), { A: 480, B: 480, C: 380, D: 240 });
});

test('UPI first, then cash: Day Book gets UPI 1000 and cash 580 exactly', () => {
  const items = [['A', 480], ['B', 480], ['C', 380], ['D', 240]].map(([loanId, amount]) => ({ loanId, kind: 'installment', amount }));
  const { entries, short } = splitModes(items, { upi: 1000, cash: 580 });
  assert.equal(short, 0);
  assert.deepEqual(entries.map((e) => [e.loanId, e.mode, e.amount]), [
    ['A', 'upi', 480], ['B', 'upi', 480], ['C', 'upi', 40], ['C', 'cash', 340], ['D', 'cash', 240],
  ]);
  assert.equal(entries.filter((e) => e.mode === 'upi').reduce((t, e) => t + e.amount, 0), 1000);
  assert.equal(entries.filter((e) => e.mode === 'cash').reduce((t, e) => t + e.amount, 0), 580);
});

test('nothing overdue: extra days go round every loan, never past a balance', () => {
  const fresh = loans.map((l) => ({ ...l, overdue: 0 }));
  assert.deepEqual(autoFill(fresh, 1440), { A: 480, B: 480, C: 240, D: 240 });
  assert.deepEqual(autoFill([{ id: 'X', inst: 240, overdue: 0, outstanding: 300 }], 1000), { X: 300 });
});

test('short payment covers a day on every loan, not all on the first (Aman Biryani)', () => {
  const two = [
    { id: 'A', inst: 150, overdue: 450, outstanding: 7650 },
    { id: 'B', inst: 100, overdue: 300, outstanding: 4900 },
  ];
  assert.deepEqual(autoFill(two, 250), { A: 150, B: 100 });
  assert.deepEqual(autoFill(two, 400), { A: 300, B: 100 });
  assert.deepEqual(autoFill(two.map((l) => ({ ...l, overdue: 0 })), 250), { A: 150, B: 100 });
  assert.deepEqual(autoFill([{ ...two[0], overdue: 0 }, two[1]], 250), { A: 0, B: 250 });
});

test('penalty is split by mode too', () => {
  const { entries } = splitModes([{ loanId: 'A', kind: 'installment', amount: 240 }, { loanId: 'A', kind: 'penalty', amount: 100 }], { upi: 300, cash: 40 });
  assert.deepEqual(entries.map((e) => [e.kind, e.mode, e.amount]), [['installment', 'upi', 240], ['penalty', 'upi', 60], ['penalty', 'cash', 40]]);
});
