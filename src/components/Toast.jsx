import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((type, text) => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, type, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), type === 'error' ? 6000 : 2800);
  }, []);

  const api = useMemo(
    () => ({
      success: (t) => push('success', t),
      error: (t) => push('error', t),
      info: (t) => push('info', t),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
