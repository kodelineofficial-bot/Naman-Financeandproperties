import { useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Modal } from '../../components/ui.jsx';
import { fmtDate, money, toNum } from '../../lib/format.js';
import { useAction, useLoad } from '../../lib/hooks.js';
import { loanCashNote } from '../../lib/loanDelete.js';
import { q, supabase } from '../../lib/supabase.js';

/** Delete a loan: hide it and keep its money, or undo it as a mistake (migration 038). */
export default function DeleteLoanModal({ loan, renewedFrom, duesCut, cutElsewhere, onClose, onDeleted }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [mode, setMode] = useState('keep_money');
  const { data: preview, loading, error } = useLoad(() => q(supabase.rpc('loan_delete_preview', { p_loan: loan.id })), [loan.id]);

  async function submit(e) {
    e.preventDefault();
    const ok = await run(
      () => q(supabase.rpc('delete_loan', { p_loan: loan.id, p_mode: mode })),
      `Loan #${loan.loan_no} deleted · you can restore it from Deleted loans`,
    );
    if (ok) onDeleted();
  }

  return (
    <Modal title={`Delete loan #${loan.loan_no} — ${loan.borrower_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="note-box" style={{ display: 'block', cursor: 'pointer' }}>
          <input type="radio" name="delete-mode" checked={mode === 'keep_money'} onChange={() => setMode('keep_money')} />{' '}
          <strong>Remove loan, keep the money</strong>
          <div className="small">
            The money was real. The loan leaves the lists, collection sheet and dues totals. Its entries stay in the Day Book, so
            cash in hand does not change on any day.
          </div>
        </label>
        <label className="note-box" style={{ display: 'block', cursor: 'pointer' }}>
          <input type="radio" name="delete-mode" checked={mode === 'undo'} onChange={() => setMode('undo')} />{' '}
          <strong>Entered by mistake, undo everything</strong>
          <div className="small">
            The loan or its entries never really happened. They are removed from the Day Book and every report.
            {renewedFrom && ` Old loan #${renewedFrom.loan_no} will run again.`}
            {duesCut.length > 0 && ' Dues cut from this loan go back on those loans.'}
            {cutElsewhere > 0 && ' Dues of this loan paid from another loan are removed there too.'}
          </div>
        </label>
        {mode === 'undo' && (
          <div className="note-box small">
            {loading && !preview && 'Working out the change in cash…'}
            {error && <span className="amt-out">Could not work out the change in cash: {error.message}</span>}
            {preview && (
              <>
                <strong>{loanCashNote(preview)}</strong>
                {preview.days.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {preview.days.map((d) => (
                      <li key={d.date}>{fmtDate(d.date)}: {toNum(d.change) > 0 ? '+' : '−'}{money(Math.abs(toNum(d.change)))}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        <p className="muted small">Either way a full copy is saved, and you can restore the loan from Deleted loans.</p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || (mode === 'undo' && !preview)}>{busy ? 'Deleting…' : 'Delete loan'}</button>
        </div>
      </form>
    </Modal>
  );
}
