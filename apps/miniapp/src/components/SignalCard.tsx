import { isFiniteNumber, timeAgo, usd } from '../lib/format.js';
import type { Token } from '../lib/types.js';
import { Card } from './ui/index.js';
import { TokenAvatar } from './TokenAvatar.js';

function confidenceTone(score: number): string {
  if (score >= 70) return 'text-success';
  if (score >= 40) return 'text-warning';
  return 'text-danger';
}

function confidenceBarColor(score: number): string {
  if (score >= 70) return 'bg-success';
  if (score >= 40) return 'bg-warning';
  return 'bg-danger';
}

/**
 * "AI Signal card" per the brief — sourced from the real Token.aiScore/
 * aiSummary (GET /tokens), used here as the confidence score. There is no
 * dedicated /signals endpoint (MISSING_APIS.md #3); a "signal" here means
 * any token that has actually been scored (aiScore is not null), not every
 * detected token.
 */
export function SignalCard({ token }: { token: Token }) {
  const symbol = token.symbol ?? token.mint.slice(0, 6);
  const score = token.aiScore;

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
        {isFiniteNumber(score) && (
          <span className={`text-2xl font-extrabold ${confidenceTone(score)}`}>
            {Math.round(score)}
          </span>
        )}
      </div>

      {isFiniteNumber(score) && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full rounded-full ${confidenceBarColor(score)}`}
            style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
          />
        </div>
      )}

      {token.aiSummary && <p className="text-sm text-text-secondary">{token.aiSummary}</p>}

      <div className="flex items-center gap-4 border-t border-surface-border/10 pt-3 text-xs">
        <span className="text-text-secondary">
          Liquidity{' '}
          <span className="font-medium text-text-primary">{usd(token.liquidityUsd, 0)}</span>
        </span>
        <span className="text-text-secondary">
          Mkt cap{' '}
          <span className="font-medium text-text-primary">{usd(token.marketCapUsd, 0)}</span>
        </span>
      </div>
    </Card>
  );
}
