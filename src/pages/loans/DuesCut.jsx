import { useMemo, useState } from 'react';
import { ErrorBox, Field } from '../../components/ui.jsx';
import { duesCutCall, duesCutRows, duesCutStart } from '../../lib/duesCut.js';
import { money, round2, toNum } from '../../lib/format.js';
import { freqOf } from '../../lib/loanMath.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

export { duesCutErrors, duesCutRows, duesCutStart } from '../../lib/duesCut.js';

/**
 * Cut anyone's dues (overdue + penalty) from a loan's cash (migration 027), or close
 * their loan from it (033). Dave's loan ₹3,000, G2 owes ₹800 overdue + ₹200 penalty →
 * Dave gets ₹2,000; G2's loan and penalty are paid by the cut.
 */

/**
 * Days (installments) to cut ⇄ amount: days × installment, never past the balance.
 * Shows the days the typed amount covers (2.5 = two and a half days).
 */
export function DaysToCut({ amount, installment, max, onAmount, unit = 'day' }) {
  const inst = toNum(installment);
  const left = inst > 0 ? Math.ceil(toNum(max) / inst - 0.001) : 0;
  const days = amount === '' || inst <= 0 ? '' : round2(toNum(amount) / inst);
  const setDays = (v) => {
    if (v === '') return onAmount('');
    const n = Math.max(0, Math.min(toNum(v), left));
    onAmount(String(round2(Math.min(n * inst, toNum(max)))));
  };
  return (
    <div className="amount-cell">
      <button type="button" className="step-btn" onClick={() => setDays(Math.ceil(toNum(days)) - 1)} aria-label={`One ${unit} less`}>−</button>
      <input type="number" min="0" max={left} step="any" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} />
      <button type="button" className="step-btn" onClick={() => setDays(Math.floor(toNum(days)) + 1)} aria-label={`One ${unit} more`}>+</button>
    </div>
  );
}

/** Save the cuts into loan `loanId`, one RPC per picked loan. */
export async function saveDuesCuts(loanId, rows, date) {
  for (const r of rows) {
    if (r.total > 0) {
      const [fn, args] = duesCutCall(r, loanId, date);
      await q(supabase.rpc(fn, args));
    }
  }
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
  const rows = duesCutRows(picks);

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
      {rows.map((r) => {
        const l = r.loan;
        const F = freqOf(l);
        const monthly = l.frequency === 'monthly';
        return (
          <div key={l.id} className="help-box renew-box" style={{ marginTop: 12 }}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <span>
                ✂ <strong>{l.borrower_name}</strong> · Loan #{l.loan_no}
                {l.borrower_phone ? <span className="muted"> · {l.borrower_phone}</span> : null}
              </span>
              <button type="button" className="icon-btn danger" title="Remove" onClick={() => onChange(picks.filter((x) => x.loan.id !== l.id))}>✕</button>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Balance {money(l.outstanding)} · Overdue {money(l.overdue)} · <strong>Penalty due {money(l.penalty_due)}</strong> · {money(l.daily_installment)}{F.per}
            </div>
            <div className="segmented" style={{ marginTop: 8 }}>
              <button type="button" className={!r.close ? 'active' : ''} onClick={() => update(l.id, duesCutStart(l, false))}>
                Cut dues · keep it running
              </button>
              <button type="button" className={r.close ? 'active' : ''} onClick={() => update(l.id, duesCutStart(l, true))}>
                Close loan #{l.loan_no} · पूरा काटें
              </button>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field
                label="Installments to cut ₹ · बकाया"
                hint={r.close
                  ? (r.forgiveInst > 0 ? `Forgiven (छूट): ${money(r.forgiveInst)} of the balance ${money(l.outstanding)}` : `Full balance ${money(l.outstanding)} is cut. Lower it to give a discount (छूट).`)
                  : `Overdue ${money(l.overdue)} · max ${money(l.outstanding)}. Loan #${l.loan_no} keeps running for the rest (closes if fully cut).`}
              >
                <input type="number" min="0" step="any" value={r.amount} onChange={(e) => update(l.id, { amount: e.target.value })} />
              </Field>
              <Field label={`${monthly ? 'Months' : 'Days'} to cut (${monthly ? 'कितने महीने' : 'कितने दिन'})`} hint={`${money(l.daily_installment)}${F.per} · max ${money(l.outstanding)}`}>
                <DaysToCut amount={r.amount} installment={l.daily_installment} max={l.outstanding} onAmount={(amount) => update(l.id, { amount })} unit={F.unit} />
              </Field>
              <Field
                label="Penalty to cut ₹ · जुर्माना"
                hint={r.close && r.forgivePen > 0
                  ? `Penalty due ${money(l.penalty_due)} · forgiven (छूट): ${money(r.forgivePen)}`
                  : `Penalty due ${money(l.penalty_due)} — counted as penalty income`}
              >
                <input type="number" min="0" step="any" value={r.penalty} onChange={(e) => update(l.id, { penalty: e.target.value })} />
              </Field>
              <Field label="Total cut from this loan">
                <input type="text" readOnly value={money(r.total)} />
              </Field>
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              {r.close && (
                <>
                  Loan #{l.loan_no} will be <strong>closed</strong>
                  {r.forgiven > 0 ? <> · forgiven (छूट) {money(r.forgiven)} ({money(r.forgiveInst)} installments + {money(r.forgivePen)} penalty), no cash</> : null}.{' '}
                </>
              )}
              Day Book: {money(r.total)} goes out as part of this loan and comes in on {l.borrower_name}&apos;s loan
              ({money(r.cut)} collection{r.pen > 0 ? ` + ${money(r.pen)} penalty income` : ''}). Cash in hand moves only by what you really hand over.
            </p>
          </div>
        );
      })}
    </>
  );
}
