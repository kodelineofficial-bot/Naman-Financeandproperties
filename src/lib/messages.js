// WhatsApp message templates: {placeholder} filling + the ready-made texts.
import { fmtDateLong, money, toNum, todayStr } from './format.js';

export const PLACEHOLDERS = [
  { key: 'name', label: 'Borrower name' },
  { key: 'loan_no', label: 'Loan number' },
  { key: 'daily', label: 'Daily installment' },
  { key: 'pending_days', label: 'Days not paid' },
  { key: 'overdue', label: 'Overdue amount' },
  { key: 'penalty', label: 'Penalty due' },
  { key: 'penalty_rate', label: 'Penalty per day' },
  { key: 'penalty_days', label: 'Penalty days' },
  { key: 'total_due', label: 'Overdue + penalty' },
  { key: 'balance', label: 'Loan balance' },
  { key: 'paid_till', label: 'Paid till date' },
  { key: 'end_date', label: 'Last date of loan' },
  { key: 'today', label: "Today's date" },
  { key: 'business', label: 'Business name' },
  { key: 'business_phone', label: 'Business phone' },
];

// Same text as the rows seeded by supabase/migrations/006_penalty_and_whatsapp_templates.sql.
export const BUILTIN_TEMPLATES = [
  {
    name: 'Daily payment reminder',
    use_for: 'reminder',
    sort: 1,
    body:
      'Hello {name},\n\nThis is a gentle reminder from {business}. Your daily installment of {daily} for Loan #{loan_no} is pending.\n\n' +
      'Pending: {pending_days} day(s) ({overdue})\nPaid till: {paid_till}\n\nPlease pay today. Thank you!',
  },
  {
    name: 'Late payment penalty',
    use_for: 'penalty',
    sort: 2,
    body:
      'Dear {name},\n\nYour daily installment for Loan #{loan_no} has not been paid for {pending_days} day(s).\n\n' +
      'Overdue amount: {overdue}\nLate penalty ({penalty_rate} per day): {penalty}\nTotal to pay now: {total_due}\n\n' +
      'Please pay today to avoid further penalty.\n\n- {business} {business_phone}',
  },
  {
    name: 'Final notice',
    use_for: null,
    sort: 3,
    body:
      'Dear {name},\n\nFINAL REMINDER for Loan #{loan_no}.\n\nOverdue: {overdue}\nPenalty: {penalty}\nTotal due: {total_due}\nLoan balance: {balance}\n\n' +
      'Please clear the dues within 2 days. If not paid, we will have to contact your guarantor.\n\n- {business} {business_phone}',
  },
  {
    name: 'Loan balance statement',
    use_for: null,
    sort: 4,
    body:
      'Hello {name},\n\nLoan #{loan_no} statement as on {today}:\nDaily installment: {daily}\nPaid till: {paid_till}\n' +
      'Balance to pay: {balance}\nLast date: {end_date}\n\nThank you,\n{business}',
  },
];

/**
 * Values for one loan. `l` can be a loan_summary row or a collection-sheet row;
 * `overdue` / `balance` may be passed in to override (e.g. as of another date).
 */
export function loanVars(l, settings, { overdue, balance } = {}) {
  const daily = toNum(l.daily_installment ?? l.daily);
  const od = toNum(overdue ?? l.overdue);
  const pen = toNum(l.penalty_due);
  return {
    name: l.borrower_name || '',
    loan_no: l.loan_no ?? '',
    daily: money(daily),
    pending_days: daily > 0 ? Math.ceil(od / daily - 1e-9) : 0,
    overdue: money(od),
    penalty: money(pen),
    penalty_rate: money(l.penalty_rate ?? settings?.penalty_per_day),
    penalty_days: toNum(l.penalty_days),
    total_due: money(od + pen),
    balance: money(balance ?? l.outstanding),
    paid_till: l.paid_till ? fmtDateLong(l.paid_till) : 'not started',
    end_date: l.expected_end_date ? fmtDateLong(l.expected_end_date) : '-',
    today: fmtDateLong(todayStr()),
    business: settings?.business_name || 'Naman - Finance & Properties',
    business_phone: settings?.phone || '',
  };
}

/** Replace {key} with its value; unknown keys are left as they are. */
export function fillTemplate(body, vars) {
  return String(body || '')
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
    .replace(/[ \t]+$/gm, '');
}

/** Template to open first: penalty notice when penalty is due, else the reminder. */
export function pickTemplate(templates, hasPenalty) {
  const by = (u) => templates.find((t) => t.use_for === u);
  return (hasPenalty && by('penalty')) || by('reminder') || templates[0] || null;
}
