import { useMemo, useState } from 'react';
import { ErrorBox, Field } from '../../components/ui.jsx';
import { money, round2, toNum } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

/**
 * Cut anyone's dues (overdue + penalty) from a loan's cash (migration 027).
 * Dave's loan ₹3,000, G2 owes ₹800 overdue + ₹200 penalty → Dave gets ₹2,000;
 * G2's loan and penalty are paid by the cut.
 */

/** Picked rows → what the RPC needs, with checks. */
export function duesCutRows(picks) {
  return picks.map((p) => ({
    ...p,
    cut: round2(p.amount),
    pen: round2(p.penalty),
    total: round2(round2(p.amount) + round2(p.penalty)),
  }));
}

export function duesCutErrors(rows) {
  const errors = [];
  for (const r of rows) {
    const who = `Loan #${r.loan.loan_no} (${r.loan.borrower_name})`;
    if (r.cut < 0 || r.pen < 0) errors.push(`${who}: cut cannot be negative.`);
    if (r.cut > round2(toNum(r.loan.outstanding)) + 0.001) errors.push(`${who}: cannot cut more than its balance ${money(r.loan.outstanding)}.`);
    if (r.pen > round2(toNum(r.loan.penalty_due)) + 0.001) errors.push(`${who}: penalty cut is more than its penalty due ${money(r.loan.penalty_due)}.`);
  }
  return errors;
}

/** Save the cuts into loan `loanId`, one RPC per picked loan. */
export async function saveDuesCuts(loanId, rows, date) {
  for (const r of rows) {
    if (r.total > 0) {
      await q(supabase.rpc('cut_dues_into_loan', { p_old: r.loan.id, p_new: loanId, p_amount: r.cut, p_penalty: r.pen, p_date: date }));
    }
  }
}

/** Starting values for a loan: its overdue and penalty due. */
export function duesCutStart(loan) {
  return {
    amount: String(round2(Math.min(toNum(loan.overdue), toNum(loan.outstanding)))),
    penalty: String(round2(toNum(loan.penalty_due))),
  };
}

/**
 * Search running loans and pick whose dues to cut.
 * excludeLoanId: the loan being given; excludeBorrowerId: hide this borrower's loans
 * (on New Loan their own loans are offered separately above).
 */
export function DuesCutPicker({ picks, onChange, excludeLoanId, excludeBorrowerId }) {
  const [search, setSearch] = useState('');
  const loans = useLoad(
    () => q(
      supabase.from('loan_summary')
        .select('id,loan_no,borrower_id,borrower_name,borrower_phone,outstanding,overdue,penalty_due,frequency,daily_installment,status')
        .in('status', ['active', 'defaulted'])
        .order('loan_no'),
    ),
    [],
  );
  const picked = new Set(picks.map((p) => p.loan.id));
  const found = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return (loans.data || [])
      .filter((l) => l.id !== excludeLoanId && l.borrower_id !== excludeBorrowerId && !picked.has(l.id))
      .filter((l) => toNum(l.outstanding) > 0 || toNum(l.penalty_due) > 0)
      .filter((l) => `${l.borrower_name} ${l.borrower_phone || ''} #${l.loan_no} ${l.loan_no}`.toLowerCase().includes(s))
      .slice(0, 20);
  }, [loans.data, search, excludeLoanId, excludeBorrowerId, picks]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id, patch) => onChange(picks.map((p) => (p.loan.id === id ? { ...p, ...patch } : p)));

  return (
    <>
      <ErrorBox error={loans.error} />
      <input
        type="search"
        className="search full"
        placeholder="Search borrower name / phone / loan no. whose dues to cut…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {search.trim() && (
        <div className="pick-list">
          {found.length === 0 && <div className="muted small pad">{loans.loading ? 'Loading…' : 'No running loan found.'}</div>}
          {found.map((l) => (
            <button
              type="button"
              key={l.id}
              className="pick"
              onClick={() => { onChange([...picks, { loan: l, ...duesCutStart(l) }]); setSearch(''); }}
            >
              <strong>{l.borrower_name} · Loan #{l.loan_no}</strong>
              <span className="muted small">
                Overdue {money(l.overdue)} · Penalty {money(l.penalty_due)} · Balance {money(l.outstanding)}
              </span>
            </button>
          ))}
        </div>
      )}
      {picks.map((p) => {
        const l = p.loan;
        const total = round2(round2(p.amount) + round2(p.penalty));
        return (
          <div key={l.id} className="help-box renew-box" style={{ marginTop: 12 }}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <span>
                ✂ <strong>{l.borrower_name}</strong> · Loan #{l.loan_no}
                {l.borrower_phone ? <span className="muted"> · {l.borrower_phone}</span> : null}
              </span>
              <button type="button" className="icon-btn danger" title="Remove" onClick={() => onChange(picks.filter((x) => x.loan.id !== l.id))}>✕</button>
            </div>
            <div className="form-grid three" style={{ marginTop: 8 }}>
              <Field label="Overdue / installment to cut ₹ · बकाया" hint={`Overdue ${money(l.overdue)} · max ${money(l.outstanding)}`}>
                <input type="number" min="0" step="any" value={p.amount} onChange={(e) => update(l.id, { amount: e.target.value })} />
              </Field>
              <Field label="Penalty to cut ₹ · जुर्माना" hint={`Penalty due ${money(l.penalty_due)}`}>
                <input type="number" min="0" step="any" value={p.penalty} onChange={(e) => update(l.id, { penalty: e.target.value })} disabled={toNum(l.penalty_due) <= 0 && !toNum(p.penalty)} />
              </Field>
              <Field label="Total cut">
                <input type="text" readOnly value={money(total)} />
              </Field>
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              Day Book: {money(total)} goes out as part of this loan and comes in on {l.borrower_name}&apos;s loan
              ({money(round2(p.amount))} collection{round2(p.penalty) > 0 ? ` + ${money(round2(p.penalty))} penalty income` : ''}). Cash in hand moves only by what you really hand over.
            </p>
          </div>
        );
      })}
    </>
  );
}
