import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, Progress, SearchInput, Stat, StatusBadge, Tabs } from '../../components/ui.jsx';
import { downloadCSV, fmtDate, fmtDateShort, money, sum, toNum, todayStr } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

const SORTS = {
  recent: { label: 'Newest', fn: (a, b) => b.loan_no - a.loan_no },
  overdue: { label: 'Most overdue', fn: (a, b) => b.overdue - a.overdue },
  outstanding: { label: 'Highest balance', fn: (a, b) => b.outstanding - a.outstanding },
  name: { label: 'Name A–Z', fn: (a, b) => a.borrower_name.localeCompare(b.borrower_name) },
  ending: { label: 'Ending soon', fn: (a, b) => String(a.expected_end_date).localeCompare(String(b.expected_end_date)) },
};

export default function LoansList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'open';
  const sort = params.get('sort') || 'recent';
  const [search, setSearch] = useState('');

  const { data, loading, error } = useLoad(() => q(supabase.from('loan_summary').select('*').order('loan_no', { ascending: false })), []);

  const set = (k, v) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    setParams(p, { replace: true });
  };

  const all = data || [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all
      .filter((l) => {
        if (status === 'open' && !['active', 'defaulted'].includes(l.status)) return false;
        if (status !== 'open' && status !== 'all' && l.status !== status) return false;
        if (s && !`${l.borrower_name} ${l.borrower_phone || ''} ${l.loan_no} ${l.borrower_occupation || ''}`.toLowerCase().includes(s)) return false;
        return true;
      })
      .map((l) => ({ ...l, overdue: toNum(l.overdue), outstanding: toNum(l.outstanding) }))
      .sort(SORTS[sort]?.fn || SORTS.recent.fn);
  }, [all, status, sort, search]);

  const count = (st) => all.filter((l) => (st === 'open' ? ['active', 'defaulted'].includes(l.status) : st === 'all' || l.status === st)).length;

  function exportCsv() {
    downloadCSV(`loans-${todayStr()}.csv`, rows, [
      { key: 'loan_no', label: 'Loan #' },
      { key: 'borrower_name', label: 'Borrower' },
      { key: 'borrower_phone', label: 'Phone' },
      { key: 'borrower_occupation', label: 'Work' },
      { key: 'loan_date', label: 'Loan date' },
      { key: 'principal', label: 'Principal' },
      { key: 'interest_amount', label: 'Interest cut' },
      { key: 'advance_amount', label: 'Advance kept' },
      { key: 'net_disbursable', label: 'Net to give' },
      { key: 'disbursed', label: 'Given' },
      { key: 'daily_installment', label: 'Daily' },
      { key: 'total_repayable', label: 'Total repayable' },
      { key: 'collected_total', label: 'Collected (incl. advance)' },
      { key: 'outstanding', label: 'Balance' },
      { key: 'overdue', label: 'Overdue' },
      { key: 'expected_end_date', label: 'Expected end' },
      { key: 'status', label: 'Status' },
    ]);
  }

  return (
    <>
      <PageHeader title="Loans" hindi="उधारी खाता" subtitle="Every loan with live balance, overdue and progress">
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>⬇ Export</button>
        <Link to="/loans/new" className="btn btn-primary">+ New loan</Link>
      </PageHeader>

      <div className="stats">
        <Stat label="Principal (shown)" value={money(sum(rows, 'principal'))} hint={`${rows.length} loans`} />
        <Stat label="Collected (shown)" value={money(sum(rows, 'collected_total'))} tone="green" />
        <Stat label="Balance (shown)" value={money(sum(rows, 'outstanding'))} />
        <Stat label="Overdue (shown)" value={money(sum(rows, 'overdue'))} tone={sum(rows, 'overdue') > 0 ? 'red' : undefined} />
      </div>

      <Card
        flush
        title={
          <Tabs
            value={status}
            onChange={(v) => set('status', v)}
            options={[
              { value: 'open', label: 'Running', count: count('open') },
              { value: 'closed', label: 'Closed', count: count('closed') },
              { value: 'defaulted', label: 'Defaulted', count: count('defaulted') },
              { value: 'cancelled', label: 'Cancelled', count: count('cancelled') },
              { value: 'all', label: 'All', count: count('all') },
            ]}
          />
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Name / phone / loan # / work" />
            <select value={sort} onChange={(e) => set('sort', e.target.value)}>
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </>
        }
      >
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No loans found. <Link to="/loans/new">Create the first loan →</Link></Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Borrower</th>
                  <th>Date</th>
                  <th className="num">Principal</th>
                  <th className="num">Daily</th>
                  <th className="num">Total</th>
                  <th style={{ minWidth: 140 }}>Collected</th>
                  <th className="num">Balance</th>
                  <th className="num">Overdue</th>
                  <th>Ends</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => navigate(`/loans/${l.id}`)}>
                    <td className="muted">{l.loan_no}</td>
                    <td>
                      <strong>{l.borrower_name}</strong>
                      <div className="muted small">{[l.borrower_occupation, l.borrower_phone].filter(Boolean).join(' · ') || '—'}</div>
                      {toNum(l.pending_disbursement) > 0 && (
                        <div className="small amt-warn">To give: {money(l.pending_disbursement)}</div>
                      )}
                    </td>
                    <td className="nowrap">{fmtDate(l.loan_date)}</td>
                    <td className="num">{money(l.principal)}</td>
                    <td className="num">{money(l.daily_installment)}</td>
                    <td className="num">{money(l.total_repayable)}</td>
                    <td>
                      <div className="small">{money(l.collected_total)} · {l.progress_pct}%</div>
                      <Progress pct={l.progress_pct} />
                    </td>
                    <td className="num"><strong>{money(l.outstanding)}</strong></td>
                    <td className={`num ${l.overdue > 0 ? 'amt-out' : 'muted'}`}>{money(l.overdue)}</td>
                    <td className="nowrap">{fmtDateShort(l.expected_end_date)}</td>
                    <td><StatusBadge status={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
