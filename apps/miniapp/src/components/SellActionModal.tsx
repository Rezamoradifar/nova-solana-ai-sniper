import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api.js';
import { positionActions } from '../lib/positionActions.js';
import { haptics } from '../lib/telegram.js';
import { Button, Modal } from './ui/index.js';
import type { Position } from '../lib/types.js';

export type SellMode = 'sell' | 'partial' | 'emergency';

export interface SellActionModalProps {
  position: Position | null;
  mode: SellMode;
  onOpenChange: (open: boolean) => void;
}

const PARTIAL_PRESETS = [25, 50, 75] as const;

/**
 * One modal for all three real, fund-moving actions. "Sell" and "Emergency
 * Sell" both call POST /positions/:id/sell|/emergency-sell (same
 * PositionManager.closePosition execution path — see MISSING_APIS.md's #4
 * note on why there's no separate urgent swap mode); Emergency additionally
 * requires typing SELL to confirm, since it's meant for "get me out right
 * now" panic moments where a normal tap-once confirm is too easy to misuse.
 */
export function SellActionModal({ position, mode, onOpenChange }: SellActionModalProps) {
  const queryClient = useQueryClient();
  const [percent, setPercent] = useState(25);
  const [emergencyConfirmText, setEmergencyConfirmText] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!position) throw new Error('No position selected');
      if (mode === 'sell') return positionActions.sell(position.id);
      if (mode === 'emergency') return positionActions.emergencySell(position.id);
      return positionActions.partialSell(position.id, percent);
    },
    onSuccess: () => {
      haptics.success();
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      onOpenChange(false);
    },
    onError: () => {
      haptics.error();
    },
  });

  const open = position !== null;
  const symbol = position?.token.symbol ?? position?.token.mint.slice(0, 6) ?? '';

  const title =
    mode === 'sell'
      ? `Sell ${symbol}`
      : mode === 'emergency'
        ? `Emergency Sell ${symbol}`
        : `Partial Sell ${symbol}`;
  const description =
    mode === 'sell'
      ? 'Sells the entire remaining position at the current market price. This executes a real on-chain swap immediately.'
      : mode === 'emergency'
        ? 'Immediately closes the entire position. Use this only when you need out right now — type SELL below to confirm.'
        : 'Sells the selected percentage of your remaining tokens and keeps the rest of the position open.';

  const canConfirm = mode !== 'emergency' || emergencyConfirmText.trim().toUpperCase() === 'SELL';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPercent(25);
          setEmergencyConfirmText('');
          mutation.reset();
        }
        onOpenChange(next);
      }}
      title={title}
      description={description}
    >
      <div className="flex flex-col gap-4">
        {mode === 'partial' && (
          <div className="flex gap-2">
            {PARTIAL_PRESETS.map((p) => (
              <Button
                key={p}
                variant={percent === p ? 'primary' : 'secondary'}
                onClick={() => setPercent(p)}
                className="flex-1"
              >
                {p}%
              </Button>
            ))}
          </div>
        )}

        {mode === 'emergency' && (
          <input
            type="text"
            value={emergencyConfirmText}
            onChange={(e) => setEmergencyConfirmText(e.target.value)}
            placeholder="Type SELL to confirm"
            className="rounded-input border border-danger/40 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-danger/50"
            autoCapitalize="characters"
          />
        )}

        {mutation.isError && (
          <p className="text-sm text-danger">
            {mutation.error instanceof ApiError
              ? mutation.error.message
              : 'Sell failed — check your connection and try again.'}
          </p>
        )}

        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            loading={mutation.isPending}
            disabled={!canConfirm}
            onClick={() => mutation.mutate()}
          >
            {mode === 'sell'
              ? 'Sell now'
              : mode === 'emergency'
                ? 'Emergency sell'
                : `Sell ${percent}%`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
