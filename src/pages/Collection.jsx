import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/Toast.jsx';
import { Card, Empty, ErrorBox, Loading, ModeSelect, PageHeader, SearchInput, Stat, Tabs } from '../components/ui.jsx';
import { addDays, fmtDate, fmtWeekday, money, round2, sum, toNum, todayStr, whatsappLink } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

/**
 * Daily collection sheet (वसूली रजिस्टर).
 * One row per open loan; type the amount received and save — single row or all at once.
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
    const [loans, paidRows] = await Promise.all([
      q(
        supabase
          .from('loan_summary')
          .select(
            'id,loan_no,borrower_name,borrower_phone,borrower_address,daily_installment,outstanding,overdue,collection_start_date,status,last_paid_on',
          )
          .in('status', ['active', 'defaulted'])
          .lte('collection_start_date', date)
          .order('borrower_name'),
      ),
      q(supabase.from('loan_repayments').select('loan_id,amount').eq('paid_on', date)),
    ]);
    const paid = {};
    for (const r of paidRows) paid[r.loan_id] = round2((paid[r.loan_id] || 0) + toNum(r.amount));
    return { loans, paid };
  }, [date]);

  const rows = useMemo(() => {
    if (!data) return [];
    const s = search.trim().toLowerCase();
    return data.loans
      .map((l) => ({ ...l, paidOnDate: data.paid[l.id] || 0 }))
      .filter((l) => {
        if (s && !`${l.borrower_name} ${l.borrower_phone} ${l.loan_no}`.toLowerCase().includes(s)) return false;
        if (filter === 'pending') return l.paidOnDate === 0 && toNum(l.outstanding) > 0;
        if (filter === 'paid') return l.paidOnDate > 0;
        if (filter === 'overdue') return toNum(l.overdue) > 0;
        return true;
      });
  }, [data, search, filter]);

  const all = data?.loans || [];
  const paidMap = data?.paid || {};
  const counts = {
    pending: all.filter((l) => !paidMap[l.id] && toNum(l.outstanding) > 0).length,
    paid: all.filter((l) => paidMap[l.id]).length,
    overdue: all.filter((l) => toNum(l.overdue) > 0).length,
    all: all.length,
  };
  const expected = sum(all.filter((l) => toNum(l.outstanding) > 0 || paidMap[l.id]), (l) =>
    Math.min(toNum(l.daily_installment), toNum(l.outstanding) + (paidMap[l.id] || 0)),
  );
  const collected = sum(Object.values(paidMap), (v) => v);

  const amountFor = (l) =>
    amounts[l.id] ?? (l.paidOnDate > 0 ? '' : String(Math.min(toNum(l.daily_installment), toNum(l.outstanding))));

  async function saveRows(list) {
    const payload = list
      .map((l) => ({ loan_id: l.id, paid_on: date, amount: round2(amountFor(l)), mode: modes[l.id] || 'cash' }))
      .filter((p) => p.amount > 0);
    if (!payload.length) return toast.info('Enter an amount first.');
    const ok = await run(
      () => q(supabase.from('loan_repayments').insert(payload)),
      payload.length === 1 ? `Saved ${money(payload[0].amount)}` : `Saved ${payload.length} collections · ${money(sum(payload, 'amount'))}`,
    );
    if (ok) {
      setAmounts((a) => {
        const n = { ...a };
        list.forEach((l) => delete n[l.id]);
        return n;
      });
    }
  }

  const pendingVisible = rows.filter((l) => l.paidOnDate === 0 && toNum(amountFor(l)) > 0);

  return (
    <>
      <PageHeader title="Daily Collection" hindi="रोज़ की वसूली" subtitle={`${fmtWeekday(date)}, ${fmtDate(date)}`}>
        <div className="date-nav">
          <button className="btn btn-sm" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setDate(addDays(date, 1))}>›</button>
          {date !== todayStr() && <button className="btn btn-sm" onClick={() => setDate(todayStr())}>Today</button>}
        </div>
      </PageHeader>

      <div className="stats">
        <Stat label="Expected" value={money(expected)} hint={`${counts.all} running loans`} />
        <Stat label="Collected" value={money(collected)} tone="green" hint={`${counts.paid} paid`} />
        <Stat label="Short" value={money(Math.max(expected - collected, 0))} tone={expected - collected > 0 ? 'red' : undefined} hint={`${counts.pending} not paid yet`} />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'pending', label: 'Not paid', count: counts.pending },
              { value: 'paid', label: 'Paid', count: counts.paid },
              { value: 'overdue', label: 'Overdue', count: counts.overdue },
              { value: 'all', label: 'All', count: counts.all },
            ]}
          />
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Name / phone / loan #" />
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
          <Empty>{filter === 'pending' ? 'Sab ne de diya! Everyone has paid for this day.' : 'No loans match.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table collect-table">
              <thead>
                <tr>
                  <th>Borrower</th>
                  <th className="num">Daily</th>
                  <th className="num">Paid this day</th>
                  <th className="num">Overdue</th>
                  <th className="num">Balance</th>
                  <th>Amount</th>
                  <th>Mode</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const wa = whatsappLink(
                    l.borrower_phone,
                    `Namaste ${l.borrower_name}, aaj ki kisht ${money(l.daily_installment)} baaki hai.` +
                      (toNum(l.overdue) > 0 ? ` Kul bakaya: ${money(l.overdue)}.` : ''),
                  );
                  return (
                    <tr key={l.id} className={l.paidOnDate > 0 ? 'row-done' : ''}>
                      <td>
                        <Link to={`/loans/${l.id}`}><strong>{l.borrower_name}</strong></Link>
                        <div className="muted small">
                          #{l.loan_no} · {l.borrower_phone || '—'}
                          {l.status === 'defaulted' && <span className="badge badge-red ml">Defaulted</span>}
                        </div>
                      </td>
                      <td className="num">{money(l.daily_installment)}</td>
                      <td className="num">{l.paidOnDate > 0 ? <span className="amt-in">✓ {money(l.paidOnDate)}</span> : <span className="muted">—</span>}</td>
                      <td className={`num ${toNum(l.overdue) > 0 ? 'amt-out' : 'muted'}`}>{money(l.overdue)}</td>
                      <td className="num">{money(l.outstanding)}</td>
                      <td>
                        <input
                          className="amount-input"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          value={amountFor(l)}
                          placeholder="0"
                          onChange={(e) => setAmounts((a) => ({ ...a, [l.id]: e.target.value }))}
                          onKeyDown={(e) => e.key === 'Enter' && saveRows([l])}
                        />
                      </td>
                      <td>
                        <ModeSelect value={modes[l.id] || 'cash'} onChange={(v) => setModes((m) => ({ ...m, [l.id]: v }))} />
                      </td>
                      <td className="nowrap">
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => saveRows([l])}>
                          {l.paidOnDate > 0 ? '+ Add' : 'Save'}
                        </button>
                        {wa && l.paidOnDate === 0 && (
                          <a className="btn btn-sm btn-wa ml" href={wa} target="_blank" rel="noreferrer" title="Send WhatsApp reminder">
                            WA
                          </a>
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
      <p className="muted small">
        Tip: amounts are pre-filled with the daily installment. Change any amount, then press <kbd>Enter</kbd> on a row or “Save all”.
        Overdue is calculated as of today.
      </p>
    </>
  );
}
