import { useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Field, Modal, ModeSelect } from '../../components/ui.jsx';
import { fmtDateLong, money, round2, toNum, todayStr } from '../../lib/format.js';
import { freqOf, periodDate, periodsText } from '../../lib/loanMath.js';
import { useAction } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

/**
 * Take payment for all of one borrower's running loans in one go: one row per loan with the
 * same days / amount buttons as the loan page, plus penalty. Saved as one repayment (and one
 * penalty entry) per loan — exactly what Take payment on each loan would save.
 */

// Old defaulters have one balance and no schedule, so no days buttons.
const instOf = (l) => (l.old_defaulter ? 0 : toNum(l.daily_installment));

function startRow(l) {
  const inst = instOf(l);
  const outstanding = round2(toNum(l.outstanding));
  // A defaulted (frozen) loan is only settled on purpose, so it starts unticked.
  const on = l.status === 'active' && outstanding > 0;
  const amount = on ? round2(Math.min(toNum(l.overdue) > 0 ? toNum(l.overdue) : inst, outstanding)) : 0;
  return { on, amount: amount > 0 ? String(amount) : '', days: daysFor(amount, inst), penalty: '' };
}

function daysFor(amount, inst) {
  const n = inst > 0 ? toNum(amount) / inst : 0;
  return n > 0 && Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : '';
}

