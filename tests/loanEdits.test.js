import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLoan, buildLoanCalendar, periodDate } from '../src/lib/loanMath.js';
import { canSyncPayout, loanOverridesAfterEdit, loanPayoutEdits } from '../src/lib/loanEdits.js';

const fields = ['interest_amount', 'daily_installment', 'total_repayable', 'duration_days', 'advance_amount'];
const form = {
  principal: '10000', interest_pct: '4', interest_amount: '400', markup_pct: '35',
  daily_installment: '150', total_repayable: '13500', duration_days: '90',
  advance_days: '10', advance_amount: '1500', collection_start_date: '2026-01-01', loan_date: '2026-01-01',
};
const loaded = { ...Object.fromEntries(fields.map((field) => [field, true])), duration_days: false };

function edit(state, name, value, manual = true) {
  const d = deriveLoan(state.form, state.ov);
  return {
    form: { ...state.form, ...Object.fromEntries(fields.map((field) => [field, String(d[field])])), [name]: value },
    ov: loanOverridesAfterEdit(state.ov, name, manual),
  };
}

test('90 → 100 days updates total, calendar, end date and preserves payments', () => {
  const state = edit({ form, ov: loaded }, 'duration_days', '100');
  const d = deriveLoan(state.form, state.ov);
  assert.equal(d.total_repayable, 15000);
  assert.equal(d.daily_installment, 150);
  assert.equal(d.duration_days, 100);
  const calendar = buildLoanCalendar({ ...form, ...d }, [{ paid_on: '2026-01-12', amount: 300 }], '2026-01-15');
  assert.equal(calendar.schedule.length, 100);
  assert.equal(calendar.end, periodDate('daily', form.collection_start_date, 100));
  assert.equal(calendar.paidTill, '2026-01-12');
  assert.equal(calendar.schedule.reduce((n, row) => n + row.covered, 0), 1800);
});

test('total, installment and duration remain consistent across repeated edits', () => {
  let state = { form, ov: loaded };
  for (const [field, value, expected] of [
    ['duration_days', '100', [150, 15000, 100]],
    ['total_repayable', '12050', [150, 12050, 81]],
    ['daily_installment', '200', [200, 12050, 61]],
    ['duration_days', '100', [200, 20000, 100]],
    ['daily_installment', '250', [250, 25000, 100]],
  ]) {
    state = edit(state, field, value);
    const d = deriveLoan(state.form, state.ov);
    assert.deepEqual([d.daily_installment, d.total_repayable, d.duration_days], expected);
    assert.equal(buildLoanCalendar({ ...state.form, ...d }, [], '2026-01-15').nDays, d.duration_days);
  }
});

test('advance days and interest percentage release old loaded amounts', () => {
  let state = edit({ form, ov: loaded }, 'advance_days', '12');
  assert.equal(deriveLoan(state.form, state.ov).advance_amount, 1800);
  state = edit(state, 'interest_pct', '5');
  assert.equal(deriveLoan(state.form, state.ov).interest_amount, 500);
});

test('principal corrections recalculate interest, repayable total and duration', () => {
  const state = edit({ form, ov: loaded }, 'principal', '12000');
  const d = deriveLoan(state.form, state.ov);
  assert.deepEqual([d.interest_amount, d.total_repayable, d.duration_days, d.net], [480, 16200, 108, 10020]);
});

test('monthly duration edits update every installment and the final due date', () => {
  const state = edit({ form: { ...form, frequency: 'monthly', duration_days: '12', total_repayable: '1800' }, ov: loaded }, 'duration_days', '18');
  const d = deriveLoan(state.form, state.ov, 150, 'monthly');
  const calendar = buildLoanCalendar({ ...state.form, ...d }, [], '2026-01-15');
  assert.equal(calendar.schedule.length, 18);
  assert.equal(calendar.end, '2027-06-01');
});

test('Karan office: changing principal/payout 2550 → 2450 proposes the corrected recorded payout', () => {
  const loan = { net_disbursable: 2550 };
  const rows = [{ id: 'payout', amount: 2550, mode: 'cash' }];
  assert.equal(canSyncPayout(loan, rows), true);
  assert.equal(loanPayoutEdits(loan, rows, 2450, true, {})[0].amount, 2450);
  assert.equal(loanPayoutEdits(loan, rows, 2550, true, { payout: '2450' })[0].amount, 2450);
  assert.equal(loanPayoutEdits(loan, rows, 2450, false, {})[0].amount, 2550);
  // The terms may already have been corrected before this fix was deployed.
  const previouslyEdited = { net_disbursable: 2450 };
  assert.equal(canSyncPayout(previouslyEdited, rows), true);
  assert.equal(loanPayoutEdits(previouslyEdited, rows, 2450, true, {})[0].amount, 2450);
});

test('partial payouts, multiple payouts and renewal adjustments are preserved', () => {
  const loan = { net_disbursable: 8100 };
  const partial = [{ id: 'partial', amount: 4000, mode: 'cash' }];
  assert.equal(canSyncPayout(loan, partial), false);
  assert.equal(loanPayoutEdits(loan, partial, 8000, true, {})[0].amount, 4000);
  const multiple = [...partial, { id: 'second', amount: 4100, mode: 'upi' }];
  assert.equal(canSyncPayout(loan, multiple), false);
  assert.deepEqual(loanPayoutEdits(loan, multiple, 8100, false, { second: '4000' }).map((r) => r.amount), [4000, 4000]);
  const renewal = [{ id: 'adjusted', amount: 5000, mode: 'renewal' }, { id: 'cash', amount: 3100, mode: 'cash' }];
  assert.equal(canSyncPayout(loan, renewal), true);
  assert.deepEqual(loanPayoutEdits(loan, renewal, 8000, true, {}).map((r) => [r.id, r.amount]), [['cash', 3000]]);
});

test('auto reset and fractional duration validation', () => {
  let state = edit({ form, ov: loaded }, 'duration_days', '100');
  state = edit(state, 'duration_days', '100', false);
  assert.equal(deriveLoan(state.form, state.ov).duration_days, 100);
  state = edit(state, 'daily_installment', '150', false);
  const d = deriveLoan(state.form, state.ov);
  assert.equal(d.duration_days, Math.ceil(d.total_repayable / d.daily_installment));
  state = edit(state, 'duration_days', '100.5');
  assert.match(deriveLoan(state.form, state.ov).errors.join(' '), /whole number/);
});

test('advance is deducted once: 3700 before advance becomes 3550 actual, and mode edits preserve both Karan payouts', () => {
  const d = deriveLoan({ ...form, principal: '3700', interest_amount: '0', advance_amount: '150' }, loaded);
  assert.equal(d.net, 3550);
  const today = { net_disbursable: 9650 };
  const todayRows = [{ id: 'actual', amount: 3550, mode: 'upi' }, { id: 'old-dues', amount: 4100, mode: 'renewal' }];
  assert.equal(loanPayoutEdits(today, todayRows, 9650, false, {})[0].amount, 3550);
  const yesterday = { net_disbursable: 4700 };
  const yesterdayRows = [{ id: 'actual', amount: 2450, mode: 'upi' }, { id: 'old-dues', amount: 2250, mode: 'renewal' }];
  assert.equal(loanPayoutEdits(yesterday, yesterdayRows, 4700, true, {})[0].amount, 2450);
});
