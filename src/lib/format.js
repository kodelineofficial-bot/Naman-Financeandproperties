// Formatting + date helpers. Dates are handled as 'YYYY-MM-DD' strings in local (India) time.

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const round2 = (n) => Math.round(toNum(n) * 100) / 100;

export function money(n, { sign = false } = {}) {
  const v = toNum(n);
  const s = '₹' + inr.format(Math.abs(v));
  if (v < 0) return '−' + s;
  if (sign && v > 0) return '+' + s;
  return s;
}

export const money0 = (n) => '₹' + inr0.format(toNum(n));
export const fmtNum = (n) => inr.format(toNum(n));

export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(str) {
  const [y, m, d] = String(str).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Always India date, even if the device clock/timezone is set to something else.
export const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

export function addMonths(str, n) {
  const d = parseDate(monthStart(str));
  d.setMonth(d.getMonth() + n);
  return toDateStr(d);
}

/** Same day n months later; 31 Jan + 1 → 28/29 Feb (matches Postgres date + interval). */
export function shiftMonths(str, n) {
  const [y, m, day] = String(str).slice(0, 10).split('-').map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return toDateStr(new Date(first.getFullYear(), first.getMonth(), Math.min(day, last)));
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export const monthStart = (str) => String(str).slice(0, 7) + '-01';

export function monthEnd(str) {
  const d = parseDate(monthStart(str));
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function fmtDate(str) {
  if (!str) return '—';
  return parseDate(str).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateShort(str) {
  if (!str) return '—';
  return parseDate(str).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/** "Tuesday, 13 October 2026" */
export function fmtDateFull(str) {
  if (!str) return '—';
  return parseDate(str).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "13 October 2026" */
export function fmtDateLong(str) {
  if (!str) return '—';
  return parseDate(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** How many daily installments an amount covers, e.g. 600 @ 150 → "4 days · 4 दिन". */
export function daysText(amount, daily) {
  const a = toNum(amount);
  const d = toNum(daily);
  if (a <= 0 || d <= 0) return '';
  const n = Math.round((a / d) * 10) / 10;
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return n === 1 ? '1 day · 1 दिन' : `${s} days · ${s} दिन`;
}

export function fmtWeekday(str) {
  return parseDate(str).toLocaleDateString('en-IN', { weekday: 'long' });
}

export function fmtMonth(str) {
  if (!str) return '—';
  return parseDate(monthStart(str)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function fmtMonthShort(str) {
  return parseDate(monthStart(str)).toLocaleDateString('en-IN', { month: 'short' });
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function phoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

export function whatsappLink(phone, text) {
  const d = phoneDigits(phone);
  if (d.length !== 10) return null;
  return `https://wa.me/91${d}?text=${encodeURIComponent(text)}`;
}

/** columns: [{ key, label, value?: (row) => any }] */
export function downloadCSV(filename, rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows) {
    lines.push(columns.map((c) => esc(c.value ? c.value(r) : r[c.key])).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const sum = (rows, key) =>
  round2((rows || []).reduce((acc, r) => acc + toNum(typeof key === 'function' ? key(r) : r[key]), 0));

export const MODES = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

export const modeLabel = (m) =>
  m === 'renewal' ? 'Adjusted (no cash)' : m === 'opening' ? 'Old loan (not in cash book)' : m === 'upi' ? 'UPI (not counted)' : MODES.find((x) => x.value === m)?.label || m || '—';

/** UPI money is shown in the books but left out of money in / out and cash in hand. */
export const isUpi = (r) => r?.mode === 'upi';
export const counted = (rows) => (rows || []).filter((r) => !isUpi(r));

export const EXPENSE_CATEGORIES = [
  'Tea / Snacks', 'Food', 'Fuel / Petrol', 'Travel', 'Rent', 'Electricity',
  'Phone / Internet', 'Stationery', 'Office', 'Commission', 'Repair & Maintenance',
  'Bank Charges', 'Donation', 'Misc',
];

export const LEDGER_KINDS = {
  collection:       { label: 'Collection (जमा)', short: 'Collection', dir: 'in' },
  capital_in:       { label: 'Cash In (पूंजी)', short: 'Cash in', dir: 'in' },
  disbursement:     { label: 'Loan Given (उधार दिया)', short: 'Loan given', dir: 'out' },
  expense:          { label: 'Expense (खर्चा)', short: 'Expense', dir: 'out' },
  salary:           { label: 'Salary (तनख्वाह)', short: 'Salary', dir: 'out' },
  employee_advance: { label: 'Staff Advance (एडवांस)', short: 'Staff advance', dir: 'out' },
  capital_out:      { label: 'Cash Out (निकासी)', short: 'Cash out', dir: 'out' },
  penalty:          { label: 'Penalty (जुर्माना)', short: 'Penalty', dir: 'in' },
  loan_advance:     { label: 'Advance Kept (एडवांस)', short: 'Advance kept', dir: 'in' },
  loan_advance_cut: { label: 'Advance Cut (एडवांस कटौती)', short: 'Advance cut', dir: 'out' },
};
