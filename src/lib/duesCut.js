import { money, round2, toNum } from './format.js';

/**
 * Cut anyone's dues from a loan's cash (migration 027), or close their loan (033).
 *
 * Dave renews and G2 comes with him: "clear my loan from Dave's new loan too".
 * G2 owes ₹4,000 + ₹300 penalty. Close it with ₹3,800 + ₹200 penalty cut →
 * ₹4,000 comes off Dave's cash, ₹200 + ₹100 is forgiven (छूट), G2's loan closes.
 *
 * A pick is { loan, amount, penalty, close }; amount = installments, penalty apart.
 */

/** Starting values for a picked loan: keep running → its overdue; close → the full balance. */
export function duesCutStart(loan, close = false) {
  const outstanding = round2(toNum(loan.outstanding));
  return {
    close,
    amount: String(close ? outstanding : round2(Math.min(toNum(loan.overdue), outstanding))),
    penalty: String(round2(toNum(loan.penalty_due))),
  };
}

/** Picked rows → what the RPC needs: cut, penalty, total and (on close) what is forgiven. */
export function duesCutRows(picks) {
  return picks.map((p) => {
    const cut = round2(p.amount);
    const pen = round2(p.penalty);
    const close = !!p.close;
    const forgiveInst = close ? round2(Math.max(0, toNum(p.loan.outstanding) - cut)) : 0;
    const forgivePen = close ? round2(Math.max(0, toNum(p.loan.penalty_due) - pen)) : 0;
    return { ...p, close, cut, pen, total: round2(cut + pen), forgiveInst, forgivePen, forgiven: round2(forgiveInst + forgivePen) };
  });
}

export function duesCutErrors(rows) {
  const errors = [];
  for (const r of rows) {
    const who = `Loan #${r.loan.loan_no} (${r.loan.borrower_name})`;
    if (r.cut < 0 || r.pen < 0) errors.push(`${who}: cut cannot be negative.`);
    if (r.cut > round2(toNum(r.loan.outstanding)) + 0.001) errors.push(`${who}: cannot cut more than its balance ${money(r.loan.outstanding)}.`);
    if (r.pen > round2(toNum(r.loan.penalty_due)) + 0.001) errors.push(`${who}: penalty cut is more than its penalty due ${money(r.loan.penalty_due)}.`);
    if (r.close && r.total <= 0) errors.push(`${who}: enter an amount to cut to close it.`);
  }
  return errors;
}

/** RPC call for one row: close → cut_and_close_into_loan (033), else cut_dues_into_loan (027). */
export function duesCutCall(row, loanId, date) {
  return [
    row.close ? 'cut_and_close_into_loan' : 'cut_dues_into_loan',
    { p_old: row.loan.id, p_new: loanId, p_amount: row.cut, p_penalty: row.pen, p_date: date },
  ];
}
