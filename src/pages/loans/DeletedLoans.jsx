import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/Toast.jsx';
import { Card, Empty, ErrorBox, Loading, Modal, PageHeader } from '../../components/ui.jsx';
import { fmtDate, modeLabel, money, toNum } from '../../lib/format.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { deletedLoanEntries } from '../../lib/loanDelete.js';
import { q, supabase } from '../../lib/supabase.js';

const MODE_LABEL = { keep_money: 'Money kept', undo: 'Undone (mistake)' };

function Entries({ row, onClose }) {
  const rows = deletedLoanEntries(row);
  return (
    <Modal wide title={`Loan #${row.loan_no} — ${row.borrower_name}`} onClose={onClose}>
      {rows.length === 0 ? <Empty>No entries.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Type</th><th>Mode</th><th>Note</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type + r.id}>
                  <td className="nowrap">{fmtDate(r.paid_on)}</td>
                  <td>{r.type}</td>
                  <td>{modeLabel(r.mode)}</td>
                  <td>{r.note}</td>
                  <td className="num">{money(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/** Loans deleted since migration 038: what was given, paid and left, and a way back. */
export default function DeletedLoans() {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [viewing, setViewing] = useState(null);
  const { data, loading, error } = useLoad(
    () => q(supabase.from('loan_deletions').select('*').is('restored_at', null).order('deleted_at', { ascending: false })),
    [],
  );

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  async function restore(r) {
    const note = r.mode === 'undo'
      ? 'Its entries come back into the Day Book, so cash in hand changes back too.'
      : 'Cash in hand does not change. It may show missed days and penalty for the time it was deleted.';
    if (!window.confirm(`Restore loan #${r.loan_no} of ${r.borrower_name}?\n\n${note}`)) return;
    await run(() => q(supabase.rpc('restore_loan', { p_deletion: r.id })), `Loan #${r.loan_no} restored`);
  }

  return (
    <>
      <PageHeader title="Deleted loans" hindi="हटाए गए लोन" subtitle="What was given, paid and left when each loan was deleted. Restore brings it back." />
      <Card flush>
        {data.length === 0 ? <Empty>No deleted loans.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Loan</th><th>Borrower</th><th className="num">Loan amount</th><th className="num">Given</th>
                  <th className="num">Paid</th><th className="num">Left</th><th>Type</th><th>Deleted on</th><th />
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td>#{r.loan_no}</td>
                    <td><Link to={`/borrowers/${r.borrower_id}`}>{r.borrower_name}</Link></td>
                    <td className="num">{money(toNum(r.summary?.principal))}</td>
                    <td className="num">{money(toNum(r.summary?.disbursed))}</td>
                    <td className="num">{money(toNum(r.summary?.collected_total))}</td>
                    <td className="num">{money(toNum(r.summary?.outstanding))}</td>
                    <td>{MODE_LABEL[r.mode]}</td>
                    <td className="nowrap">{fmtDate(r.deleted_at.slice(0, 10))}</td>
                    <td className="num nowrap">
                      <button className="btn btn-sm" onClick={() => setViewing(r)}>Entries</button>{' '}
                      <button className="btn btn-sm" disabled={busy} onClick={() => restore(r)}>Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {viewing && <Entries row={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
