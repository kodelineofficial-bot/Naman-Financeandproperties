import { round2, toNum } from './format.js';

// Ledger out includes the advance kept; the transaction stores what actually
// reached the borrower. Keep both amounts so cashflow arithmetic stays intact.
export function withPayoutAmounts(entries, payouts) {
  const actual = new Map(payouts.map((r) => [r.id, toNum(r.amount)]));
  return entries.map((row) => {
    if (row.kind !== 'disbursement' || row.mode === 'renewal' || !actual.has(row.id)) return row;
    const handedOver = actual.get(row.id);
    return { ...row, handed_over: handedOver, advance_included: round2(toNum(row.amount) - handedOver) };
  });
}

export function loanMoneyOnDate(entries, loanId) {
  const rows = entries.filter((r) => r.kind === 'disbursement' && r.ref_id === loanId);
  return {
    handedOver: round2(rows.filter((r) => r.mode !== 'renewal').reduce((n, r) => n + toNum(r.handed_over ?? r.amount), 0)),
    adjusted: round2(rows.filter((r) => r.mode === 'renewal').reduce((n, r) => n + toNum(r.amount), 0)),
  };
}

export function displayedLedgerAmount(row) {
  return toNum(row.mode === 'upi' ? row.handed_over ?? row.amount : row.amount);
}
