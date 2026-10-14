import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, ErrorBox, Field, Loading, ModeSelect, PageHeader } from '../../components/ui.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { getBorrowers } from '../../lib/api.js';
import { fmtDateLong, money, round2, toNum, todayStr } from '../../lib/format.js';
import { deriveLoan } from '../../lib/loanMath.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import { BORROWER_FIELDS, BorrowerFields, cleanBorrower } from './BorrowerForm.jsx';

const AUTO_FIELDS = ['interest_amount', 'daily_installment', 'total_repayable', 'duration_days', 'advance_amount'];

/** Number input that shows the calculated value until the user types their own. */
function AutoInput({ name, form, ov, derived, setForm, setOv, step = 'any' }) {
  const overridden = !!ov[name];
  const value = overridden ? form[name] : derived[name];
  return (
    <div className={`auto-input ${overridden ? 'is-manual' : 'is-auto'}`}>
      <input
        type="number"
        min="0"
        step={step}
        value={value === 0 && !overridden ? '0' : value}
        onChange={(e) => {
          setForm((f) => ({ ...f, [name]: e.target.value }));
          setOv((o) => ({ ...o, [name]: true }));
        }}
      />
      {overridden ? (
        <button type="button" className="auto-tag" title="Go back to auto calculation" onClick={() => setOv((o) => ({ ...o, [name]: false }))}>
          ↺ auto
        </button>
      ) : (
        <span className="auto-tag">auto</span>
      )}
    </div>
  );
}

