import { money, toNum } from './format.js';

// Stage of a loan in plain words, from a loan_summary row — for the export.
//   Closed · Renewed · Defaulter · Paid, not closed · Time over · Behind · On time
export function loanStage(l, today) {
  if (l.status === 'closed') return 'Closed';
  if (l.status === 'renewed') return 'Renewed';
  if (l.status === 'defaulted') return 'Defaulter';
  if (toNum(l.outstanding) <= 0) return 'Paid, not closed';
  if (l.expected_end_date && today && l.expected_end_date < today) return 'Time over';
  if (toNum(l.overdue) > 0) return 'Behind';
  return 'On time';
}

/** Days of installments the overdue amount covers (₹4,560 at ₹240/day = 19). */
export function daysBehind(l) {
  const inst = toNum(l.daily_installment);
  return inst > 0 && toNum(l.overdue) > 0 ? Math.ceil(toNum(l.overdue) / inst - 1e-9) : 0;
}

/** One-line detail: "#125 Behind · 63% paid · ₹8,880 left · overdue ₹4,560 (19 days) · penalty ₹3,450" */
export function loanStageLine(l, today) {
  const stage = loanStage(l, today);
  const bits = [`#${l.loan_no} ${stage}`];
  if (l.status === 'active') {
    bits.push(`${Math.round(toNum(l.progress_pct))}% paid`, `${money(l.outstanding)} left`);
    if (toNum(l.overdue) > 0) bits.push(`overdue ${money(l.overdue)} (${daysBehind(l)} ${l.frequency === 'monthly' ? 'months' : 'days'})`);
  } else if (l.status === 'defaulted') {
    bits.push(`${money(l.outstanding)} left`);
  }
  if (toNum(l.penalty_due) > 0) bits.push(`penalty ${money(l.penalty_due)}`);
  return bits.join(' · ');
}
