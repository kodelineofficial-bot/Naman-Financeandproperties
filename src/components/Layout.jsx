import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { Logo } from './ui.jsx';
import { getBalanceAsOf } from '../lib/api.js';
import { money, todayStr } from '../lib/format.js';
import { debounce, notifyChange, useLoad } from '../lib/hooks.js';
import { supabase } from '../lib/supabase.js';

const NAV = [
  { section: 'Overview' },
  { to: '/', label: 'Dashboard', hi: 'डैशबोर्ड', icon: '◧', end: true },
  { section: 'Lending · उधारी' },
  { to: '/collection', label: 'Daily Collection', hi: 'रोज़ की किस्त', icon: '₹' },
  { to: '/monthly-loans', label: 'Monthly Loans', hi: 'मासिक किस्त', icon: '◷' },
  { to: '/loans', label: 'Loans', hi: 'उधारी खाता', icon: '▤' },
  { to: '/borrowers', label: 'Borrowers', hi: 'ग्राहक', icon: '☺' },
  { section: 'Books · हिसाब' },
  { to: '/daybook', label: 'Day Book', hi: 'रोज़नामचा', icon: '☰' },
  { to: '/daily', label: 'Daily Summary', hi: 'दिन वार', icon: '▦' },
  { to: '/monthly', label: 'Monthly Report', hi: 'मासिक', icon: '▥' },
  { to: '/expenses', label: 'Expenses', hi: 'खर्चा', icon: '✎' },
  { to: '/cashbook', label: 'Cash In / Out', hi: 'पूंजी', icon: '⇅' },
  { section: 'Staff · कर्मचारी' },
  { to: '/attendance', label: 'Attendance', hi: 'हाज़िरी', icon: '☑' },
  { to: '/employees', label: 'Employees', hi: 'कर्मचारी', icon: '♟' },
  { to: '/salary', label: 'Salary Report', hi: 'तनख्वाह', icon: '✓' },
  { section: '' },
  { to: '/templates', label: 'WhatsApp Templates', hi: 'मैसेज टेम्पलेट', icon: '✉' },
  { to: '/settings', label: 'Settings', hi: 'सेटिंग', icon: '⚙' },
];

function BalancePill() {
  const { data } = useLoad(() => getBalanceAsOf(todayStr()), []);
  return (
    <div className={`balance-pill ${data < 0 ? 'neg' : ''}`} title="Cash in hand (रोकड़ बाकी)">
      <span>Cash in hand</span>
      <strong>{data == null ? '…' : money(data)}</strong>
    </div>
  );
}

export default function Layout() {
  const { admin, user, signOut } = useAuth();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  // Realtime: refresh every screen when any table changes (from any device).
  useEffect(() => {
    const refresh = debounce(notifyChange, 400);
    const channel = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, refresh)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <Logo size={42} light />
          <div>
            <div className="brand-name">{settings?.business_name || 'Naman - Finance & Properties'}</div>
            <div className="brand-sub">Admin Panel</div>
          </div>
        </div>
        <nav>
          {NAV.map((n, i) =>
            n.section !== undefined ? (
              <div key={'s' + i} className="nav-section">
                {n.section}
              </div>
            ) : (
              <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
                <span className="nav-icon">{n.icon}</span>
                <span className="nav-text">
                  {n.label}
                  <small>{n.hi}</small>
                </span>
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <div className="who-name">{admin?.name || 'Admin'}</div>
            <div className="who-mail">{user?.email}</div>
          </div>
          <button className="btn btn-ghost-light btn-sm" onClick={signOut}>
            Logout
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">
            ☰
          </button>
          <div className="topbar-date">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </div>
          <BalancePill />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
