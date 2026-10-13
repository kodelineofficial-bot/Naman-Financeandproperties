import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import {
  Card, Empty, ErrorBox, Field, Loading, Modal, ModeSelect, PageHeader, Progress, Stat, StatusBadge,
} from '../../components/ui.jsx';
import KhataCalendar from '../../components/KhataCalendar.jsx';
import {
  addDays, daysText, fmtDate, fmtDateLong, fmtDateShort, modeLabel, money, round2, sum, toNum, todayStr, whatsappLink,
} from '../../lib/format.js';
import { buildLoanCalendar } from '../../lib/loanMath.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

function EntryModal({ title, table, loanId, defaultAmount, max, daily, collected, startDate, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ paid_on: todayStr(), amount: defaultAmount ? String(defaultAmount) : '', mode: 'cash', note: '' });

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    if (max != null && amount > max + 0.001 && !window.confirm(`This is more than the remaining ${money(max)}. Save anyway?`)) return;
    const ok = await run(
      () => q(supabase.from(table).insert({ loan_id: loanId, paid_on: f.paid_on, amount, mode: f.mode, note: f.note.trim() || null })),
      `${money(amount)} saved`,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Date"><input type="date" required value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
          <Field label="Amount (₹) · रकम" hint={daily ? daysText(f.amount, daily) : undefined}>
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" required autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          {daily > 0 && (
            <div className="span-2 quick-days">
              <span className="field-label">How many days is this payment for? · कितने दिन का?</span>
              <div className="btn-row">
                {[1, 2, 3, 4, 7, 10, 15, 30].map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={`btn btn-sm ${round2(f.amount) === round2(n * daily) ? 'btn-primary' : ''}`}
                    onClick={() => setF({ ...f, amount: String(round2(Math.min(n * daily, max ?? Infinity))) })}
                  >
                    {n} {n === 1 ? 'day' : 'days'}
                  </button>
                ))}
                {max > 0 && (
                  <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, amount: String(max) })}>
                    Full balance {money(max)}
                  </button>
                )}
              </div>
              {toNum(f.amount) > 0 && (() => {
                const full = Math.floor((toNum(collected) + round2(f.amount)) / daily + 1e-9);
                return (
                  <div className="good-note">
                    {full >= 1 ? (
                      <>After saving, paid till · यहाँ तक जमा: <strong>{fmtDateLong(addDays(startDate, full - 1))}</strong></>
                    ) : (
                      'Not a full day yet · अभी पूरा दिन नहीं'
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function TxnTable({ rows, onDelete, empty, daily }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Date</th><th className="num">Amount</th><th>Mode</th><th>Note</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{fmtDate(r.paid_on)}</td>
              <td className="num">
                <strong>{money(r.amount)}</strong>
                {daily > 0 && <div className="muted small">{daysText(r.amount, daily)}</div>}
              </td>
              <td>{modeLabel(r.mode)}</td>
              <td className="muted">{r.note || ''}</td>
              <td className="num">
                <button className="icon-btn danger" title="Delete" onClick={() => onDelete(r)}>🗑</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LoanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [modal, setModal] = useState(null);
  const today = todayStr();

  const { data, loading, error } = useLoad(async () => {
    const [loan, disb, reps] = await Promise.all([
      q(supabase.from('loan_summary').select('*').eq('id', id).single()),
      q(supabase.from('loan_disbursements').select('*').eq('loan_id', id).order('paid_on', { ascending: false }).order('created_at', { ascending: false })),
      q(supabase.from('loan_repayments').select('*').eq('loan_id', id).order('paid_on', { ascending: false }).order('created_at', { ascending: false })),
    ]);
    return { loan, disb, reps };
  }, [id]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error || new Error('Loan not found')} />;

  const { loan: l, disb, reps } = data;
  const cal = buildLoanCalendar(l, reps, today);
  const missedDays = cal.counts.missed;
  const pendingDisb = toNum(l.pending_disbursement);
  const outstanding = toNum(l.outstanding);
  const wa = whatsappLink(
    l.borrower_phone,
    `Namaste ${l.borrower_name}, Loan #${l.loan_no}: kul baaki ${money(outstanding)}` +
      (toNum(l.overdue) > 0 ? `, jismein ${money(l.overdue)} bakaya hai` : '') +
      `. Roz ki kisht ${money(l.daily_installment)}.`,
  );

  async function del(table, row) {
    if (!window.confirm(`Delete ${money(row.amount)} entry of ${fmtDate(row.paid_on)}?`)) return;
    await run(() => q(supabase.from(table).delete().eq('id', row.id)), 'Entry deleted');
  }

  async function setStatus(status) {
    const labels = { defaulted: 'mark this loan as DEFAULTED', active: 're-open this loan', cancelled: 'CANCEL this loan', closed: 'close / settle this loan now' };
    if (!window.confirm(`Are you sure you want to ${labels[status]}?`)) return;
    await run(
      () => q(supabase.from('loans').update({ status, closed_on: status === 'closed' ? today : null }).eq('id', id)),
      'Status updated',
    );
  }

  async function deleteLoan() {
    if (!window.confirm(`Delete loan #${l.loan_no} with ALL its ${disb.length + reps.length} entries? This cannot be undone.`)) return;
    const ok = await run(() => q(supabase.from('loans').delete().eq('id', id)), 'Loan deleted');
    if (ok) navigate('/loans');
  }

  return (
    <>
      <PageHeader
        title={`${l.borrower_name}`}
        hindi={`Loan #${l.loan_no}`}
        subtitle={`${[l.borrower_occupation, l.borrower_phone, l.borrower_address].filter(Boolean).join(' · ') || '—'}`}
      >
        <StatusBadge status={l.status} />
        {(l.status === 'active' || l.status === 'defaulted') && (
          <button className="btn btn-primary btn-lg" onClick={() => setModal('rep')}>₹ Take payment · पैसे लिए</button>
        )}
        {wa && <a className="btn btn-wa" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
        <Link className="btn" to={`/borrowers/${l.borrower_id}`}>Borrower</Link>
        <Link className="btn" to={`/loans/${id}/edit`}>Edit terms</Link>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHeader>
      <ErrorBox error={error} />

      <div className="stats">
        <Stat label="Balance · बाकी" value={money(outstanding)} tone="gold" hint={`${l.installments_left} installments left`} />
        <Stat label="Collected · वसूल" value={money(l.collected_total)} tone="green" hint={`incl. ${money(l.advance_amount)} advance`} />
        <Stat label="Overdue · बकाया" value={money(l.overdue)} tone={toNum(l.overdue) > 0 ? 'red' : undefined} hint={`${missedDays} missed day(s)`} />
        <Stat label="To give · देना बाकी" value={money(pendingDisb)} tone={pendingDisb > 0 ? 'red' : undefined} hint={`Given ${money(l.disbursed)} of ${money(l.net_disbursable)}`} />
      </div>

      <Card>
        <div className="progress-line">
          <span>{money(l.collected_total)} of {money(l.total_repayable)}</span>
          <strong>{l.progress_pct}%</strong>
        </div>
        <Progress pct={l.progress_pct} />
        <div className="paid-till">
          {cal.paidTill ? (
            <>Paid till · यहाँ तक जमा: <strong>{fmtDateLong(cal.paidTill)}</strong></>
          ) : (
            <>No day paid yet · अभी कोई दिन जमा नहीं</>
          )}
          <span className="muted"> · Collection {fmtDateLong(l.collection_start_date)} → {fmtDateLong(l.expected_end_date)} ({cal.nDays} days)</span>
        </div>
      </Card>

      <Card title="Khata calendar · रोज़ का हिसाब" actions={<span className="muted small">{cal.nDays} collection days</span>}>
        <KhataCalendar cal={cal} today={today} />
      </Card>

      <div className="grid-2">
        <Card
          title={`Collections · वसूली (${reps.length})`}
          actions={
            <button className="btn btn-primary btn-sm" onClick={() => setModal('rep')}>+ Add collection</button>
          }
          flush
        >
          <div className="card-sub muted small">
            Cash collected: <strong>{money(l.collected_cash)}</strong> · Advance: <strong>{money(l.advance_amount)}</strong>
          </div>
          <TxnTable rows={reps} daily={toNum(l.daily_installment)} onDelete={(r) => del('loan_repayments', r)} empty="No collections yet." />
        </Card>
        <Card
          title={`Money given · दिया (${disb.length})`}
          actions={
            <button className="btn btn-sm" onClick={() => setModal('disb')} disabled={pendingDisb <= 0}>+ Give money</button>
          }
          flush
        >
          <div className="card-sub muted small">
            Given: <strong>{money(sum(disb, 'amount'))}</strong> · Still to give: <strong className={pendingDisb > 0 ? 'amt-out' : ''}>{money(pendingDisb)}</strong>
          </div>
          <TxnTable rows={disb} onDelete={(r) => del('loan_disbursements', r)} empty="Nothing given yet." />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Loan terms · शर्तें">
          <div className="kv-list">
            <div><span>Loan date</span><strong>{fmtDate(l.loan_date)}</strong></div>
            <div><span>Loan amount (principal)</span><strong>{money(l.principal)}</strong></div>
            <div><span>Interest cut upfront ({toNum(l.interest_pct)}%)</span><strong>{money(l.interest_amount)}</strong></div>
            <div><span>Advance kept ({l.advance_days} days)</span><strong>{money(l.advance_amount)}</strong></div>
            <div className="kv-total"><span>Net cash to give</span><strong>{money(l.net_disbursable)}</strong></div>
            <div><span>Daily installment</span><strong>{money(l.daily_installment)}</strong></div>
            <div><span>Total repayable ({l.duration_days} days)</span><strong>{money(l.total_repayable)}</strong></div>
            <div><span>Collection</span><strong>{fmtDateLong(l.collection_start_date)} → {fmtDateLong(l.expected_end_date)}</strong></div>
            <div><span>Expected by today</span><strong>{money(l.expected_till_today)}</strong></div>
            <div><span>Last payment</span><strong>{fmtDate(l.last_paid_on)}</strong></div>
            <div><span>Expected profit</span><strong className="amt-in">{money(l.expected_profit)}</strong></div>
            {l.closed_on && <div><span>Closed on</span><strong>{fmtDate(l.closed_on)}</strong></div>}
          </div>
          {l.notes && <p className="note-box">{l.notes}</p>}
        </Card>

        <Card title="Actions">
          <div className="btn-row">
            {l.status === 'active' && <button className="btn" disabled={busy} onClick={() => setStatus('closed')}>Settle / close now</button>}
            {l.status === 'active' && <button className="btn btn-danger-outline" disabled={busy} onClick={() => setStatus('defaulted')}>Mark defaulted</button>}
            {l.status !== 'active' && <button className="btn" disabled={busy} onClick={() => setStatus('active')}>Re-open as active</button>}
            {l.status !== 'cancelled' && <button className="btn btn-danger-outline" disabled={busy} onClick={() => setStatus('cancelled')}>Cancel loan</button>}
            <button className="btn btn-danger" disabled={busy} onClick={deleteLoan}>Delete loan</button>
          </div>
          <p className="muted small">Loans close automatically when the full amount is collected. Deleting removes all its entries from every report.</p>
        </Card>
      </div>

      {modal === 'rep' && (
        <EntryModal
          title={`Take payment · पैसे लिए — ${l.borrower_name}`}
          table="loan_repayments"
          loanId={id}
          defaultAmount={Math.min(toNum(l.daily_installment), outstanding) || ''}
          max={outstanding}
          daily={toNum(l.daily_installment)}
          collected={l.collected_cash}
          startDate={l.collection_start_date}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'disb' && (
        <EntryModal
          title={`Give money — ${l.borrower_name}`}
          table="loan_disbursements"
          loanId={id}
          defaultAmount={pendingDisb > 0 ? pendingDisb : ''}
          max={pendingDisb}
          onClose={() => setModal(null)}
        />
      )}
      <div className="print-only muted small">Printed {fmtDateShort(today)}</div>
    </>
  );
}
