import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Global "data changed" signal. Any write calls notifyChange(); every page that
// loads data with useLoad() re-fetches. Realtime events from Supabase call it
// too, so screens on other devices stay in sync.
// ---------------------------------------------------------------------------
const listeners = new Set();
let version = 0;

export function notifyChange() {
  version += 1;
  listeners.forEach((fn) => fn(version));
}

export function useDataVersion() {
  const [v, setV] = useState(version);
  useEffect(() => {
    listeners.add(setV);
    return () => listeners.delete(setV);
  }, []);
  return v;
}

/** Load async data; re-runs when deps change or when any data changes. */
export function useLoad(fn, deps = []) {
  const dataVersion = useDataVersion();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(() => fnRef.current())
      .then((data) => alive && setState({ data, loading: false, error: null }))
      .catch((error) => {
        console.error(error);
        if (alive) setState((s) => ({ data: s.data, loading: false, error }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Wrap a submit handler with busy state + error toast. */
export function useAction(toast) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, successMsg) => {
      setBusy(true);
      try {
        const res = await fn();
        if (successMsg) toast?.success(successMsg);
        notifyChange();
        return res ?? true;
      } catch (e) {
        console.error(e);
        toast?.error(e.message || String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [busy, run];
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
