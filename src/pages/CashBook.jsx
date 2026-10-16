import { useState } from 'react';
import { useToast } from '../components/Toast.jsx';
import { Card, Empty, ErrorBox, ExportButton, Field, Loading, Modal, ModeSelect, PageHeader, PrintButton, Stat } from '../components/ui.jsx';
import { counted, fmtDate, modeLabel, money, round2, sum, todayStr } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

function CashForm({ direction, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ entry_date: todayStr(), amount: '', mode: 'cash', party: '', description: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const amount = round2(f.amount);
    if (amount <= 0) return toast.error('Enter an amount.');
    const ok = await run(
      () =>
        q(
          supabase.from('cash_entries').insert({
            entry_date: f.entry_date,
            direction,
            amount,
            mode: f.mode,
            party: f.party.trim() || null,
            description: f.description.trim() || null,
          }),
        ),
      'Saved',
    );
    if (ok) onClose();
  }

  return (
    <Modal title={direction === 'in' ? 'Cash in — capital / other income' : 'Cash out — owner withdrawal / deposit'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Date money came / went · पैसा किस दिन" hint="Today or earlier — not a future date"><input type="date" required max={todayStr()} value={f.entry_date} onChange={set('entry_date')} /></Field>
          <Field label="Amount (₹)"><input type="number" min="0" step="any" required autoFocus value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label={direction === 'in' ? 'From' : 'To'}><input value={f.party} onChange={set('party')} placeholder="Owner, bank, partner…" /></Field>
          <Field label="Description" span={2}><input value={f.description} onChange={set('description')} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Capital in / owner withdrawals — anything that changes cash but isn't a loan, salary or expense. */
export default function CashBook() {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [modal, setModal] = useState(null);
  const { data, loading, error } = useLoad(
    () => q(supabase.from('cash_entries').select('*').order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(500)),
    [],
  );

  const rows = data || [];
  const ins = counted(rows).filter((r) => r.direction === 'in');
  const outs = counted(rows).filter((r) => r.direction === 'out');

  async function remove(r) {
    if (!window.confirm(`Delete ${money(r.amount)} entry?`)) return;
    await run(() => q(supabase.from('cash_entries').delete().eq('id', r.id)), 'Deleted');
  }

  return (
    <>
      <PageHeader title="Cash In / Out" hindi="पूंजी · निकासी" subtitle="Owner adds capital, takes money home, deposits to bank, other income">
        <button className="btn btn-primary" onClick={() => setModal('in')}>+ Cash in</button>
        <button className="btn" onClick={() => setModal('out')}>− Cash out</button>
        <ExportButton
          filename="cash-in-out.csv"
          rows={rows}
          columns={[
            { label: 'Date', key: 'entry_date' }, { label: 'In / Out', value: (r) => (r.direction === 'in' ? 'In' : 'Out') },
            { label: 'Party', key: 'party' }, { label: 'Details', key: 'description' }, { label: 'Mode', value: (r) => modeLabel(r.mode) },
            { label: 'Amount', key: 'amount' },
          ]}
        />
        <PrintButton />
      </PageHeader>
      <div className="stats">
        <Stat label="Total cash in" value={money(sum(ins, 'amount'))} tone="green" />
        <Stat label="Total cash out" value={money(sum(outs, 'amount'))} tone="red" />
        <Stat label="Net capital" value={money(sum(ins, 'amount') - sum(outs, 'amount'))} tone="gold" />
      </div>
      <ErrorBox error={error} />
      <Card flush title="Entries (latest 500)">
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No entries. Use “Cash in” when the owner puts more money into the business.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Party</th><th>Description</th><th>Mode</th><th className="num">Amount</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDate(r.entry_date)}</td>
                    <td>{r.direction === 'in' ? <span className="badge badge-green">In</span> : <span className="badge badge-red">Out</span>}</td>
                    <td>{r.party || '—'}</td>
                    <td className="muted">{r.description || ''}</td>
                    <td>{modeLabel(r.mode)}</td>
                    <td className={`num ${r.direction === 'in' ? 'amt-in' : 'amt-out'}`}><strong>{money(r.amount)}</strong></td>
                    <td className="num"><button className="icon-btn danger" disabled={busy} onClick={() => remove(r)}>🗑</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {modal && <CashForm direction={modal} onClose={() => setModal(null)} />}
    </>
  );
}
