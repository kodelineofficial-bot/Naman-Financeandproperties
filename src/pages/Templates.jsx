import { useRef, useState } from 'react';
import { useToast } from '../components/Toast.jsx';
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { BUILTIN_TEMPLATES, PLACEHOLDERS, fillTemplate, loanVars } from '../lib/messages.js';
import { todayStr, addDays } from '../lib/format.js';
import { useAction, useLoad } from '../lib/hooks.js';
import { q, supabase } from '../lib/supabase.js';

const USE_FOR = {
  reminder: { label: 'Default: payment reminder', tone: 'blue' },
  penalty: { label: 'Default: penalty notice', tone: 'red' },
};

// Sample borrower used for the preview.
const SAMPLE = {
  borrower_name: 'Ramesh Kumar',
  loan_no: 12,
  daily_installment: 150,
  overdue: 450,
  outstanding: 6750,
  penalty_due: 60,
  penalty_rate: 20,
  penalty_days: 3,
  paid_till: addDays(todayStr(), -3),
  expected_end_date: addDays(todayStr(), 45),
  next_due_date: addDays(todayStr(), 1),
};

function TemplateModal({ tpl, templates, onClose }) {
  const toast = useToast();
  const { settings } = useSettings();
  const [busy, run] = useAction(toast);
  const [f, setF] = useState({ name: tpl?.name || '', body: tpl?.body || '', use_for: tpl?.use_for || '' });
  const bodyRef = useRef(null);
  const vars = loanVars(SAMPLE, settings);

  function insert(key) {
    const el = bodyRef.current;
    const token = `{${key}}`;
    const start = el ? el.selectionStart : f.body.length;
    const end = el ? el.selectionEnd : f.body.length;
    const body = f.body.slice(0, start) + token + f.body.slice(end);
    setF({ ...f, body });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(e) {
    e.preventDefault();
    const name = f.name.trim();
    const body = f.body.trim();
    if (!name) return toast.error('Give the template a name.');
    if (!body) return toast.error('Write the message.');
    const use_for = f.use_for || null;
    const ok = await run(async () => {
      // Only one default per purpose: free it from the other template first.
      const holder = use_for && templates.find((t) => t.use_for === use_for && t.id !== tpl?.id);
      if (holder) await q(supabase.from('message_templates').update({ use_for: null }).eq('id', holder.id));
      if (tpl) {
        await q(supabase.from('message_templates').update({ name, body, use_for }).eq('id', tpl.id));
      } else {
        const sort = Math.max(0, ...templates.map((t) => t.sort || 0)) + 1;
        await q(supabase.from('message_templates').insert({ name, body, use_for, sort }));
      }
    }, tpl ? 'Template saved' : 'Template added');
    if (ok) onClose();
  }

  return (
    <Modal title={tpl ? 'Edit template' : 'New template'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="grid-2">
          <div className="form-grid">
            <Field label="Template name" span={2}>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sunday reminder" />
            </Field>
            <Field label="Open this one first for…" span={2} hint="The WhatsApp button picks this template automatically">
              <select value={f.use_for} onChange={(e) => setF({ ...f, use_for: e.target.value })}>
                <option value="">— Nothing (choose by hand) —</option>
                <option value="reminder">Payment reminder (installment pending)</option>
                <option value="penalty">Penalty notice (when penalty is due)</option>
              </select>
            </Field>
            <Field label="Message" span={2}>
              <textarea ref={bodyRef} rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
            </Field>
            <div className="span-2">
              <span className="field-label">Tap to add a value · ये जोड़ें</span>
              <div className="tag-row">
                {PLACEHOLDERS.map((p) => (
                  <button type="button" key={p.key} className="tag-btn" title={p.label} onClick={() => insert(p.key)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <span className="field-label">Preview (sample borrower)</span>
            <div className="wa-preview">{fillTemplate(f.body, vars) || '…'}</div>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save template'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Templates() {
  const toast = useToast();
  const { settings } = useSettings();
  const [busy, run] = useAction(toast);
  const [edit, setEdit] = useState(null); // null | 'new' | template row
  const { data, loading, error } = useLoad(
    () => q(supabase.from('message_templates').select('*').order('sort').order('created_at')),
    [],
  );
  const templates = data || [];
  const missing = BUILTIN_TEMPLATES.filter((b) => !templates.some((t) => t.name === b.name));
  const vars = loanVars(SAMPLE, settings);

  async function del(t) {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    await run(() => q(supabase.from('message_templates').delete().eq('id', t.id)), 'Template deleted');
  }

  async function addBuiltins() {
    await run(
      () =>
        q(
          supabase.from('message_templates').insert(
            missing.map((b) => ({
              ...b,
              // keep an existing default in place
              use_for: b.use_for && !templates.some((t) => t.use_for === b.use_for) ? b.use_for : null,
            })),
          ),
        ),
      'Ready-made templates added',
    );
  }

  return (
    <>
      <PageHeader title="WhatsApp Templates" hindi="मैसेज टेम्पलेट" subtitle="Messages sent from the WhatsApp button on Collection, Loans and Dashboard">
        {missing.length > 0 && (
          <button className="btn" disabled={busy} onClick={addBuiltins}>+ Ready-made templates ({missing.length})</button>
        )}
        <button className="btn btn-primary" onClick={() => setEdit('new')}>+ New template</button>
      </PageHeader>
      <ErrorBox error={error} />

      {loading && !data ? (
        <Loading />
      ) : templates.length === 0 ? (
        <Card><Empty>No templates yet. Add the ready-made ones or make your own.</Empty></Card>
      ) : (
        <div className="grid-2">
          {templates.map((t) => (
            <Card
              key={t.id}
              title={t.name}
              actions={
                <>
                  {USE_FOR[t.use_for] && <Badge tone={USE_FOR[t.use_for].tone}>{USE_FOR[t.use_for].label}</Badge>}
                  <button className="btn btn-sm" onClick={() => setEdit(t)}>Edit</button>
                  <button className="icon-btn danger" title="Delete" disabled={busy} onClick={() => del(t)}>🗑</button>
                </>
              }
            >
              <div className="wa-preview">{fillTemplate(t.body, vars)}</div>
            </Card>
          ))}
        </div>
      )}

      <p className="help-box">
        <strong>How it works · कैसे चलता है:</strong> Words in curly brackets like <code>{'{name}'}</code> or <code>{'{penalty}'}</code> are
        filled in for each borrower. When you press <strong>WhatsApp</strong> next to a borrower, the penalty notice opens first if they
        have penalty due, otherwise the payment reminder. You can pick any other template there, change the text, then WhatsApp opens
        with the message ready — just press Send.
      </p>

      {edit && <TemplateModal tpl={edit === 'new' ? null : edit} templates={templates} onClose={() => setEdit(null)} />}
    </>
  );
}
