import { round2, toNum } from './format.js';

// Release dependent values when an input changes. Loaded manual values must
// not pin both the old total and the old duration after an edit.
export function loanOverridesAfterEdit(overrides, name, manual = true) {
  const next = { ...overrides, [name]: manual };
  if (name === 'duration_days') {
    next.daily_installment = true;
    next.total_repayable = !manual;
  }
  if (name === 'total_repayable') next.duration_days = false;
  if (name === 'daily_installment') {
    if (!manual) next.duration_days = false;
    if (next.duration_days) next.total_repayable = false;
    else next.duration_days = false;
    next.advance_amount = false;
  }
  if (name === 'advance_days') next.advance_amount = false;
  if (name === 'interest_pct') next.interest_amount = false;
  if (name === 'markup_pct') {
    next.total_repayable = false;
    next.duration_days = false;
  }
  if (name === 'principal') {
    next.interest_amount = false;
    next.total_repayable = false;
    next.duration_days = false;
  }
  return next;
}

export const isCashDisbursement = (row) => !['renewal', 'opening'].includes(row.mode);

export function canSyncPayout(loan, rows) {
  return rows.filter(isCashDisbursement).length === 1 &&
    rows.reduce((total, row) => total + toNum(row.amount), 0) >= toNum(loan.net_disbursable) - 0.005;
}

// Renewals/overdue cuts stay fixed; only the actual cash/UPI payout changes.
export function loanPayoutEdits(loan, rows, net, syncPayout, amounts) {
  return rows.filter(isCashDisbursement).map((row) => ({
    ...row,
    original_amount: toNum(row.amount),
    amount: Object.hasOwn(amounts, row.id) ? round2(amounts[row.id])
      : syncPayout && canSyncPayout(loan, rows)
        ? round2(net - rows.filter((r) => !isCashDisbursement(r)).reduce((total, r) => total + toNum(r.amount), 0))
        : toNum(row.amount),
  }));
}
