import test from 'node:test';
import assert from 'node:assert/strict';
import { deletedLoanEntries, entryCashNote, loanCashNote } from '../src/lib/loanDelete.js';

test('deleting a cash payment warns cash goes down from its date', () => {
  const note = entryCashNote({ amount: 4000, mode: 'cash', direction: 'in', date: '2026-10-25' });
  assert.match(note, /goes down by/);
  assert.match(note, /4,000/);
});

test('deleting a cash payout or expense warns cash goes up', () => {
  assert.match(entryCashNote({ amount: 500, mode: 'cash', direction: 'out', date: '2026-10-25' }), /goes up by/);
});

test('payout with an advance warns only the cash handed over', () => {
  assert.match(entryCashNote({ amount: 9600, handed_over: 8100, mode: 'cash', direction: 'out', date: '2026-10-25' }), /8,100/);
});

test('UPI and no-cash entries say cash does not change', () => {
  for (const mode of ['upi', 'renewal', 'waiver', 'opening']) {
    assert.match(entryCashNote({ amount: 100, mode, direction: 'in', date: '2026-10-25' }), /does not change/);
  }
});

test('loan preview gives the total and the first day', () => {
  const note = loanCashNote({ days: [{ date: '2026-10-25', change: -4000 }, { date: '2026-10-26', change: -2700 }], total: -6700 });
  assert.match(note, /goes down by/);
  assert.match(note, /6,700/);
});

test('loan preview with nothing changing says so', () => {
  assert.equal(loanCashNote({ days: [], total: 0 }), 'Cash in hand does not change.');
});

test('loan preview that nets to zero still flags the days', () => {
  assert.match(loanCashNote({ days: [{ date: '2026-10-25', change: -100 }, { date: '2026-10-26', change: 100 }], total: 0 }), /ends up the same/);
});

test('deleted loan shows only its own entries, newest first', () => {
  const rows = deletedLoanEntries({
    loan_id: 'x',
    snapshot: {
      disbursements: [{ loan_id: 'x', paid_on: '2026-10-01', created_at: 'a', amount: 1000 }],
      repayments: [
        { loan_id: 'x', paid_on: '2026-10-25', created_at: 'a', amount: 4000 },
        { loan_id: 'other', paid_on: '2026-10-26', created_at: 'a', amount: 50 },
      ],
      penalties: [],
    },
  });
  assert.deepEqual(rows.map((r) => r.type), ['Paid', 'Given']);
});
