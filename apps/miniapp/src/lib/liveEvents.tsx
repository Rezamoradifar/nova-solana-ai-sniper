import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken } from './authToken.js';

/** Complete WS event catalog — apps/api/src/lib/eventBus.ts publishes
 * nothing else (verified against API_CONTRACT.md); do not add types here
 * speculatively. */
export type LiveEventType =
  'token.created' | 'token.migrated' | 'trade.created' | 'position.updated' | 'social.mention';

export interface LiveEvent {
  type: LiveEventType;
  payload: Record<string, unknown>;
  at: string;
}

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
const MAX_EVENTS = 50;

function toWsUrl(apiBase: string, token: string): string {
  // Same-origin relative base (production, e.g. "/api") resolves against the
  // current page location; an absolute dev URL (http://localhost:4000) is
  // used as-is. Either way, swap the http(s) scheme for ws(s). Same approach
  // as apps/dashboard/src/lib/useLiveEvents.ts's already-verified toWsUrl.
  const absolute = new URL(apiBase, window.location.origin);
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:';
  absolute.pathname = `${absolute.pathname.replace(/\/$/, '')}/ws`;
  absolute.searchParams.set('token', token);
  return absolute.toString();
}

// Every query key a given event type should invalidate on arrival — the one
// WebSocket connection this provider owns is what keeps every screen's
// react-query cache live, instead of each screen polling or opening its own
// socket. Deliberately conservative: only invalidates caches the event type
// actually affects.
const INVALIDATES: Record<LiveEventType, readonly (readonly unknown[])[]> = {
  'token.created': [['tokens']],
  'token.migrated': [['tokens']],
  'trade.created': [['portfolio'], ['trades']],
  'position.updated': [['positions'], ['portfolio']],
  'social.mention': [],
};

interface LiveEventsContextValue {
  /** Most recent first, capped at MAX_EVENTS — backs the Notification Center.
   * This is a live, in-memory feed only; there is no persisted/historical
   * notification store on the backend (MISSING_APIS.md #9), so this list is
   * always empty on a fresh app open and only grows while it stays mounted. */
  events: LiveEvent[];
  unreadCount: number;
  connected: boolean;
  markAllRead: () => void;
}

const LiveEventsContext = createContext<LiveEventsContextValue | undefined>(undefined);

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closedByCleanup = false;

    function connect() {
      socket = new WebSocket(toWsUrl(API_BASE, token!));

      socket.onopen = () => setConnected(true);

      socket.onclose = () => {
        setConnected(false);
        if (!closedByCleanup) {
          retryTimer = setTimeout(connect, 3000);
        }
      };

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data as string) as LiveEvent;
          setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
          setUnreadCount((n) => n + 1);
          for (const key of INVALIDATES[event.type] ?? []) {
            void queryClient.invalidateQueries({ queryKey: key as unknown[] });
          }
        } catch {
          // Ignore malformed frames rather than crashing the socket handler.
        }
      };
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [queryClient]);

  const markAllRead = () => setUnreadCount(0);

  return (
    <LiveEventsContext.Provider value={{ events, unreadCount, connected, markAllRead }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

export function useLiveEvents(): LiveEventsContextValue {
  const ctx = useContext(LiveEventsContext);
  if (!ctx) throw new Error('useLiveEvents must be used within LiveEventsProvider');
  return ctx;
}
