import { useState } from 'react';
import { Field, Loading, Modal } from './ui.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { phoneDigits, toNum, whatsappLink } from '../lib/format.js';
import { BUILTIN_TEMPLATES, fillTemplate, loanVars, pickTemplate } from '../lib/messages.js';
import { useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

function WhatsAppModal({ loan, phone, overrides, onClose }) {
  const { settings } = useSettings();
  const { data } = useLoad(
    () => q(supabase.from('message_templates').select('*').order('sort').order('created_at')),
    [],
  );
  const templates = data?.length ? data : data ? BUILTIN_TEMPLATES.map((t, i) => ({ ...t, id: 'builtin' + i })) : null;
  const vars = loanVars(loan, settings, overrides);
  const [picked, setPicked] = useState(null);
  const [text, setText] = useState(null);

  if (!templates) {
    return (
      <Modal title="WhatsApp" onClose={onClose}>
        <Loading />
      </Modal>
    );
  }

  const current = templates.find((t) => t.id === picked) || pickTemplate(templates, toNum(loan.penalty_due) > 0);
  const message = text ?? fillTemplate(current?.body, vars);
  const link = whatsappLink(phone, message);

  return (
    <Modal title={`WhatsApp — ${loan.borrower_name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Template · मैसेज चुनें" span={2}>
          <select
            value={current?.id || ''}
            onChange={(e) => {
              setPicked(e.target.value);
              setText(null);
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.use_for === 'penalty' ? ' (penalty)' : t.use_for === 'reminder' ? ' (reminder)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Message (you can change it before sending)" span={2}>
          <textarea rows={11} value={message} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
      <p className="muted small">
        To: +91 {phoneDigits(phone)} · WhatsApp will open with this message filled in. Just press <strong>Send</strong>.
      </p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <a className="btn btn-wa btn-lg" href={link} target="_blank" rel="noreferrer" onClick={() => setTimeout(onClose, 300)}>
          Open WhatsApp ➜
        </a>
      </div>
    </Modal>
  );
}

/**
 * WhatsApp button for a loan. Opens a template picker with the message filled in,
 * then wa.me opens WhatsApp with that text ready to send.
 * `overrides` = { overdue, balance } when the page shows them for another date.
 */
export default function WhatsAppButton({ loan, phone = loan.borrower_phone, overrides, className = '', label = 'WhatsApp' }) {
  const [open, setOpen] = useState(false);
  if (phoneDigits(phone).length !== 10) return null;
  return (
    <>
      <button
        type="button"
        className={`btn btn-wa ${className}`}
        title="Send WhatsApp message"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {label}
      </button>
      {open && (
        <span onClick={(e) => e.stopPropagation()}>
          <WhatsAppModal loan={loan} phone={phone} overrides={overrides} onClose={() => setOpen(false)} />
        </span>
      )}
    </>
  );
}
