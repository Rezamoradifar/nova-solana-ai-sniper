import type { WalletBackup } from '@nova/shared';
import type { ScreenId } from './types.js';

/**
 * Tracks the one text-input flow a chat can be mid-way through (e.g. "paste your
 * secret key", "send a new take-profit %"). In-memory only: if the bot restarts
 * mid-flow the user just has to tap the button again, which is an acceptable
 * trade-off for not pulling in a session/storage plugin for a single pending slot.
 */
export type PendingAction =
  | { type: 'wallet_import'; returnTo: ScreenId }
  | { type: 'wallet_backup_awaiting_password'; walletId: string; returnTo: ScreenId }
  | { type: 'wallet_restore_awaiting_file'; returnTo: ScreenId }
  | { type: 'wallet_restore_awaiting_password'; backup: WalletBackup; returnTo: ScreenId }
  | { type: 'position_edit_tp'; positionId: string; returnTo: ScreenId }
  | { type: 'position_edit_sl'; positionId: string; returnTo: ScreenId }
  | {
      type: 'settings_edit';
      snipeConfigId: string;
      field:
        'buyAmountSol' | 'maxSlippageBps' | 'minLiquidityUsd' | 'minAiScore' | 'stopLossPercent';
      returnTo: ScreenId;
    };

const pending = new Map<number, PendingAction>();

export function setPending(chatId: number, action: PendingAction): void {
  pending.set(chatId, action);
}

export function getPending(chatId: number): PendingAction | undefined {
  return pending.get(chatId);
}

export function clearPending(chatId: number): void {
  pending.delete(chatId);
}

/** Read-only diagnostic snapshot — e.g. logging what's still in-flight on shutdown. */
export function pendingSnapshot(): Array<{ chatId: number; type: PendingAction['type'] }> {
  return [...pending.entries()].map(([chatId, action]) => ({ chatId, type: action.type }));
}
