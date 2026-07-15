import { isFiniteNumber, pct, pnlToneClass, sol, usd } from '../lib/format.js';
import type { Position } from '../lib/types.js';
import { Card, Button } from './ui/index.js';
import { TokenAvatar } from './TokenAvatar.js';
import type { SellMode } from './SellActionModal.js';

export interface PositionCardProps {
  position: Position;
  onAction?: (mode: SellMode) => void;
}

const EXIT_REASON_LABEL: Record<string, string> = {
  take_profit: 'Take profit',
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
  manual: 'Manual sell',
  manual_emergency: 'Emergency sell',
};

export function PositionCard({ position, onAction }: PositionCardProps) {
  const { token } = position;
  const symbol = token.symbol ?? token.mint.slice(0, 6);
  const pnlPercent =
    position.status === 'OPEN' &&
    isFiniteNumber(position.currentPriceUsd) &&
    position.entryPriceUsd > 0
      ? ((position.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : undefined;
  const pnlUsd = position.status === 'OPEN' ? position.unrealizedPnlUsd : position.realizedPnlUsd;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} mint={token.mint} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-text-primary">{symbol}</span>
          <span className="text-xs text-text-secondary">{token.dex}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className={`text-sm font-bold ${pnlToneClass(pnlUsd)}`}>{usd(pnlUsd)}</span>
          {position.status === 'OPEN' && (
            <span className={`text-xs ${pnlToneClass(pnlPercent)}`}>{pct(pnlPercent)}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-surface-border/10 pt-3 text-xs">
        <div className="flex flex-col">
          <span className="text-text-secondary">Invested</span>
          <span className="mt-0.5 font-medium text-text-primary">
            {sol(position.amountSolInvested)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-text-secondary">Entry</span>
          <span className="mt-0.5 font-medium text-text-primary">
            {usd(position.entryPriceUsd, 6)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-text-secondary">
            {position.status === 'OPEN' ? 'Current' : 'Closed'}
          </span>
          <span className="mt-0.5 font-medium text-text-primary">
            {position.status === 'OPEN'
              ? usd(position.currentPriceUsd, 6)
              : (EXIT_REASON_LABEL[position.exitReason ?? ''] ?? 'Closed')}
          </span>
        </div>
      </div>

      {position.status === 'OPEN' && onAction && (
        <div className="flex gap-2 pt-1">
          <Button
            variant="secondary"
            className="flex-1 !px-3 !py-2 text-xs"
            onClick={() => onAction('partial')}
          >
            Partial
          </Button>
          <Button
            variant="secondary"
            className="flex-1 !px-3 !py-2 text-xs"
            onClick={() => onAction('sell')}
          >
            Sell
          </Button>
          <Button
            variant="danger"
            className="flex-1 !px-3 !py-2 text-xs"
            onClick={() => onAction('emergency')}
          >
            Emergency
          </Button>
        </div>
      )}
    </Card>
  );
}