function LoanRow({ loan: l, row, onChange }) {
  const F = freqOf(l);
  const inst = instOf(l);
  const outstanding = round2(toNum(l.outstanding));
  const penaltyDue = round2(toNum(l.penalty_due));
  const quick = l.frequency === 'monthly' ? [1, 2, 3, 6] : [1, 2, 3, 7, 10, 15, 30];
  const amountFor = (days) => (toNum(days) > 0 ? String(round2(Math.min(toNum(days) * inst, outstanding))) : '');
  const set = (patch) => onChange({ ...row, ...patch });
  const full = inst > 0 && toNum(row.amount) > 0 ? Math.floor((toNum(l.collected_total) + round2(row.amount)) / inst + 1e-9) : 0;

  return (
    <div className={`help-box ${row.on ? 'renew-box' : ''}`} style={{ marginTop: 12 }}>
      <label className="check">
        <input type="checkbox" checked={row.on} onChange={(e) => set({ on: e.target.checked })} />
        <strong>Loan #{l.loan_no}</strong>
        <span className="muted small">
          {' '}· {money(l.principal)}{inst > 0 && <> · {money(inst)}{F.per}</>}
          {' '}· balance {money(outstanding)}
          {toNum(l.overdue) > 0 && <> · overdue <span className="amt-out">{money(l.overdue)}</span></>}
          {penaltyDue > 0 && <> · penalty <span className="amt-out">{money(penaltyDue)}</span></>}
          {l.status === 'defaulted' && ' · defaulted'}
          {l.paid_till && <> · paid till {fmtDateLong(l.paid_till)}</>}
        </span>
      </label>
      {row.on && (
        <div className="form-grid three" style={{ marginTop: 8 }}>
          <Field label="Amount (₹) · रकम" hint={inst > 0 ? periodsText(row.amount, inst, l.frequency) : undefined}>
            <input type="number" inputMode="decimal" min="0" step="any" value={row.amount} onChange={(e) => set({ amount: e.target.value, days: daysFor(e.target.value, inst) })} />
          </Field>
          {inst > 0 && (
            <Field label={l.frequency === 'monthly' ? 'Months · कितने महीने' : 'Days · कितने दिन'} hint={`× ${money(inst)} = amount`}>
              <input type="number" inputMode="numeric" min="0" step="1" placeholder="0" value={row.days} onChange={(e) => set({ days: e.target.value, amount: amountFor(e.target.value) })} />
            </Field>
          )}
          {(penaltyDue > 0 || toNum(row.penalty) > 0) && (
            <Field label="Penalty taken (₹) · जुर्माना" hint={`Penalty due ${money(penaltyDue)}`}>
              <input type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={row.penalty} onChange={(e) => set({ penalty: e.target.value })} />
            </Field>
          )}
          <div className="span-3 quick-days">
            <div className="btn-row">
              {inst > 0 && quick.map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`btn btn-sm ${round2(row.amount) === round2(Math.min(n * inst, outstanding)) ? 'btn-primary' : ''}`}
                  onClick={() => set({ amount: amountFor(n), days: daysFor(amountFor(n), inst) })}
                >
                  {n} {n === 1 ? F.unit : F.units}
                </button>
              ))}
              {outstanding > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => set({ amount: String(outstanding), days: daysFor(outstanding, inst) })}>
                  Full balance {money(outstanding)}
                </button>
              )}
              {penaltyDue > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => set({ penalty: String(penaltyDue) })}>
                  Full penalty {money(penaltyDue)}
                </button>
              )}
            </div>
            {full >= 1 && (
              <div className="good-note">After saving, paid till · यहाँ तक जमा: <strong>{fmtDateLong(periodDate(l.frequency, l.collection_start_date, full))}</strong></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BorrowerPayModal({ borrower, loans, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ paid_on: todayStr(), mode: 'cash', note: '' });
  const [rows, setRows] = useState(() => Object.fromEntries(loans.map((l) => [l.id, startRow(l)])));

  const picked = loans
    .filter((l) => rows[l.id].on)
    .map((l) => ({ loan: l, amount: round2(rows[l.id].amount), penalty: round2(rows[l.id].penalty) }));
  const totalAmount = round2(picked.reduce((t, p) => t + p.amount, 0));
  const totalPenalty = round2(picked.reduce((t, p) => t + p.penalty, 0));
  const total = round2(totalAmount + totalPenalty);
  const errors = [];
  for (const p of picked) {
    if (p.amount < 0 || p.penalty < 0) errors.push(`Loan #${p.loan.loan_no}: amount cannot be negative.`);
  }

  async function submit(e) {
    e.preventDefault();
    if (total <= 0) return toast.error('Enter an amount for at least one loan.');
    if (errors.length) return toast.error(errors[0]);
    if (f.paid_on > todayStr()) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    const over = picked.filter((p) => p.amount > round2(toNum(p.loan.outstanding)) + 0.001 || p.penalty > round2(toNum(p.loan.penalty_due)) + 0.001);
    if (over.length && !window.confirm(`More than the balance / penalty due on loan ${over.map((p) => `#${p.loan.loan_no}`).join(', ')}. Save anyway?`)) return;
    const note = f.note.trim() || null;
    const reps = picked.filter((p) => p.amount > 0).map((p) => ({ loan_id: p.loan.id, paid_on: f.paid_on, amount: p.amount, mode: f.mode, note }));
    const pens = picked.filter((p) => p.penalty > 0).map((p) => ({ loan_id: p.loan.id, kind: 'paid', paid_on: f.paid_on, amount: p.penalty, mode: f.mode, note }));
    const ok = await run(async () => {
      if (reps.length) await q(supabase.from('loan_repayments').insert(reps));
      if (pens.length) await q(supabase.from('loan_penalty_entries').insert(pens));
    }, `${money(total)} saved on ${picked.filter((p) => p.amount + p.penalty > 0).length} loan(s)`);
    if (ok) onClose();
  }

  return (
    <Modal title={`Take payment · पैसे लिए — ${borrower.name}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid three">
          <Field label="Date money came · पैसा किस दिन मिला">
            <input type="date" required max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Tick the loans this money is for. Each loan gets its own entry, the same as Take payment on that loan.</p>
        {loans.map((l) => (
          <LoanRow key={l.id} loan={l} row={rows[l.id]} onChange={(row) => setRows((r) => ({ ...r, [l.id]: row }))} />
        ))}
        <p className="good-note">
          Total · कुल: <strong>{money(total)}</strong>
          {totalPenalty > 0 && <> ({money(totalAmount)} installments + {money(totalPenalty)} penalty)</>}
          {' '}from {picked.filter((p) => p.amount + p.penalty > 0).length} loan(s)
        </p>
        {errors.length > 0 && <div className="alert alert-error small">{errors.map((er) => <div key={er}>{er}</div>)}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || total <= 0 || errors.length > 0}>{busy ? 'Saving…' : `Save ${money(total)}`}</button>
        </div>
      </form>
    </Modal>
  );
}

