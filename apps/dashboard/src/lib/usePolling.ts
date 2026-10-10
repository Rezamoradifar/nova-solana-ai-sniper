import { useEffect, useRef, useState } from 'react';

/**
 * Polls `fetcher` every `intervalMs` while mounted, as a resilience fallback.
 * When `refreshSignal` changes (bumped by useLiveEvents on a relevant
 * websocket event), the poll fires immediately and the interval resets —
 * so updates feel live while still self-healing if the socket drops.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 5000,
  refreshSignal: unknown = undefined,
) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(undefined);
        }
      } catch (err) {
        if (!cancelled) setError(err as Error);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => void tick(), intervalMs);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [intervalMs, refreshSignal]);

  return { data, error, loading };
}
