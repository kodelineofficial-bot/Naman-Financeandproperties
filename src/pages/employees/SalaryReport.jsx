import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, Stat } from '../../components/ui.jsx';
import { addMonths, downloadCSV, fmtMonth, money, monthStart, sum, toNum, todayStr } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import { SalaryPayForm } from './EmployeeForms.jsx';

/** Month-end salary sheet: salary − advances − already paid = left to pay. */
export default function SalaryReport() {
  const [month, setMonth] = useState(monthStart(todayStr()));
  const [paying, setPaying] = useState(null);

  const { data, loading, error } = useLoad(() => q(supabase.rpc('salary_report', { p_month: month })), [month]);
  const rows = data || [];
  const due = rows.filter((r) => toNum(r.balance) > 0);

  return (
    <>
      <PageHeader title="Salary Report" hindi="तनख्वाह रिपोर्ट" subtitle={`${fmtMonth(month)} — salary minus advances minus already paid`}>
        <div className="date-nav">
          <button className="btn btn-sm" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
          <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} />
          <button className="btn btn-sm" onClick={() => setMonth(addMonths(month, 1))}>›</button>
        </div>
        <button
          className="btn"
          disabled={!rows.length}
          onClick={() =>
            downloadCSV(`salary-${month.slice(0, 7)}.csv`, rows, [
              { key: 'name', label: 'Name' }, { key: 'designation', label: 'Role' }, { key: 'monthly_salary', label: 'Salary' },
              { key: 'advances', label: 'Advances' }, { key: 'paid', label: 'Paid' }, { key: 'balance', label: 'Balance' },
            ])
          }
        >
          ⬇ Export
        </button>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHeader>

      <div className="stats">
        <Stat label="Total salary" value={money(sum(rows, 'monthly_salary'))} hint={`${rows.length} employees`} />
        <Stat label="Advances cut" value={money(sum(rows, 'advances'))} tone="red" />
        <Stat label="Already paid" value={money(sum(rows, 'paid'))} />
        <Stat label="Left to pay" value={money(sum(due, 'balance'))} tone="gold" hint={`${due.length} people`} />
      </div>

      <ErrorBox error={error} />
      <Card flush>
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No employees for this month. <Link to="/employees">Add employees →</Link></Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th><th className="num">Fixed salary</th><th className="num">− Advance / loan</th>
                  <th className="num">− Paid</th><th className="num">= Balance</th><th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const bal = toNum(r.balance);
                  return (
                    <tr key={r.employee_id}>
                      <td>
                        <Link to={`/employees/${r.employee_id}`}><strong>{r.name}</strong></Link>
                        <div className="muted small">{r.designation || ''}{!r.is_active ? ' · left' : ''}</div>
                      </td>
                      <td className="num">{money(r.monthly_salary)}</td>
                      <td className="num amt-out">{toNum(r.advances) ? money(r.advances) : '—'}</td>
                      <td className="num">{toNum(r.paid) ? money(r.paid) : '—'}</td>
                      <td className={`num ${bal > 0 ? 'amt-warn' : bal < 0 ? 'amt-out' : 'amt-in'}`}>
                        <strong>{bal === 0 ? '✓ Settled' : money(bal)}</strong>
                        {bal < 0 && <div className="small">recover from employee</div>}
                      </td>
                      <td className="num no-print">
                        {bal > 0 && (
                          <button className="btn btn-sm btn-primary" onClick={() => setPaying({ employee: { id: r.employee_id, name: r.name }, amount: bal })}>
                            Pay {money(bal)}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{money(sum(rows, 'monthly_salary'))}</td>
                  <td className="num">{money(sum(rows, 'advances'))}</td>
                  <td className="num">{money(sum(rows, 'paid'))}</td>
                  <td className="num">{money(sum(rows, 'balance'))}</td>
                  <td className="no-print" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      {paying && (
        <SalaryPayForm employee={paying.employee} month={month} suggested={paying.amount} onClose={() => setPaying(null)} />
      )}
    </>
  );
}
