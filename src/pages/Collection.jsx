import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import WhatsAppButton from '../components/WhatsAppButton.jsx';
import { Card, Empty, ErrorBox, ExportButton, Loading, ModeSelect, PageHeader, PrintButton, SearchInput, Stat, Tabs } from '../components/ui.jsx';
import {
  addDays, daysBetween, daysText, fmtDateFull, fmtDateLong, money, round2, sum, toNum, todayStr,
} from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

/**
 * Daily collection sheet (किस्त रजिस्टर).
 * One row per running loan; type the amount received and save — single row or all at once.
 * A payment of several days (₹300 = 2 days of ₹150) fills that many days, so
 * the person shows as "paid in advance" on the next days instead of "not paid".
 */
export default function Collection() {
  const toast = useToast();
  const [date, setDate] = useState(todayStr());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('pending');
  const [amounts, setAmounts] = useState({});
  const [modes, setModes] = useState({});
  const [busy, run] = useAction(toast);

  const { data, loading, error } = useLoad(async () => {
    const [sheet, pen] = await Promise.all([
      q(supabase.rpc('collection_sheet', { p_date: date })),
      q(supabase.from('loan_penalty').select('loan_id,penalty_due,penalty_days,penalty_rate').gt('penalty_due', 0)),
    ]);
    const byLoan = Object.fromEntries(pen.map((p) => [p.loan_id, p]));
    return sheet.map((l) => ({ ...l, ...(byLoan[l.id] && { penalty_due: byLoan[l.id].penalty_due, penalty_days: byLoan[l.id].penalty_days, penalty_rate: byLoan[l.id].penalty_rate }) }));
  }, [date]);

  const all = useMemo(
    () =>
      (data || []).map((l) => {
        const daily = toNum(l.daily_installment);
        const paidToday = toNum(l.paid_on_date);
        const before = round2(toNum(l.collected_upto) - paidToday);
        const dayNo = daysBetween(l.collection_start_date, date) + 1;
        const daysBefore = daily > 0 ? Math.floor(before / daily + 1e-9) : 0;
        const balanceBefore = Math.max(0, round2(toNum(l.to_collect) - before));
        let state;
        if (paidToday > 0) state = 'paid';
        else if (toNum(l.balance_upto) <= 0) state = 'done';
        else if (daysBefore >= dayNo) state = 'advance';
        else state = 'pending';
        const dueToday = daysBefore < dayNo && balanceBefore > 0;
        return {
          ...l,
          daily,
          paidToday,
          state,
          dueToday,
          dueAmount: dueToday ? Math.min(daily, balanceBefore) : 0,
          short: toNum(l.short_upto),
          balance: toNum(l.balance_upto),
        };
      }),
    [data, date],
  );

  const counts = {
    pending: all.filter((l) => l.state === 'pending').length,
    paid: all.filter((l) => l.state === 'paid').length,
    advance: all.filter((l) => l.state === 'advance').length,
    all: all.length,
  };

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((l) => {
      if (s && !`${l.borrower_name} ${l.borrower_phone || ''} ${l.loan_no}`.toLowerCase().includes(s)) return false;
      if (filter === 'all') return true;
      return l.state === filter;
    });
  }, [all, search, filter]);

  const expected = sum(all, 'dueAmount');
  const collected = sum(all, 'paidToday');

  const amountFor = (l) =>
    amounts[l.id] ?? (l.state === 'pending' ? String(Math.min(l.daily, l.balance)) : '');

  const stepDays = (l, delta) => {
    const cur = toNum(amountFor(l));
    const days = Math.max(0, Math.round(cur / l.daily) + delta);
    setAmounts((a) => ({ ...a, [l.id]: days ? String(round2(Math.min(days * l.daily, l.balance))) : '' }));
  };

  async function saveRows(list) {
    const payload = list
      .map((l) => ({ loan_id: l.id, paid_on: date, amount: round2(amountFor(l)), mode: modes[l.id] || 'cash' }))
      .filter((p) => p.amount > 0);
    if (!payload.length) return toast.info('Enter an amount first · पहले रकम लिखें');
    const ok = await run(
      () => q(supabase.from('loan_repayments').insert(payload)),
      payload.length === 1 ? `Saved ${money(payload[0].amount)}` : `Saved ${payload.length} payments · ${money(sum(payload, 'amount'))}`,
    );
    if (ok) {
      setAmounts((a) => {
        const n = { ...a };
        list.forEach((l) => delete n[l.id]);
        return n;
      });
    }
  }

  const pendingVisible = rows.filter((l) => l.state === 'pending' && toNum(amountFor(l)) > 0);

  return (
    <>
      <PageHeader title="Daily Collection" hindi="रोज़ की किस्त" subtitle={fmtDateFull(date)}>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))}>‹ Yesterday</button>
          <input type="date" value={date} max={todayStr()} onChange={(e) => e.target.value && e.target.value <= todayStr() && setDate(e.target.value)} />
          <button className="btn" disabled={date >= todayStr()} onClick={() => setDate(addDays(date, 1))}>Next ›</button>
          {date !== todayStr() && <button className="btn btn-primary" onClick={() => setDate(todayStr())}>Today</button>}
        </div>
        <ExportButton
          filename={`collection-${date}.csv`}
          rows={rows}
          columns={[
            { label: 'Loan #', key: 'loan_no' }, { label: 'Name', key: 'borrower_name' }, { label: 'Phone', key: 'borrower_phone' },
            { label: 'Daily', key: 'daily' },
            { label: 'Status', value: (l) => ({ paid: 'Paid', advance: 'Advance', pending: 'Not paid', done: 'Fully paid' })[l.state] },
            { label: 'Paid this day', key: 'paidToday' }, { label: 'Paid till', key: 'paid_till' },
            { label: 'Behind (bakaya)', key: 'short' }, { label: 'Penalty due', value: (l) => toNum(l.penalty_due) }, { label: 'Balance', key: 'balance' },
          ]}
        />
        <PrintButton />
      </PageHeader>

      <div className="stats">
        <Stat label="To collect this day · आज लेना" value={money(expected)} hint={`${all.filter((l) => l.dueToday).length} people`} />
        <Stat label="Collected · मिला" value={money(collected)} tone="green" hint={`${counts.paid} paid`} />
        <Stat label="Still to collect · बाकी" value={money(Math.max(expected - collected, 0))} tone={expected - collected > 0 ? 'red' : undefined} hint={`${counts.pending} not paid yet`} />
        <Stat label="Paid in advance · एडवांस" value={counts.advance} hint="No need to collect today" />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'Not paid · बाकी', count: counts.pending },
              { value: 'paid', label: 'Paid · दिया', count: counts.paid },
              { value: 'advance', label: 'Advance · एडवांस', count: counts.advance },
              { value: 'all', label: 'All · सब', count: counts.all },
            ]}
          />
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search name / phone" />
            <button className="btn btn-primary" disabled={busy || !pendingVisible.length} onClick={() => saveRows(pendingVisible)}>
              Save all ({pendingVisible.length})
            </button>
          </>
        }
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            {filter === 'pending' ? 'Sab ne de diya! 🎉 Everyone has paid for this day.' : 'Nobody here.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table collect-table">
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th>Status</th>
                  <th className="num">Behind · बकाया</th>
                  <th className="num">Balance</th>
                  <th>Amount received · रकम</th>
                  <th>Mode</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const amt = amountFor(l);
                  return (
                    <tr key={l.id} className={l.state === 'paid' || l.state === 'advance' ? 'row-done' : ''}>
                      <td>
                        <Link to={`/loans/${l.id}`}><strong className="big-name">{l.borrower_name}</strong></Link>
                        <div className="muted small">
                          #{l.loan_no} · {l.borrower_phone || '—'} · {money(l.daily)}/day
                          {l.status === 'defaulted' && <span className="badge badge-red ml">Defaulted</span>}
                        </div>
                      </td>
                      <td>
                        {l.state === 'paid' && (
                          <span className="pill pill-green">✓ Paid {money(l.paidToday)} <small>({daysText(l.paidToday, l.daily)})</small></span>
                        )}
                        {l.state === 'advance' && <span className="pill pill-blue">✓ Advance</span>}
                        {l.state === 'pending' && <span className="pill pill-red">Not paid</span>}
                        {l.state === 'done' && <span className="pill pill-green">Fully paid</span>}
                        {l.paid_till && (
                          <div className="muted small">Paid till {fmtDateLong(l.paid_till)}</div>
                        )}
                      </td>
                      <td className={`num ${l.short > 0 ? 'amt-out' : 'muted'}`}>
                        {money(l.short)}
                        {toNum(l.penalty_due) > 0 && <div className="pen-note">+ {money(l.penalty_due)} penalty</div>}
                      </td>
                      <td className="num">{money(l.balance)}</td>
                      <td>
                        <div className="amount-cell">
                          <button type="button" className="step-btn" onClick={() => stepDays(l, -1)} aria-label="One day less">−</button>
                          <input
                            className="amount-input"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={amt}
                            placeholder="0"
                            onChange={(e) => setAmounts((a) => ({ ...a, [l.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === 'Enter' && saveRows([l])}
                          />
                          <button type="button" className="step-btn" onClick={() => stepDays(l, 1)} aria-label="One day more">+</button>
                        </div>
                        <div className="days-hint">{daysText(amt, l.daily)}</div>
                      </td>
                      <td>
                        <ModeSelect value={modes[l.id] || 'cash'} onChange={(v) => setModes((m) => ({ ...m, [l.id]: v }))} />
                      </td>
                      <td className="nowrap">
                        <button className="btn btn-primary" disabled={busy || !(toNum(amt) > 0)} onClick={() => saveRows([l])}>
                          {l.state === 'pending' ? 'Save' : '+ Add'}
                        </button>
                        {l.state === 'pending' && (
                          <WhatsAppButton className="ml" loan={l} overrides={{ overdue: l.short, balance: l.balance }} />
                        )}
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
        <strong>How to use · कैसे करें:</strong> The amount is already filled with 1 day's installment. If someone pays for more days,
        press <strong>+</strong> (one more day) or type the amount — e.g. ₹300 on a ₹150 loan = 2 days. Then press <strong>Save</strong>.
        People who paid in advance move to the <strong>Advance</strong> tab automatically.
      </p>
    </>
  );
}
