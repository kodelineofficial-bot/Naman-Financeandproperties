import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  // User whose admin check is done. Supabase re-sends the session on token refresh (about
  // every hour) and when the tab comes back into view; for the same user nothing is
  // re-checked, so the screen is not swapped for "Checking login…" and a half-filled
  // form (new loan etc.) is not lost.
  const checkedUser = useRef(null);

  useEffect(() => {
    if (!supabase) return undefined;
    let alive = true;

    async function apply(sess) {
      if (!alive) return;
      setSession(sess);
      if (!sess) {
        checkedUser.current = null;
        setAdmin(null);
        setLoading(false);
        return;
      }
      if (checkedUser.current === sess.user.id) return;
      checkedUser.current = sess.user.id;
      setLoading(true);
      const { data, error } = await supabase
        .from('admins')
        .select('user_id, name')
        .eq('user_id', sess.user.id)
        .maybeSingle();
      if (!alive) return;
      if (error) checkedUser.current = null; // network hiccup: check again next time
      setAdmin(data || null);
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => apply(data.session));
    // Supabase recommends not awaiting other supabase calls inside this callback.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setTimeout(() => apply(sess), 0);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = {
    session,
    user: session?.user || null,
    admin,
    isAdmin: Boolean(admin),
    loading,
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    signOut: () => supabase.auth.signOut(),
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
