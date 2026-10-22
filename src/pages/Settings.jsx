import { useEffect, useState } from 'react';
import { useToast } from '../components/Toast.jsx';
import { Card, Field, Loading, PageHeader } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { Link } from 'react-router-dom';
import { fmtDateLong, money, round2, toNum, todayStr } from '../lib/format.js';
import { deriveLoan } from '../lib/loanMath.js';
import { useAction } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

export default function Settings() {
  const toast = useToast();
  const { settings } = useSettings();
  const { user, updatePassword } = useAuth();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState(null);
  const [pw, setPw] = useState({ a: '', b: '' });
  // Starting cash re-counts every day from the cash start date, so it is locked by default.
  const [unlockCash, setUnlockCash] = useState(false);

  useEffect(() => {
    if (settings && !f) {
      setF({
        business_name: settings.business_name || '',
        owner_name: settings.owner_name || '',
        phone: settings.phone || '',
        address: settings.address || '',
        opening_balance: String(settings.opening_balance ?? 0),
        cash_start_date: settings.cash_start_date || '',
        default_interest_pct: String(settings.default_interest_pct ?? 4),
        default_markup_pct: String(settings.default_markup_pct ?? 20),
        default_daily_per_10k: String(settings.default_daily_per_10k ?? 150),
        default_advance_days: String(settings.default_advance_days ?? 10),
        attendance_cuts_salary: settings.attendance_cuts_salary ?? true,
        free_absent_days: String(settings.free_absent_days ?? 3),
        penalty_enabled: !!settings.penalty_enabled,
        penalty_per_day: String(settings.penalty_per_day ?? 0),
        // shown as the day the penalty starts: grace 0 = day 2, grace 1 = day 3, …
        penalty_start_day: String((settings.penalty_grace_days ?? 0) + 2),
        penalty_from: settings.penalty_from || todayStr(),
      });
    }
  }, [settings, f]);

  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const startDay = Math.max(2, Math.round(toNum(f.penalty_start_day)));

  const example = deriveLoan(
    {
      principal: 10000,
      interest_pct: f.default_interest_pct,
      markup_pct: f.default_markup_pct,
      advance_days: f.default_advance_days,
    },
    {},
    toNum(f.default_daily_per_10k),
  );

  async function save(e) {
    e.preventDefault();
    await run(
      () =>
        q(
          supabase
            .from('settings')
            .update({
              business_name: f.business_name.trim() || 'Naman - Finance & Properties',
              owner_name: f.owner_name.trim() || null,
              phone: f.phone.trim() || null,
              address: f.address.trim() || null,
              opening_balance: round2(f.opening_balance),
              cash_start_date: f.cash_start_date || null,
              default_interest_pct: toNum(f.default_interest_pct),
              default_markup_pct: toNum(f.default_markup_pct),
              default_daily_per_10k: toNum(f.default_daily_per_10k),
              default_advance_days: Math.max(0, Math.round(toNum(f.default_advance_days))),
              attendance_cuts_salary: !!f.attendance_cuts_salary,
              free_absent_days: Math.max(0, Math.round(toNum(f.free_absent_days) * 2) / 2),
              penalty_enabled: !!f.penalty_enabled,
              penalty_per_day: Math.max(0, round2(f.penalty_per_day)),
              penalty_grace_days: Math.max(0, Math.round(toNum(f.penalty_start_day)) - 2),
              penalty_from: f.penalty_from || todayStr(),
            })
            .eq('id', 1),
        ),
      'Settings saved',
    );
  }

  async function changePassword(e) {
    e.preventDefault();
    if (pw.a.length < 8) return toast.error('Password must be at least 8 characters.');
    if (pw.a !== pw.b) return toast.error('Passwords do not match.');
    try {
      await updatePassword(pw.a);
      toast.success('Password changed');
      setPw({ a: '', b: '' });
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <>
      <PageHeader title="Settings" hindi="सेटिंग" />
      <form onSubmit={save}>
        <div className="grid-2">
          <Card title="Business">
            <div className="form-grid">
              <Field label="Business name"><input value={f.business_name} onChange={set('business_name')} /></Field>
              <Field label="Owner name"><input value={f.owner_name} onChange={set('owner_name')} /></Field>
              <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
              <Field label="Address"><input value={f.address} onChange={set('address')} /></Field>
              <Field label="Cash start date · कैश शुरू तारीख" hint="Cash in hand is counted from this day. Older entries still show and still count for loans.">
                <input type="date" value={f.cash_start_date} max={todayStr()} disabled={!unlockCash} onChange={set('cash_start_date')} />
              </Field>
              <Field label="Opening cash balance (₹)" hint="Cash in hand at the start of the cash start date">
                <input type="number" step="any" value={f.opening_balance} disabled={!unlockCash} onChange={set('opening_balance')} />
              </Field>
            </div>
            <p className="muted small">
              To correct one day's opening cash, use <Link to="/daybook">Day Book → 🪙 Count cash</Link> on that day — earlier days stay as they are.
            </p>
            <label className="check small">
              <input type="checkbox" checked={unlockCash} onChange={(e) => setUnlockCash(e.target.checked)} />
              Change starting cash — this changes the opening and closing of every day from the cash start date
            </label>
          </Card>

          <Card title="Default loan terms (pre-filled, editable per loan)">
            <div className="form-grid">
              <Field label="Interest % cut upfront"><input type="number" min="0" step="any" value={f.default_interest_pct} onChange={set('default_interest_pct')} /></Field>
              <Field label="Extra % on principal"><input type="number" min="0" step="any" value={f.default_markup_pct} onChange={set('default_markup_pct')} /></Field>
              <Field label="Daily installment per ₹10,000"><input type="number" min="0" step="any" value={f.default_daily_per_10k} onChange={set('default_daily_per_10k')} /></Field>
              <Field label="Advance days kept"><input type="number" min="0" step="1" value={f.default_advance_days} onChange={set('default_advance_days')} /></Field>
            </div>
            <div className="note-box small">
              <strong>Example for ₹10,000:</strong> interest {money(example.interest_amount)} → loan given (cash out){' '}
              <strong>{money(example.principal - example.interest_amount)}</strong>, advance {money(example.advance_amount)} kept as income →
              hand over <strong>{money(example.net)}</strong>. Collect {money(example.daily_installment)}/day, total {money(example.total_repayable)} over{' '}
              {example.duration_days} days ({example.collectDays} installments after advance). Profit {money(example.profit)}.
            </div>
          </Card>
        </div>
        <Card title="Staff attendance · हाज़िरी">
          <label className="check">
            <input
              type="checkbox"
              checked={!!f.attendance_cuts_salary}
              onChange={(e) => setF({ ...f, attendance_cuts_salary: e.target.checked })}
            />
            Cut salary for absent days · छुट्टी (गैरहाज़िर) के पैसे काटें
          </label>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="Free absent days per month · माफ़ छुट्टी" hint={`Cut starts from day ${Math.floor(toNum(f.free_absent_days)) + 1}`}>
              <input type="number" min="0" step="0.5" value={f.free_absent_days} onChange={set('free_absent_days')} />
            </Field>
          </div>
          <p className="muted small">
            The first {toNum(f.free_absent_days) || 0} absent days in a month are not cut (half day = ½ day); the cut starts after them.
            With 3 free days: 3 absent = no cut, 5 absent = 2 days cut.
            When on: 1 cut day = salary ÷ days in month (₹15,000 in a 30-day month = ₹500 per day). Half day = half of that.
            “Leave” (paid leave) and days not marked are not cut. An employee with their own “cut per extra leave day” is always cut that amount instead.
          </p>
        </Card>
        <Card title="Late payment penalty · जुर्माना">
          <label className="check">
            <input
              type="checkbox"
              checked={!!f.penalty_enabled}
              onChange={(e) =>
                setF({
                  ...f,
                  penalty_enabled: e.target.checked,
                  // switching on: count from today, so old missed days are not charged
                  penalty_from: e.target.checked && !settings.penalty_enabled ? todayStr() : f.penalty_from,
                })
              }
            />
            Charge penalty when the daily installment is not paid · किस्त न देने पर जुर्माना लगाएं
          </label>
          {f.penalty_enabled && (
            <div className="form-grid three">
              <Field label="Penalty per day (₹)" hint="For every day the borrower is behind">
                <input type="number" min="0" step="any" value={f.penalty_per_day} onChange={set('penalty_per_day')} />
              </Field>
              <Field label="Penalty starts on day" hint="Days in a row with no payment · 3 = on the 3rd unpaid day all 3 days are charged; any payment starts again">
                <input type="number" min="2" step="1" value={f.penalty_start_day} onChange={set('penalty_start_day')} />
              </Field>
              <Field label="Count penalty from" hint="Missed days before this date are not charged">
                <input type="date" max={todayStr()} value={f.penalty_from} onChange={set('penalty_from')} />
              </Field>
            </div>
          )}
          <p className="muted small">
            {f.penalty_enabled ? (
              <>
                Example: penalty {money(f.penalty_per_day)}/day, starting on day {startDay}. Only days in a row with no payment count:
                {' '}{startDay - 1} unpaid day{startDay - 1 === 1 ? '' : 's'} in a row = no penalty. On the {startDay}th unpaid day in a row
                all of them are charged = {money(startDay * toNum(f.penalty_per_day))}, then {money(f.penalty_per_day)} more for each
                further unpaid day (day {startDay + 1} = {money((startDay + 1) * toNum(f.penalty_per_day))}). Any payment ends the run —
                missing a single day now and then is never charged. Penalty already showing stays: a payment entered later with an earlier date (or paying the overdue) does not take it back — only Take penalty / Waive / Edit penalty lowers it.
                Counted from {fmtDateLong(f.penalty_from)}, and for each loan from the day it was entered in the software. Penalty is kept separate from the loan balance — take it or
                waive it (माफ़) from the loan page. A single loan can be kept penalty-free from its page.
              </>
            ) : (
              'Off — no penalty is charged on any loan.'
            )}
          </p>
          <p className="small">
            Messages for borrowers: <Link to="/templates">WhatsApp Templates →</Link>
          </p>
        </Card>
        <div className="form-actions left">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>

      <Card title="Your login">
        <p className="muted">Signed in as <strong>{user?.email}</strong></p>
        <form onSubmit={changePassword} className="form-grid">
          <Field label="New password"><input type="password" autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
          <Field label="Confirm password"><input type="password" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
          <div><button className="btn">Change password</button></div>
        </form>
      </Card>
    </>
  );
}
