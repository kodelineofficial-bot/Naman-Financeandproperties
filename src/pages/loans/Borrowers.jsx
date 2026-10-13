import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Empty, ErrorBox, Loading, PageHeader, PrintButton, SearchInput } from '../../components/ui.jsx';
import { downloadCSV, money, round2, toNum, todayStr } from '../../lib/format.js';
import { useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import BorrowerForm from './BorrowerForm.jsx';

export default function Borrowers() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    const [borrowers, loans] = await Promise.all([
      q(supabase.from('borrowers').select('*').order('name')),
      q(supabase.from('loan_summary').select('borrower_id,status,outstanding,overdue,principal')),
    ]);
    const agg = {};
    for (const l of loans) {
      const a = (agg[l.borrower_id] ||= { loans: 0, open: 0, outstanding: 0, overdue: 0, principal: 0, defaulted: 0 });
      a.loans += 1;
      a.principal = round2(a.principal + toNum(l.principal));
      if (l.status === 'active' || l.status === 'defaulted') {
        a.open += 1;
        a.outstanding = round2(a.outstanding + toNum(l.outstanding));
        a.overdue = round2(a.overdue + toNum(l.overdue));
      }
      if (l.status === 'defaulted') a.defaulted += 1;
    }
    return borrowers.map((b) => ({ ...b, ...(agg[b.id] || { loans: 0, open: 0, outstanding: 0, overdue: 0, principal: 0, defaulted: 0 }) }));
  }, []);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data || []).filter((b) => !s || `${b.name} ${b.phone || ''} ${b.occupation || ''} ${b.address || ''}`.toLowerCase().includes(s));
  }, [data, search]);

  return (
    <>
      <PageHeader title="Borrowers" hindi="ग्राहक" subtitle="Everyone who has taken money, with their total balance">
        <button
          className="btn"
          disabled={!rows.length}
          onClick={() =>
            downloadCSV(`borrowers-${todayStr()}.csv`, rows, [
              { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'occupation', label: 'Work' },
              { key: 'address', label: 'Address' }, { key: 'loans', label: 'Loans' }, { key: 'outstanding', label: 'Balance' },
              { key: 'overdue', label: 'Overdue' },
            ])
          }
        >
          ⬇ Excel
        </button>
        <PrintButton />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ New borrower</button>
      </PageHeader>

      <Card flush actions={<SearchInput value={search} onChange={setSearch} placeholder="Name / phone / work / address" />} title={`${rows.length} borrowers`}>
        <ErrorBox error={error} />
        {loading && !data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No borrowers yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th><th>Work</th><th className="num">Loans</th>
                  <th className="num">Running</th><th className="num">Balance</th><th className="num">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => navigate(`/borrowers/${b.id}`)}>
                    <td>
                      <strong>{b.name}</strong>
                      {b.defaulted > 0 && <span className="badge badge-red ml">Defaulter</span>}
                      <div className="muted small">{b.address || ''}</div>
                    </td>
                    <td>{b.phone || '—'}</td>
                    <td>{b.occupation || '—'}</td>
                    <td className="num">{b.loans}</td>
                    <td className="num">{b.open}</td>
                    <td className="num"><strong>{money(b.outstanding)}</strong></td>
                    <td className={`num ${b.overdue > 0 ? 'amt-out' : 'muted'}`}>{money(b.overdue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <BorrowerForm onClose={() => setAdding(false)} onSaved={(b) => navigate(`/borrowers/${b.id}`)} />}
    </>
  );
}
