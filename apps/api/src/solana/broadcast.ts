import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import type { Logger } from '@nova/shared';
import { JitoClient } from './jito.js';
import { latencyTracker } from '../lib/latencyTracker.js';

const JITO_TIP_LAMPORTS = 100_000;

export interface BroadcastDeps {
  connection: Connection;
  logger: Logger;
  jito?: JitoClient;
}

/**
 * 2026-07-23 audit (real on-chain referral/owner payout): extracted verbatim
 * from PositionManager's own private `broadcastTransaction` (unchanged
 * behavior — Jito-bundle-first, direct-send fallback, explicit
 * `confirmation.value.err` revert check on both paths, since
 * confirmTransaction alone never catches an on-chain revert, only a
 * timeout/expiry) so the new payout-transfer code path can reuse the exact
 * same, already-battle-tested reliability logic instead of a second,
 * potentially-drifting copy. PositionManager's own method is now a one-line
 * delegate to this function — see its own doc comment.
 */
export async function broadcastTransaction(
  deps: BroadcastDeps,
  transaction: VersionedTransaction,
  signer: Keypair,
  lastValidBlockHeight?: number,
  traceId?: string,
): Promise<string> {
  const signature = bs58.encode(transaction.signatures[0]!);
  const confirmStrategy =
    lastValidBlockHeight !== undefined
      ? { signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight }
      : signature;

  latencyTracker.mark(traceId, 'broadcast');

  if (deps.jito) {
    try {
      const { blockhash } = await deps.connection.getLatestBlockhash();
      const tipTx = JitoClient.buildTipTransaction(signer, JITO_TIP_LAMPORTS, blockhash);
      await deps.jito.sendBundle([tipTx, transaction]);
      const confirmation = await deps.connection.confirmTransaction(
        confirmStrategy as never,
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(
          `Transaction ${signature} landed but reverted on-chain: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      latencyTracker.mark(traceId, 'rpc_confirmation');
      return signature;
    } catch (err) {
      deps.logger.warn({ err }, 'Jito bundle submission failed — falling back to a direct send');
    }
  }

  await deps.connection.sendTransaction(transaction);
  const confirmation = await deps.connection.confirmTransaction(
    confirmStrategy as never,
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction ${signature} landed but reverted on-chain: ${JSON.stringify(confirmation.value.err)}`,
    );
  }
  latencyTracker.mark(traceId, 'rpc_confirmation');
  return signature;
}
