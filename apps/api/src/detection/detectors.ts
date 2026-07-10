import type { Logger } from '@nova/shared';
import type { PumpFunLaunchEvent } from '../solana/pumpfun.js';
import {
  isBuyInstruction,
  isCreateInstruction,
  isMigrationInstruction,
} from '../solana/pumpfun.js';

export type DetectionKind = 'new_token' | 'liquidity_add' | 'migration';

export interface DetectionResult {
  kind: DetectionKind;
  signature: string;
  slot: number;
  detectedAt: string;
}

export type DetectionHandler = (result: DetectionResult) => void | Promise<void>;

/**
 * Fans a raw pump.fun log event out into semantic detection events. Kept
 * separate from PumpFunMonitor so the classification logic is unit-testable
 * without a live websocket connection.
 */
export class TokenEventClassifier {
  constructor(private readonly logger: Logger) {}

  classify(event: PumpFunLaunchEvent): DetectionResult | undefined {
    if (isCreateInstruction(event.logs)) {
      return {
        kind: 'new_token',
        signature: event.signature,
        slot: event.slot,
        detectedAt: event.detectedAt,
      };
    }
    if (isMigrationInstruction(event.logs)) {
      return {
        kind: 'migration',
        signature: event.signature,
        slot: event.slot,
        detectedAt: event.detectedAt,
      };
    }
    if (isBuyInstruction(event.logs)) {
      return {
        kind: 'liquidity_add',
        signature: event.signature,
        slot: event.slot,
        detectedAt: event.detectedAt,
      };
    }
    this.logger.debug({ signature: event.signature }, 'unclassified pump.fun event');
    return undefined;
  }
}
