import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '@nova/shared';

export const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface PumpFunLaunchEvent {
  signature: string;
  slot: number;
  logs: string[];
  detectedAt: string;
}

export type PumpFunEventHandler = (event: PumpFunLaunchEvent) => void | Promise<void>;

/**
 * Subscribes to pump.fun program logs over the RPC websocket. This is a
 * lightweight signal ("something happened involving this program") — the
 * detection layer parses `logs` for the `create`/`buy` instruction discriminants
 * to decide whether it's a new token launch, a buy, or a migration.
 */
export class PumpFunMonitor {
  private subscriptionId: number | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
  ) {}

  start(onEvent: PumpFunEventHandler): void {
    if (this.subscriptionId !== undefined) return;
    this.subscriptionId = this.connection.onLogs(
      PUMPFUN_PROGRAM_ID,
      (logInfo, ctx) => {
        if (logInfo.err) return;
        void onEvent({
          signature: logInfo.signature,
          slot: ctx.slot,
          logs: logInfo.logs,
          detectedAt: new Date().toISOString(),
        });
      },
      'processed',
    );
    this.logger.info({ programId: PUMPFUN_PROGRAM_ID.toBase58() }, 'pump.fun monitor started');
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }
}

export function isCreateInstruction(logs: string[]): boolean {
  return logs.some((l) => l.includes('Instruction: Create'));
}

export function isBuyInstruction(logs: string[]): boolean {
  return logs.some((l) => l.includes('Instruction: Buy'));
}

export function isMigrationInstruction(logs: string[]): boolean {
  return logs.some((l) => l.includes('Instruction: Withdraw') || l.includes('Migrate'));
}
