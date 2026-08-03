import { useEffect } from 'react';
import {
  ArrowRightLeft,
  Layers,
  MessageCircle,
  Repeat2,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useLiveEvents, type LiveEvent } from '../lib/liveEvents.js';
import { isFiniteNumber, pnlToneClass, timeAgo, usd } from '../lib/format.js';
import { Card } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function truncMint(mint: string | undefined): string {
  return mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : 'unknown token';
}

/** Renders exactly the fields each event type actually publishes (see
 * apps/api/src/lib/eventBus.ts's real publish call sites) — never guesses at
 * a field that isn't there; an unexpected/malformed payload falls back to a
 * generic line instead of crashing the list. */
function describeEvent(event: LiveEvent): { icon: React.ReactNode; text: React.ReactNode } {
  const p = event.payload;
  switch (event.type) {
    case 'token.created':
      return {
        icon: <Sparkles size={16} className="text-accent-from" />,
        text: (
          <>
            New token detected · <span className="font-mono">{truncMint(str(p.mint))}</span> ·{' '}
            {str(p.dex) ?? 'unknown DEX'}
          </>
        ),
      };
    case 'token.migrated':
      return {
        icon: <ArrowRightLeft size={16} className="text-accent-to" />,
        text: (
          <>
            Token migrated · <span className="font-mono">{truncMint(str(p.mint))}</span> ·{' '}
            {str(p.from) ?? '?'} → {str(p.to) ?? '?'}
          </>
        ),
      };
    case 'trade.created':
      return {
        icon: (
          <Repeat2 size={16} className={str(p.side) === 'SELL' ? 'text-danger' : 'text-success'} />
        ),
        text: (
          <>
            {str(p.side) ?? 'Trade'} · <span className="font-mono">{truncMint(str(p.mint))}</span>
          </>
        ),
      };
    case 'position.updated': {
      const realizedPnlUsd = num(p.realizedPnlUsd);
      return {
        icon: <Layers size={16} className="text-text-secondary" />,
        text: (
          <>
            Position {str(p.status) === 'CLOSED' ? 'closed' : 'opened'}
            {isFiniteNumber(realizedPnlUsd) && (
              <>
                {' '}
                · <span className={pnlToneClass(realizedPnlUsd)}>{usd(realizedPnlUsd)}</span>
              </>
            )}
          </>
        ),
      };
    }
    case 'social.mention':
      return {
        icon: <MessageCircle size={16} className="text-text-secondary" />,
        text: <>Social mention{str(p.text) ? `: “${str(p.text)!.slice(0, 80)}”` : ''}</>,
      };
    default:
      return { icon: <Sparkles size={16} className="text-text-secondary" />, text: event.type };
  }
}

/**
 * Notification Center (Increment 4) — a live-only feed built from the real
 * WS event stream (lib/liveEvents.tsx), which is the single source shared
 * with the TopBar bell badge. There is no persisted/historical notification
 * store, and trade.failed/deposit/withdrawal events don't exist in the WS
 * catalog (MISSING_APIS.md #9) — this list is always empty on a fresh open
 * and only grows while the app stays running, never backfilled.
 */
export function Notifications() {
  const { events, connected, markAllRead } = useLiveEvents();

  useEffect(() => {
    markAllRead();
  }, [markAllRead]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Notifications" subtitle="Live activity" />

      <div className="flex items-center gap-2 text-xs text-text-secondary">
        {connected ? (
          <>
            <Wifi size={14} className="text-success" /> Live
          </>
        ) : (
          <>
            <WifiOff size={14} className="text-danger" /> Reconnecting…
          </>
        )}
      </div>

      {events.length === 0 ? (
        <Card className="p-5">
          <p className="text-sm text-text-secondary">
            No notifications yet — you'll see live updates here as they happen while the app is
            open.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((event, i) => {
            const { icon, text } = describeEvent(event);
            return (
              <Card key={`${event.at}-${i}`} className="flex items-center gap-3 p-3.5" static>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
                  {icon}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-text-primary">{text}</span>
                  <span className="text-xs text-text-secondary">{timeAgo(event.at)}</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
