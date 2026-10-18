import { round2, toNum } from './format.js';

/**
 * One payment from a borrower spread over several loans (borrower Take payment).
 *
 * Example: 4 loans (2 × ₹240/day, 2 × ₹120/day), 2 days + ₹140 overdue = ₹1,580.
 * Received ₹1,000 UPI + ₹600 cash − ₹20 change = ₹1,580 → auto-fill puts it on the
 * loans, then UPI is used first and cash after, so the Day Book shows UPI ₹1,000 and
 * cash ₹580 exactly.
 */

/** Money actually kept: UPI + cash − change given back (change comes out of cash). */
export function received({ upi, cash, change }) {
  const u = round2(Math.max(0, toNum(upi)));
  const c = round2(Math.max(0, toNum(cash)) - Math.max(0, toNum(change)));
  return { upi: u, cash: c, total: round2(u + c) };
}

/**
 * Spread `money` over the loans: first each loan's overdue (missed days, up to today),
 * then one more installment at a time on every loan (extra days), never past a loan's
 * balance. `penaltyTaken` is already spoken for. Returns { [loanId]: amount }.
 * loans: [{ id, overdue, inst, outstanding }] in the order to fill.
 */
export function autoFill(loans, money) {
  let left = round2(money);
  const out = Object.fromEntries(loans.map((l) => [l.id, 0]));
  const room = (l) => round2(toNum(l.outstanding) - out[l.id]);
  for (const l of loans) {
    const put = round2(Math.max(0, Math.min(toNum(l.overdue), room(l), left)));
    out[l.id] = round2(out[l.id] + put);
    left = round2(left - put);
  }
  // Extra days, round by round so every loan moves forward together.
  while (left > 0.001) {
    let moved = false;
    for (const l of loans) {
      const put = round2(Math.max(0, Math.min(toNum(l.inst) || room(l), room(l), left)));
      if (put <= 0) continue;
      out[l.id] = round2(out[l.id] + put);
      left = round2(left - put);
      moved = true;
      if (left <= 0.001) break;
    }
    if (!moved) break;
  }
  return out;
}

/**
 * Decide the mode of every entry: UPI is used first, top to bottom, then cash.
 * items: [{ loanId, kind: 'installment' | 'penalty', amount }]
 * Returns [{ loanId, kind, mode: 'upi' | 'cash', amount }] — a loan can get two entries
 * (part UPI, part cash). Anything beyond the money received is returned as `short`.
 */
export function splitModes(items, money) {
  let upi = round2(money.upi);
  let cash = round2(money.cash);
  const entries = [];
  let short = 0;
  for (const it of items) {
    let need = round2(it.amount);
    if (need <= 0) continue;
    const fromUpi = round2(Math.min(need, Math.max(0, upi)));
    if (fromUpi > 0) { entries.push({ ...it, mode: 'upi', amount: fromUpi }); upi = round2(upi - fromUpi); need = round2(need - fromUpi); }
    const fromCash = round2(Math.min(need, Math.max(0, cash)));
    if (fromCash > 0) { entries.push({ ...it, mode: 'cash', amount: fromCash }); cash = round2(cash - fromCash); need = round2(need - fromCash); }
    short = round2(short + need);
  }
  return { entries, short };
}