export default function LoanForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { settings } = useSettings();
  const [busy, run] = useAction(toast);

  const today = todayStr();
  const [form, setForm] = useState({
    principal: '10000',
    interest_pct: '4',
    interest_amount: '',
    markup_pct: '20',
    total_repayable: '',
    daily_installment: '',
    duration_days: '',
    advance_days: '10',
    advance_amount: '',
    loan_date: today,
    collection_start_date: today,
    status: 'active',
    notes: '',
  });
  const [ov, setOv] = useState({});
  const [borrowerMode, setBorrowerMode] = useState('existing');
  const [borrowerId, setBorrowerId] = useState(params.get('borrower') || '');
  const [borrowerSearch, setBorrowerSearch] = useState('');
  const [newBorrower, setNewBorrower] = useState({ ...BORROWER_FIELDS });
  const [giveNow, setGiveNow] = useState(true);
  const [giveAmount, setGiveAmount] = useState('');
  const [giveMode, setGiveMode] = useState('cash');
  const [ready, setReady] = useState(!isEdit);
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  const borrowers = useLoad(getBorrowers, []);

  // Renewal: /loans/new?renew=<old loan id>
  const renewId = !isEdit ? params.get('renew') : null;
  const oldLoan = useLoad(
    () => (renewId ? q(supabase.from('loan_summary').select('*').eq('id', renewId).single()) : null),
    [renewId],
  );
  const old = oldLoan.data;
  const oldBalance = old ? round2(toNum(old.outstanding)) : 0;
  const [adjust, setAdjust] = useState('');
  const [renewReady, setRenewReady] = useState(false);
  useEffect(() => {
    if (!old || renewReady) return;
    setBorrowerId(old.borrower_id);
    setBorrowerMode('existing');
    setAdjust(String(oldBalance));
    setForm((f) => ({ ...f, principal: String(old.principal) }));
    setRenewReady(true);
  }, [old, renewReady, oldBalance]);
  // A brand-new loan for someone who already has a running loan → offer renewal.
  const running = useLoad(
    () =>
      !isEdit && !renewId && borrowerMode === 'existing' && borrowerId
        ? q(supabase.from('loan_summary').select('id,loan_no,outstanding,daily_installment').eq('borrower_id', borrowerId).in('status', ['active', 'defaulted']))
        : [],
    [borrowerId, borrowerMode, renewId, isEdit],
  );
  const adjustAmt = renewId ? round2(adjust) : 0;
  const discount = renewId ? round2(Math.max(0, oldBalance - adjustAmt)) : 0;

  // Apply defaults from Settings once (new loans only).
  useEffect(() => {
    if (isEdit || !settings || defaultsApplied) return;
    setForm((f) => ({
      ...f,
      interest_pct: String(settings.default_interest_pct ?? 4),
      markup_pct: String(settings.default_markup_pct ?? 20),
      advance_days: String(settings.default_advance_days ?? 10),
    }));
    setDefaultsApplied(true);
  }, [settings, isEdit, defaultsApplied]);

  // Load an existing loan for editing — all amounts treated as manual so nothing shifts.
  useEffect(() => {
    if (!isEdit) return;
    (async () => {
      try {
        const l = await q(supabase.from('loans').select('*').eq('id', id).single());
        setForm({
          principal: String(l.principal),
          interest_pct: String(l.interest_pct),
          interest_amount: String(l.interest_amount),
          markup_pct: String(l.markup_pct),
          total_repayable: String(l.total_repayable),
          daily_installment: String(l.daily_installment),
          duration_days: String(l.duration_days),
          advance_days: String(l.advance_days),
          advance_amount: String(l.advance_amount),
          loan_date: l.loan_date,
          collection_start_date: l.collection_start_date,
          status: l.status,
          notes: l.notes || '',
        });
        setOv(Object.fromEntries(AUTO_FIELDS.map((k) => [k, true])));
        setBorrowerId(l.borrower_id);
        setReady(true);
      } catch (e) {
        toast.error(e.message);
      }
    })();
  }, [id, isEdit, toast]);

  const dailyPer10k = settings?.default_daily_per_10k ?? 150;
  const d = useMemo(() => deriveLoan(form, ov, dailyPer10k), [form, ov, dailyPer10k]);
  const cashToGive = round2(d.net - adjustAmt);
  const renewErrors = [];
  if (renewId && old) {
    if (!['active', 'defaulted'].includes(old.status)) renewErrors.push(`Loan #${old.loan_no} is not running — cannot renew.`);
    if (adjustAmt < 0) renewErrors.push('Old balance to cut cannot be negative.');
    if (adjustAmt > oldBalance + 0.001) renewErrors.push(`Cannot cut more than the old balance ${money(oldBalance)}.`);
    if (cashToGive < 0) renewErrors.push(`Old balance ${money(adjustAmt)} is more than this loan's cash ${money(d.net)} — make the new loan bigger.`);
  }
  const allErrors = [...d.errors, ...renewErrors];

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const autoProps = { form, ov, derived: d, setForm, setOv };

  const filteredBorrowers = useMemo(() => {
    const s = borrowerSearch.trim().toLowerCase();
    const list = borrowers.data || [];
    if (!s) return list;
    return list.filter((b) => `${b.name} ${b.phone || ''} ${b.occupation || ''}`.toLowerCase().includes(s));
  }, [borrowers.data, borrowerSearch]);

  const selectedBorrower = (borrowers.data || []).find((b) => b.id === borrowerId);

  async function submit(e) {
    e.preventDefault();
    if (allErrors.length) return toast.error(allErrors[0]);
    if (!isEdit && borrowerMode === 'existing' && !borrowerId) return toast.error('Choose a borrower or add a new one.');
    if (!isEdit && borrowerMode === 'new' && !newBorrower.name.trim()) return toast.error('Borrower name is required.');
    const give = giveNow ? round2(giveAmount === '' ? cashToGive : giveAmount) : 0;
    if (!isEdit && give > cashToGive + 0.001) return toast.error(`Cannot give more than ${money(cashToGive)} now.`);

    const loanPayload = {
      principal: d.principal,
      interest_pct: toNum(form.interest_pct),
      interest_amount: d.interest_amount,
      markup_pct: d.effMarkup,
      total_repayable: d.total_repayable,
      daily_installment: d.daily_installment,
      duration_days: d.duration_days,
      advance_days: Math.max(0, Math.round(toNum(form.advance_days))),
      advance_amount: d.advance_amount,
      loan_date: form.loan_date,
      collection_start_date: form.collection_start_date,
      notes: form.notes.trim() || null,
    };

    const res = await run(async () => {
      if (isEdit) {
        await q(supabase.from('loans').update({ ...loanPayload, status: form.status }).eq('id', id));
        // Auto-close if the new total is already collected (a manual "closed"/"defaulted" choice is kept).
        if (form.status === 'active') await q(supabase.rpc('recalc_loan_status', { p_loan: id }));
        return { id };
      }
      let bId = borrowerId;
      if (borrowerMode === 'new') {
        const b = await q(supabase.from('borrowers').insert(cleanBorrower(newBorrower)).select('id').single());
        bId = b.id;
      }
      const loan = await q(supabase.from('loans').insert({ ...loanPayload, borrower_id: bId }).select('id').single());
      if (renewId) {
        try {
          await q(supabase.rpc('renew_loan', { p_old: renewId, p_new: loan.id, p_adjust: adjustAmt, p_date: form.loan_date }));
        } catch (e) {
          // Do not leave a half-done renewal behind.
          await q(supabase.from('loans').delete().eq('id', loan.id));
          throw e;
        }
      }
      if (give > 0) {
        await q(
          supabase.from('loan_disbursements').insert({
            loan_id: loan.id, paid_on: form.loan_date, amount: give, mode: giveMode, note: 'Given at loan creation',
          }),
        );
      }
      return loan;
    }, isEdit ? 'Loan updated' : renewId ? `Loan renewed · old loan #${old?.loan_no} closed` : 'Loan created');

    if (res) navigate(`/loans/${res.id}`);
  }

  if (!ready) return <Loading />;

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit loan terms' : renewId ? 'Renew loan' : 'New loan'}
        hindi={isEdit ? 'उधारी बदलें' : renewId ? 'लोन रिन्यू' : 'नई उधारी'}
        subtitle="Every amount is flexible — type over any “auto” value to set your own."
      >
        <Link to={isEdit ? `/loans/${id}` : renewId ? `/loans/${renewId}` : '/loans'} className="btn">Cancel</Link>
      </PageHeader>

      <form onSubmit={submit} className="loan-form">
        <div className="loan-form-main">
          {renewId ? (
            <Card title="1 · Old loan to renew (पुराना लोन)" className="renew-box">
              <ErrorBox error={oldLoan.error} />
              {!old ? (
                <Loading />
              ) : (
                <>
                  <div className="kv-list">
                    <div><span>Borrower</span><strong>{old.borrower_name} {old.borrower_phone ? `· ${old.borrower_phone}` : ''}</strong></div>
                    <div><span>Old loan</span><strong>#{old.loan_no} · {money(old.principal)} · {money(old.daily_installment)}/day</strong></div>
                    <div><span>Paid till</span><strong>{old.paid_till ? fmtDateLong(old.paid_till) : 'nothing paid yet'}</strong></div>
                    <div className="kv-total"><span>Old balance still to collect (बाकी)</span><strong>{money(oldBalance)}</strong></div>
                  </div>
                  <div className="form-grid" style={{ marginTop: 12 }}>
                    <Field
                      label="Cut from new loan (पुराना बाकी काटें) ₹"
                      hint={discount > 0 ? `Discount (छूट) given: ${money(discount)} — this part is forgiven` : 'Full old balance is cut. Lower it only if you want to give a discount (छूट).'}
                    >
                      <input className="input-big" type="number" min="0" step="any" value={adjust} onChange={(e) => setAdjust(e.target.value)} />
                    </Field>
                  </div>
                  <p className="muted small">
                    The old loan will be marked <strong>Renewed</strong> and closed. This cut is not cash — it does not go in the cash book.
                  </p>
                </>
              )}
            </Card>
          ) : !isEdit ? (
            <Card title="1 · Borrower (कौन ले रहा है)">
              <div className="segmented">
                <button type="button" className={borrowerMode === 'existing' ? 'active' : ''} onClick={() => setBorrowerMode('existing')}>Existing borrower</button>
                <button type="button" className={borrowerMode === 'new' ? 'active' : ''} onClick={() => setBorrowerMode('new')}>+ New borrower</button>
              </div>
              {borrowerMode === 'existing' ? (
                <>
                  <ErrorBox error={borrowers.error} />
                  <input
                    type="search"
                    className="search full"
                    placeholder="Search name / phone / work…"
                    value={borrowerSearch}
                    onChange={(e) => setBorrowerSearch(e.target.value)}
                  />
                  <div className="pick-list">
                    {filteredBorrowers.length === 0 && (
                      <div className="muted small pad">No borrower found. Use “+ New borrower”.</div>
                    )}
                    {filteredBorrowers.slice(0, 50).map((b) => (
                      <button
                        type="button"
                        key={b.id}
                        className={`pick ${b.id === borrowerId ? 'active' : ''}`}
                        onClick={() => setBorrowerId(b.id)}
                      >
                        <strong>{b.name}</strong>
                        <span className="muted small">{[b.occupation, b.phone].filter(Boolean).join(' · ')}</span>
                      </button>
                    ))}
                  </div>
                  {(running.data || []).map((r) => (
                    <div key={r.id} className="help-box renew-box" style={{ marginTop: 12 }}>
                      ⚠ This borrower already has <strong>Loan #{r.loan_no}</strong> running with <strong>{money(r.outstanding)}</strong> still to collect.
                      <div className="btn-row" style={{ marginTop: 8 }}>
                        <Link className="btn btn-primary" to={`/loans/new?renew=${r.id}`}>🔁 Renew loan #{r.loan_no} (cut old balance)</Link>
                        <span className="muted small">or continue below for a separate second loan</span>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <BorrowerFields value={newBorrower} onChange={setNewBorrower} compact />
              )}
            </Card>
          ) : (
            <Card title="Borrower">
              <strong>{selectedBorrower?.name || '…'}</strong>{' '}
              <span className="muted">{selectedBorrower?.phone}</span>
            </Card>
          )}

          <Card title={isEdit ? 'Loan terms' : '2 · Loan terms (शर्तें)'}>
            <div className="form-grid three">
              <Field label="Loan amount (मूल रकम) *">
                <input type="number" min="1" step="any" required value={form.principal} onChange={set('principal')} />
              </Field>
              <Field label="Interest % cut upfront (ब्याज %)">
                <input type="number" min="0" step="any" value={form.interest_pct} onChange={set('interest_pct')} />
              </Field>
              <Field label="Interest amount (₹)">
                <AutoInput name="interest_amount" {...autoProps} />
              </Field>

              <Field label="Daily installment (रोज़ की किश्त)" hint={`Default ₹${dailyPer10k} per ₹10,000`}>
                <AutoInput name="daily_installment" {...autoProps} />
              </Field>
              <Field label="Extra on principal % (मुनाफ़ा)" hint="10,000 → 12,000 = 20%">
                <input type="number" min="0" step="any" value={form.markup_pct} onChange={set('markup_pct')} disabled={ov.total_repayable || ov.duration_days} />
              </Field>
              <Field label="Total to repay (कुल वापसी)">
                <AutoInput name="total_repayable" {...autoProps} />
              </Field>

              <Field label="Duration (days)" hint="Typing days sets total = daily × days">
                <AutoInput name="duration_days" step="1" {...autoProps} />
              </Field>
              <Field label="Advance installments kept (days)" hint="e.g. 10 days × daily, kept upfront">
                <input type="number" min="0" step="1" value={form.advance_days} onChange={set('advance_days')} />
              </Field>
              <Field label="Advance amount (₹)">
                <AutoInput name="advance_amount" {...autoProps} />
              </Field>

              <Field label="Loan date">
                <input type="date" required max={todayStr()} value={form.loan_date} onChange={set('loan_date')} />
              </Field>
              <Field label="Daily collection starts on">
                <input type="date" required value={form.collection_start_date} onChange={set('collection_start_date')} />
              </Field>
              {isEdit && (
                <Field label="Status">
                  <select value={form.status} onChange={set('status')}>
                    <option value="active">Active</option>
                    <option value="closed">Closed</option>
                    <option value="defaulted">Defaulted</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </Field>
              )}
              <Field label="Notes" span={3}>
                <textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Guarantee, gold kept, any special terms…" />
              </Field>
            </div>
          </Card>

          {!isEdit && (
            <Card title="3 · Give money now? (पैसे देना)">
              <label className="check">
                <input type="checkbox" checked={giveNow} onChange={(e) => setGiveNow(e.target.checked)} />
                Record a payment to the borrower now
              </label>
              {giveNow && (
                <div className="form-grid three">
                  <Field label="Amount given now" hint={`Cash payable is ${money(cashToGive)}. Give the rest later from the loan page.`}>
                    <input type="number" min="0" step="any" value={giveAmount} placeholder={String(cashToGive)} onChange={(e) => setGiveAmount(e.target.value)} />
                  </Field>
                  <Field label="Mode"><ModeSelect value={giveMode} onChange={setGiveMode} /></Field>
                </div>
              )}
            </Card>
          )}
        </div>

        <aside className="loan-form-side">
          <div className="calc-card">
            <h3>Hisaab · हिसाब</h3>
            <div className="calc-row"><span>Loan amount</span><strong>{money(d.principal)}</strong></div>
            <div className="calc-row minus"><span>− Interest cut ({d.effInterestPct}%)</span><strong>{money(d.interest_amount)}</strong></div>
            <div className="calc-row"><span>Loan given (cash out)</span><strong>{money(d.principal - d.interest_amount)}</strong></div>
            <div className="calc-row minus"><span>− Advance kept ({form.advance_days || 0} days) · income</span><strong>{money(d.advance_amount)}</strong></div>
            {renewId && (
              <div className="calc-row minus"><span>− Old loan #{old?.loan_no} balance</span><strong>{money(adjustAmt)}</strong></div>
            )}
            <div className="calc-row total"><span>Cash to give (देना)</span><strong>{money(cashToGive)}</strong></div>

            <div className="calc-sep" />
            <div className="calc-row"><span>Daily installment</span><strong>{money(d.daily_installment)}</strong></div>
            <div className="calc-row"><span>Total repayable</span><strong>{money(d.total_repayable)}</strong></div>
            <div className="calc-row"><span>Duration</span><strong>{d.duration_days} days</strong></div>
            <div className="calc-row minus"><span>− Already kept as advance</span><strong>{money(d.advance_amount)}</strong></div>
            <div className="calc-row total"><span>To collect daily (लेना)</span><strong>{money(d.toCollect)}</strong></div>
            <div className="calc-row"><span>Installments left</span><strong>{d.collectDays}</strong></div>
            <div className="calc-row"><span>Day 1 of loan</span><strong>{fmtDateLong(form.collection_start_date)}</strong></div>
            {d.advanceDaysCovered > 0 && (
              <div className="calc-row"><span>Paid by advance</span><strong>first {d.advanceDaysCovered} days</strong></div>
            )}
            <div className="calc-row"><span>First cash collection</span><strong>{d.firstCashDate ? fmtDateLong(d.firstCashDate) : '—'}</strong></div>
            <div className="calc-row"><span>Last collection</span><strong>{d.endDate ? fmtDateLong(d.endDate) : '—'}</strong></div>

            <div className="calc-sep" />
            <div className="calc-row profit"><span>Expected profit</span><strong>{money(d.profit)}</strong></div>
            <div className="muted small">
              Interest {money(d.interest_amount)} + extra {money(round2(d.total_repayable - d.principal))} ({d.effMarkup}%)
            </div>

            {allErrors.length > 0 && (
              <div className="alert alert-error small">
                {allErrors.map((er) => <div key={er}>{er}</div>)}
              </div>
            )}

            <button className="btn btn-primary btn-block" disabled={busy || allErrors.length > 0 || (renewId && !old)}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : renewId ? '🔁 Renew loan' : 'Create loan'}
            </button>
          </div>
        </aside>
      </form>
    </>
  );
}
