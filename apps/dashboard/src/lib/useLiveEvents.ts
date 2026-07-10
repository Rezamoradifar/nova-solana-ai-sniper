import { useEffect, useRef, useState } from 'react';
import { getToken } from './api.js';

export type LiveEventType =
  'token.created' | 'token.migrated' | 'trade.created' | 'position.updated' | 'social.mention';

export interface LiveEvent {
  type: LiveEventType;
  payload: Record<string, unknown>;
  at: string;
}

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

function toWsUrl(apiBase: string, token: string): string {
  // Same-origin relative base (production, e.g. "/api") resolves against the
  // current page location; an absolute dev URL (http://localhost:4000) is
  // used as-is. Either way, swap the http(s) scheme for ws(s).
  const absolute = new URL(apiBase, window.location.origin);
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:';
  absolute.pathname = `${absolute.pathname.replace(/\/$/, '')}/ws`;
  absolute.searchParams.set('token', token);
  return absolute.toString();
}

/**
 * Subscribes to the API's live event feed and bumps a counter whenever an
 * event of interest arrives (or, if `types` is omitted, on every event).
 * Reconnects with backoff on drop; consumers pass the returned counter as
 * `usePolling`'s `refreshSignal` so a live push triggers an immediate refetch
 * while the polling interval remains as a fallback.
 */
export function useLiveEvents(types?: LiveEventType[]): number {
  const [tick, setTick] = useState(0);
  const typesRef = useRef(types);
  useEffect(() => {
    typesRef.current = types;
  });

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closedByCleanup = false;

    function connect() {
      socket = new WebSocket(toWsUrl(API_BASE, token!));

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data as string) as LiveEvent;
          if (!typesRef.current || typesRef.current.includes(event.type)) {
            setTick((t) => t + 1);
          }
        } catch {
          // Ignore malformed frames rather than crashing the socket handler.
        }
      };

      socket.onclose = () => {
        if (!closedByCleanup) {
          retryTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return tick;
}
