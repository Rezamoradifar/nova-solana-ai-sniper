import { useCallback, useEffect, useState } from 'react';
import { PUBLIC_API_BASE } from './publicMarket.js';
import { parseTraders, type TraderPeriod, type TraderSnapshot } from './copyTraders.js';

export function useCopyTraders(period: TraderPeriod) {
  const [snapshot, setSnapshot] = useState<TraderSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    let pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const response = await fetch(
          `${PUBLIC_API_BASE}/public/copy-trading/traders?period=${period}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22_000)]),
          },
        );
        if (!response.ok) throw new Error('UNAVAILABLE');
        const data = parseTraders(await response.json(), period);
        if (live) {
          setSnapshot(data);
          setError(false);
        }
      } catch {
        if (live) setError(true);
      } finally {
        pending = false;
        if (live) {
          setLoading(false);
          setNow(Date.now());
        }
      }
    };
    void load();
    const poll = window.setInterval(() => void load(), 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 5000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      controller.abort();
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [period, revision]);
  return { data: snapshot?.period === period ? snapshot : null, loading, error, refresh, now };
}
