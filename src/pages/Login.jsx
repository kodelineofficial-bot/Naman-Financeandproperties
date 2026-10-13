import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Logo } from '../components/ui.jsx';

export default function Login() {
  const { session, isAdmin, loading, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!loading && session && isAdmin) {
    return <Navigate to={location.state?.from?.pathname || '/'} replace />;
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message === 'Invalid login credentials' ? 'Wrong email or password.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="logo-big"><Logo size={72} /></div>
          <h1>Naman - Finance &amp; Properties</h1>
          <p className="muted">उधारी · किस्त · हिसाब — Admin Login</p>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </div>
  );
}
