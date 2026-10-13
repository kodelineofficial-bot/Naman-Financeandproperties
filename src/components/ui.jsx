import { useEffect } from 'react';
import { MODES, downloadCSV, money, toNum } from '../lib/format.js';

export function PageHeader({ title, hindi, subtitle, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>
          {title} {hindi && <span className="hindi">{hindi}</span>}
        </h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, onClick }) {
  return (
    <div className={`stat ${tone ? 'stat-' + tone : ''} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '', flush }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, span }) {
  return (
    <label className={`field ${span ? 'span-' + span : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ModeSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {MODES.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Loading({ text = 'Loading…' }) {
  return (
    <div className="loading">
      <span className="spinner" /> {text}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="alert alert-error">⚠ {error.message || String(error)}</div>;
}

export function Empty({ children = 'Nothing here yet.' }) {
  return <div className="empty">{children}</div>;
}

export function Amount({ value, dir, strong }) {
  const v = toNum(value);
  const cls = dir === 'in' ? 'amt-in' : dir === 'out' ? 'amt-out' : v < 0 ? 'amt-out' : '';
  const Tag = strong ? 'strong' : 'span';
  return (
    <Tag className={`amt ${cls}`}>
      {dir === 'in' ? '+ ' : dir === 'out' ? '− ' : ''}
      {money(dir ? Math.abs(v) : v)}
    </Tag>
  );
}

const STATUS = {
  active: { label: 'Active', cls: 'badge-blue' },
  closed: { label: 'Closed', cls: 'badge-green' },
  defaulted: { label: 'Defaulted', cls: 'badge-red' },
  cancelled: { label: 'Cancelled', cls: 'badge-grey' },
  renewed: { label: 'Renewed', cls: 'badge-purple' },
};

export function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status, cls: 'badge-grey' };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

export function Badge({ children, tone = 'grey' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Progress({ pct }) {
  const p = Math.max(0, Math.min(100, toNum(pct)));
  return (
    <div className="progress" title={`${p.toFixed(1)}%`}>
      <div className="progress-bar" style={{ width: `${p}%` }} />
    </div>
  );
}

export function Tabs({ value, onChange, options }) {
  return (
    <div className="tabs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`tab ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count != null && <span className="tab-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <input
      type="search"
      className="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** "Excel" download (CSV opens in Excel / Google Sheets). columns: [{ label, key | value(row) }] */
export function ExportButton({ filename, rows, columns, label = 'Excel' }) {
  return (
    <button
      type="button"
      className="btn no-print"
      disabled={!rows?.length}
      title="Download this list as an Excel file"
      onClick={() => downloadCSV(filename, rows, columns)}
    >
      ⬇ {label}
    </button>
  );
}

/** Print the page, or "Save as PDF" from the print window. */
export function PrintButton() {
  return (
    <button type="button" className="btn no-print" title="Print or save as PDF" onClick={() => window.print()}>
      🖨 Print / PDF
    </button>
  );
}
