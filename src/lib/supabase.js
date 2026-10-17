import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && key);

export const supabase = isConfigured
  ? createClient(url, key, {
      // sessionStorage: the login lasts while the browser is open; closing it asks for the password again.
      auth: { persistSession: true, autoRefreshToken: true, storage: window.sessionStorage },
    })
  : null;

/** Unwrap a Supabase query: return data or throw the error. */
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data;
}
