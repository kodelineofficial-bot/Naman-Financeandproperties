import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Amount, Card, Empty, ErrorBox, Loading, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import {
  downloadCSV, fmtMonth, fmtMonthShort, money, monthEnd, round2, sum, toNum, todayStr,
} from '../lib/format.js';
import { useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

/** Month-wise broad view (मासिक): every month of a year side by side + drill-down for one month. */
export default function Monthly() {
  const navigate = useNavigate();
  const today = todayStr();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [selected, setSelected] = useState(today.slice(0, 7) + '-01');

  const yFrom = `${year}-01-01`;
  const yTo = `${year}-12-31`;

  const { data, loading, error } = useLoad(async () => {
    const [cash, loans, prev] = await Promise.all([
      q(supabase.from('monthly_cashflow').select('*').gte('month', yFrom).lte('month', yTo).order('month')),
      q(supabase.from('loans_monthly').select('*').gte('month', yFrom).lte('month', yTo)),
      q(supabase.from('monthly_cashflow').select('closing_balance').lt('month', yFrom).order('month', { ascending: false }).limit(1)),
    ]);
    const settings = await q(supabase.from('settings').select('opening_balance').eq('id', 1).single());
    const cashMap = Object.fromEntries(cash.map((r) => [r.month, r]));
    const loanMap = Object.fromEntries(loans.map((r) => [r.month, r]));
    let bal = prev.length ? toNum(prev[0].closing_balance) : toNum(settings.opening_balance);
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}-01`;
      const c = cashMap[key] || {};
      const l = loanMap[key] || {};
      const opening = bal;
      if (cashMap[key]) bal = toNum(c.closing_balance);
      months.push({
        month: key,
        opening,
        closing: round2(bal),
        total_in: toNum(c.total_in),
        total_out: toNum(c.total_out),
        collections: toNum(c.collections),
        penalties: toNum(c.penalties),
        advances_kept: toNum(c.advances_kept),
        disbursements: toNum(c.disbursements),
        expenses: toNum(c.expenses),
        salaries: toNum(c.salaries),
        employee_advances: toNum(c.employee_advances),
        capital_in: toNum(c.capital_in),
        capital_out: toNum(c.capital_out),
        net: toNum(c.net),
        loans_count: toNum(l.loans_count),
        principal_issued: toNum(l.principal_issued),
        interest_earned: toNum(l.interest_earned),
        markup_booked: toNum(l.markup_booked),
        future: key > today,
      });
    }
    return { months };
  }, [year]);

  const detail = useLoad(async () => {
    const [cats, salary] = await Promise.all([
      q(supabase.from('expenses').select('category,amount').gte('spent_on', selected).lte('spent_on', monthEnd(selected))),
      q(supabase.rpc('salary_report', { p_month: selected })),
    ]);
    const byCat = {};
    for (const e of cats) byCat[e.category] = round2((byCat[e.category] || 0) + toNum(e.amount));
    return {
      cats: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
      salary,
    };
  }, [selected]);

  const months = data?.months || [];
  const maxBar = Math.max(1, ...months.map((m) => Math.max(m.total_in, m.total_out)));
  const sel = months.find((m) => m.month === selected);
  const businessIncome = (m) => round2(m.interest_earned + m.markup_booked);

  return (
    <>
      <PageHeader title="Monthly Report" hindi="मासिक हिसाब" subtitle="Month-wise money in, money out, new business and balance">
        <div className="date-nav">
          <button className="btn btn-sm" onClick={() => setYear(year - 1)}>‹ {year - 1}</button>
          <strong className="year">{year}</strong>
          <button className="btn btn-sm" onClick={() => setYear(year + 1)}>{year + 1} ›</button>
        </div>
        <button
          className="btn"
          disabled={!months.length}
          onClick={() =>
            downloadCSV(`monthly-${year}.csv`, months, [
              { key: 'month', label: 'Month', value: (r) => fmtMonth(r.month) },
              { key: 'opening', label: 'Opening' },
              { key: 'collections', label: 'Collections' },
              { key: 'penalties', label: 'Penalty' },
              { key: 'advances_kept', label: 'Advance kept' },
              { key: 'capital_in', label: 'Cash in' },
              { key: 'disbursements', label: 'Loans given' },
              { key: 'expenses', label: 'Expenses' },
              { key: 'salaries', label: 'Salary' },
              { key: 'employee_advances', label: 'Staff advances' },
              { key: 'capital_out', label: 'Cash out' },
              { key: 'closing', label: 'Closing' },
              { key: 'loans_count', label: 'New loans' },
              { key: 'principal_issued', label: 'Principal issued' },
              { key: 'interest_earned', label: 'Interest cut' },
              { key: 'markup_booked', label: 'Extra booked' },
            ])
          }
        >
          ⬇ Excel
        </button>
        <PrintButton />
      </PageHeader>
      <ErrorBox error={error} />

      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label={`Collections ${year}`} value={money(sum(months, 'collections'))} tone="green" hint={sum(months, 'penalties') > 0 ? `+ ${money(sum(months, 'penalties'))} penalty` : undefined} />
            <Stat label={`Loans given ${year}`} value={money(sum(months, 'disbursements'))} hint={`${sum(months, 'loans_count')} new loans`} />
            <Stat label="Expenses + salary" value={money(sum(months, (m) => m.expenses + m.salaries + m.employee_advances))} tone="red" />
            <Stat label="Interest + extra booked" value={money(sum(months, businessIncome))} tone="gold" hint="Income from loans issued this year" />
          </div>

          <Card title="Money in vs out">
            <div className="bars">
              {months.map((m) => (
                <button
                  key={m.month}
                  type="button"
                  className={`bar-group ${m.month === selected ? 'active' : ''} ${m.future ? 'future' : ''}`}
                  onClick={() => setSelected(m.month)}
                  title={`${fmtMonth(m.month)}\nIn: ${money(m.total_in)}\nOut: ${money(m.total_out)}`}
                >
                  <div className="bar-pair">
                    <div className="bar bar-in" style={{ height: `${(m.total_in / maxBar) * 100}%` }} />
                    <div className="bar bar-out" style={{ height: `${(m.total_out / maxBar) * 100}%` }} />
                  </div>
                  <span>{fmtMonthShort(m.month)}</span>
                </button>
              ))}
            </div>
            <div className="cal-legend">
              <span><i className="cal-dot st-paid" /> In</span>
              <span><i className="cal-dot st-missed" /> Out</span>
              <span className="muted small">Click a month for details</span>
            </div>
          </Card>

          <Card flush title="Month-wise table">
            <div className="table-wrap">
              <table className="table table-dense">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="num">Opening</th>
                    <th className="num">Collections</th>
                    <th className="num">Advance kept</th>
                    <th className="num">Cash in</th>
                    <th className="num">Loans given</th>
                    <th className="num">Expenses</th>
                    <th className="num">Salary + adv.</th>
                    <th className="num">Cash out</th>
                    <th className="num">Closing</th>
                    <th className="num">New loans</th>
                    <th className="num">Interest + extra</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr
                      key={m.month}
                      className={`clickable ${m.month === selected ? 'row-today' : ''} ${m.future ? 'row-empty' : ''}`}
                      onClick={() => setSelected(m.month)}
                    >
                      <td><strong>{fmtMonth(m.month)}</strong></td>
                      <td className="num muted">{money(m.opening)}</td>
                      <td className="num amt-in">{money(m.collections)}</td>
                      <td className="num amt-in">{money(m.advances_kept)}</td>
                      <td className="num">{money(m.capital_in)}</td>
                      <td className="num amt-out">{money(m.disbursements)}</td>
                      <td className="num">{money(m.expenses)}</td>
                      <td className="num">{money(m.salaries + m.employee_advances)}</td>
                      <td className="num">{money(m.capital_out)}</td>
                      <td className="num"><strong>{money(m.closing)}</strong></td>
                      <td className="num">{m.loans_count} · {money(m.principal_issued)}</td>
                      <td className="num amt-in">{money(businessIncome(m))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total {year}</td>
                    <td />
                    <td className="num">{money(sum(months, 'collections'))}</td>
                    <td className="num">{money(sum(months, 'advances_kept'))}</td>
                    <td className="num">{money(sum(months, 'capital_in'))}</td>
                    <td className="num">{money(sum(months, 'disbursements'))}</td>
                    <td className="num">{money(sum(months, 'expenses'))}</td>
                    <td className="num">{money(sum(months, (m) => m.salaries + m.employee_advances))}</td>
                    <td className="num">{money(sum(months, 'capital_out'))}</td>
                    <td className="num">{money(months.length ? months[months.length - 1].closing : 0)}</td>
                    <td className="num">{sum(months, 'loans_count')} · {money(sum(months, 'principal_issued'))}</td>
                    <td className="num">{money(sum(months, businessIncome))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {sel && (
            <div className="grid-2">
              <Card title={`${fmtMonth(sel.month)} — summary`}>
                <div className="kv-list">
                  <div><span>Opening cash</span><strong>{money(sel.opening)}</strong></div>
                  <div><span>Collections</span><Amount value={sel.collections} dir="in" /></div>
                  {sel.penalties > 0 && <div><span>Penalty received</span><Amount value={sel.penalties} dir="in" /></div>}
                  <div><span>Advance kept from new loans</span><Amount value={sel.advances_kept} dir="in" /></div>
                  <div><span>Cash added</span><Amount value={sel.capital_in} dir="in" /></div>
                  <div><span>Loans given</span><Amount value={sel.disbursements} dir="out" /></div>
                  <div><span>Expenses</span><Amount value={sel.expenses} dir="out" /></div>
                  <div><span>Salary paid</span><Amount value={sel.salaries} dir="out" /></div>
                  <div><span>Staff advances</span><Amount value={sel.employee_advances} dir="out" /></div>
                  <div><span>Cash withdrawn</span><Amount value={sel.capital_out} dir="out" /></div>
                  <div className="kv-total"><span>Closing cash</span><strong>{money(sel.closing)}</strong></div>
                  <div><span>New loans</span><strong>{sel.loans_count} · {money(sel.principal_issued)}</strong></div>
                  <div><span>Interest cut upfront</span><strong className="amt-in">{money(sel.interest_earned)}</strong></div>
                  <div><span>Extra booked (total − principal)</span><strong className="amt-in">{money(sel.markup_booked)}</strong></div>
                </div>
                <div className="btn-row">
                  <button className="btn btn-sm" onClick={() => navigate('/daily')}>Day-wise view →</button>
                  <Link className="btn btn-sm" to="/salary">Salary report →</Link>
                </div>
              </Card>
              <Card title="Where the money went">
                <ErrorBox error={detail.error} />
                {!detail.data ? (
                  <Loading />
                ) : (
                  <>
                    <h4 className="mini-title">Expenses by category</h4>
                    {detail.data.cats.length === 0 ? (
                      <Empty>No expenses.</Empty>
                    ) : (
                      <div className="hbars">
                        {detail.data.cats.map(([cat, amt]) => (
                          <div key={cat} className="hbar">
                            <span>{cat}</span>
                            <div className="hbar-track"><div style={{ width: `${(amt / detail.data.cats[0][1]) * 100}%` }} /></div>
                            <strong>{money(amt)}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                    <h4 className="mini-title">Salary status</h4>
                    {detail.data.salary.length === 0 ? (
                      <Empty>No employees.</Empty>
                    ) : (
                      <div className="kv-list">
                        <div><span>Total salary</span><strong>{money(sum(detail.data.salary, 'monthly_salary'))}</strong></div>
                        <div><span>Advances deducted</span><strong>{money(sum(detail.data.salary, 'advances'))}</strong></div>
                        <div><span>Paid</span><strong>{money(sum(detail.data.salary, 'paid'))}</strong></div>
                        <div className="kv-total"><span>Still to pay</span><strong>{money(sum(detail.data.salary.filter((s) => toNum(s.balance) > 0), 'balance'))}</strong></div>
                      </div>
                    )}
                  </>
                )}
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}
