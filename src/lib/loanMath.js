import { addDays, round2, toNum } from './format.js';

/**
 * Derive every loan number from the form inputs.
 *
 * Fields can be "auto" (calculated) or "overridden" (typed by the user).
 * `ov` is a map of field → true when the user has typed their own value.
 *
 * Default rules (all editable):
 *   interest_amount   = principal × interest_pct%            (cut upfront)
 *   daily_installment = principal × dailyPer10k / 10,000
 *   total_repayable   = principal × (1 + markup_pct%)         (or daily × days if days typed)
 *   duration_days     = ceil(total / daily)
 *   advance_amount    = advance_days × daily                  (installments kept upfront)
 *   net to give       = principal − interest − advance
 *
 * Example: 10,000 @4%, 150/day, 20% markup, 10 advance days
 *   → interest 400, total 12,000, 80 days, advance 1,500, net 8,100,
 *     70 daily installments still to collect (10,500), profit 2,400.
 */
export function deriveLoan(f, ov, dailyPer10k = 150) {
  const P = toNum(f.principal);

  const interest = ov.interest_amount
    ? toNum(f.interest_amount)
    : round2((P * toNum(f.interest_pct)) / 100);

  const daily = ov.daily_installment
    ? toNum(f.daily_installment)
    : round2((P * toNum(dailyPer10k)) / 10000);

  let total;
  let days;
  if (ov.total_repayable) {
    total = toNum(f.total_repayable);
    days = ov.duration_days ? toNum(f.duration_days) : daily > 0 ? Math.ceil(total / daily) : 0;
  } else if (ov.duration_days) {
    days = toNum(f.duration_days);
    total = round2(daily * days);
  } else {
    total = round2(P * (1 + toNum(f.markup_pct) / 100));
    days = daily > 0 ? Math.ceil(total / daily) : 0;
  }

  const advance = ov.advance_amount
    ? toNum(f.advance_amount)
    : round2(Math.max(0, toNum(f.advance_days)) * daily);

  const net = round2(P - interest - advance);
  const toCollect = round2(total - advance);
  const collectDays = daily > 0 ? Math.ceil(Math.max(0, toCollect) / daily) : 0;
  const profit = round2(total - P + interest);
  const effMarkup = P > 0 ? round2(((total - P) / P) * 100) : 0;
  const effInterestPct = P > 0 ? round2((interest / P) * 100) : 0;
  const endDate =
    f.collection_start_date && collectDays > 0 ? addDays(f.collection_start_date, collectDays - 1) : null;

  const errors = [];
  if (P <= 0) errors.push('Loan amount must be more than 0.');
  if (daily <= 0) errors.push('Daily installment must be more than 0.');
  if (total <= 0) errors.push('Total repayable must be more than 0.');
  if (days <= 0) errors.push('Duration (days) must be more than 0.');
  if (advance > total) errors.push('Advance kept cannot be more than total repayable.');
  if (net < 0) errors.push('Interest + advance cannot be more than the loan amount.');
  if (f.collection_start_date && f.loan_date && f.collection_start_date < f.loan_date) {
    errors.push('Collection cannot start before the loan date.');
  }

  return {
    principal: P,
    interest_amount: interest,
    daily_installment: daily,
    total_repayable: total,
    duration_days: days,
    advance_amount: advance,
    net,
    toCollect,
    collectDays,
    profit,
    effMarkup,
    effInterestPct,
    endDate,
    errors,
  };
}

/**
 * Day-by-day khata for one loan: for each day from collection start,
 * how much was due vs paid. Used for the colour grid on the loan page.
 */
export function buildLoanCalendar(loan, repayments, today) {
  const byDate = {};
  for (const r of repayments) byDate[r.paid_on] = (byDate[r.paid_on] || 0) + toNum(r.amount);

  const start = loan.collection_start_date;
  const end = loan.expected_end_date;
  const lastPaid = repayments.reduce((m, r) => (r.paid_on > m ? r.paid_on : m), '');
  let last = end;
  if (today > last) last = today;
  if (lastPaid > last) last = lastPaid;
  if (loan.status !== 'active' && loan.status !== 'defaulted') {
    last = lastPaid && lastPaid > end ? lastPaid : end;
  }

  const cells = [];
  let d = start;
  let guard = 0;
  while (d <= last && guard < 500) {
    const paid = byDate[d] || 0;
    let state;
    if (d > today) state = 'future';
    else if (paid >= toNum(loan.daily_installment)) state = 'paid';
    else if (paid > 0) state = 'partial';
    else state = 'missed';
    cells.push({ date: d, paid, state });
    d = addDays(d, 1);
    guard++;
  }
  return cells;
}
