import { useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Field, Modal } from '../../components/ui.jsx';
import { useAction } from '../../lib/hooks.js';
import { q, supabase } from '../../lib/supabase.js';

export const BORROWER_FIELDS = {
  name: '', phone: '', alt_phone: '', occupation: '', address: '',
  id_proof: '', guarantor_name: '', guarantor_phone: '', notes: '',
};

export function cleanBorrower(f) {
  const out = {};
  for (const k of Object.keys(BORROWER_FIELDS)) out[k] = (f[k] ?? '').toString().trim() || null;
  out.name = (f.name || '').trim();
  return out;
}

/** Fields only — reused inside the New Loan form. */
export function BorrowerFields({ value, onChange, compact }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="form-grid">
      <Field label="Name *"><input required value={value.name} onChange={set('name')} /></Field>
      <Field label="Phone"><input type="tel" value={value.phone} onChange={set('phone')} /></Field>
      <Field label="Work / Occupation (काम)"><input value={value.occupation} onChange={set('occupation')} placeholder="e.g. Shop owner, Driver" /></Field>
      <Field label="Address"><input value={value.address} onChange={set('address')} /></Field>
      {!compact && (
        <>
          <Field label="Alternate phone"><input type="tel" value={value.alt_phone} onChange={set('alt_phone')} /></Field>
          <Field label="ID proof (Aadhaar / PAN)"><input value={value.id_proof} onChange={set('id_proof')} /></Field>
          <Field label="Guarantor name (ज़मानती)"><input value={value.guarantor_name} onChange={set('guarantor_name')} /></Field>
          <Field label="Guarantor phone"><input type="tel" value={value.guarantor_phone} onChange={set('guarantor_phone')} /></Field>
          <Field label="Notes" span={2}><textarea rows={2} value={value.notes} onChange={set('notes')} /></Field>
        </>
      )}
    </div>
  );
}

export default function BorrowerForm({ borrower, onClose, onSaved }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState(() => {
    const init = { ...BORROWER_FIELDS };
    if (borrower) for (const k of Object.keys(init)) init[k] = borrower[k] ?? '';
    return init;
  });

  async function submit(e) {
    e.preventDefault();
    const payload = cleanBorrower(f);
    const res = await run(async () => {
      if (borrower) return q(supabase.from('borrowers').update(payload).eq('id', borrower.id).select().single());
      return q(supabase.from('borrowers').insert(payload).select().single());
    }, borrower ? 'Borrower updated' : 'Borrower added');
    if (res) {
      onSaved?.(res);
      onClose();
    }
  }

  return (
    <Modal title={borrower ? 'Edit borrower' : 'New borrower'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <BorrowerFields value={f} onChange={setF} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
