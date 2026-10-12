import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, Stat } from '../../components/ui.jsx';
import { addMonths, fmtDate, fmtMonth, modeLabel, money, monthStart, round2, sum, toNum, todayStr } from '../../lib/format.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import { AdvanceForm, EmployeeForm, SalaryPayForm } from './EmployeeForms.jsx';

export default function EmployeeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [modal, setModal] = useState(null);
  const thisMonth = monthStart(todayStr());

  const { data, loading, error } = useLoad(async () => {
    const [emp, advances, payments] = await Promise.all([
      q(supabase.from('employees').select('*').eq('id', id).single()),
      q(supabase.from('employee_advances').select('*').eq('employee_id', id).order('given_on', { ascending: false })),
      q(supabase.from('salary_payments').select('*').eq('employee_id', id).order('paid_on', { ascending: false })),
    ]);
    return { emp, advances, payments };
  }, [id]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error || new Error('Not found')} />;
  const { emp, advances, payments } = data;

  // Month-wise statement: from joining month (max 24 months back) to the current month.
  const startMonth = monthStart(emp.joining_date) > addMonths(thisMonth, -23) ? monthStart(emp.joining_date) : addMonths(thisMonth, -23);
  const statement = [];
  for (let m = thisMonth; m >= startMonth; m = addMonths(m, -1)) {
    const adv = sum(advances.filter((a) => a.deduct_month === m), 'amount');
    const paid = sum(payments.filter((p) => p.salary_month === m), 'amount');
    const salary = toNum(emp.monthly_salary);
    statement.push({ month: m, salary, adv, paid, balance: round2(salary - adv - paid) });
  }
  const current = statement[0] || { salary: emp.monthly_salary, adv: 0, paid: 0, balance: emp.monthly_salary };

  async function del(table, row, label) {
    if (!window.confirm(`Delete ${label} of ${money(row.amount)}?`)) return;
    await run(() => q(supabase.from(table).delete().eq('id', row.id)), 'Deleted');
  }

  async function removeEmployee() {
    if (!window.confirm(`Delete ${emp.name} and ALL salary/advance history? (Tip: use Edit → untick "Currently working" instead.)`)) return;
    const ok = await run(() => q(supabase.from('employees').delete().eq('id', id)), 'Employee deleted');
    if (ok) navigate('/employees');
  }

  return (
    <>
      <PageHeader title={emp.name} hindi={emp.designation || 'कर्मचारी'} subtitle={[emp.phone, emp.address].filter(Boolean).join(' · ')}>
        {!emp.is_active && <Badge>Left</Badge>}
        <button className="btn" onClick={() => setModal('edit')}>Edit</button>
        <button className="btn" onClick={() => setModal('adv')}>+ Advance / loan</button>
        <button className="btn btn-primary" onClick={() => setModal('pay')}>Pay salary</button>
      </PageHeader>
      <ErrorBox error={error} />

      <div className="stats">
        <Stat label="Fixed salary" value={money(emp.monthly_salary)} hint={`Joined ${fmtDate(emp.joining_date)}`} />
        <Stat label={`Advances · ${fmtMonth(thisMonth)}`} value={money(current.adv)} tone="red" />
        <Stat label="Paid this month" value={money(current.paid)} />
        <Stat label="Salary left to give" value={money(current.balance)} tone={current.balance < 0 ? 'red' : 'gold'} hint={current.balance < 0 ? 'Advance is more than salary' : 'Salary − advance − paid'} />
      </div>

      <Card title="Month-wise statement · महीने का हिसाब" flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Month</th><th className="num">Salary</th><th className="num">Advance / loan cut</th><th className="num">Paid</th><th className="num">Balance</th><th /></tr>
            </thead>
            <tbody>
              {statement.map((s) => (
                <tr key={s.month} className={s.month === thisMonth ? 'row-today' : ''}>
                  <td><strong>{fmtMonth(s.month)}</strong></td>
                  <td className="num">{money(s.salary)}</td>
                  <td className="num amt-out">{s.adv ? money(s.adv) : '—'}</td>
                  <td className="num">{s.paid ? money(s.paid) : '—'}</td>
                  <td className={`num ${s.balance > 0 ? 'amt-warn' : s.balance < 0 ? 'amt-out' : 'amt-in'}`}>
                    <strong>{s.balance === 0 ? '✓ Settled' : money(s.balance)}</strong>
                  </td>
                  <td className="num">
                    {s.balance > 0 && (
                      <button className="btn btn-sm" onClick={() => setModal({ pay: s.month, amount: s.balance })}>Pay</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2">
        <Card title={`Advances & loans (${advances.length})`} flush actions={<button className="btn btn-sm" onClick={() => setModal('adv')}>+ Add</button>}>
          {advances.length === 0 ? (
            <Empty>No advances.</Empty>
          ) : (
            <table className="table">
              <thead><tr><th>Date</th><th>Type</th><th>Deduct in</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {advances.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{fmtDate(a.given_on)}<div className="muted small">{modeLabel(a.mode)} {a.note ? '· ' + a.note : ''}</div></td>
                    <td><Badge tone={a.kind === 'loan' ? 'red' : 'blue'}>{a.kind === 'loan' ? 'Loan' : 'Advance'}</Badge></td>
                    <td>{fmtMonth(a.deduct_month)}</td>
                    <td className="num amt-out"><strong>{money(a.amount)}</strong></td>
                    <td className="num"><button className="icon-btn danger" disabled={busy} onClick={() => del('employee_advances', a, 'advance')}>🗑</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title={`Salary paid (${payments.length})`} flush actions={<button className="btn btn-sm btn-primary" onClick={() => setModal('pay')}>Pay</button>}>
          {payments.length === 0 ? (
            <Empty>No salary paid yet.</Empty>
          ) : (
            <table className="table">
              <thead><tr><th>Paid on</th><th>For month</th><th>Mode</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.paid_on)}{p.note && <div className="muted small">{p.note}</div>}</td>
                    <td>{fmtMonth(p.salary_month)}</td>
                    <td>{modeLabel(p.mode)}</td>
                    <td className="num"><strong>{money(p.amount)}</strong></td>
                    <td className="num"><button className="icon-btn danger" disabled={busy} onClick={() => del('salary_payments', p, 'salary payment')}>🗑</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Details">
        <div className="kv-list">
          <div><span>Phone</span><strong>{emp.phone || '—'}</strong></div>
          <div><span>Address</span><strong>{emp.address || '—'}</strong></div>
          <div><span>ID proof</span><strong>{emp.id_proof || '—'}</strong></div>
          <div><span>Total advances (all time)</span><strong>{money(sum(advances, 'amount'))}</strong></div>
          <div><span>Total salary paid (all time)</span><strong>{money(sum(payments, 'amount'))}</strong></div>
        </div>
        {emp.notes && <p className="note-box">{emp.notes}</p>}
        <button className="btn btn-danger-outline btn-sm" disabled={busy} onClick={removeEmployee}>Delete employee</button>
      </Card>

      {modal === 'edit' && <EmployeeForm employee={emp} onClose={() => setModal(null)} />}
      {modal === 'adv' && <AdvanceForm employee={emp} onClose={() => setModal(null)} />}
      {modal === 'pay' && <SalaryPayForm employee={emp} month={thisMonth} suggested={current.balance} onClose={() => setModal(null)} />}
      {modal?.pay && <SalaryPayForm employee={emp} month={modal.pay} suggested={modal.amount} onClose={() => setModal(null)} />}
    </>
  );
}
