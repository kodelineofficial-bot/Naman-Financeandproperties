import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, ErrorBox, Loading, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import { getOpeningOn } from '../lib/api.js';
import {
  addDays, downloadCSV, fmtDate, fmtWeekday, money, monthStart, round2, sum, toNum, todayStr,
} from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

const COLS = [
  { key: 'collections', label: 'Collection', dir: 'in' },
  { key: 'penalties', label: 'Penalty', dir: 'in' },
  { key: 'advances_kept', label: 'Advance kept', dir: 'in' },
  { key: 'capital_in', label: 'Cash in', dir: 'in' },
  { key: 'disbursements', label: 'Loan given', dir: 'out' },
  { key: 'expenses', label: 'Expenses', dir: 'out' },
  { key: 'salaries', label: 'Salary', dir: 'out' },
  { key: 'employee_advances', label: 'Staff adv.', dir: 'out' },
  { key: 'capital_out', label: 'Cash out', dir: 'out' },
];

/** Broad day-wise view (दिन वार): one line per day for a date range, with running cash balance. */
export default function DailySummary() {
  const navigate = useNavigate();
  const today = todayStr();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [hideEmpty, setHideEmpty] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    const [opening, rows] = await Promise.all([
      getOpeningOn(from),
      q(supabase.from('daily_cashflow').select('*').gte('entry_date', from).lte('entry_date', to).order('entry_date')),
    ]);
    // Fill every calendar day so the owner sees blank days too.
    const map = Object.fromEntries(rows.map((r) => [r.entry_date, r]));
    const days = [];
    let bal = opening;
    let d = from;
    let guard = 0;
    while (d <= to && guard < 1000) {
      const r = map[d];
      const open = bal;
      if (r) bal = toNum(r.closing_balance);
      days.push({
        date: d,
        opening: open,
        ...(r || {}),
        total_in: toNum(r?.total_in),
        total_out: toNum(r?.total_out),
        net: toNum(r?.net),
        closing: round2(bal),
        empty: !r,
      });
      d = addDays(d, 1);
      guard++;
    }
    return { opening, days };
  }, [from, to]);

  const days = (data?.days || []).filter((d) => !hideEmpty || !d.empty);
  const all = data?.days || [];
  const closing = all.length ? all[all.length - 1].closing : data?.opening ?? 0;

  function quick(range) {
    if (range === 'month') { setFrom(monthStart(today)); setTo(today); }
    if (range === 'last7') { setFrom(addDays(today, -6)); setTo(today); }
    if (range === 'last30') { setFrom(addDays(today, -29)); setTo(today); }
    if (range === 'prevMonth') {
      const pm = monthStart(addDays(monthStart(today), -1));
      setFrom(pm); setTo(addDays(monthStart(today), -1));
    }
  }

  return (
    <>
      <PageHeader title="Daily Summary" hindi="दिन वार हिसाब" subtitle="Broad view — one line per day. Click a day to open its full Day Book.">
        <button
          className="btn"
          disabled={!days.length}
          onClick={() =>
            downloadCSV(`daily-summary-${from}-to-${to}.csv`, days, [
              { key: 'date', label: 'Date' },
              { key: 'opening', label: 'Opening' },
              ...COLS.map((c) => ({ key: c.key, label: c.label, value: (r) => toNum(r[c.key]) })),
              { key: 'total_in', label: 'Total in' },
              { key: 'total_out', label: 'Total out' },
              { key: 'closing', label: 'Closing' },
            ])
          }
        >
          ⬇ Excel
        </button>
        <PrintButton />
      </PageHeader>

      <Card>
        <div className="filters">
          <label>From <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => quick('last7')}>Last 7 days</button>
            <button className="btn btn-sm" onClick={() => quick('month')}>This month</button>
            <button className="btn btn-sm" onClick={() => quick('prevMonth')}>Last month</button>
            <button className="btn btn-sm" onClick={() => quick('last30')}>Last 30 days</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide days with no entries
          </label>
        </div>
      </Card>

      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label="Opening" value={money(data.opening)} />
            <Stat label="Total in" value={money(sum(all, 'total_in'))} tone="green" hint={`Collections ${money(sum(all, 'collections'))}`} />
            <Stat label="Total out" value={money(sum(all, 'total_out'))} tone="red" hint={`Loans given ${money(sum(all, 'disbursements'))}`} />
            <Stat label="Closing" value={money(closing)} tone="gold" />
          </div>

          <Card flush>
            <div className="table-wrap">
              <table className="table table-dense">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Opening</th>
                    {COLS.map((c) => <th key={c.key} className="num">{c.label}</th>)}
                    <th className="num">Total in</th>
                    <th className="num">Total out</th>
                    <th className="num">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date} className={`clickable ${d.empty ? 'row-empty' : ''} ${d.date === today ? 'row-today' : ''}`} onClick={() => navigate(`/daybook?date=${d.date}`)}>
                      <td className="nowrap">
                        <strong>{fmtDate(d.date)}</strong>
                        <div className="muted small">{fmtWeekday(d.date)}</div>
                      </td>
                      <td className="num muted">{money(d.opening)}</td>
                      {COLS.map((c) => (
                        <td key={c.key} className={`num ${toNum(d[c.key]) ? (c.dir === 'in' ? 'amt-in' : 'amt-out') : 'muted'}`}>
                          {toNum(d[c.key]) ? money(d[c.key]) : '—'}
                        </td>
                      ))}
                      <td className="num amt-in">{d.total_in ? money(d.total_in) : '—'}</td>
                      <td className="num amt-out">{d.total_out ? money(d.total_out) : '—'}</td>
                      <td className="num"><strong>{money(d.closing)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td />
                    {COLS.map((c) => <td key={c.key} className="num">{money(sum(all, c.key))}</td>)}
                    <td className="num">{money(sum(all, 'total_in'))}</td>
                    <td className="num">{money(sum(all, 'total_out'))}</td>
                    <td className="num">{money(closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
