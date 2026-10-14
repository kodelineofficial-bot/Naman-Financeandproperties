import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, Empty, ErrorBox, ExportButton, Field, Loading, Modal, ModeSelect, PageHeader, PrintButton, Progress, Stat, StatusBadge } from '../../components/ui.jsx';
import KhataCalendar from '../../components/KhataCalendar.jsx';
import WhatsAppButton from '../../components/WhatsAppButton.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import {
  fmtDate, fmtDateLong, fmtDateShort, modeLabel, money, round2, sum, toNum, todayStr,
} from '../../lib/format.js';
import { FREQ, buildLoanCalendar, freqOf, periodDate, periodsText } from '../../lib/loanMath.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

function EntryModal({ title, table, loanId, defaultAmount, max, daily, freq = 'daily', collected, startDate, onClose }) {
  const F = FREQ[freq] || FREQ.daily;
  const quick = freq === 'monthly' ? [1, 2, 3, 6, 12] : [1, 2, 3, 4, 7, 10, 15, 30];
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ paid_on: todayStr(), amount: defaultAmount ? String(defaultAmount) : '', mode: 'cash', note: '' });

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    if (f.paid_on > todayStr()) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
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
          <Field label="Date money came · पैसा किस दिन मिला" hint="Not the 'paid till' date — the days buttons below decide that">
            <input type="date" required max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Amount (₹) · रकम" hint={daily ? periodsText(f.amount, daily, freq) : undefined}>
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" required autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          {daily > 0 && (
            <div className="span-2 quick-days">
              <span className="field-label">{freq === 'monthly' ? 'How many months is this payment for? · कितने महीने का?' : 'How many days is this payment for? · कितने दिन का?'}</span>
              <div className="btn-row">
                {quick.map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={`btn btn-sm ${round2(f.amount) === round2(n * daily) ? 'btn-primary' : ''}`}
                    onClick={() => setF({ ...f, amount: String(round2(Math.min(n * daily, max ?? Infinity))) })}
                  >
                    {n} {n === 1 ? F.unit : F.units}
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
                      <>After saving, paid till · यहाँ तक जमा: <strong>{fmtDateLong(periodDate(freq, startDate, full))}</strong></>
                    ) : (
                      freq === 'monthly' ? 'Not a full month yet · अभी पूरा महीना नहीं' : 'Not a full day yet · अभी पूरा दिन नहीं'
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

function PenaltyModal({ kind, loanId, due, borrower, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ paid_on: todayStr(), amount: due > 0 ? String(due) : '', mode: 'cash', note: '' });
  const paid = kind === 'paid';

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    if (f.paid_on > todayStr()) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    if (amount > due + 0.001 && !window.confirm(`This is more than the penalty due (${money(due)}). Save anyway?`)) return;
    const ok = await run(
      () =>
        q(
          supabase.from('loan_penalty_entries').insert({
            loan_id: loanId, kind, paid_on: f.paid_on, amount, mode: paid ? f.mode : 'waiver', note: f.note.trim() || null,
          }),
        ),
      paid ? `Penalty ${money(amount)} received` : `Penalty ${money(amount)} waived`,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={`${paid ? 'Take penalty · जुर्माना लिया' : 'Waive penalty · माफ़ करें'} — ${borrower}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label={paid ? 'Date money came' : 'Date'}>
            <input type="date" max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Amount (₹)" hint={`Penalty due: ${money(due)}`}>
            <input type="number" min="0" step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
          </Field>
          {paid && <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>}
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={paid ? '' : 'Reason (optional)'} /></Field>
        </div>
        {!paid && <p className="muted small">A waiver is not cash — it only lowers the penalty due.</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function TxnTable({ rows, onDelete, empty, daily, freq }) {
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
                {daily > 0 && <div className="muted small">{periodsText(r.amount, daily, freq)}</div>}
              </td>
              <td>{r.mode === 'advance' ? <span className="badge">Advance kept</span> : modeLabel(r.mode)}</td>
              <td className="muted">{r.note || ''}</td>
              <td className="num">
                {r.mode === 'advance' ? (
                  <span className="muted small" title="Kept at loan time — change it from Edit terms">🔒</span>
                ) : r.mode === 'renewal' ? (
                  <span className="muted small" title="Part of a renewal — cannot be deleted here">🔒</span>
                ) : (
                  <button className="icon-btn danger" title="Delete" onClick={() => onDelete(r)}>🗑</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleState({ r }) {
  if (r.byAdvance) return <span className="pill pill-blue">✓ Advance</span>;
  if (r.state === 'paid' || r.state === 'advance') return <span className="pill pill-green">✓ Paid</span>;
  if (r.state === 'partial') return <span className="pill pill-red">½ Part paid</span>;
  if (r.state === 'missed') return <span className="pill pill-red">✗ Not paid</span>;
  return <span className="muted small">Upcoming</span>;
}

export default function LoanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [modal, setModal] = useState(null);
  const today = todayStr();
  const { settings } = useSettings();

  const { data, loading, error } = useLoad(async () => {
    const [loan, disb, reps, link, renewedInto, penalties] = await Promise.all([
      q(supabase.from('loan_summary').select('*').eq('id', id).single()),
      q(supabase.from('loan_disbursements').select('*').eq('loan_id', id).order('paid_on', { ascending: false }).order('created_at', { ascending: false })),
      q(supabase.from('loan_repayments').select('*').eq('loan_id', id).order('paid_on', { ascending: false }).order('created_at', { ascending: false })),
      q(supabase.from('loans').select('renewed_from, penalty_per_day, from:renewed_from(loan_no)').eq('id', id).single()),
      q(supabase.from('loans').select('id,loan_no,loan_date').eq('renewed_from', id)),
      q(supabase.from('loan_penalty_entries').select('*').eq('loan_id', id).order('paid_on', { ascending: false }).order('created_at', { ascending: false })),
    ]);
    return { loan, disb, reps, renewedFrom: link.renewed_from ? { id: link.renewed_from, loan_no: link.from?.loan_no } : null, renewedInto, penalties, ownPenaltyRate: link.penalty_per_day };
  }, [id]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error || new Error('Loan not found')} />;

  const { loan: l, disb, reps, renewedFrom, renewedInto, penalties } = data;
  const renewAdjusted = sum(reps.filter((r) => r.mode === 'renewal'), 'amount');
  const isRunning = l.status === 'active' || l.status === 'defaulted';
  const F = freqOf(l);
  const monthly = l.frequency === 'monthly';
  const inst = toNum(l.daily_installment);
  const cal = buildLoanCalendar(l, reps, today);
  // The advance kept at loan time is part of what the borrower paid, so it is shown in the
  // history too — dated with the first cash payout, the same day the cash book shows it.
  const firstPayout = disb
    .filter((x) => x.mode !== 'renewal')
    .sort((a, b) => (a.paid_on + a.created_at).localeCompare(b.paid_on + b.created_at))[0];
  const advanceRow = toNum(l.advance_amount) > 0
    ? {
        id: 'advance',
        paid_on: firstPayout?.paid_on || l.loan_date,
        created_at: '',
        amount: toNum(l.advance_amount),
        mode: 'advance',
        note: `Advance kept at loan time (${l.advance_days} ${l.advance_days === 1 ? F.unit : F.units})`,
      }
    : null;
  const repRows = advanceRow ? [...reps, advanceRow] : reps;
  const missedDays = cal.counts.missed;
  const pendingDisb = toNum(l.pending_disbursement);
  const outstanding = toNum(l.outstanding);
  const penaltyDue = toNum(l.penalty_due);
  // A penalty amount typed on the loan itself applies even when the Settings switch is off.
  const ownPenalty = data.ownPenaltyRate != null;
  const penaltyOn = settings?.penalty_enabled || (ownPenalty && toNum(data.ownPenaltyRate) > 0);
  const penaltyStartDay = toNum(settings?.penalty_grace_days) + 2;

  async function togglePenaltyOff() {
    const off = !l.penalty_off;
    if (!window.confirm(off ? 'Stop penalty for this loan? Penalty not yet received will not be shown.' : 'Start charging penalty on this loan again?')) return;
    await run(() => q(supabase.from('loans').update({ penalty_off: off }).eq('id', id)), off ? 'No penalty on this loan' : 'Penalty on for this loan');
  }

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
    if (!window.confirm(`Delete loan #${l.loan_no} with ALL its ${disb.length + reps.length} entries? This cannot be undone.` + (renewedFrom ? `

Old loan #${renewedFrom.loan_no} will become running again.` : ''))) return;
    const ok = await run(async () => {
      await q(supabase.from('loans').delete().eq('id', id));
      if (renewedFrom) {
        // Undo the renewal: remove the adjustment on the old loan and put it back to running.
        await q(
          supabase.from('loan_repayments').delete()
            .eq('loan_id', renewedFrom.id).eq('mode', 'renewal').eq('note', `Adjusted in new loan #${l.loan_no}`),
        );
        await q(supabase.rpc('recalc_loan_status', { p_loan: renewedFrom.id }));
      }
    }, renewedFrom ? `Loan deleted · Loan #${renewedFrom.loan_no} is running again` : 'Loan deleted');
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
        <WhatsAppButton loan={l} />
        {isRunning && (
          <Link className="btn" to={`/loans/new?renew=${id}`}>🔁 Renew · नया loan</Link>
        )}
        <Link className="btn" to={`/borrowers/${l.borrower_id}`}>Borrower</Link>
        <Link className="btn" to={`/loans/${id}/edit`}>Edit terms</Link>
        <ExportButton
          filename={`loan-${l.loan_no}-${l.borrower_name}.csv`}
          rows={[
            ...disb.map((r) => ({ ...r, kind: 'Given (diya)' })),
            ...repRows.map((r) => ({ ...r, kind: r.mode === 'advance' ? 'Advance kept (liya)' : 'Received (liya)' })),
          ].sort((a, b) => (a.paid_on + a.created_at).localeCompare(b.paid_on + b.created_at))}
          columns={[
            { label: 'Date', key: 'paid_on' }, { label: 'Type', key: 'kind' }, { label: 'Amount', key: 'amount' },
            { label: monthly ? 'Months' : 'Days', value: (r) => (r.kind.startsWith('Given') ? '' : periodsText(r.amount, inst, l.frequency).split(' ·')[0]) },
            { label: 'Mode', value: (r) => modeLabel(r.mode) }, { label: 'Note', key: 'note' },
          ]}
        />
        <PrintButton />
      </PageHeader>
      <ErrorBox error={error} />

      {renewedInto.length > 0 && (
        <div className="help-box renew-box">
          🔁 <strong>This loan was renewed</strong> on {fmtDateLong(l.closed_on)} into{' '}
          {renewedInto.map((n, i) => (
            <span key={n.id}>{i > 0 && ', '}<Link to={`/loans/${n.id}`}><strong>Loan #{n.loan_no}</strong></Link></span>
          ))}
          . Balance adjusted: <strong>{money(renewAdjusted)}</strong>
          {l.status === 'renewed' && outstanding > 0 && <> · Discount given (छूट): <strong>{money(outstanding)}</strong></>}
        </div>
      )}
      {renewedFrom && (
        <div className="help-box renew-box">
          🔁 Renewed from <Link to={`/loans/${renewedFrom.id}`}><strong>Loan #{renewedFrom.loan_no}</strong></Link>.
          Old balance adjusted from this loan: <strong>{money(sum(disb.filter((d) => d.mode === 'renewal'), 'amount'))}</strong> (no cash).
        </div>
      )}

      <div className="stats">
        <Stat label="Balance · बाकी" value={money(l.status === 'renewed' ? 0 : outstanding)} tone="gold" hint={l.status === 'renewed' ? 'Renewed — moved to new loan' : `${l.installments_left} installments left`} />
        <Stat label="Collected · जमा" value={money(l.collected_total)} tone="green" hint={`incl. ${money(l.advance_amount)} advance`} />
        <Stat label="Overdue · बकाया" value={money(l.overdue)} tone={toNum(l.overdue) > 0 ? 'red' : undefined} hint={`${missedDays} missed ${missedDays === 1 ? F.unit : F.units}` + (penaltyDue > 0 ? ` · + ${money(penaltyDue)} penalty` : '')} />
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
          <span className="muted"> · Collection {fmtDateLong(l.collection_start_date)} → {fmtDateLong(l.expected_end_date)} ({cal.nDays} {F.units})</span>
        </div>
      </Card>

      {monthly ? (
        <Card
          title="Monthly schedule · मासिक किस्त"
          actions={<span className="muted small">{cal.nDays} months{toNum(l.advance_amount) > 0 ? ` · first ${Math.floor(toNum(l.advance_amount) / inst + 1e-9)} paid by advance` : ''}</span>}
          flush
        >
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Due date</th><th className="num">Installment</th><th className="num">Covered</th><th className="num">Short</th><th className="num">Cash received</th><th>Status</th></tr>
              </thead>
              <tbody>
                {cal.schedule.map((r) => {
                  const short = round2(r.due - r.covered);
                  return (
                    <tr key={r.n}>
                      <td className="muted">{r.n}</td>
                      <td className="nowrap">{fmtDateLong(r.date)}</td>
                      <td className="num">{money(r.due)}</td>
                      <td className="num">{money(r.covered)}</td>
                      <td className={`num ${short > 0 && r.date <= today ? 'amt-out' : 'muted'}`}>{short > 0 ? money(short) : '—'}</td>
                      <td className="num">{r.received ? money(r.received) : '—'}</td>
                      <td><ScheduleState r={r} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-sub muted small">Payments fill the months in order. Whatever is short is due with the next installment.</div>
        </Card>
      ) : (
        <Card title="Khata calendar · रोज़ का हिसाब" actions={<span className="muted small">{cal.nDays} days{toNum(l.advance_amount) > 0 ? ` · first ${Math.floor(toNum(l.advance_amount) / inst + 1e-9)} paid by advance` : ''}</span>}>
          <KhataCalendar cal={cal} today={today} />
        </Card>
      )}

      <div className="grid-2">
        <Card
          title={`Collections · जमा (${repRows.length})`}
          actions={
            <button className="btn btn-primary btn-sm" onClick={() => setModal('rep')}>+ Add collection</button>
          }
          flush
        >
          <div className="card-sub muted small">
            Cash collected: <strong>{money(l.collected_cash)}</strong> · Advance: <strong>{money(l.advance_amount)}</strong>
          </div>
          <TxnTable rows={repRows} daily={inst} freq={l.frequency} onDelete={(r) => del('loan_repayments', r)} empty="No collections yet." />
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

      <Card
        title="Penalty · जुर्माना"
        actions={
          <>
            <button className="btn btn-primary btn-sm" disabled={penaltyDue <= 0} onClick={() => setModal('pen-paid')}>₹ Take penalty</button>
            <button className="btn btn-sm" disabled={penaltyDue <= 0} onClick={() => setModal('pen-waived')}>Waive · माफ़</button>
            <button className="btn btn-sm" disabled={busy} onClick={togglePenaltyOff}>
              {l.penalty_off ? 'Turn penalty on' : 'No penalty for this loan'}
            </button>
          </>
        }
        flush
      >
        <div className="card-sub muted small">
          {l.penalty_off ? (
            <>Penalty is <strong>off</strong> for this loan. </>
          ) : !penaltyOn ? (
            <>Penalty is off in <Link to="/settings">Settings</Link>. </>
          ) : (
            <>{money(l.penalty_rate)} per day behind{ownPenalty ? ' (set on this loan)' : ''}, from day {penaltyStartDay} of a missed installment · </>
          )}
          Penalty days <strong>{toNum(l.penalty_days)}</strong> = <strong>{money(l.penalty_charged)}</strong>
          {' '}· Received <strong>{money(l.penalty_paid)}</strong>
          {toNum(l.penalty_waived) > 0 && <> · Waived <strong>{money(l.penalty_waived)}</strong></>}
          {' '}· Due <strong className={penaltyDue > 0 ? 'amt-out' : ''}>{money(penaltyDue)}</strong>
        </div>
        {penalties.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Type</th><th className="num">Amount</th><th>Mode</th><th>Note</th><th /></tr>
              </thead>
              <tbody>
                {penalties.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDate(r.paid_on)}</td>
                    <td>{r.kind === 'paid' ? 'Received' : 'Waived (माफ़)'}</td>
                    <td className="num"><strong>{money(r.amount)}</strong></td>
                    <td>{r.kind === 'paid' ? modeLabel(r.mode) : '—'}</td>
                    <td className="muted">{r.note || ''}</td>
                    <td className="num">
                      <button className="icon-btn danger" title="Delete" onClick={() => del('loan_penalty_entries', r)}>🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Loan terms · शर्तें">
          <div className="kv-list">
            <div><span>Loan date</span><strong>{fmtDate(l.loan_date)}</strong></div>
            <div><span>Loan amount (principal)</span><strong>{money(l.principal)}</strong></div>
            <div><span>Interest cut upfront ({toNum(l.interest_pct)}%)</span><strong>{money(l.interest_amount)}</strong></div>
            <div><span>Loan given (cash out)</span><strong className="amt-out">{money(toNum(l.principal) - toNum(l.interest_amount))}</strong></div>
            <div><span>Advance kept ({l.advance_days} {F.units}) · income</span><strong className="amt-in">{money(l.advance_amount)}</strong></div>
            <div className="kv-total"><span>Net cash to hand over</span><strong>{money(l.net_disbursable)}</strong></div>
            <div><span>Loan type</span><strong>{F.label} · {F.hi}</strong></div>
            <div><span>{F.label} installment</span><strong>{money(l.daily_installment)}{F.per}</strong></div>
            <div><span>Total repayable ({l.duration_days} {F.units})</span><strong>{money(l.total_repayable)}</strong></div>
            {l.next_due_date && isRunning && <div><span>Next installment</span><strong>{fmtDateLong(l.next_due_date)}</strong></div>}
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
            {l.status !== 'active' && l.status !== 'renewed' && <button className="btn" disabled={busy} onClick={() => setStatus('active')}>Re-open as active</button>}
            {isRunning && <Link className="btn" to={`/loans/new?renew=${id}`}>🔁 Renew · नया loan</Link>}
            {l.status !== 'cancelled' && l.status !== 'renewed' && <button className="btn btn-danger-outline" disabled={busy} onClick={() => setStatus('cancelled')}>Cancel loan</button>}
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
          // Due now = this installment + anything short from before (it carries forward).
          defaultAmount={Math.min(toNum(l.overdue) > 0 ? toNum(l.overdue) : inst, outstanding) || ''}
          max={outstanding}
          daily={inst}
          freq={l.frequency}
          collected={l.collected_total}
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
      {(modal === 'pen-paid' || modal === 'pen-waived') && (
        <PenaltyModal
          kind={modal === 'pen-paid' ? 'paid' : 'waived'}
          loanId={id}
          due={penaltyDue}
          borrower={l.borrower_name}
          onClose={() => setModal(null)}
        />
      )}
      <div className="print-only muted small">Printed {fmtDateShort(today)}</div>
    </>
  );
}
