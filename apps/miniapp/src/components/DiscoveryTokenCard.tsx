import { AlertTriangle, Check, X } from 'lucide-react';
import { numberOrFallback, percent, timeAgo, usd } from '../lib/format.js';
import type { Token } from '../lib/types.js';
import { Card } from './ui/index.js';
import { TokenAvatar } from './TokenAvatar.js';

function FlagIcon({ ok }: { ok: boolean | null | undefined }) {
  if (ok === null || ok === undefined) {
    return <span className="text-text-secondary">?</span>;
  }
  return ok ? (
    <Check size={12} className="text-success" />
  ) : (
    <X size={12} className="text-danger" />
  );
}

export function DiscoveryTokenCard({ token }: { token: Token }) {
  const symbol = token.symbol ?? token.mint.slice(0, 6);

  return (
    <Card className="flex flex-col gap-3 p-4" static>
      <div className="flex items-center gap-3">
        <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} mint={token.mint} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-text-primary">{symbol}</span>
          <span className="text-xs text-text-secondary">
            {token.dex} · {timeAgo(token.createdAt)}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] uppercase tracking-wide text-text-secondary">AI score</span>
          <span className="text-lg font-bold text-text-primary">
            {numberOrFallback(token.aiScore, 'No data')}
          </span>
        </div>
      </div>

      {token.isHoneypotSuspected && (
        <div className="flex items-center gap-2 rounded-input bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          Honeypot suspected — trade with caution
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 border-t border-surface-border/10 pt-3 text-center text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary">Liquidity</span>
          <span className="font-medium text-text-primary">{usd(token.liquidityUsd, 0)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary">Mkt cap</span>
          <span className="font-medium text-text-primary">{usd(token.marketCapUsd, 0)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-text-secondary">Holders</span>
          <span className="font-medium text-text-primary">
            {numberOrFallback(token.holderCount, 'No data')}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {/* No volume field exists on Token — see MISSING_APIS.md. Shown as
           * an honest "No data" slot rather than omitted or fabricated. */}
          <span className="text-text-secondary">Volume</span>
          <span className="font-medium text-text-secondary">No data</span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-surface-border/10 pt-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-text-secondary">
            Mint <FlagIcon ok={token.mintAuthorityRevoked} />
          </span>
          <span className="flex items-center gap-1 text-text-secondary">
            Freeze <FlagIcon ok={token.freezeAuthorityRevoked} />
          </span>
          <span className="flex items-center gap-1 text-text-secondary">
            LP <FlagIcon ok={token.lpBurnedOrLocked} />
          </span>
        </div>
        <span className="text-text-secondary">Top10 {percent(token.top10HolderPercent, 0)}</span>
      </div>

      {/* No migration timestamp/flag exists on Token — see MISSING_APIS.md. */}
      <div className="text-[11px] text-text-secondary">Migration status: not tracked</div>
    </Card>
  );
}
