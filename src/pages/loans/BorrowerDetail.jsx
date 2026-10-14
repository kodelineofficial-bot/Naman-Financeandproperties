import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, Empty, ErrorBox, ExportButton, Loading, PageHeader, PrintButton, Progress, Stat, StatusBadge } from '../../components/ui.jsx';
import { fmtDate, money, sum, whatsappLink } from '../../lib/format.js';
import { freqOf } from '../../lib/loanMath.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';
import BorrowerForm from './BorrowerForm.jsx';

export default function BorrowerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [editing, setEditing] = useState(false);

  const { data, loading, error } = useLoad(async () => {
    const [b, loans] = await Promise.all([
      q(supabase.from('borrowers').select('*').eq('id', id).single()),
      q(supabase.from('loan_summary').select('*').eq('borrower_id', id).order('loan_no', { ascending: false })),
    ]);
    return { b, loans };
  }, [id]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error || new Error('Not found')} />;
  const { b, loans } = data;
  const open = loans.filter((l) => l.status === 'active' || l.status === 'defaulted');
  const wa = whatsappLink(b.phone, `Namaste ${b.name},`);

  async function remove() {
    if (loans.length) return toast.error('This borrower has loans. Delete the loans first.');
    if (!window.confirm(`Delete borrower ${b.name}?`)) return;
    const ok = await run(() => q(supabase.from('borrowers').delete().eq('id', id)), 'Borrower deleted');
    if (ok) navigate('/borrowers');
  }

  return (
    <>
      <PageHeader title={b.name} hindi="ग्राहक" subtitle={[b.occupation, b.phone, b.address].filter(Boolean).join(' · ')}>
        {wa && <a className="btn btn-wa" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
        {b.phone && <a className="btn" href={`tel:${b.phone}`}>Call</a>}
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
        <Link className="btn btn-primary" to={`/loans/new?borrower=${id}`}>+ New loan</Link>
        <ExportButton
          filename={`${b.name}-loans.csv`}
          rows={loans}
          columns={[
            { label: 'Loan #', key: 'loan_no' }, { label: 'Date', key: 'loan_date' }, { label: 'Status', key: 'status' },
            { label: 'Principal', key: 'principal' }, { label: 'Installment', key: 'daily_installment' }, { label: 'Type', value: (l) => freqOf(l).label }, { label: 'Total to pay', key: 'total_repayable' },
            { label: 'Collected', key: 'collected_total' }, { label: 'Paid till', key: 'paid_till' },
            { label: 'Balance', key: 'outstanding' }, { label: 'Overdue', key: 'overdue' },
          ]}
        />
        <PrintButton />
      </PageHeader>
      <ErrorBox error={error} />

      <div className="stats">
        <Stat label="Total loans" value={loans.length} hint={`${open.length} running`} />
        <Stat label="Principal taken (all time)" value={money(sum(loans, 'principal'))} />
        <Stat label="Balance" value={money(sum(open, 'outstanding'))} tone="gold" />
        <Stat label="Overdue" value={money(sum(open, 'overdue'))} tone={sum(open, 'overdue') > 0 ? 'red' : undefined} />
      </div>

      <div className="grid-2">
        <Card title="Details">
          <div className="kv-list">
            <div><span>Phone</span><strong>{b.phone || '—'}</strong></div>
            <div><span>Alternate phone</span><strong>{b.alt_phone || '—'}</strong></div>
            <div><span>Work</span><strong>{b.occupation || '—'}</strong></div>
            <div><span>Address</span><strong>{b.address || '—'}</strong></div>
            <div><span>ID proof</span><strong>{b.id_proof || '—'}</strong></div>
            <div><span>Guarantor</span><strong>{[b.guarantor_name, b.guarantor_phone].filter(Boolean).join(' · ') || '—'}</strong></div>
            <div><span>Customer since</span><strong>{fmtDate(b.created_at?.slice(0, 10))}</strong></div>
          </div>
          {b.notes && <p className="note-box">{b.notes}</p>}
          <button className="btn btn-danger-outline btn-sm" disabled={busy} onClick={remove}>Delete borrower</button>
        </Card>

        <Card title="Loans" flush>
          {loans.length === 0 ? (
            <Empty>No loans yet.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => navigate(`/loans/${l.id}`)}>
                    <td>
                      <strong>#{l.loan_no}</strong> · {money(l.principal)}
                      <div className="muted small">{fmtDate(l.loan_date)} · {money(l.daily_installment)}{freqOf(l).per}</div>
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <div className="small">{money(l.outstanding)} left</div>
                      <Progress pct={l.progress_pct} />
                    </td>
                    <td><StatusBadge status={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {editing && <BorrowerForm borrower={b} onClose={() => setEditing(false)} />}
    </>
  );
}
