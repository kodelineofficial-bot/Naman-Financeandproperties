import { useMemo, useState } from 'react';
import { useToast } from '../components/Toast.jsx';
import { Card, Empty, ErrorBox, Field, Loading, Modal, ModeSelect, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import {
  EXPENSE_CATEGORIES, addDays, downloadCSV, fmtDate, modeLabel, money, monthStart, round2, sum, toNum, todayStr,
} from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

function ExpenseForm({ expense, categories, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState(
    expense
      ? { ...expense, amount: String(expense.amount), paid_to: expense.paid_to || '', description: expense.description || '' }
      : { spent_on: todayStr(), category: 'Tea / Snacks', amount: '', mode: 'cash', paid_to: '', description: '' },
  );
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e, again) {
    e.preventDefault();
    const payload = {
      spent_on: f.spent_on,
      category: f.category.trim() || 'Misc',
      amount: round2(f.amount),
      mode: f.mode,
      paid_to: f.paid_to.trim() || null,
      description: f.description.trim() || null,
    };
    if (payload.amount <= 0) return toast.error('Enter an amount.');
    const ok = await run(
      () => (expense ? q(supabase.from('expenses').update(payload).eq('id', expense.id)) : q(supabase.from('expenses').insert(payload))),
      expense ? 'Expense updated' : `Expense ${money(payload.amount)} saved`,
    );
    if (!ok) return;
    if (again) setF({ ...f, amount: '', paid_to: '', description: '' });
    else onClose();
  }

  return (
    <Modal title={expense ? 'Edit expense' : 'Add expense · खर्चा'} onClose={onClose}>
      <form onSubmit={(e) => submit(e, false)}>
        <div className="form-grid">
          <Field label="Date money came / went · पैसा किस दिन" hint="Today or earlier — not a future date"><input type="date" required max={todayStr()} value={f.spent_on} onChange={set('spent_on')} /></Field>
          <Field label="Amount (₹)"><input type="number" min="0" step="any" required autoFocus value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Category">
            <input list="exp-cats" required value={f.category} onChange={set('category')} />
            <datalist id="exp-cats">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Paid to"><input value={f.paid_to} onChange={set('paid_to')} placeholder="Shop / person" /></Field>
          <Field label="Description"><input value={f.description} onChange={set('description')} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!expense && <button type="button" className="btn" disabled={busy} onClick={(e) => submit(e, true)}>Save & add another</button>}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Expenses() {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const today = todayStr();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [cat, setCat] = useState('');
  const [editing, setEditing] = useState(null);

  const { data, loading, error } = useLoad(
    () =>
      q(
        supabase
          .from('expenses')
          .select('*')
          .gte('spent_on', from)
          .lte('spent_on', to)
          .order('spent_on', { ascending: false })
          .order('created_at', { ascending: false }),
      ),
    [from, to],
  );

  const all = data || [];
  const rows = cat ? all.filter((e) => e.category === cat) : all;
  const categories = useMemo(
    () => Array.from(new Set([...EXPENSE_CATEGORIES, ...all.map((e) => e.category)])).sort(),
    [all],
  );
  const byCat = useMemo(() => {
    const m = {};
    for (const e of all) m[e.category] = round2((m[e.category] || 0) + toNum(e.amount));
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [all]);

  const todayTotal = sum(all.filter((e) => e.spent_on === today), 'amount');
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);

  async function remove(e) {
    if (!window.confirm(`Delete expense of ${money(e.amount)} (${e.category})?`)) return;
    await run(() => q(supabase.from('expenses').delete().eq('id', e.id)), 'Expense deleted');
  }

  return (
    <>
      <PageHeader title="Daily Expenses" hindi="रोज़ का खर्चा" subtitle="Every rupee spent — reflected in day book, monthly report and cash balance">
        <button
          className="btn"
          disabled={!rows.length}
          onClick={() =>
            downloadCSV(`expenses-${from}-to-${to}.csv`, rows, [
              { key: 'spent_on', label: 'Date' }, { key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount' },
              { key: 'mode', label: 'Mode' }, { key: 'paid_to', label: 'Paid to' }, { key: 'description', label: 'Description' },
            ])
          }
        >
          ⬇ Excel
        </button>
        <PrintButton />
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add expense</button>
      </PageHeader>

      <Card>
        <div className="filters">
          <label>From <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          <label>
            Category{' '}
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All</option>
              {categories.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => { setFrom(today); setTo(today); }}>Today</button>
            <button className="btn btn-sm" onClick={() => { setFrom(addDays(today, -6)); setTo(today); }}>7 days</button>
            <button className="btn btn-sm" onClick={() => { setFrom(monthStart(today)); setTo(today); }}>This month</button>
          </div>
        </div>
      </Card>

      <div className="stats">
        <Stat label="Total (period)" value={money(sum(all, 'amount'))} tone="red" hint={`${all.length} entries`} />
        <Stat label="Shown (filter)" value={money(sum(rows, 'amount'))} />
        <Stat label="Today" value={money(todayTotal)} />
        <Stat label="Average / day" value={money(round2(sum(all, 'amount') / days))} />
      </div>

      <ErrorBox error={error} />
      <div className="grid-2 grid-2-wide">
        <Card flush title="Entries">
          {loading && !data ? (
            <Loading />
          ) : rows.length === 0 ? (
            <Empty>No expenses in this period.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Date</th><th>Category</th><th>Details</th><th>Mode</th><th className="num">Amount</th><th /></tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap">{fmtDate(e.spent_on)}</td>
                      <td><span className="badge badge-grey">{e.category}</span></td>
                      <td>
                        {e.paid_to || ''}
                        {e.description && <div className="muted small">{e.description}</div>}
                      </td>
                      <td>{modeLabel(e.mode)}</td>
                      <td className="num amt-out"><strong>{money(e.amount)}</strong></td>
                      <td className="num nowrap">
                        <button className="icon-btn" title="Edit" onClick={() => setEditing(e)}>✎</button>
                        <button className="icon-btn danger" title="Delete" disabled={busy} onClick={() => remove(e)}>🗑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="By category">
          {byCat.length === 0 ? (
            <Empty>—</Empty>
          ) : (
            <div className="hbars">
              {byCat.map(([c, amt]) => (
                <button key={c} type="button" className={`hbar ${cat === c ? 'active' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>
                  <span>{c}</span>
                  <div className="hbar-track"><div style={{ width: `${(amt / byCat[0][1]) * 100}%` }} /></div>
                  <strong>{money(amt)}</strong>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {editing && (
        <ExpenseForm expense={editing === 'new' ? null : editing} categories={categories} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
