import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { PUBLIC_API_BASE } from './publicMarket.js';
import { parseMainnet, verifiedMainnet, type MainnetObservation } from './mainnet.js';
import type { PublicCopyReadiness } from '../neon/realReadiness.js';

interface MainnetState {
  observation: MainnetObservation | null;
  copy: PublicCopyReadiness | null;
  verified: boolean; loading: boolean; refresh: () => void;
}
const Context = createContext<MainnetState | null>(null);
export function MainnetProvider({ children }: { children: ReactNode }) {
  const [observation, setObservation] = useState<MainnetObservation | null>(null);
  const [copy, setCopy] = useState<PublicCopyReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    let live = true;
    let pending = false;
    const controller = new AbortController();
    const read = async (path: string): Promise<unknown> => {
      const response = await fetch(`${PUBLIC_API_BASE}${path}`, { cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(9_000)]) });
      // An unavailable overview deliberately returns a useful 503 proof object.
      if (!response.ok && response.status !== 503) throw new Error('UNAVAILABLE');
      return response.json();
    };
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setObservation(previous => verifiedMainnet(previous) ? previous : null);
      try {
        const [networkResult, copyResult] = await Promise.allSettled([
          read('/public/solana/overview'), read('/public/copy-trading'),
        ]);
        if (!live) return;
        setObservation(networkResult.status === 'fulfilled' ? parseMainnet(networkResult.value) : null);
        const c = copyResult.status === 'fulfilled' ? copyResult.value : null;
        setCopy(c && typeof c === 'object' && 'executionMode' in c ? c as PublicCopyReadiness : null);
      } finally {
        pending = false;
        if (live) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [revision]);
  return <Context.Provider value={{ observation, copy, verified: verifiedMainnet(observation), loading, refresh }}>{children}</Context.Provider>;
}
export function useMainnet() {
  const value = useContext(Context);
  if (!value) throw new Error('MainnetProvider is required');
  return value;
}
