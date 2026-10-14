import { Link, useSearchParams } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import { Amount, Card, Empty, ErrorBox, ExportButton, Loading, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import { deleteLedgerEntry, getLedger, getOpeningOn } from '../lib/api.js';
import { LEDGER_KINDS, addDays, fmtDateFull, modeLabel, money, round2, sum, toNum, todayStr } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

const LINK_FOR = {
  disbursement: (r) => `/loans/${r.ref_id}`,
  collection: (r) => `/loans/${r.ref_id}`,
  penalty: (r) => `/loans/${r.ref_id}`,
  loan_advance: (r) => `/loans/${r.ref_id}`,
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
                <td className="num"><Amount value={r.amount} dir={r.direction} /></td>
                <td className="num no-print">
                  {/* Advance kept is part of the loan itself — change it from the loan, not here. */}
                  {r.kind !== 'loan_advance' && (
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

/** Day Book (रोज़नामचा): full detail of one day — opening, every in/out, closing, who didn't pay. */
export default function DayBook() {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || todayStr();
  const setDate = (d) => setParams({ date: d }, { replace: true });

  const { data, loading, error } = useLoad(async () => {
    const [opening, entries, newLoans, sheet] = await Promise.all([
      getOpeningOn(date),
      getLedger(date, date),
      q(
        supabase
          .from('loan_summary')
          .select('id,loan_no,borrower_name,principal,interest_amount,advance_amount,net_disbursable,disbursed')
          .eq('loan_date', date)
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
    return { opening, entries, newLoans, missed };
  }, [date]);

  async function onDelete(r) {
    if (!window.confirm(`Delete this ${LEDGER_KINDS[r.kind]?.short} entry of ${money(r.amount)}?`)) return;
    await run(() => deleteLedgerEntry(r), 'Entry deleted');
  }

  const entries = data?.entries || [];
  const ins = entries.filter((e) => e.direction === 'in');
  const outs = entries.filter((e) => e.direction === 'out');
  const totalIn = sum(ins, 'amount');
  const totalOut = sum(outs, 'amount');
  const opening = data?.opening ?? 0;
  const closing = round2(opening + totalIn - totalOut);

  const byKind = {};
  for (const e of entries) byKind[e.kind] = round2((byKind[e.kind] || 0) + toNum(e.amount));

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
            { label: 'In', value: (r) => (r.direction === 'in' ? r.amount : '') }, { label: 'Out', value: (r) => (r.direction === 'out' ? r.amount : '') },
          ]}
        />
        <PrintButton />
      </PageHeader>
      <ErrorBox error={error} />

      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label="Opening cash · शुरुआती" value={money(opening)} />
            <Stat label="Total in · आया" value={money(totalIn)} tone="green" hint={`${ins.length} entries`} />
            <Stat label="Total out · गया" value={money(totalOut)} tone="red" hint={`${outs.length} entries`} />
            <Stat label="Closing cash · बाकी" value={money(closing)} tone="gold" />
          </div>

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

          <div className="grid-2">
            <Card title={`Money in · जमा (${ins.length})`} flush actions={<strong className="amt-in">{money(totalIn)}</strong>}>
              <LedgerTable rows={ins} onDelete={busy ? () => {} : onDelete} />
            </Card>
            <Card title={`Money out · नाम (${outs.length})`} flush actions={<strong className="amt-out">{money(totalOut)}</strong>}>
              <LedgerTable rows={outs} onDelete={busy ? () => {} : onDelete} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title={`New loans this day (${data.newLoans.length})`} flush>
              {data.newLoans.length === 0 ? (
                <Empty>No new loan on this day.</Empty>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Loan</th><th className="num">Principal</th><th className="num">Interest cut</th><th className="num">Loan given</th><th className="num">Advance in</th><th className="num">Handed over</th></tr>
                  </thead>
                  <tbody>
                    {data.newLoans.map((l) => (
                      <tr key={l.id}>
                        <td><Link to={`/loans/${l.id}`}>#{l.loan_no} {l.borrower_name}</Link></td>
                        <td className="num">{money(l.principal)}</td>
                        <td className="num amt-in">{money(l.interest_amount)}</td>
                        <td className="num amt-out">{money(toNum(l.principal) - toNum(l.interest_amount))}</td>
                        <td className="num amt-in">{money(l.advance_amount)}</td>
                        <td className="num">{money(l.net_disbursable)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">{money(sum(data.newLoans, 'principal'))}</td>
                      <td className="num">{money(sum(data.newLoans, 'interest_amount'))}</td>
                      <td className="num">{money(sum(data.newLoans, (l) => toNum(l.principal) - toNum(l.interest_amount)))}</td>
                      <td className="num">{money(sum(data.newLoans, 'advance_amount'))}</td>
                      <td className="num">{money(sum(data.newLoans, 'net_disbursable'))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </Card>

            <Card title={`Did not pay this day · नहीं दिया (${data.missed.length})`} flush>
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
            </Card>
          </div>
        </>
      )}
    </>
  );
}
