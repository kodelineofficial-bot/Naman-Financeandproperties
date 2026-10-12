import { createContext, useContext } from 'react';
import { getSettings } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';

const SettingsCtx = createContext({ settings: null, reload: () => {} });

export function SettingsProvider({ children }) {
  const { data, reload } = useLoad(getSettings, []);
  return <SettingsCtx.Provider value={{ settings: data, reload }}>{children}</SettingsCtx.Provider>;
}

export const useSettings = () => useContext(SettingsCtx);
