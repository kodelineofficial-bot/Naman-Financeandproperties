import { fmtDate, money, round2, toNum } from './format.js';

/** What deleting one money entry does to cash in hand, for the confirm popup. */
export function entryCashNote({ amount, mode, direction, date, handed_over }) {
  if (mode === 'upi') return 'UPI entry: cash in hand does not change.';
  if (mode === 'renewal' || mode === 'waiver' || mode === 'opening') return 'No cash in this entry: cash in hand does not change.';
  const value = round2(toNum(handed_over ?? amount));
  return `Cash in hand goes ${direction === 'in' ? 'down' : 'up'} by ${money(value)} from ${fmtDate(date)} onwards (until the next cash count).`;
}

/** Sentence for loan_delete_preview: { days: [{ date, change }], total }. */
export function loanCashNote(preview) {
  const days = (preview?.days || []).filter((d) => toNum(d.change) !== 0);
  if (!days.length) return 'Cash in hand does not change.';
  const total = round2(toNum(preview.total));
  const from = fmtDate(days[0].date);
  if (total === 0) return `Cash in hand changes on some days from ${from}, but ends up the same.`;
  return `Cash in hand goes ${total < 0 ? 'down' : 'up'} by ${money(Math.abs(total))} in total, starting ${from} (until the next cash count).`;
}

/** The deleted loan's own entries from the saved copy, newest first. */
export function deletedLoanEntries(deletion) {
  const s = deletion.snapshot || {};
  const own = (rows) => (rows || []).filter((r) => r.loan_id === deletion.loan_id);
  return [
    ...own(s.disbursements).map((r) => ({ ...r, type: 'Given' })),
    ...own(s.repayments).map((r) => ({ ...r, type: 'Paid' })),
    ...own(s.penalties).map((r) => ({ ...r, type: `Penalty ${r.kind}` })),
  ].sort((a, b) => (b.paid_on + b.created_at).localeCompare(a.paid_on + a.created_at));
}
