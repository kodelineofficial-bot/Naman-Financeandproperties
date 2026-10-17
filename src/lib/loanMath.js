import { addDays, monthStart, parseDate, round2, shiftMonths, toNum } from './format.js';

/** Loan frequency words. One "installment" = one day (daily) or one month (monthly). */
export const FREQ = {
  daily:   { label: 'Daily', hi: 'रोज़', unit: 'day', units: 'days', per: '/day', unitHi: 'दिन', adj: 'daily' },
  monthly: { label: 'Monthly', hi: 'मासिक', unit: 'month', units: 'months', per: '/month', unitHi: 'महीना', adj: 'monthly' },
};
export const freqOf = (l) => FREQ[l?.frequency] || FREQ.daily;

/** Date of installment n (1 = first) — same as SQL period_date(). */
export function periodDate(freq, start, n) {
  if (!start || n < 1) return null;
  return freq === 'monthly' ? shiftMonths(start, n - 1) : addDays(start, n - 1);
}

/** Installments due on or before date d — same as SQL periods_due(). */
export function periodsDue(freq, start, d) {
  if (!start || !d || d < start) return 0;
  if (freq !== 'monthly') return Math.round((parseDate(d) - parseDate(start)) / 86400000) + 1;
  const k = (Number(d.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(d.slice(5, 7)) - Number(start.slice(5, 7));
  return shiftMonths(start, k) <= d ? k + 1 : k;
}

/** "2 days · 2 दिन" / "1.5 months · 1.5 महीने" for an amount of installments. */
export function periodsText(amount, inst, freq) {
  const a = toNum(amount);
  const d = toNum(inst);
  if (a <= 0 || d <= 0) return '';
  const n = Math.round((a / d) * 10) / 10;
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  if (freq === 'monthly') return n === 1 ? '1 month · 1 महीना' : `${s} months · ${s} महीने`;
  return n === 1 ? '1 day · 1 दिन' : `${s} days · ${s} दिन`;
}

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
 *   If days are typed (daily left on auto): daily = ceil(total / days) to the rupee
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
export function deriveLoan(f, ov, dailyPer10k = 150, freq = 'daily') {
  const P = toNum(f.principal);
  // Monthly loans: the default is a number of months (12) → installment = total ÷ months.
  if (freq === 'monthly' && !ov.daily_installment && !ov.duration_days) {
    ov = { ...ov, duration_days: true };
    f = { ...f, duration_days: toNum(f.duration_days) > 0 ? f.duration_days : '12' };
  }

  const interest = ov.interest_amount
    ? toNum(f.interest_amount)
    : round2((P * toNum(f.interest_pct)) / 100);

  let daily;
  let total;
  let days;
  if (!ov.daily_installment && ov.duration_days) {
    // Days typed, daily on auto → daily comes from total ÷ days (whole rupees, so
    // daily × days always covers the total and the loan ends on the typed day).
    days = toNum(f.duration_days);
    total = ov.total_repayable ? toNum(f.total_repayable) : round2(P * (1 + toNum(f.markup_pct) / 100));
    daily = days > 0 ? Math.ceil(total / days - 1e-9) : 0;
  } else if (ov.total_repayable) {
    daily = ov.daily_installment ? toNum(f.daily_installment) : round2((P * toNum(dailyPer10k)) / 10000);
    total = toNum(f.total_repayable);
    days = ov.duration_days ? toNum(f.duration_days) : daily > 0 ? Math.ceil(total / daily) : 0;
  } else if (ov.duration_days) {
    daily = toNum(f.daily_installment);
    days = toNum(f.duration_days);
    total = round2(daily * days);
  } else {
    daily = ov.daily_installment ? toNum(f.daily_installment) : round2((P * toNum(dailyPer10k)) / 10000);
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
    f.collection_start_date && collectDays > 0 ? periodDate(freq, f.collection_start_date, advanceDaysCovered + 1) : null;
  const endDate =
    f.collection_start_date && totalDays > 0 ? periodDate(freq, f.collection_start_date, totalDays) : null;

  const errors = [];
  if (P <= 0) errors.push('Loan amount must be more than 0.');
  if (daily <= 0) errors.push('Installment must be more than 0.');
  if (total <= 0) errors.push('Total repayable must be more than 0.');
  if (days <= 0 || !Number.isInteger(days)) errors.push(`Duration (${FREQ[freq]?.units || 'days'}) must be a positive whole number.`);
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
 *   schedule : [{ n, date, due, covered, state, byAdvance, received }] one row per installment
 *              (received = cash that came between this due date and the next one)
 *
 * Monthly loans use the same rules with one installment per month.
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

  const freq = loan.frequency || 'daily';
  const start = loan.collection_start_date;
  const schedule = {};
  const list = [];
  let paidTill = null;
  const counts = { paid: 0, partial: 0, missed: 0, advance: 0, future: 0 };
  for (let i = 0; i < nDays; i++) {
    const date = periodDate(freq, start, i + 1);
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
    list.push({ n: i + 1, date, due, covered, state, byAdvance, received: 0 });
  }
  const end = nDays > 0 ? periodDate(freq, start, nDays) : start;
  // Cash received in each installment's window (its due date up to the next one).
  for (const [d, amt] of Object.entries(received)) {
    let k = list.length - 1;
    while (k > 0 && list[k].date > d) k -= 1;
    if (list[k]) list[k].received = round2(list[k].received + amt);
  }

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

  return { days, months, paidTill, counts, nDays, start, end, extra: Math.max(0, pool), schedule: list, freq };
}
