import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import WhatsAppButton from '../components/WhatsAppButton.jsx';
import { Card, Empty, ErrorBox, ExportButton, Loading, ModeSelect, PageHeader, PrintButton, SearchInput, Stat, Tabs } from '../components/ui.jsx';
import {
  addDays, addMonths, fmtDateLong, fmtMonth, money, monthEnd, monthStart, round2, sum, toNum, todayStr,
} from '../lib/format.js';
import { periodDate, periodsDue, periodsText } from '../lib/loanMath.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

/**
 * Monthly loans (मासिक किस्त) — one row per monthly loan for the chosen month.
 *
 * Due this month = everything due up to this month's installment − what came before
 * the month, so a short month carries forward: ₹10,000/month, ₹8,000 paid in March
 * → ₹12,000 due in April, and ₹22,000 in May if April is missed too.
 */
export default function MonthlyLoans() {
  const toast = useToast();
  const today = todayStr();
  const [month, setMonth] = useState(monthStart(today));
  const [payDate, setPayDate] = useState(today);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('pending');
  const [amounts, setAmounts] = useState({});
  const [modes, setModes] = useState({});
  const [busy, run] = useAction(toast);

  const mStart = month;
  const mEnd = monthEnd(month);

  const { data, loading, error } = useLoad(async () => {
    const loans = await q(
      supabase.from('loan_summary').select('*').eq('frequency', 'monthly').lte('collection_start_date', mEnd).lte('loan_date', mEnd),
    );
    const ids = loans.map((l) => l.id);
    const reps = ids.length
      ? await q(supabase.from('loan_repayments').select('loan_id,paid_on,amount,mode').in('loan_id', ids))
      : [];
    return { loans, reps };
  }, [mEnd]);

  const all = useMemo(() => {
    if (!data) return [];
    const byLoan = {};
    for (const r of data.reps) (byLoan[r.loan_id] ||= []).push(r);
    return data.loans
      .map((l) => {
        const inst = toNum(l.daily_installment);
        const adv = toNum(l.advance_amount);
        const toCollect = round2(toNum(l.total_repayable) - adv);
        const reps = byLoan[l.id] || [];
        const before = round2(sum(reps.filter((r) => r.paid_on < mStart), 'amount'));
        const paidInMonth = round2(sum(reps.filter((r) => r.paid_on >= mStart && r.paid_on <= mEnd && r.mode !== 'renewal'), 'amount'));
        const upToEnd = round2(sum(reps.filter((r) => r.paid_on <= mEnd), 'amount'));
        const balanceBefore = Math.max(0, round2(toCollect - before));
        // A defaulted loan is frozen: nothing new falls due from the day it was defaulted.
        const frozen = l.status === 'defaulted' && l.defaulted_on ? addDays(l.defaulted_on, -1) : null;
        const owed = (d) => Math.max(0, round2(Math.min(balanceBefore, periodsDue('monthly', l.collection_start_date, frozen && frozen < d ? frozen : d) * inst - adv - before)));
        const due = owed(mEnd);
        const carried = owed(addDays(mStart, -1));
        const nInMonth = periodsDue('monthly', l.collection_start_date, mEnd);
        const dueDate = periodDate('monthly', l.collection_start_date, nInMonth);
        const dueDateInMonth = dueDate && dueDate >= mStart ? dueDate : null;
        const left = Math.max(0, round2(due - paidInMonth));
        const balance = Math.max(0, round2(toCollect - upToEnd));
        const running = ['active', 'defaulted'].includes(l.status) || (l.closed_on && l.closed_on >= mStart);
        let state;
        if (balanceBefore <= 0 && paidInMonth <= 0) state = 'done';
        else if (due <= 0) state = paidInMonth > 0 ? 'paid' : 'advance';
        else if (left <= 0) state = 'paid';
        else if (paidInMonth > 0) state = 'partial';
        else if (dueDateInMonth && dueDateInMonth > today && carried <= 0) state = 'upcoming';
        else state = 'pending';
        return { ...l, inst, due, carried, paidInMonth, left, balance, dueDateInMonth, state, running };
      })
      .filter((l) => l.running || l.paidInMonth > 0)
      .sort((a, b) => a.borrower_name.localeCompare(b.borrower_name) || a.loan_no - b.loan_no);
  }, [data, mStart, mEnd, today]);

  const counts = {
    pending: all.filter((l) => ['pending', 'partial', 'upcoming'].includes(l.state)).length,
    paid: all.filter((l) => l.state === 'paid').length,
    advance: all.filter((l) => l.state === 'advance' || l.state === 'done').length,
    all: all.length,
  };

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((l) => {
      if (s && !`${l.borrower_name} ${l.borrower_phone || ''} ${l.loan_no}`.toLowerCase().includes(s)) return false;
      if (filter === 'all') return true;
      if (filter === 'pending') return ['pending', 'partial', 'upcoming'].includes(l.state);
      if (filter === 'advance') return l.state === 'advance' || l.state === 'done';
      return l.state === filter;
    });
  }, [all, search, filter]);

  const toCollect = sum(all, 'due');
  const collected = sum(all, 'paidInMonth');
  const stillDue = sum(all, 'left');

  const amountFor = (l) => amounts[l.id] ?? (l.left > 0 ? String(l.left) : '');
  const stepMonths = (l, delta) => {
    const next = Math.max(0, Math.min(round2(toNum(amountFor(l)) + delta * l.inst), l.balance));
    setAmounts((a) => ({ ...a, [l.id]: next ? String(next) : '' }));
  };

  async function save(l) {
    const amount = round2(amountFor(l));
    if (amount <= 0) return toast.info('Enter an amount first · पहले रकम लिखें');
    if (payDate > today) return toast.error('Date cannot be in the future · aage ki tareekh nahi');
    const ok = await run(
      () => q(supabase.from('loan_repayments').insert({ loan_id: l.id, paid_on: payDate, amount, mode: modes[l.id] || 'cash' })),
      `Saved ${money(amount)} · ${l.borrower_name}`,
    );
    if (ok) setAmounts((a) => { const n = { ...a }; delete n[l.id]; return n; });
  }

  const thisMonth = monthStart(today);

  return (
    <>
      <PageHeader title="Monthly Loans" hindi="मासिक किस्त" subtitle={`${fmtMonth(month)} — installment due this month + anything short from earlier months`}>
        <div className="date-nav">
          <button className="btn" onClick={() => setMonth(addMonths(month, -1))}>‹ Prev</button>
          <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} />
          <button className="btn" onClick={() => setMonth(addMonths(month, 1))}>Next ›</button>
          {month !== thisMonth && <button className="btn btn-primary" onClick={() => setMonth(thisMonth)}>This month</button>}
        </div>
        <ExportButton
          filename={`monthly-loans-${month.slice(0, 7)}.csv`}
          rows={rows}
          columns={[
            { label: 'Loan #', key: 'loan_no' }, { label: 'Name', key: 'borrower_name' }, { label: 'Phone', key: 'borrower_phone' },
            { label: 'Monthly installment', key: 'inst' }, { label: 'Due date', key: 'dueDateInMonth' },
            { label: 'Carried from before', key: 'carried' }, { label: 'Due this month', key: 'due' },
            { label: 'Paid this month', key: 'paidInMonth' }, { label: 'Still due', key: 'left' },
            { label: 'Penalty due', value: (l) => toNum(l.penalty_due) }, { label: 'Balance', key: 'balance' },
            { label: 'Status', key: 'state' },
          ]}
        />
        <PrintButton />
      </PageHeader>

      <div className="stats">
        <Stat label="To collect this month · लेना" value={money(toCollect)} hint={`${all.filter((l) => l.due > 0).length} loans`} />
        <Stat label="Collected · मिला" value={money(collected)} tone="green" hint={`${counts.paid} fully paid`} />
        <Stat label="Still to collect · बाकी" value={money(stillDue)} tone={stillDue > 0 ? 'red' : undefined} hint={`${counts.pending} not fully paid`} />
        <Stat label="Monthly loans running" value={all.filter((l) => ['active', 'defaulted'].includes(l.status)).length} hint={`Balance ${money(sum(all, 'balance'))}`} />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'Due · बाकी', count: counts.pending },
              { value: 'paid', label: 'Paid · दिया', count: counts.paid },
              { value: 'advance', label: 'Advance / done', count: counts.advance },
              { value: 'all', label: 'All · सब', count: counts.all },
            ]}
          />
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search name / phone" />
            <label className="small nowrap">
              Payment date{' '}
              <input type="date" value={payDate} max={today} onChange={(e) => e.target.value && setPayDate(e.target.value)} />
            </label>
          </>
        }
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            {all.length === 0 ? (
              <>No monthly loans yet. <Link to="/loans/new">Create one →</Link> and pick “Monthly loan”.</>
            ) : filter === 'pending' ? 'Everyone has paid this month 🎉' : 'Nobody here.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table collect-table">
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th>Due date</th>
                  <th className="num">Due this month</th>
                  <th className="num">Paid</th>
                  <th className="num">Still due</th>
                  <th className="num">Balance</th>
                  <th>Amount received · रकम</th>
                  <th>Mode</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const amt = amountFor(l);
                  const canPay = ['active', 'defaulted'].includes(l.status) && l.balance > 0;
                  return (
                    <tr key={l.id} className={l.state === 'paid' || l.state === 'advance' || l.state === 'done' ? 'row-done' : ''}>
                      <td>
                        <Link to={`/loans/${l.id}`}><strong className="big-name">{l.borrower_name}</strong></Link>
                        <div className="muted small">
                          #{l.loan_no} · {l.borrower_phone || '—'} · {money(l.inst)}/month
                          {l.status === 'defaulted' && <span className="badge badge-red ml">Defaulted</span>}
                        </div>
                      </td>
                      <td className="nowrap">
                        {l.dueDateInMonth ? fmtDateLong(l.dueDateInMonth) : <span className="muted">No installment</span>}
                        <div>
                          {l.state === 'paid' && <span className="pill pill-green">✓ Paid</span>}
                          {l.state === 'partial' && <span className="pill pill-red">Part paid</span>}
                          {l.state === 'pending' && <span className="pill pill-red">Not paid</span>}
                          {l.state === 'upcoming' && <span className="pill pill-blue">Coming</span>}
                          {l.state === 'advance' && <span className="pill pill-blue">✓ Advance</span>}
                          {l.state === 'done' && <span className="pill pill-green">Fully paid</span>}
                        </div>
                      </td>
                      <td className="num">
                        <strong>{money(l.due)}</strong>
                        {l.carried > 0 && <div className="small amt-out">incl. {money(l.carried)} from before</div>}
                        {toNum(l.penalty_due) > 0 && <div className="pen-note">+ {money(l.penalty_due)} penalty</div>}
                      </td>
                      <td className="num amt-in">{l.paidInMonth ? money(l.paidInMonth) : '—'}</td>
                      <td className={`num ${l.left > 0 ? 'amt-out' : 'muted'}`}>
                        {money(l.left)}
                        {l.left > 0 && l.paidInMonth > 0 && <div className="small">adds to next month</div>}
                      </td>
                      <td className="num">{money(l.balance)}</td>
                      <td>
                        {canPay && (
                          <>
                            <div className="amount-cell">
                              <button type="button" className="step-btn" onClick={() => stepMonths(l, -1)} aria-label="One month less">−</button>
                              <input
                                className="amount-input"
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={amt}
                                placeholder="0"
                                onChange={(e) => setAmounts((a) => ({ ...a, [l.id]: e.target.value }))}
                                onKeyDown={(e) => e.key === 'Enter' && save(l)}
                              />
                              <button type="button" className="step-btn" onClick={() => stepMonths(l, 1)} aria-label="One month more">+</button>
                            </div>
                            <div className="days-hint">{periodsText(amt, l.inst, 'monthly')}</div>
                          </>
                        )}
                      </td>
                      <td>{canPay && <ModeSelect value={modes[l.id] || 'cash'} onChange={(v) => setModes((m) => ({ ...m, [l.id]: v }))} />}</td>
                      <td className="nowrap">
                        {canPay && (
                          <button className="btn btn-primary" disabled={busy || !(toNum(amt) > 0)} onClick={() => save(l)}>Save</button>
                        )}
                        {l.left > 0 && <WhatsAppButton className="ml" loan={l} overrides={{ overdue: l.left, balance: l.balance }} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="help-box">
        <strong>How it works · कैसे:</strong> Each monthly loan has one installment every month on the same date. The amount is
        filled with what is still due this month — if someone paid less last month, the short part is added here. Payments are saved
        with the <strong>Payment date</strong> above (today by default). Use <strong>+</strong> / <strong>−</strong> to add or remove one month.
      </p>
    </>
  );
}
