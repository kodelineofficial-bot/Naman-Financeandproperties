import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, SearchInput, Stat, Tabs } from '../../components/ui.jsx';
import { fmtDate, fmtMonth, money, monthStart, sum, toNum, todayStr } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import { EmployeeForm } from './EmployeeForms.jsx';

export default function Employees() {
  const navigate = useNavigate();
  const month = monthStart(todayStr());
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    const [emps, report] = await Promise.all([
      q(supabase.from('employees').select('*').order('name')),
      q(supabase.rpc('salary_report', { p_month: month })),
    ]);
    const rep = Object.fromEntries(report.map((r) => [r.employee_id, r]));
    return emps.map((e) => ({ ...e, month: rep[e.id] || null }));
  }, [month]);

  const all = data || [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter(
      (e) =>
        (tab === 'all' || (tab === 'active' ? e.is_active : !e.is_active)) &&
        (!s || `${e.name} ${e.phone || ''} ${e.designation || ''}`.toLowerCase().includes(s)),
    );
  }, [all, tab, search]);

  const active = all.filter((e) => e.is_active);

  return (
    <>
      <PageHeader title="Employees" hindi="कर्मचारी" subtitle={`Staff, fixed salary and what is left to pay for ${fmtMonth(month)}`}>
        <Link className="btn" to="/salary">Salary report</Link>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add employee</button>
      </PageHeader>

      <div className="stats">
        <Stat label="Working staff" value={active.length} />
        <Stat label="Monthly salary bill" value={money(sum(active, 'monthly_salary'))} />
        <Stat label="Advances this month" value={money(sum(all, (e) => toNum(e.month?.advances)))} tone="red" />
        <Stat label="Still to pay this month" value={money(sum(all, (e) => Math.max(0, toNum(e.month?.balance))))} tone="gold" />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'active', label: 'Working', count: active.length },
              { value: 'left', label: 'Left', count: all.length - active.length },
              { value: 'all', label: 'All', count: all.length },
            ]}
          />
        }
        actions={<SearchInput value={search} onChange={setSearch} placeholder="Name / phone / role" />}
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No employees yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Role</th><th>Phone</th><th>Joined</th>
                  <th className="num">Salary</th><th className="num">Advance (this month)</th>
                  <th className="num">Paid (this month)</th><th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => navigate(`/employees/${e.id}`)}>
                    <td>
                      <strong>{e.name}</strong>
                      {!e.is_active && <span className="badge badge-grey ml">Left</span>}
                    </td>
                    <td>{e.designation || '—'}</td>
                    <td>{e.phone || '—'}</td>
                    <td className="nowrap">{fmtDate(e.joining_date)}</td>
                    <td className="num">{money(e.monthly_salary)}</td>
                    <td className="num amt-out">{money(e.month?.advances)}</td>
                    <td className="num">{money(e.month?.paid)}</td>
                    <td className={`num ${toNum(e.month?.balance) < 0 ? 'amt-out' : ''}`}><strong>{money(e.month?.balance)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <EmployeeForm onClose={() => setAdding(false)} onSaved={(e) => navigate(`/employees/${e.id}`)} />}
    </>
  );
}
