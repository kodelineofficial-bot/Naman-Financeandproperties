import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, ErrorBox, Field, Loading, ModeSelect, PageHeader } from '../../components/ui.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { getBorrowers } from '../../lib/api.js';
import { fmtDateLong, money, round2, toNum, todayStr } from '../../lib/format.js';
import { FREQ, deriveLoan, freqOf } from '../../lib/loanMath.js';
import { canSyncPayout, isCashDisbursement, loanOverridesAfterEdit, loanPayoutEdits } from '../../lib/loanEdits.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import { BORROWER_FIELDS, BorrowerFields, cleanBorrower } from './BorrowerForm.jsx';

const AUTO_FIELDS = ['interest_amount', 'daily_installment', 'total_repayable', 'duration_days', 'advance_amount'];

/** Number input that shows the calculated value until the user types their own. */
function AutoInput({ name, form, ov, derived, onChange, onAuto, step = 'any' }) {
  const overridden = !!ov[name];
  const value = overridden ? form[name] : derived[name];
  return (
    <div className={`auto-input ${overridden ? 'is-manual' : 'is-auto'}`}>
      <input
        type="number"
        min="0"
        step={step}
        value={value === 0 && !overridden ? '0' : value}
        onChange={(e) => onChange(name, e.target.value)}
      />
      {overridden ? (
        <button type="button" className="auto-tag" title="Go back to auto calculation" onClick={() => onAuto(name)}>
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
    frequency: 'daily',
    principal: '10000',
    interest_pct: '4',
    interest_amount: '',
    markup_pct: '20',
    total_repayable: '',
    daily_installment: '',
    duration_days: '',
    advance_days: '10',
    advance_amount: '',
    advance_mode: 'cash',
    penalty_per_day: '',
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
  const [loadError, setLoadError] = useState(null);
  const [originalLoan, setOriginalLoan] = useState(null);
  const [disbursements, setDisbursements] = useState([]);
  const [payoutAmounts, setPayoutAmounts] = useState({});
  const [syncPayout, setSyncPayout] = useState(false);
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
    // Same type as the old loan (daily / monthly); it can still be switched below.
    const fq = old.frequency || 'daily';
    setForm((f) => ({
      ...f,
      principal: String(old.principal),
      frequency: fq,
      ...(fq !== f.frequency && { duration_days: '', daily_installment: '', advance_amount: '', advance_days: fq === 'monthly' ? '0' : f.advance_days }),
    }));
    setRenewReady(true);
  }, [old, renewReady, oldBalance]);
  // A brand-new loan for someone who already has a running loan → offer renewal.
  const running = useLoad(
    () =>
      !isEdit && !renewId && borrowerMode === 'existing' && borrowerId
        ? q(supabase.from('loan_summary').select('id,loan_no,principal,outstanding,overdue,daily_installment,frequency').eq('borrower_id', borrowerId).in('status', ['active', 'defaulted']).order('loan_no'))
        : [],
    [borrowerId, borrowerMode, renewId, isEdit],
  );
  const adjustAmt = renewId ? round2(adjust) : 0;
  // Optional: cut old loans' overdue from this loan's cash; those loans keep running (migration 016).
  const [cuts, setCuts] = useState({});
  const cutRows = (running.data || [])
    .filter((r) => cuts[r.id]?.on)
    .map((r) => ({ ...r, cut: round2(cuts[r.id].amount), max: round2(toNum(r.outstanding)) }));
  const cutTotal = round2(cutRows.reduce((t, r) => t + r.cut, 0));
  // Monthly loan: pick how many months to cut; amount = months × installment, never past the balance.
  const monthsLeft = (r) => Math.ceil(round2(toNum(r.outstanding)) / toNum(r.daily_installment) - 0.001) || 0;
  const monthsAmount = (r, months) => round2(Math.min(months * toNum(r.daily_installment), toNum(r.outstanding)));
  function toggleCut(r, on) {
    setCuts((c) => {
      if (c[r.id]) return { ...c, [r.id]: { ...c[r.id], on } };
      if (r.frequency !== 'monthly') return { ...c, [r.id]: { on, amount: String(round2(toNum(r.overdue))) } };
      // default: the overdue months, at least one
      const months = Math.min(Math.max(1, Math.ceil(toNum(r.overdue) / toNum(r.daily_installment) - 0.001)), monthsLeft(r));
      return { ...c, [r.id]: { on, months: String(months), amount: String(monthsAmount(r, months)) } };
    });
  }
  function setCutMonths(r, value) {
    const months = value === '' ? '' : Math.max(0, Math.min(Math.floor(toNum(value)), monthsLeft(r)));
    setCuts((c) => ({ ...c, [r.id]: { ...c[r.id], months: String(months), amount: String(monthsAmount(r, toNum(months))) } }));
  }
  const discount = renewId ? round2(Math.max(0, oldBalance - adjustAmt)) : 0;

  // Apply defaults from Settings once (new loans only).
  useEffect(() => {
    if (isEdit || !settings || defaultsApplied) return;
    setForm((f) => ({
      ...f,
      interest_pct: String(settings.default_interest_pct ?? 4),
      markup_pct: String(settings.default_markup_pct ?? 20),
      // The default advance days are for daily loans; a monthly loan keeps its own value.
      advance_days: f.frequency === 'monthly' ? f.advance_days : String(settings.default_advance_days ?? 10),
      penalty_per_day: settings.penalty_enabled ? String(settings.penalty_per_day ?? '') : '',
    }));
    setDefaultsApplied(true);
  }, [settings, isEdit, defaultsApplied]);

  // Preserve loaded amounts; derive duration from the schedule that reports use.
  useEffect(() => {
    if (!isEdit) return;
    let alive = true;
    setReady(false);
    setLoadError(null);
    (async () => {
      try {
        const [l, payouts] = await Promise.all([
          q(supabase.from('loans').select('*').eq('id', id).single()),
          q(supabase.from('loan_disbursements').select('*').eq('loan_id', id).order('paid_on').order('created_at').order('id')),
        ]);
        if (!alive) return;
        setOriginalLoan(l);
        setDisbursements(payouts);
        setPayoutAmounts({});
        setSyncPayout(canSyncPayout(l, payouts));
        setForm({
          frequency: l.frequency || 'daily',
          principal: String(l.principal),
          interest_pct: String(l.interest_pct),
          interest_amount: String(l.interest_amount),
          markup_pct: String(l.markup_pct),
          total_repayable: String(l.total_repayable),
          daily_installment: String(l.daily_installment),
          duration_days: String(l.duration_days),
          advance_days: String(l.advance_days),
          advance_amount: String(l.advance_amount),
          advance_mode: l.advance_mode || (payouts.find(isCashDisbursement)?.mode === 'upi' ? 'upi' : 'cash'),
          penalty_per_day: l.penalty_per_day == null ? '' : String(l.penalty_per_day),
          loan_date: l.loan_date,
          collection_start_date: l.collection_start_date,
          status: l.status,
          notes: l.notes || '',
        });
        setOv({ ...Object.fromEntries(AUTO_FIELDS.map((k) => [k, true])), duration_days: false });
        setBorrowerId(l.borrower_id);
        setReady(true);
      } catch (e) {
        if (!alive) return;
        setLoadError(e);
        toast.error(e.message);
      }
    })();
    return () => { alive = false; };
  }, [id, isEdit, toast]);

  const dailyPer10k = settings?.default_daily_per_10k ?? 150;
  const F = FREQ[form.frequency] || FREQ.daily;
  const monthly = form.frequency === 'monthly';
  const d = useMemo(() => deriveLoan(form, ov, dailyPer10k, form.frequency), [form, ov, dailyPer10k]);

  // Daily ↔ monthly: start the amounts again from auto with sensible advance defaults.
  function setFrequency(fq) {
    if (fq === form.frequency) return;
    setForm((f) => ({
      ...f,
      frequency: fq,
      duration_days: '',
      daily_installment: '',
      advance_amount: '',
      advance_days: fq === 'monthly' ? '0' : String(settings?.default_advance_days ?? 10),
    }));
    setOv((o) => ({ ...o, daily_installment: false, duration_days: false, advance_amount: false }));
  }
  const cashToGive = round2(d.net - adjustAmt - cutTotal);
  const payoutEdits = originalLoan ? loanPayoutEdits(originalLoan, disbursements, d.net, syncPayout, payoutAmounts) : [];
  const adjustedPayout = disbursements.filter((r) => !isCashDisbursement(r)).reduce((total, r) => total + toNum(r.amount), 0);
  const recordedPayout = round2(adjustedPayout + payoutEdits.reduce((total, r) => total + r.amount, 0));
  const renewErrors = [];
  if (renewId && old) {
    if (!['active', 'defaulted'].includes(old.status)) renewErrors.push(`Loan #${old.loan_no} is not running — cannot renew.`);
    if (adjustAmt < 0) renewErrors.push('Old balance to cut cannot be negative.');
    if (adjustAmt > oldBalance + 0.001) renewErrors.push(`Cannot cut more than the old balance ${money(oldBalance)}.`);
    if (cashToGive < 0) renewErrors.push(`Old balance ${money(adjustAmt)} is more than this loan's cash ${money(d.net)} — make the new loan bigger.`);
  }
  for (const r of cutRows) {
    if (r.cut < 0) renewErrors.push(`Loan #${r.loan_no}: cut cannot be negative.`);
    if (r.cut > r.max + 0.001) renewErrors.push(`Loan #${r.loan_no}: cannot cut more than its balance ${money(r.max)}.`);
  }
  if (!renewId && cutTotal > 0 && cashToGive < 0) renewErrors.push(`Old dues ${money(cutTotal)} are more than this loan's cash ${money(d.net)} — make the new loan bigger or cut less.`);
  const payoutErrors = [];
  if (isEdit && payoutEdits.some((r) => r.amount <= 0)) payoutErrors.push('Each recorded payout must be more than 0. Remove an incorrect payout from the loan page.');
  if (isEdit && recordedPayout > d.net + 0.005) payoutErrors.push(`Recorded payouts exceed cash to give by ${money(recordedPayout - d.net)}. Correct the amount handed over below.`);
  const allErrors = [...d.errors, ...renewErrors, ...payoutErrors];

  function changeField(name, value, manual = true) {
    // Materialize calculated values before switching which field drives them.
    setForm((f) => ({ ...f, ...Object.fromEntries(AUTO_FIELDS.map((k) => [k, String(d[k])])), [name]: value }));
    setOv((o) => loanOverridesAfterEdit(o, name, manual));
  }
  const set = (k) => (e) => changeField(k, e.target.value);
  const autoProps = { form, ov, derived: d, onChange: changeField, onAuto: (name) => changeField(name, String(d[name]), false) };

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
      frequency: form.frequency,
      principal: d.principal,
      interest_pct: toNum(form.interest_pct),
      interest_amount: d.interest_amount,
      markup_pct: d.effMarkup,
      total_repayable: d.total_repayable,
      daily_installment: d.daily_installment,
      duration_days: d.duration_days,
      advance_days: Math.max(0, Math.round(toNum(form.advance_days))),
      advance_amount: d.advance_amount,
      advance_mode: form.advance_mode,
      // Blank = follow the penalty rule in Settings.
      penalty_per_day: form.penalty_per_day === '' ? null : Math.max(0, round2(form.penalty_per_day)),
      loan_date: form.loan_date,
      collection_start_date: form.collection_start_date,
      notes: form.notes.trim() || null,
    };

    const res = await run(async () => {
      if (isEdit) {
        await q(supabase.rpc('edit_loan_terms', {
          p_loan: id,
          p_terms: { ...loanPayload, status: form.status },
          p_disbursements: payoutEdits.map((r) => ({ id: r.id, amount: r.amount, original_amount: r.original_amount })),
          p_expected_updated_at: originalLoan.updated_at,
        }));
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
      if (!renewId && cutRows.some((r) => r.cut > 0)) {
        try {
          for (const r of cutRows) {
            if (r.cut > 0) await q(supabase.rpc('cut_overdue_into_loan', { p_old: r.id, p_new: loan.id, p_amount: r.cut, p_date: form.loan_date }));
          }
        } catch (e) {
          // Deleting the new loan also removes any cut already made (on delete cascade).
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
    }, isEdit ? 'Loan updated' : renewId ? `Loan renewed · old loan #${old?.loan_no} closed`
      : cutTotal > 0 ? `Loan created · ${money(cutTotal)} old dues cut` : 'Loan created');

    if (res) navigate(`/loans/${res.id}`);
  }

  if (loadError) return <ErrorBox error={loadError} />;
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
                    <div><span>Old loan</span><strong>#{old.loan_no} · {money(old.principal)} · {money(old.daily_installment)}{freqOf(old).per}</strong></div>
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
                  {(running.data || []).map((r) => {
                    const c = cuts[r.id];
                    const overdue = round2(toNum(r.overdue));
                    const monthly = r.frequency === 'monthly';
                    return (
                      <div key={r.id} className="help-box renew-box" style={{ marginTop: 12 }}>
                        ⚠ This borrower already has <strong>Loan #{r.loan_no}</strong>
                        {monthly && <> (monthly · {money(r.daily_installment)}/month)</>} ({money(r.principal)}) running with{' '}
                        <strong>{money(r.outstanding)}</strong> still to collect
                        {overdue > 0 ? <> · overdue (बकाया) <strong>{money(overdue)}</strong></> : ' · nothing overdue'}.
                        {toNum(r.outstanding) > 0 && (
                          <div style={{ marginTop: 8 }}>
                            <label className="check">
                              <input type="checkbox" checked={!!c?.on} onChange={(e) => toggleCut(r, e.target.checked)} />
                              {monthly
                                ? <>Cut monthly installment of loan #{r.loan_no} from this new loan (मासिक किस्त काटें)</>
                                : <>Cut old dues of loan #{r.loan_no} from this new loan (बकाया काटें)</>}
                            </label>
                            {c?.on && (
                              <div className="form-grid" style={{ marginTop: 8 }}>
                                {monthly ? (
                                  <>
                                    <Field
                                      label="Months to cut (कितने महीने)"
                                      hint={`${money(r.daily_installment)}/month · ${monthsLeft(r)} month${monthsLeft(r) === 1 ? '' : 's'} left on loan #${r.loan_no}`}
                                    >
                                      <div className="amount-cell">
                                        <button type="button" className="step-btn" onClick={() => setCutMonths(r, toNum(c.months) - 1)} aria-label="One month less">−</button>
                                        <input type="number" min="0" max={monthsLeft(r)} step="1" inputMode="numeric" value={c.months} onChange={(e) => setCutMonths(r, e.target.value)} />
                                        <button type="button" className="step-btn" onClick={() => setCutMonths(r, toNum(c.months) + 1)} aria-label="One month more">+</button>
                                      </div>
                                    </Field>
                                    <Field
                                      label="Amount to cut ₹ (auto)"
                                      hint={`${toNum(c.months) || 0} × ${money(r.daily_installment)}${toNum(c.amount) < toNum(c.months) * toNum(r.daily_installment) ? ` — capped at balance ${money(r.outstanding)}` : ''}. Loan #${r.loan_no} keeps running for the rest. Not cash — not in the cash book.`}
                                    >
                                      <input type="text" readOnly value={money(c.amount)} />
                                    </Field>
                                  </>
                                ) : (
                                  <Field
                                    label="Amount to cut ₹"
                                    hint={`Overdue ${money(overdue)} · max ${money(r.outstanding)}. Loan #${r.loan_no} keeps running for the rest. Not cash — not in the cash book.`}
                                  >
                                    <input type="number" min="0" step="any" value={c.amount} onChange={(e) => setCuts((x) => ({ ...x, [r.id]: { ...x[r.id], amount: e.target.value } }))} />
                                  </Field>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="btn-row" style={{ marginTop: 8 }}>
                          <Link className="btn" to={`/loans/new?renew=${r.id}`}>🔁 Renew loan #{r.loan_no} (cut full balance, close it)</Link>
                          <span className="muted small">or continue below for a separate loan</span>
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                <BorrowerFields value={newBorrower} onChange={setNewBorrower} />
              )}
            </Card>
          ) : (
            <Card title="Borrower">
              <strong>{selectedBorrower?.name || '…'}</strong>{' '}
              <span className="muted">{selectedBorrower?.phone}</span>
            </Card>
          )}

          <Card title={isEdit ? 'Loan terms' : '2 · Loan terms (शर्तें)'}>
            <div className="segmented">
              {Object.entries(FREQ).map(([k, v]) => (
                <button type="button" key={k} className={form.frequency === k ? 'active' : ''} onClick={() => setFrequency(k)}>
                  {v.label} loan · {v.hi}
                </button>
              ))}
            </div>
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

              <Field
                label={monthly ? 'Monthly installment (महीने की किश्त)' : 'Daily installment (रोज़ की किश्त)'}
                hint={monthly ? 'Auto = total ÷ months' : `Default ₹${dailyPer10k} per ₹10,000`}
              >
                <AutoInput name="daily_installment" {...autoProps} />
              </Field>
              <Field label="Extra on principal % (मुनाफ़ा)" hint="10,000 → 12,000 = 20%">
                <input type="number" min="0" step="any" value={form.markup_pct} onChange={set('markup_pct')} disabled={ov.total_repayable || (ov.duration_days && ov.daily_installment)} />
              </Field>
              <Field label="Total to repay (कुल वापसी)">
                <AutoInput name="total_repayable" {...autoProps} />
              </Field>

              <Field label={`Duration (${F.units})`} hint={`Changing ${F.units} keeps the installment and updates total = installment × ${F.units}. Changing total recalculates the duration.`}>
                <AutoInput name="duration_days" step="1" {...autoProps} />
              </Field>
              <Field label={`Advance installments kept (${F.units})`} hint={monthly ? 'e.g. 1 month × installment, kept upfront' : 'e.g. 10 days × daily, kept upfront'}>
                <input type="number" min="0" step="1" value={form.advance_days} onChange={set('advance_days')} />
              </Field>
              <Field label="Advance amount (₹)">
                <AutoInput name="advance_amount" {...autoProps} />
              </Field>
              <Field label="Advance received via · एडवांस कैसे लिया?" hint="The retained advance has a matching cut and income in this mode. It does not add extra cash to the balance.">
                <select required value={form.advance_mode} onChange={set('advance_mode')}>
                  <option value="cash">Cash · नकद</option>
                  <option value="upi">UPI</option>
                </select>
              </Field>
              <Field
                label="Penalty per late day (₹) · जुर्माना"
                hint={settings?.penalty_enabled ? `Blank = Settings (${money(settings.penalty_per_day)}/day) · 0 = no penalty` : 'Blank or 0 = no penalty'}
              >
                <input type="number" min="0" step="any" value={form.penalty_per_day} onChange={set('penalty_per_day')} placeholder={settings?.penalty_enabled ? String(settings.penalty_per_day ?? 0) : '0'} />
              </Field>

              <Field label="Loan date">
                <input type="date" required max={todayStr()} value={form.loan_date} onChange={set('loan_date')} />
              </Field>
              <Field label={monthly ? 'First monthly installment on' : 'Daily collection starts on'} hint={monthly ? 'Then the same date every month' : undefined}>
                <input type="date" required value={form.collection_start_date} onChange={set('collection_start_date')} />
              </Field>
              {isEdit && (
                <Field label="Status">
                  <select value={form.status} onChange={set('status')}>
                    <option value="active">Active</option>
                    <option value="closed">Closed</option>
                    <option value="defaulted">Defaulted</option>
                    <option value="cancelled">Cancelled</option>
                    {form.status === 'renewed' && <option value="renewed">Renewed</option>}
                  </select>
                </Field>
              )}
              <Field label="Notes" span={3}>
                <textarea rows={2} value={form.notes} onChange={set('notes')} placeholder="Guarantee, gold kept, any special terms…" />
              </Field>
            </div>
          </Card>

          {isEdit && (
            <Card title="Recorded money given · दिए हुए पैसे">
              <p className="muted small">Correct the actual amount handed over here. Saving updates the original payout in the Day Book, cash balance and reports.</p>
              {canSyncPayout(originalLoan, disbursements) && (
                <label className="check">
                  <input type="checkbox" checked={syncPayout} onChange={(e) => { setSyncPayout(e.target.checked); setPayoutAmounts({}); }} />
                  Match the recorded payout to cash to give
                </label>
              )}
              {payoutEdits.length === 0 ? <p className="muted small">No cash or UPI payout recorded. Use Give money on the loan page to record one.</p> : (
                <div className="form-grid three">
                  {payoutEdits.map((r) => (
                    <Field key={r.id} label={`Amount handed over · ${fmtDateLong(r.paid_on)}`} hint={`${r.mode.toUpperCase()} · was ${money(r.original_amount)}. UPI shows only the amount transferred; cash book out includes advance.`}>
                      <input type="number" min="0.01" step="0.01" required value={payoutAmounts[r.id] ?? r.amount} onChange={(e) => setPayoutAmounts((amounts) => ({ ...amounts, [r.id]: e.target.value }))} />
                    </Field>
                  ))}
                </div>
              )}
              {adjustedPayout > 0 && <p className="muted small">Old balance adjusted: {money(adjustedPayout)}. This stays linked to the original loan.</p>}
              <p className="muted small">Still to give after saving: <strong>{money(Math.max(0, d.net - recordedPayout))}</strong></p>
            </Card>
          )}

          {!isEdit && (
            <Card title="3 · Give money now? (पैसे देना)">
              <label className="check">
                <input type="checkbox" checked={giveNow} onChange={(e) => setGiveNow(e.target.checked)} />
                Record a payment to the borrower now
              </label>
              {giveNow && (
                <div className="form-grid three">
                  <Field label="Amount given now" hint={`Enter the actual cash/UPI handed over, after advance. Do not subtract advance again. Full payable: ${money(cashToGive)}.`}>
                    <input type="number" min="0" step="any" value={giveAmount} placeholder={String(cashToGive)} onChange={(e) => setGiveAmount(e.target.value)} />
                  </Field>
                  <Field label="Mode"><ModeSelect value={giveMode} onChange={setGiveMode} /></Field>
                </div>
              )}
              {giveNow && d.advance_amount > 0 && (
                <p className="muted small">
                  Before advance {money(round2((giveAmount === '' ? cashToGive : toNum(giveAmount)) + d.advance_amount))}
                  {' − '}advance kept {money(d.advance_amount)} ({form.advance_mode === 'upi' ? 'UPI' : 'Cash'})
                  {' = '}actual {giveMode === 'upi' ? 'UPI sent' : 'handed over'} {money(giveAmount === '' ? cashToGive : giveAmount)}.
                  {' '}The retained advance has a matching cut and income in its selected mode; it is not extra cash received.
                </p>
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
            <div className="calc-row minus"><span>− Advance kept ({form.advance_days || 0} {F.units}) · {form.advance_mode === 'upi' ? 'UPI' : 'Cash'} income</span><strong>{money(d.advance_amount)}</strong></div>
            {renewId && (
              <div className="calc-row minus"><span>− Old loan #{old?.loan_no} balance</span><strong>{money(adjustAmt)}</strong></div>
            )}
            {!renewId && cutRows.map((r) => (
              <div key={r.id} className="calc-row minus"><span>− Loan #{r.loan_no} {r.frequency === 'monthly' ? `monthly installment (${toNum(cuts[r.id]?.months)} month${toNum(cuts[r.id]?.months) === 1 ? '' : 's'})` : 'old dues'}</span><strong>{money(r.cut)}</strong></div>
            ))}
            <div className="calc-row total"><span>Cash to give (देना)</span><strong>{money(cashToGive)}</strong></div>

            <div className="calc-sep" />
            <div className="calc-row"><span>{F.label} installment</span><strong>{money(d.daily_installment)}{F.per}</strong></div>
            <div className="calc-row"><span>Total repayable</span><strong>{money(d.total_repayable)}</strong></div>
            <div className="calc-row"><span>Duration</span><strong>{d.duration_days} {F.units}</strong></div>
            <div className="calc-row minus"><span>− Already kept as advance</span><strong>{money(d.advance_amount)}</strong></div>
            <div className="calc-row total"><span>To collect {F.adj} (लेना)</span><strong>{money(d.toCollect)}</strong></div>
            <div className="calc-row"><span>Installments left</span><strong>{d.collectDays}</strong></div>
            <div className="calc-row"><span>{monthly ? 'Installment 1 due' : 'Day 1 of loan'}</span><strong>{fmtDateLong(form.collection_start_date)}</strong></div>
            {d.advanceDaysCovered > 0 && (
              <div className="calc-row"><span>Paid by advance</span><strong>first {d.advanceDaysCovered} {F.units}</strong></div>
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
