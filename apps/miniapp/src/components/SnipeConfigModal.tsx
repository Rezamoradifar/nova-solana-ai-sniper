import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { haptics } from '../lib/telegram.js';
import { Button, Input, Modal } from './ui/index.js';

export interface SnipeConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Real POST /snipes — every field maps 1:1 to SnipeConfig's real columns
 * (apps/api/prisma/schema.prisma); server-side defaults (maxSlippageBps,
 * trailingStopPercent, etc.) apply to whatever's left blank here. */
export function SnipeConfigModal({ open, onOpenChange }: SnipeConfigModalProps) {
  const queryClient = useQueryClient();
  const [buyAmountSol, setBuyAmountSol] = useState('0.1');
  const [minAiScore, setMinAiScore] = useState('60');
  const [minLiquidityUsd, setMinLiquidityUsd] = useState('1000');
  const [takeProfitPercent, setTakeProfitPercent] = useState('');
  const [stopLossPercent, setStopLossPercent] = useState('');
  const [autoBuyOnLaunch, setAutoBuyOnLaunch] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/snipes', {
        buyAmountSol: Number(buyAmountSol),
        minAiScore: Number(minAiScore),
        minLiquidityUsd: Number(minLiquidityUsd),
        takeProfitPercent: takeProfitPercent ? Number(takeProfitPercent) : undefined,
        stopLossPercent: stopLossPercent ? Number(stopLossPercent) : undefined,
        autoBuyOnLaunch,
      }),
    onSuccess: () => {
      haptics.success();
      void queryClient.invalidateQueries({ queryKey: ['snipes'] });
      onOpenChange(false);
    },
    onError: () => haptics.error(),
  });

  const buyAmountValid = Number(buyAmountSol) > 0;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
      title="New snipe config"
      description="Creates a real auto-buy rule — POST /snipes."
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Buy amount (SOL)"
          type="number"
          step="0.01"
          min="0"
          value={buyAmountSol}
          onChange={(e) => setBuyAmountSol(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Min AI score"
            type="number"
            min="0"
            max="100"
            value={minAiScore}
            onChange={(e) => setMinAiScore(e.target.value)}
          />
          <Input
            label="Min liquidity ($)"
            type="number"
            min="0"
            value={minLiquidityUsd}
            onChange={(e) => setMinLiquidityUsd(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Take profit (%)"
            type="number"
            min="0"
            placeholder="Optional"
            value={takeProfitPercent}
            onChange={(e) => setTakeProfitPercent(e.target.value)}
          />
          <Input
            label="Stop loss (%)"
            type="number"
            min="0"
            placeholder="Optional"
            value={stopLossPercent}
            onChange={(e) => setStopLossPercent(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={autoBuyOnLaunch}
            onChange={(e) => setAutoBuyOnLaunch(e.target.checked)}
            className="h-4 w-4 rounded border-surface-border/30 accent-accent-from"
          />
          Auto-buy on launch
        </label>

        {mutation.isError && (
          <p className="text-sm text-danger">
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : 'Failed to create — check your connection and try again.'}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            loading={mutation.isPending}
            disabled={!buyAmountValid}
            onClick={() => mutation.mutate()}
          >
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
