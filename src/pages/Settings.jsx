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

  useEffect(() => {
    if (settings && !f) {
      setF({
        business_name: settings.business_name || '',
        owner_name: settings.owner_name || '',
        phone: settings.phone || '',
        address: settings.address || '',
        opening_balance: String(settings.opening_balance ?? 0),
        default_interest_pct: String(settings.default_interest_pct ?? 4),
        default_markup_pct: String(settings.default_markup_pct ?? 20),
        default_daily_per_10k: String(settings.default_daily_per_10k ?? 150),
        default_advance_days: String(settings.default_advance_days ?? 10),
        attendance_cuts_salary: settings.attendance_cuts_salary ?? true,
        penalty_enabled: !!settings.penalty_enabled,
        penalty_per_day: String(settings.penalty_per_day ?? 0),
        penalty_grace_days: String(settings.penalty_grace_days ?? 0),
        penalty_from: settings.penalty_from || todayStr(),
      });
    }
  }, [settings, f]);

  if (!f) return <Loading />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

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
              default_interest_pct: toNum(f.default_interest_pct),
              default_markup_pct: toNum(f.default_markup_pct),
              default_daily_per_10k: toNum(f.default_daily_per_10k),
              default_advance_days: Math.max(0, Math.round(toNum(f.default_advance_days))),
              attendance_cuts_salary: !!f.attendance_cuts_salary,
              penalty_enabled: !!f.penalty_enabled,
              penalty_per_day: Math.max(0, round2(f.penalty_per_day)),
              penalty_grace_days: Math.max(0, Math.round(toNum(f.penalty_grace_days))),
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
              <Field label="Opening cash balance (₹)" hint="Cash in hand on the day you started using this software" span={2}>
                <input type="number" step="any" value={f.opening_balance} onChange={set('opening_balance')} />
              </Field>
            </div>
          </Card>

          <Card title="Default loan terms (pre-filled, editable per loan)">
            <div className="form-grid">
              <Field label="Interest % cut upfront"><input type="number" min="0" step="any" value={f.default_interest_pct} onChange={set('default_interest_pct')} /></Field>
              <Field label="Extra % on principal"><input type="number" min="0" step="any" value={f.default_markup_pct} onChange={set('default_markup_pct')} /></Field>
              <Field label="Daily installment per ₹10,000"><input type="number" min="0" step="any" value={f.default_daily_per_10k} onChange={set('default_daily_per_10k')} /></Field>
              <Field label="Advance days kept"><input type="number" min="0" step="1" value={f.default_advance_days} onChange={set('default_advance_days')} /></Field>
            </div>
            <div className="note-box small">
              <strong>Example for ₹10,000:</strong> interest {money(example.interest_amount)}, advance {money(example.advance_amount)} →
              give <strong>{money(example.net)}</strong>. Collect {money(example.daily_installment)}/day, total {money(example.total_repayable)} over{' '}
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
          <p className="muted small">
            When on: 1 absent day = salary ÷ days in month (₹15,000 in a 30-day month = ₹500 per day). Half day = half of that.
            “Leave” (paid leave) and days not marked are not cut.
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
              <Field label="Free days (grace)" hint="0 = from the first missed day">
                <input type="number" min="0" step="1" value={f.penalty_grace_days} onChange={set('penalty_grace_days')} />
              </Field>
              <Field label="Count penalty from" hint="Missed days before this date are not charged">
                <input type="date" max={todayStr()} value={f.penalty_from} onChange={set('penalty_from')} />
              </Field>
            </div>
          )}
          <p className="muted small">
            {f.penalty_enabled ? (
              <>
                Example: daily ₹150, penalty {money(f.penalty_per_day)}/day, {toNum(f.penalty_grace_days)} free day(s). A borrower who is{' '}
                {toNum(f.penalty_grace_days) > 0 ? `more than ${toNum(f.penalty_grace_days)} installment(s) behind` : 'behind (even partly)'} at the end of a day gets{' '}
                {money(f.penalty_per_day)} added for that day. 3 such days = {money(3 * toNum(f.penalty_per_day))}. Counted from{' '}
                {fmtDateLong(f.penalty_from)}; today is never counted. Penalty is kept separate from the loan balance — take it or
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
