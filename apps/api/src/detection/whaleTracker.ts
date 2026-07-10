import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';

export interface WalletActivity {
  address: string;
  signature: string;
  slot: number;
  detectedAt: string;
}

export type WalletActivityHandler = (activity: WalletActivity) => void | Promise<void>;

/**
 * Tracks a set of "smart"/whale wallets by subscribing to their logs directly.
 * Used both for whale-tracking alerts and as the trigger source for copy trading.
 */
export class WhaleTracker {
  private subscriptions = new Map<string, number>();

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  track(address: string, onActivity: WalletActivityHandler): void {
    if (this.subscriptions.has(address)) return;
    const pubkey = new PublicKey(address);
    const id = this.connection.onLogs(
      pubkey,
      (logInfo, ctx) => {
        if (logInfo.err) return;
        void onActivity({
          address,
          signature: logInfo.signature,
          slot: ctx.slot,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.subscriptions.set(address, id);
    this.logger.info({ address }, 'tracking wallet');
  }

  async untrack(address: string): Promise<void> {
    const id = this.subscriptions.get(address);
    if (id === undefined) return;
    await this.connection.removeOnLogsListener(id);
    this.subscriptions.delete(address);
  }

  trackedAddresses(): string[] {
    return [...this.subscriptions.keys()];
  }
}
