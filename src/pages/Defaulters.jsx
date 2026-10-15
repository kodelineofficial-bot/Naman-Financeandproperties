import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import {
  Card, Empty, ErrorBox, ExportButton, Field, Loading, Modal, ModeSelect, PageHeader, PrintButton, SearchInput, Stat, Tabs,
} from '../components/ui.jsx';
import { addDays, fmtDate, money, round2, sum, toNum, todayStr } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { photoThumb, uploadPhoto } from '../lib/photos.js';
import { q, supabase } from '../lib/supabase.js';
import { BORROWER_FIELDS, BorrowerFields, cleanBorrower } from './loans/BorrowerForm.jsx';

/** Day (India time) a row was added to the software. */
export const addedOn = (l) => (l.created_at ? new Date(l.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null);

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function Avatar({ url, name }) {
  return (
    <span className="avatar avatar-sm">
      {url ? <img src={photoThumb(url, 96)} alt={name} /> : <span>{initials(name)}</span>}
    </span>
  );
}

/** Take money from a defaulter — a normal collection, so the balance goes down and the cash book shows it. */
export function DefaulterPayModal({ loan, onClose }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const balance = toNum(loan.outstanding);
  const [f, setF] = useState({ paid_on: todayStr(), amount: '', mode: 'cash', note: '' });
  const amount = round2(f.amount);

  async function submit(e) {
    e.preventDefault();
    if (amount <= 0) return toast.error('Enter an amount.');
    if (f.paid_on > todayStr()) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    if (amount > balance + 0.001 && !window.confirm(`This is more than the balance ${money(balance)}. Save anyway?`)) return;
    const ok = await run(
      () => q(supabase.from('loan_repayments').insert({ loan_id: loan.id, paid_on: f.paid_on, amount, mode: f.mode, note: f.note.trim() || null })),
      amount >= balance ? `${money(amount)} saved · balance cleared` : `${money(amount)} saved · ${money(round2(balance - amount))} left`,
    );
    if (ok) onClose();
  }

  return (
    <Modal title={`Take payment · पैसे लिए — ${loan.borrower_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Date money came · पैसा किस दिन मिला">
            <input type="date" required max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />
          </Field>
          <Field label="Amount (₹) · रकम" hint={`Balance now ${money(balance)}`}>
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" required autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <div className="span-2">
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, amount: String(balance) })}>Full balance {money(balance)}</button>
            </div>
            {amount > 0 && (
              <div className="good-note">
                {amount >= balance
                  ? <>Balance becomes <strong>₹0</strong> — defaulter cleared · पूरा चुकता</>
                  : <>Balance after this · इसके बाद बाकी: <strong>{money(round2(balance - amount))}</strong></>}
              </div>
            )}
          </div>
          <Field label="Mode"><ModeSelect value={f.mode} onChange={(v) => setF({ ...f, mode: v })} /></Field>
          <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Add an old defaulter (from before the software), or edit one (pass `loan`).
 * Stored as a defaulted loan with old_defaulter = true — see migration 014.
 */
export function OldDefaulterModal({ loan, onClose, onSaved }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const editing = !!loan;
  const { data: borrowers } = useLoad(() => (editing ? [] : q(supabase.from('borrowers').select('id,name,phone').order('name'))), []);
  const [who, setWho] = useState('new');
  const [borrowerId, setBorrowerId] = useState('');
  const [b, setB] = useState({ ...BORROWER_FIELDS });
  const [photo, setPhoto] = useState(null);
  const [f, setF] = useState(() => ({
    balance: editing ? String(toNum(loan.total_repayable)) : '',
    original: editing && toNum(loan.principal) !== toNum(loan.total_repayable) ? String(toNum(loan.principal)) : '',
    loan_date: editing ? loan.loan_date : '',
    notes: editing ? loan.notes || '' : '',
  }));
  const paidSoFar = editing ? toNum(loan.collected_cash) : 0;

  async function submit(e) {
    e.preventDefault();
    const balance = round2(f.balance);
    const original = round2(f.original) || balance;
    const today = todayStr();
    const date = f.loan_date || today;
    if (balance <= 0) return toast.error('Enter the balance still to take · बाकी रकम');
    if (date > today) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    if (!editing && who === 'new' && !b.name.trim()) return toast.error('Enter the name');
    if (!editing && who === 'existing' && !borrowerId) return toast.error('Choose the borrower');
    if (editing && balance < paidSoFar && !window.confirm(`${money(paidSoFar)} is already received, more than this balance. Save anyway? The defaulter will show as cleared.`)) return;

    const terms = {
      principal: original,
      total_repayable: balance,
      daily_installment: balance,
      loan_date: date,
      // Collection is counted from a day before it was added, so the whole balance shows as overdue.
      collection_start_date: date < today ? date : addDays(today, -1),
      notes: f.notes.trim() || null,
    };

    const res = await run(async () => {
      if (editing) {
        await q(supabase.from('loans').update(terms).eq('id', loan.id));
        await q(supabase.from('loan_disbursements').update({ amount: original, paid_on: date }).eq('loan_id', loan.id).eq('mode', 'opening'));
        await q(supabase.rpc('recalc_loan_status', { p_loan: loan.id }));
        return loan;
      }
      let bid = borrowerId;
      if (who === 'new') bid = (await q(supabase.from('borrowers').insert(cleanBorrower(b)).select('id').single())).id;
      const row = await q(
        supabase.from('loans').insert({
          ...terms,
          borrower_id: bid,
          interest_pct: 0,
          interest_amount: 0,
          markup_pct: 0,
          duration_days: 1,
          advance_days: 0,
          advance_amount: 0,
          frequency: 'daily',
          status: 'defaulted',
          defaulted_on: today,
          penalty_off: true,
          old_defaulter: true,
        }).select('id').single(),
      );
      // The old payout: keeps "To give" at 0, left out of the cash book (mode 'opening').
      await q(
        supabase.from('loan_disbursements').insert({
          loan_id: row.id, paid_on: date, amount: original, mode: 'opening', note: 'Old loan — given before this software, not in cash book',
        }),
      );
      if (photo) {
        try {
          await uploadPhoto('borrowers', bid, photo);
        } catch (err) {
          toast.error(`Defaulter saved, but photo failed: ${err.message}. Add it from the borrower page.`);
        }
      }
      return row;
    }, editing ? 'Defaulter updated' : 'Old defaulter added');
    if (res) {
      onSaved?.(res);
      onClose();
    }
  }

  return (
    <Modal title={editing ? `Edit old defaulter — ${loan.borrower_name}` : 'Add old defaulter · पुराना डिफ़ॉल्टर'} onClose={onClose} wide>
      <form onSubmit={submit}>
        {!editing && (
          <>
            <div className="segmented">
              <button type="button" className={who === 'new' ? 'active' : ''} onClick={() => setWho('new')}>New person · नया</button>
              <button type="button" className={who === 'existing' ? 'active' : ''} onClick={() => setWho('existing')}>Existing borrower</button>
            </div>
            {who === 'new' ? (
              <>
                <BorrowerFields value={b} onChange={setB} />
                <div className="form-grid">
                  <Field label="Photo · फोटो" hint={photo ? photo.name : 'Optional — can also be added later from the borrower page'}>
                    <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
                  </Field>
                </div>
              </>
            ) : (
              <div className="form-grid">
                <Field label="Borrower *" span={2}>
                  <select required value={borrowerId} onChange={(e) => setBorrowerId(e.target.value)}>
                    <option value="">— choose —</option>
                    {(borrowers || []).map((x) => (
                      <option key={x.id} value={x.id}>{x.name}{x.phone ? ` · ${x.phone}` : ''}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <h4 className="form-section">Money · पैसा</h4>
          </>
        )}
        <div className="form-grid">
          <Field label="Balance still to take (₹) * · बाकी रकम" hint={editing && paidSoFar > 0 ? `Balance when added. ${money(paidSoFar)} received since then is taken off.` : 'What they still owe today'}>
            <input className="input-big" type="number" inputMode="decimal" min="0" step="any" required autoFocus={editing} value={f.balance} onChange={(e) => setF({ ...f, balance: e.target.value })} />
          </Field>
          <Field label="Original loan amount (₹)" hint="Optional — just for the record">
            <input type="number" inputMode="decimal" min="0" step="any" value={f.original} onChange={(e) => setF({ ...f, original: e.target.value })} />
          </Field>
          <Field label="Old loan date · कब दिया था" hint="Optional — leave empty if not known">
            <input type="date" max={todayStr()} value={f.loan_date} onChange={(e) => setF({ ...f, loan_date: e.target.value })} />
          </Field>
          <Field label="Note"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. from old register page 12" /></Field>
        </div>
        <p className="muted small">
          This old loan is not added to the cash book (that money went out before the software). Every payment you take later is
          added to the cash book as a collection, and the balance goes down.
        </p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add defaulter'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Defaulters() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);

  const { data, loading, error } = useLoad(async () => {
    const [loans, photos] = await Promise.all([
      q(
        supabase
          .from('loan_summary')
          .select('id,loan_no,borrower_id,borrower_name,borrower_phone,borrower_address,principal,total_repayable,collected_cash,outstanding,last_paid_on,loan_date,defaulted_on,closed_on,status,old_defaulter,notes,created_at')
          .or('status.eq.defaulted,and(old_defaulter.eq.true,status.eq.closed)')
          .order('borrower_name'),
      ),
      q(supabase.from('borrowers').select('id,photo_url').not('photo_url', 'is', null)),
    ]);
    const photo = Object.fromEntries(photos.map((p) => [p.id, p.photo_url]));
    return loans.map((l) => ({ ...l, photo_url: photo[l.borrower_id] || null }));
  }, []);

  const all = data || [];
  const pending = all.filter((l) => l.status === 'defaulted');
  const cleared = all.filter((l) => l.status === 'closed');
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (tab === 'pending' ? pending : cleared).filter(
      (l) => !s || `${l.borrower_name} ${l.borrower_phone || ''} ${l.borrower_address || ''} ${l.loan_no}`.toLowerCase().includes(s),
    );
  }, [all, tab, search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader title="Defaulters" hindi="डिफ़ॉल्टर" subtitle="Everyone who stopped paying — take whatever they give and the balance goes down">
        <ExportButton
          filename={`defaulters-${todayStr()}.csv`}
          rows={rows}
          columns={[
            { label: 'Name', key: 'borrower_name' }, { label: 'Phone', key: 'borrower_phone' }, { label: 'Loan #', key: 'loan_no' },
            { label: 'Type', value: (l) => (l.old_defaulter ? 'Old (before software)' : 'Defaulted loan') },
            { label: 'Since', value: (l) => (l.old_defaulter ? addedOn(l) : l.defaulted_on) }, { label: 'Received', key: 'collected_cash' },
            { label: 'Balance', key: 'outstanding' }, { label: 'Last payment', key: 'last_paid_on' },
          ]}
        />
        <PrintButton />
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'add' })}>+ Add old defaulter</button>
      </PageHeader>

      <div className="stats">
        <Stat label="Defaulters · डिफ़ॉल्टर" value={pending.length} hint={`${pending.filter((l) => l.old_defaulter).length} old · ${pending.filter((l) => !l.old_defaulter).length} from loans`} />
        <Stat label="Balance to take · बाकी" value={money(sum(pending, 'outstanding'))} tone="red" />
        <Stat label="Received from them · जमा" value={money(sum(pending, 'collected_cash'))} tone="green" hint="Payments taken while defaulted / since added" />
        <Stat label="Cleared · चुकता" value={cleared.length} hint="Old defaulters who paid it all" />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pending', label: 'Pending · बाकी', count: pending.length },
              { value: 'cleared', label: 'Cleared · चुकता', count: cleared.length },
            ]}
          />
        }
        actions={<SearchInput value={search} onChange={setSearch} placeholder="Name / phone / address / loan #" />}
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{tab === 'pending' ? 'No defaulters. Use "+ Add old defaulter" for dues from before the software.' : 'Nobody cleared yet.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Defaulter</th><th>Since</th><th className="num">Received</th><th className="num">Balance · बाकी</th><th>Last payment</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => navigate(`/loans/${l.id}`)}>
                    <td>
                      <div className="person-cell">
                        <Avatar url={l.photo_url} name={l.borrower_name} />
                        <div>
                          <strong>{l.borrower_name}</strong>
                          {l.old_defaulter ? <span className="badge badge-grey ml">Old</span> : <span className="badge badge-red ml">Loan #{l.loan_no}</span>}
                          <div className="muted small">{[l.borrower_phone, l.borrower_address].filter(Boolean).join(' · ') || '—'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap">
                      {fmtDate(l.old_defaulter ? addedOn(l) : l.defaulted_on)}
                      {l.old_defaulter && toNum(l.principal) !== toNum(l.total_repayable) && <div className="muted small">Loan was {money(l.principal)}</div>}
                    </td>
                    <td className="num amt-in">{money(l.collected_cash)}</td>
                    <td className="num"><strong className={toNum(l.outstanding) > 0 ? 'amt-out' : ''}>{money(l.outstanding)}</strong></td>
                    <td className="nowrap">{l.last_paid_on ? fmtDate(l.last_paid_on) : <span className="muted">Never</span>}</td>
                    <td className="num nowrap" onClick={(e) => e.stopPropagation()}>
                      {l.status === 'defaulted' && (
                        <button className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'pay', loan: l })}>₹ Take payment</button>
                      )}
                      {l.old_defaulter && (
                        <button className="btn btn-sm ml" onClick={() => setModal({ kind: 'edit', loan: l })}>Edit</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {tab === 'pending' && (
                <tfoot>
                  <tr>
                    <td colSpan={2}>Total</td>
                    <td className="num">{money(sum(rows, 'collected_cash'))}</td>
                    <td className="num">{money(sum(rows, 'outstanding'))}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </Card>
      <p className="muted small">
        Loans marked <strong>Defaulted</strong> from the loan page show here too — open them to Settle or Resume.{' '}
        <Link to="/loans">All loans →</Link>
      </p>

      {modal?.kind === 'add' && <OldDefaulterModal onClose={() => setModal(null)} />}
      {modal?.kind === 'edit' && <OldDefaulterModal loan={modal.loan} onClose={() => setModal(null)} />}
      {modal?.kind === 'pay' && <DefaulterPayModal loan={modal.loan} onClose={() => setModal(null)} />}
    </>
  );
}
