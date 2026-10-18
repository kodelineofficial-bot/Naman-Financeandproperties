import { useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { autoFill, received, splitModes } from '../../lib/borrowerPay.js';
import { fmtDateLong, money, round2, toNum, todayStr } from '../../lib/format.js';
import { freqOf, periodDate, periodsText } from '../../lib/loanMath.js';
import { useAction } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

/**
 * Take payment for all of one borrower's running loans in one go.
 * Money received (UPI + cash − change) is spread over the loans — by hand or with Auto-fill
 * (overdue first, then extra days) — and each loan gets its own entries: UPI is used first,
 * then cash, so the Day Book shows exactly the UPI and cash that came in.
 */

// Old defaulters have one balance and no schedule, so no days buttons.
const instOf = (l) => (l.old_defaulter ? 0 : toNum(l.daily_installment));

function daysFor(amount, inst) {
  const n = inst > 0 ? toNum(amount) / inst : 0;
  return n > 0 && Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : '';
}

function startRow(l) {
  // A defaulted (frozen) loan is only collected on purpose, so it starts unticked.
  return { on: l.status === 'active' && toNum(l.outstanding) > 0, amount: '', days: '', penalty: '' };
}

const modeText = (parts) => parts.map((p) => `${p.mode === 'upi' ? 'UPI' : 'Cash'} ${money(p.amount)}`).join(' + ');

function LoanRow({ loan: l, row, split, onChange }) {
  const F = freqOf(l);
  const inst = instOf(l);
  const outstanding = round2(toNum(l.outstanding));
  const penaltyDue = round2(toNum(l.penalty_due));
  const quick = l.frequency === 'monthly' ? [1, 2, 3, 6] : [1, 2, 3, 7, 10, 15, 30];
  const amountFor = (days) => (toNum(days) > 0 ? String(round2(Math.min(toNum(days) * inst, outstanding))) : '');
  const set = (patch) => onChange({ ...row, ...patch });
  const full = inst > 0 && toNum(row.amount) > 0 ? Math.floor((toNum(l.collected_total) + round2(row.amount)) / inst + 1e-9) : 0;
  const instParts = split.filter((p) => p.kind === 'installment');
  const penParts = split.filter((p) => p.kind === 'penalty');

  return (
    <div className={`help-box ${row.on ? 'renew-box' : ''}`} style={{ marginTop: 12 }}>
      <label className="check">
        <input type="checkbox" checked={row.on} onChange={(e) => set({ on: e.target.checked })} />
        <strong>Loan #{l.loan_no}</strong>
        <span className="muted small">
          {' '}· {money(l.principal)}{inst > 0 && <> · {money(inst)}{F.per}</>}
          {' '}· balance {money(outstanding)}
          {toNum(l.overdue) > 0 ? <> · overdue <span className="amt-out">{money(l.overdue)}</span></> : ' · nothing overdue'}
          {penaltyDue > 0 && <> · penalty <span className="amt-out">{money(penaltyDue)}</span></>}
          {l.status === 'defaulted' && ' · defaulted'}
          {l.paid_till && <> · paid till {fmtDateLong(l.paid_till)}</>}
        </span>
      </label>
      {row.on && (
        <div className="form-grid three" style={{ marginTop: 8 }}>
          <Field label="Installments (₹) · किश्त" hint={inst > 0 ? periodsText(row.amount, inst, l.frequency) : undefined}>
            <input type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={row.amount} onChange={(e) => set({ amount: e.target.value, days: daysFor(e.target.value, inst) })} />
          </Field>
          {inst > 0 && (
            <Field label={l.frequency === 'monthly' ? 'Months · कितने महीने' : 'Days · कितने दिन'} hint={`× ${money(inst)} = amount`}>
              <input type="number" inputMode="numeric" min="0" step="1" placeholder="0" value={row.days} onChange={(e) => set({ days: e.target.value, amount: amountFor(e.target.value) })} />
            </Field>
          )}
          <Field label="Penalty taken (₹) · जुर्माना" hint={penaltyDue > 0 ? `Penalty due ${money(penaltyDue)} · counted as penalty income` : 'No penalty due'}>
            <input type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={row.penalty} onChange={(e) => set({ penalty: e.target.value })} disabled={penaltyDue <= 0 && !toNum(row.penalty)} />
          </Field>
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
              {toNum(l.overdue) > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => { const a = String(round2(Math.min(toNum(l.overdue), outstanding))); set({ amount: a, days: daysFor(a, inst) }); }}>
                  Overdue {money(l.overdue)}
                </button>
              )}
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
            {(instParts.length > 0 || penParts.length > 0) && (
              <div className="muted small" style={{ marginTop: 6 }}>
                Saved as: {instParts.length > 0 && <>installments {modeText(instParts)}</>}
                {instParts.length > 0 && penParts.length > 0 && ' · '}
                {penParts.length > 0 && <>penalty {modeText(penParts)}</>}
              </div>
            )}
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
  const [f, setF] = useState({ paid_on: todayStr(), note: '', upi: '', cash: '', change: '' });
  const [rows, setRows] = useState(() => Object.fromEntries(loans.map((l) => [l.id, startRow(l)])));
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  const got = received(f);
  const picked = loans.filter((l) => rows[l.id].on);
  const items = picked.flatMap((l) => [
    { loanId: l.id, kind: 'installment', amount: round2(rows[l.id].amount) },
    { loanId: l.id, kind: 'penalty', amount: round2(rows[l.id].penalty) },
  ]).filter((it) => it.amount > 0);
  const onLoans = round2(items.reduce((t, it) => t + it.amount, 0));
  const onPenalty = round2(items.filter((it) => it.kind === 'penalty').reduce((t, it) => t + it.amount, 0));
  const left = round2(got.total - onLoans);
  const { entries } = splitModes(items, got);
  const loanCount = new Set(items.map((it) => it.loanId)).size;

  const errors = [];
  if (toNum(f.change) > toNum(f.cash) + 0.001) errors.push('Change given back cannot be more than the cash received.');
  for (const l of picked) {
    if (round2(rows[l.id].amount) < 0 || round2(rows[l.id].penalty) < 0) errors.push(`Loan #${l.loan_no}: amount cannot be negative.`);
  }

  // Overdue first, then extra days; penalty already typed stays as it is.
  function runAutoFill() {
    const fill = picked.filter((l) => toNum(l.outstanding) > 0);
    if (!fill.length) return toast.error('Tick at least one loan with a balance.');
    const penalties = round2(picked.reduce((t, l) => t + Math.max(0, round2(rows[l.id].penalty)), 0));
    const amounts = autoFill(
      fill.map((l) => ({ id: l.id, overdue: l.overdue, inst: instOf(l), outstanding: l.outstanding })),
      Math.max(0, round2(got.total - penalties)),
    );
    setRows((r) => {
      const next = { ...r };
      for (const l of fill) {
        const a = amounts[l.id] > 0 ? String(amounts[l.id]) : '';
        next[l.id] = { ...next[l.id], amount: a, days: daysFor(a, instOf(l)) };
      }
      return next;
    });
  }

  // Money in the boxes = what is on the loans (when only one mode came in).
  const fillMoney = (key) => setF({ ...f, upi: key === 'upi' ? String(onLoans) : '', cash: key === 'cash' ? String(onLoans) : '', change: '' });

  async function submit(e) {
    e.preventDefault();
    if (got.total <= 0) return toast.error('Enter the money received (UPI / cash).');
    if (onLoans <= 0) return toast.error('Put the money on at least one loan.');
    if (errors.length) return toast.error(errors[0]);
    if (Math.abs(left) > 0.005) return toast.error(left > 0 ? `${money(left)} is not put on any loan yet.` : `${money(-left)} more on loans than received.`);
    if (f.paid_on > todayStr()) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    const over = picked.filter((l) => round2(rows[l.id].amount) > round2(toNum(l.outstanding)) + 0.001 || round2(rows[l.id].penalty) > round2(toNum(l.penalty_due)) + 0.001);
    if (over.length && !window.confirm(`More than the balance / penalty due on loan ${over.map((l) => `#${l.loan_no}`).join(', ')}. Save anyway?`)) return;

    const changeNote = toNum(f.change) > 0 ? `cash ${money(toNum(f.cash))} − change ${money(toNum(f.change))}` : '';
    const note = [f.note.trim(), changeNote].filter(Boolean).join(' · ') || null;
    const reps = entries.filter((x) => x.kind === 'installment').map((x) => ({ loan_id: x.loanId, paid_on: f.paid_on, amount: x.amount, mode: x.mode, note }));
    const pens = entries.filter((x) => x.kind === 'penalty').map((x) => ({ loan_id: x.loanId, kind: 'paid', paid_on: f.paid_on, amount: x.amount, mode: x.mode, note }));
    const ok = await run(async () => {
      const saved = reps.length ? await q(supabase.from('loan_repayments').insert(reps).select('id')) : [];
      try {
        if (pens.length) await q(supabase.from('loan_penalty_entries').insert(pens));
      } catch (er) {
        // Keep it all-or-nothing: take the installments back out if the penalty could not be saved.
        if (saved.length) await q(supabase.from('loan_repayments').delete().in('id', saved.map((r) => r.id)));
        throw er;
      }
    }, `${money(got.total)} saved on ${loanCount} loan(s) · UPI ${money(got.upi)} · cash ${money(got.cash)}`);
    if (ok) onClose();
  }

  const leftTone = Math.abs(left) <= 0.005 ? 'good-note' : 'alert alert-error small';

  return (
    <Modal title={`Take payment · पैसे लिए — ${borrower.name}`} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Date money came · पैसा किस दिन मिला">
            <input type="date" required max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>

        <h4 style={{ margin: '12px 0 4px' }}>Money received · पैसे मिले</h4>
        <div className="form-grid three">
          <Field label="UPI (₹)">
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={f.upi} onChange={(e) => setF({ ...f, upi: e.target.value })} />
          </Field>
          <Field label="Cash (₹) · नकद">
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={f.cash} onChange={(e) => setF({ ...f, cash: e.target.value })} />
          </Field>
          <Field label="Change given back (₹) · वापस दिए" hint="Cash returned to the borrower">
            <input type="number" inputMode="decimal" min="0" step="any" placeholder="0" value={f.change} onChange={(e) => setF({ ...f, change: e.target.value })} />
          </Field>
        </div>
        <div className="btn-row" style={{ alignItems: 'center' }}>
          <span>
            Received · मिले: <strong>{money(got.total)}</strong>
            <span className="muted small"> (UPI {money(got.upi)} · cash {money(Math.max(0, got.cash))})</span>
          </span>
          <button type="button" className="btn btn-sm btn-primary" disabled={got.total <= 0} onClick={runAutoFill} title="Overdue first, then extra days on every loan">
            ⚡ Auto-fill loans
          </button>
          {got.total <= 0 && onLoans > 0 && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => fillMoney('cash')}>All cash {money(onLoans)}</button>
              <button type="button" className="btn btn-sm" onClick={() => fillMoney('upi')}>All UPI {money(onLoans)}</button>
            </>
          )}
        </div>

        <h4 style={{ margin: '16px 0 0' }}>Where it goes · कहाँ लगाना है</h4>
        <p className="muted small" style={{ margin: '2px 0 0' }}>
          Tick the loans this money is for. Auto-fill puts it on overdue first, then extra days. UPI is used first, then cash.
        </p>
        {loans.map((l) => (
          <LoanRow key={l.id} loan={l} row={rows[l.id]} split={entries.filter((x) => x.loanId === l.id)} onChange={(row) => setRow(l.id, row)} />
        ))}

        <div className={leftTone} style={{ marginTop: 12 }}>
          Received <strong>{money(got.total)}</strong> · On loans <strong>{money(onLoans)}</strong>
          {onPenalty > 0 && <> (incl. penalty {money(onPenalty)})</>}
          {' '}· Left <strong>{money(left)}</strong> {Math.abs(left) <= 0.005 && onLoans > 0 && '✓'}
          {left > 0.005 && (
            <div className="btn-row" style={{ marginTop: 6 }}>
              <span className="small">Put the {money(left)} as advance on:</span>
              {picked.filter((l) => toNum(l.outstanding) > round2(rows[l.id].amount)).map((l) => (
                <button
                  type="button"
                  key={l.id}
                  className="btn btn-sm"
                  onClick={() => { const a = String(round2(round2(rows[l.id].amount) + left)); setRow(l.id, { amount: a, days: daysFor(a, instOf(l)) }); }}
                >
                  Loan #{l.loan_no}
                </button>
              ))}
              {got.cash >= left - 0.005 && (
                <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, change: String(round2(toNum(f.change) + left)) })}>
                  Give back {money(left)} as change
                </button>
              )}
            </div>
          )}
          {left < -0.005 && <div className="small">Lower an amount on a loan, or fix the money received.</div>}
        </div>
        {errors.length > 0 && <div className="alert alert-error small">{errors.map((er) => <div key={er}>{er}</div>)}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || got.total <= 0 || Math.abs(left) > 0.005 || errors.length > 0}>
            {busy ? 'Saving…' : `Save ${money(got.total)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
