import { addDays, monthStart, round2, toNum } from './format.js';

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
 * In the cash book the loan is shown gross: cash out = principal − interest
 * (9,600) and the advance (1,500) as income; only the net 8,100 is handed over.
 *
 * Example: 10,000 @4%, 150/day, 20% markup, 10 advance days
 *   → interest 400, total 12,000, 80 days, advance 1,500, net 8,100,
 *     70 daily installments still to collect (10,500), profit 2,400.
 *
 * The schedule is the full 80 days from collection_start_date. The advance
 * covers the first 10 of them, so cash is due from day 11 to day 80.
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
  const totalDays = daily > 0 ? Math.ceil(Math.max(0, total) / daily) : 0;
  const advanceDaysCovered = daily > 0 ? Math.floor(advance / daily + 1e-9) : 0;
  const firstCashDate =
    f.collection_start_date && collectDays > 0 ? addDays(f.collection_start_date, advanceDaysCovered) : null;
  const endDate =
    f.collection_start_date && totalDays > 0 ? addDays(f.collection_start_date, totalDays - 1) : null;

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
    advanceDaysCovered,
    firstCashDate,
    profit,
    effMarkup,
    effInterestPct,
    endDate,
    errors,
  };
}

/**
 * Day-by-day khata for one loan.
 *
 * The schedule is every day of the loan (total ÷ daily), from collection_start_date.
 * The advance kept at loan time fills the first days, then all cash collected
 * fills the rest day by day, oldest day first. So with ₹150/day, a ₹300 payment
 * fills 2 days and ₹600 fills 4 days — and a late payment fills the days that
 * were missed before it.
 *
 * Returns
 *   days     : [{ date, due, covered, received, state, inSchedule, byAdvance }]
 *              state = paid | partial | missed | advance | future | off
 *   months   : [{ month: 'YYYY-MM-01', days: [...] }]  (every date of each month)
 *   paidTill : last date that is fully paid (or null)
 *   counts   : { paid, partial, missed, advance, future }
 */
export function buildLoanCalendar(loan, repayments, today) {
  const daily = toNum(loan.daily_installment);
  const total = Math.max(0, toNum(loan.total_repayable));
  const nDays = daily > 0 ? Math.ceil(total / daily - 1e-9) : 0;
  let advancePool = round2(Math.min(total, Math.max(0, toNum(loan.advance_amount))));

  const received = {};
  let pool = 0;
  for (const r of repayments) {
    received[r.paid_on] = round2((received[r.paid_on] || 0) + toNum(r.amount));
    pool += toNum(r.amount);
  }
  pool = round2(pool);

  const start = loan.collection_start_date;
  const schedule = {};
  let paidTill = null;
  const counts = { paid: 0, partial: 0, missed: 0, advance: 0, future: 0 };
  for (let i = 0; i < nDays; i++) {
    const date = addDays(start, i);
    const due = round2(Math.min(daily, total - daily * i));
    const fromAdvance = round2(Math.min(due, advancePool));
    advancePool = round2(advancePool - fromAdvance);
    const fromCash = round2(Math.min(due - fromAdvance, Math.max(0, pool)));
    pool = round2(pool - fromCash);
    const covered = round2(fromAdvance + fromCash);
    const byAdvance = fromAdvance >= due - 0.001;
    let state;
    if (covered >= due - 0.001) state = date > today ? 'advance' : 'paid';
    else if (covered > 0) state = 'partial';
    else state = date > today ? 'future' : 'missed';
    if (state === 'paid' || state === 'advance') paidTill = date;
    counts[state] += 1;
    schedule[date] = { due, covered, state, byAdvance };
  }
  const end = nDays > 0 ? addDays(start, nDays - 1) : start;

  // Show whole months, from the first payment/start up to the end / last payment.
  const dates = Object.keys(received);
  let first = start;
  let last = end;
  for (const d of dates) {
    if (d < first) first = d;
    if (d > last) last = d;
  }

  const months = [];
  const days = [];
  for (let m = monthStart(first); m <= last; ) {
    const md = [];
    let d = m;
    while (d.slice(0, 7) === m.slice(0, 7)) {
      const s = schedule[d];
      const cell = {
        date: d,
        due: s?.due || 0,
        covered: s?.covered || 0,
        received: received[d] || 0,
        state: s ? s.state : 'off',
        inSchedule: !!s,
        byAdvance: !!s?.byAdvance,
      };
      md.push(cell);
      if (s) days.push(cell);
      d = addDays(d, 1);
    }
    months.push({ month: m, days: md });
    m = d; // first day of the next month
  }

  return { days, months, paidTill, counts, nDays, start, end, extra: Math.max(0, pool) };
}
