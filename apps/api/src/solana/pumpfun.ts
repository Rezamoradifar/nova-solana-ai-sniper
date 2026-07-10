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

// Anchored to the exact instruction name (not a bare substring): live sampling this
// session turned up `CreateFeeSharingConfig` and `MigrateBondingCurveCreator` — unrelated
// fee/creator-payout admin instructions that happen to contain "Create"/"Migrate" as a
// substring and involve zero token balance movement. A loose `.includes()` match would
// misclassify those as a new-token launch / migration. `CreateV2` is included alongside
// `Create` since pump.fun's live instruction set includes both create variants.
const CREATE_INSTRUCTION_RE = /Instruction:\s*(Create|CreateV2)$/;
const BUY_INSTRUCTION_RE = /Instruction:\s*(Buy|BuyV2|BuyExactQuoteInV2)$/;
const WITHDRAW_INSTRUCTION_RE = /Instruction:\s*Withdraw$/;

export function isCreateInstruction(logs: string[]): boolean {
  return logs.some((l) => CREATE_INSTRUCTION_RE.test(l));
}

export function isBuyInstruction(logs: string[]): boolean {
  return logs.some((l) => BUY_INSTRUCTION_RE.test(l));
}

/**
 * Best-effort hint only, not authoritative — live sampling found no reliably-observed
 * single "this bonding curve just migrated" log line (the real Withdraw-driven migration
 * event turned out to be rare relative to overall program traffic, and "Migrate" as a
 * substring false-positives on unrelated admin instructions, see above). The ground-truth
 * migration signal is the bonding curve account's own `complete` flag
 * (`solana/pumpfunBondingCurve.ts`), checked by `MigrationMonitor`. This hint exists only
 * to trigger an immediate out-of-band recheck instead of waiting for the next poll tick.
 */
export function isMigrationInstruction(logs: string[]): boolean {
  return logs.some((l) => WITHDRAW_INSTRUCTION_RE.test(l));
}
