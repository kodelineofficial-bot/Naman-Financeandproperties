import { useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Field, Modal, ModeSelect } from '../../components/ui.jsx';
import { fmtMonth, money, monthStart, round2, todayStr } from '../../lib/format.js';
import { useAction } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

export function EmployeeForm({ employee, onClose, onSaved }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({
    name: employee?.name || '',
    phone: employee?.phone || '',
    designation: employee?.designation || '',
    address: employee?.address || '',
    id_proof: employee?.id_proof || '',
    joining_date: employee?.joining_date || todayStr(),
    monthly_salary: employee ? String(employee.monthly_salary) : '',
    is_active: employee ? employee.is_active : true,
    notes: employee?.notes || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const payload = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      designation: f.designation.trim() || null,
      address: f.address.trim() || null,
      id_proof: f.id_proof.trim() || null,
      joining_date: f.joining_date,
      monthly_salary: round2(f.monthly_salary),
      is_active: f.is_active,
      notes: f.notes.trim() || null,
    };
    if (!payload.name) return toast.error('Name is required.');
    const res = await run(
      () =>
        employee
          ? q(supabase.from('employees').update(payload).eq('id', employee.id).select().single())
          : q(supabase.from('employees').insert(payload).select().single()),
      employee ? 'Employee updated' : 'Employee added',
    );
    if (res) {
      onSaved?.(res);
      onClose();
    }
  }

  return (
    <Modal title={employee ? 'Edit employee' : 'New employee · नया कर्मचारी'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Name *"><input required autoFocus value={f.name} onChange={set('name')} /></Field>
          <Field label="Phone"><input type="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Designation / Work"><input value={f.designation} onChange={set('designation')} placeholder="Collection agent, Accountant…" /></Field>
          <Field label="Fixed monthly salary (₹) *"><input type="number" min="0" step="any" required value={f.monthly_salary} onChange={set('monthly_salary')} /></Field>
          <Field label="Joining date"><input type="date" required value={f.joining_date} onChange={set('joining_date')} /></Field>
          <Field label="ID proof"><input value={f.id_proof} onChange={set('id_proof')} /></Field>
          <Field label="Address" span={2}><input value={f.address} onChange={set('address')} /></Field>
          <Field label="Notes" span={2}><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Currently working
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AdvanceForm({ employee, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({
    given_on: todayStr(),
    amount: '',
    kind: 'advance',
    deduct_month: todayStr().slice(0, 7),
    mode: 'cash',
    note: '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    const ok = await run(
      () =>
        q(
          supabase.from('employee_advances').insert({
            employee_id: employee.id,
            given_on: f.given_on,
            amount,
            kind: f.kind,
            deduct_month: `${f.deduct_month}-01`,
            mode: f.mode,
            note: f.note.trim() || null,
          }),
        ),
      `${money(amount)} ${f.kind} recorded`,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={`Advance / loan to ${employee.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Date given"><input type="date" required value={f.given_on} onChange={set('given_on')} /></Field>
          <Field label="Amount (₹)"><input type="number" min="0" step="any" required autoFocus value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Type">
            <select value={f.kind} onChange={set('kind')}>
              <option value="advance">Salary advance (एडवांस)</option>
              <option value="loan">Loan / udhaar (उधार)</option>
            </select>
          </Field>
          <Field label="Deduct from salary of" hint={fmtMonth(`${f.deduct_month}-01`)}>
            <input type="month" required value={f.deduct_month} onChange={set('deduct_month')} />
          </Field>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Note"><input value={f.note} onChange={set('note')} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SalaryPayForm({ employee, month, suggested, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({
    salary_month: (month || monthStart(todayStr())).slice(0, 7),
    paid_on: todayStr(),
    amount: suggested > 0 ? String(suggested) : '',
    mode: 'cash',
    note: '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    const ok = await run(
      () =>
        q(
          supabase.from('salary_payments').insert({
            employee_id: employee.id,
            salary_month: `${f.salary_month}-01`,
            paid_on: f.paid_on,
            amount,
            mode: f.mode,
            note: f.note.trim() || null,
          }),
        ),
      `Salary ${money(amount)} paid to ${employee.name}`,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={`Pay salary — ${employee.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Salary for month"><input type="month" required value={f.salary_month} onChange={set('salary_month')} /></Field>
          <Field label="Paid on"><input type="date" required value={f.paid_on} onChange={set('paid_on')} /></Field>
          <Field label="Amount (₹)" hint={suggested != null ? `Balance due: ${money(suggested)}` : undefined}>
            <input type="number" min="0" step="any" required autoFocus value={f.amount} onChange={set('amount')} />
          </Field>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Note" span={2}><input value={f.note} onChange={set('note')} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Pay'}</button>
        </div>
      </form>
    </Modal>
  );
}
