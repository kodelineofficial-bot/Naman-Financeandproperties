import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import { Amount, Card, Empty, ErrorBox, ExportButton, Loading, Modal, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import { deleteLedgerEntry, getLedger, getOpeningDetail } from '../lib/api.js';
import { LEDGER_KINDS, addDays, counted, fmtDateFull, isUpi, modeLabel, money, round2, sum, toNum, todayStr } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { displayedLedgerAmount, loanMoneyOnDate } from '../lib/ledgerAmounts.js';
import { q, supabase } from '../lib/supabase.js';

const LINK_FOR = {
  disbursement: (r) => `/loans/${r.ref_id}`,
  collection: (r) => `/loans/${r.ref_id}`,
  penalty: (r) => `/loans/${r.ref_id}`,
  loan_advance: (r) => `/loans/${r.ref_id}`,
  loan_advance_cut: (r) => `/loans/${r.ref_id}`,
  salary: (r) => `/employees/${r.ref_id}`,
  employee_advance: (r) => `/employees/${r.ref_id}`,
};

function LedgerTable({ rows, onDelete }) {
  if (!rows.length) return <Empty>No entries.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Type</th><th>Party / Details</th><th>Mode</th><th className="num">Amount</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const link = LINK_FOR[r.kind]?.(r);
            return (
              <tr key={r.kind + r.id}>
                <td className="nowrap">{LEDGER_KINDS[r.kind]?.short || r.kind}</td>
                <td>
                  {link && r.ref_id ? <Link to={link}>{r.party}</Link> : r.party}
                  {r.note && <div className="muted small">{r.note}</div>}
                </td>
                <td>{modeLabel(r.mode)}</td>
                <td className={`num ${isUpi(r) ? 'muted' : ''}`}>
                  {isUpi(r) ? money(displayedLedgerAmount(r)) : <Amount value={displayedLedgerAmount(r)} dir={r.direction} />}
                  {!isUpi(r) && r.advance_included > 0 && (
                    <div className="muted small">
                      Includes {money(r.advance_included)} advance<br />Handed over {money(r.handed_over)}
                    </div>
                  )}
                </td>
                <td className="num no-print">
                  {/* Advance kept and overdue cuts are part of the loan itself — change them from the loan, not here. */}
                  {!['loan_advance', 'loan_advance_cut'].includes(r.kind) && r.mode !== 'renewal' && (
                    <button className="icon-btn danger" title="Delete entry" onClick={() => onDelete(r)}>🗑</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A card that opens in a big popup when tapped (links inside still open the loan). */
function TapCard({ title, bigTitle, children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="card-tap" onClick={(e) => !e.target.closest('a') && setOpen(true)}>
        <Card title={title} flush actions={<button type="button" className="btn btn-sm">⤢ Open big</button>}>
          {children}
        </Card>
      </div>
      {open && (
        <Modal full title={bigTitle || title} onClose={() => setOpen(false)}>
          <div className="big-table">{children}</div>
        </Modal>
      )}
    </>
  );
}

/** One side of the UPI card: amount per type (Collection, Loan given, …) and the side's total. */
function UpiSide({ title, rows, total, dir }) {
  const byKind = {};
  for (const r of rows) byKind[r.kind] = round2((byKind[r.kind] || 0) + displayedLedgerAmount(r));
  return (
    <div>
      <h3 className="upi-side-title">{title} ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <table className="table">
          <tbody>
            {Object.entries(byKind).map(([k, v]) => (
              <tr key={k}>
                <td>{LEDGER_KINDS[k]?.label || k}</td>
                <td className="num"><Amount value={v} dir={dir} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Total</td><td className="num"><Amount value={total} dir={dir} /></td></tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

/**
 * Cash counted in the drawer at the start of one day (migration 030). It becomes that day's
 * opening; days before it keep their own opening and closing.
 */
function CashCountForm({ date, detail, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [amount, setAmount] = useState(detail.counted != null ? String(detail.counted) : '');
  const [note, setNote] = useState('');
  const diff = amount === '' ? 0 : round2(toNum(amount) - detail.expected);

  async function submit(e) {
    e.preventDefault();
    if (amount === '' || toNum(amount) < 0) return toast.error('Enter the cash counted.');
    const ok = await run(
      () => q(supabase.from('cash_counts').upsert({
        count_date: date, amount: round2(amount), note: note.trim() || null, updated_at: new Date().toISOString(),
      })),
      'Cash count saved',
    );
    if (ok) onClose();
  }

  async function remove() {
    if (!window.confirm(`Remove the cash count of ${fmtDateFull(date)}? The opening goes back to ${money(detail.expected)}.`)) return;
    const ok = await run(() => q(supabase.from('cash_counts').delete().eq('count_date', date)), 'Cash count removed');
    if (ok) onClose();
  }

  return (
    <Modal title={`Count cash · कैश गिनती — ${fmtDateFull(date)}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted small">
          Cash in the drawer at the start of this day, before any entry. It becomes this day's opening and the days after
          follow from it. Earlier days do not change.
        </p>
        <div className="form-grid">
          <Field label="Cash counted (₹)" hint={`System says ${money(detail.expected)} (closing of the day before)`}>
            <input type="number" min="0" step="any" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it differs, if it does" /></Field>
        </div>
        {amount !== '' && diff !== 0 && (
          <div className="note-box small">
            Difference: <strong className={diff < 0 ? 'amt-out' : 'amt-in'}>{diff > 0 ? '+' : ''}{money(diff)}</strong>{' '}
            ({diff < 0 ? 'less' : 'more'} cash than the system). It stays visible on this day.
          </div>
        )}
        <div className="form-actions">
          {detail.counted != null && <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={remove}>Remove count</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Day Book (रोज़नामचा): full detail of one day — opening, every in/out, closing, who didn't pay. */
export default function DayBook() {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || todayStr();
  const setDate = (d) => setParams({ date: d }, { replace: true });
  const [counting, setCounting] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    const [openingDetail, entries, newLoans, sheet] = await Promise.all([
      getOpeningDetail(date),
      getLedger(date, date),
      q(
        supabase
          .from('loan_summary')
          .select('id,loan_no,borrower_name,principal,interest_amount,advance_amount,net_disbursable,disbursed')
          .eq('loan_date', date)
          .eq('old_defaulter', false)
          .neq('status', 'cancelled'),
      ),
      q(supabase.rpc('collection_sheet', { p_date: date })),
    ]);
    // Did not pay = nothing paid this day AND not already covered in advance up to this day.
    // A monthly loan only counts when an installment (or an old shortfall) is due by this day.
    const missed = sheet.filter(
      (l) => toNum(l.paid_on_date) === 0 && toNum(l.balance_upto) > 0 &&
        (l.frequency === 'monthly' ? toNum(l.short_upto) > 0 : !l.paid_till || l.paid_till < date),
    );
    return {
      opening: openingDetail.opening, openingDetail, entries,
      newLoans: newLoans.map((l) => ({ ...l, ...loanMoneyOnDate(entries, l.id) })), missed,
    };
  }, [date]);

  async function onDelete(r) {
    if (!window.confirm(`Delete this ${LEDGER_KINDS[r.kind]?.short} entry of ${money(r.amount)}?`)) return;
    await run(() => deleteLedgerEntry(r), 'Entry deleted');
  }

  const entries = data?.entries || [];
  const ins = entries.filter((e) => e.direction === 'in');
  const outs = entries.filter((e) => e.direction === 'out');
  const totalIn = sum(counted(ins), 'amount');
  const totalOut = sum(counted(outs), 'amount');
  // UPI rows show the actual transfer, so their totals use the same amount as the table.
  const upiIns = ins.filter(isUpi);
  const upiOuts = outs.filter(isUpi);
  const upiIn = sum(upiIns, displayedLedgerAmount);
  const upiOut = sum(upiOuts, displayedLedgerAmount);
  const opening = data?.opening ?? 0;
  const closing = round2(opening + totalIn - totalOut);

  const byKind = {};
  for (const e of counted(entries)) byKind[e.kind] = round2((byKind[e.kind] || 0) + toNum(e.amount));

  return (
    <>
      <PageHeader title="Day Book" hindi="रोज़नामचा" subtitle={`${fmtDateFull(date)} — full detail of the day`}>
        <div className="date-nav">
          <button className="btn btn-sm" onClick={() => setDate(addDays(date, -1))}>‹ Prev</button>
          <input type="date" value={date} max={todayStr()} onChange={(e) => e.target.value && e.target.value <= todayStr() && setDate(e.target.value)} />
          <button className="btn btn-sm" disabled={date >= todayStr()} onClick={() => setDate(addDays(date, 1))}>Next ›</button>
          {date !== todayStr() && <button className="btn btn-sm" onClick={() => setDate(todayStr())}>Today</button>}
        </div>
        <ExportButton
          filename={`daybook-${date}.csv`}
          rows={data?.entries}
          columns={[
            { label: 'Date', key: 'entry_date' }, { label: 'Type', value: (r) => LEDGER_KINDS[r.kind]?.short || r.kind },
            { label: 'Party / Details', key: 'party' }, { label: 'Note', key: 'note' }, { label: 'Mode', value: (r) => modeLabel(r.mode) },
            { label: 'In', value: (r) => (r.direction === 'in' ? r.amount : '') }, { label: 'Out', value: (r) => (r.direction === 'out' ? displayedLedgerAmount(r) : '') },
            { label: 'Actual handed over', value: (r) => r.handed_over ?? '' },
            { label: 'Advance included in out', value: (r) => r.advance_included ?? '' },
          ]}
        />
        <PrintButton />
        {data && <button className="btn btn-sm" onClick={() => setCounting(true)}>🪙 Count cash</button>}
      </PageHeader>
      {counting && data && <CashCountForm date={date} detail={data.openingDetail} onClose={() => setCounting(false)} />}
      <ErrorBox error={error} />

      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat
              label={data.openingDetail.counted != null ? 'Opening cash · गिना हुआ' : 'Opening cash · शुरुआती'}
              value={money(opening)}
              hint={data.openingDetail.counted != null
                ? `Counted. System said ${money(data.openingDetail.expected)}`
                  + (data.openingDetail.difference ? ` · difference ${data.openingDetail.difference > 0 ? '+' : ''}${money(data.openingDetail.difference)}` : ' · no difference')
                : undefined}
            />
            {/* Like the paper diary: total in = opening + today's money in. */}
            <Stat label="Total in · आया" value={money(round2(opening + totalIn))} tone="green" hint={`Opening ${money(opening)} + today ${money(totalIn)} (${counted(ins).length} entries)`} />
            <Stat label="Total out · गया" value={money(totalOut)} tone="red" hint={`${counted(outs).length} entries`} />
            <Stat label="Closing cash · बाकी" value={money(closing)} tone="gold" />
          </div>

          {upiIns.length + upiOuts.length > 0 && (
            <Card title="UPI · not counted in cash" actions={<span className="muted small">Shown only — not in total in/out or cash in hand</span>}>
              <div className="grid-2">
                <UpiSide title="UPI in · आया" rows={upiIns} total={upiIn} dir="in" />
                <UpiSide title="UPI out · गया" rows={upiOuts} total={upiOut} dir="out" />
              </div>
              <div className="chips upi-total">
                <div className="chip"><span>Total UPI in</span><Amount value={upiIn} dir="in" /></div>
                <div className="chip"><span>Total UPI out</span><Amount value={upiOut} dir="out" /></div>
                <div className="chip"><span>Net UPI (in − out)</span><strong>{money(round2(upiIn - upiOut))}</strong></div>
              </div>
            </Card>
          )}

          <Card title="Summary of the day">
            <div className="chips">
              {Object.entries(LEDGER_KINDS).map(([k, v]) => (
                <div key={k} className={`chip ${byKind[k] ? '' : 'chip-dim'}`}>
                  <span>{v.label}</span>
                  <Amount value={byKind[k] || 0} dir={v.dir} />
                </div>
              ))}
            </div>
          </Card>

          {outs.some((r) => r.advance_included > 0) && (
            <p className="muted small">UPI shows the actual transfer. Advance withheld appears as a separate cut and matching income. Cash payouts already include that cut in book out.</p>
          )}
          <div className="grid-2">
            <Card title={`Money in · जमा (${ins.length})`} flush actions={<strong className="amt-in">{money(totalIn)}</strong>}>
              <LedgerTable rows={ins} onDelete={busy ? () => {} : onDelete} />
            </Card>
            <Card title={`Money out · नाम (${outs.length})`} flush actions={<strong className="amt-out">Book total {money(totalOut)}</strong>}>
              <LedgerTable rows={outs} onDelete={busy ? () => {} : onDelete} />
            </Card>
          </div>

          <div className="grid-2">
            <TapCard title={`New loans this day (${data.newLoans.length})`} bigTitle={`New loans · ${fmtDateFull(date)}`}>
              {data.newLoans.length === 0 ? (
                <Empty>No new loan on this day.</Empty>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Loan</th><th className="num">Principal</th><th className="num">Interest cut</th><th className="num">Loan given</th><th className="num">Advance in</th><th className="num">Old dues adjusted</th><th className="num">Handed over this day</th></tr>
                  </thead>
                  <tbody>
                    {data.newLoans.map((l) => (
                      <tr key={l.id}>
                        <td><Link to={`/loans/${l.id}`}>#{l.loan_no} {l.borrower_name}</Link></td>
                        <td className="num">{money(l.principal)}</td>
                        <td className="num amt-in">{money(l.interest_amount)}</td>
                        <td className="num amt-out">{money(toNum(l.principal) - toNum(l.interest_amount))}</td>
                        <td className="num amt-in">{money(toNum(l.advance_amount) + l.payoutAdvance)}</td>
                        <td className="num">{money(l.adjusted)}</td>
                        <td className="num">{money(l.handedOver)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">{money(sum(data.newLoans, 'principal'))}</td>
                      <td className="num">{money(sum(data.newLoans, 'interest_amount'))}</td>
                      <td className="num">{money(sum(data.newLoans, (l) => toNum(l.principal) - toNum(l.interest_amount)))}</td>
                      <td className="num">{money(sum(data.newLoans, (l) => toNum(l.advance_amount) + l.payoutAdvance))}</td>
                      <td className="num">{money(sum(data.newLoans, 'adjusted'))}</td>
                      <td className="num">{money(sum(data.newLoans, 'handedOver'))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </TapCard>

            <TapCard title={`Did not pay this day · नहीं दिया (${data.missed.length})`} bigTitle={`Did not pay · नहीं दिया · ${fmtDateFull(date)}`}>
              {data.missed.length === 0 ? (
                <Empty>Everyone paid. 🎉</Empty>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Borrower</th><th className="num">Installment</th><th className="num">Behind (as of this day)</th></tr>
                  </thead>
                  <tbody>
                    {data.missed.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/loans/${l.id}`}>{l.borrower_name}</Link>
                          <div className="muted small">#{l.loan_no} · {l.borrower_phone || '—'}</div>
                        </td>
                        <td className="num">{money(l.daily_installment)}{l.frequency === 'monthly' ? '/month' : '/day'}</td>
                        <td className="num amt-out">{money(l.short_upto)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TapCard>
          </div>
        </>
      )}
    </>
  );
}
