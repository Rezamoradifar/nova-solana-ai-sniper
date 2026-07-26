import { randomBytes, randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { Dex, PrismaClient } from '@prisma/client';
import { unsealKeypair, type Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import { JupiterClient, SOL_MINT, type PriorityLevel } from '../solana/jupiter.js';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import {
  sharedSolPriceOracle,
  getBondingCurveVaultAta,
  type SolPriceOracle,
} from '../solana/pumpfunBondingCurve.js';
import { getTopHolder } from '../detection/onchain.js';
import type { DexRegistry } from '../solana/dex/registry.js';
import { JitoClient } from '../solana/jito.js';
import { broadcastTransaction as broadcastTransactionShared } from '../solana/broadcast.js';
import { evaluateExit, resolveEffectiveStopLossPercent, type ExitReason } from './exitEngine.js';
import { positionCloseLock } from './positionCloseLock.js';
import {
  classifySellFailure,
  type SellFailureCategory,
  type SellFailureClassification,
} from './sellFailureClassifier.js';
import { computeTrailingStopDisplay, defaultExitParams } from './adaptiveTrailingStop.js';
import { eventBus } from '../lib/eventBus.js';
import { latencyTracker } from '../lib/latencyTracker.js';
import { TtlCache } from '../lib/ttlCache.js';
import { TradingSafety, SafetyCheckError } from './safety.js';
import {
  evaluateNextPartialExit,
  DEFAULT_PARTIAL_EXIT_TIERS,
  type PartialExitTier,
} from './partialExitEngine.js';
import {
  computeInstitutionalTrailingStopPriceUsd,
  INSTITUTIONAL_STOP_LOSS_PERCENT,
} from './institutionalTrailingStop.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;

/**
 * Never trust a pre-trade Jupiter quote for bookkeeping — actual execution almost
 * always differs slightly from the estimate. Reads what actually landed in the
 * wallet from the confirmed transaction's own balance snapshot.
 */
async function getActualTokenDelta(
  connection: Connection,
  signature: string,
  ownerPubkey: string,
  mint: string,
): Promise<bigint> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) {
    throw new Error(
      `Could not fetch confirmed transaction ${signature} to verify the actual amount received`,
    );
  }
  const findAmount = (balances: typeof tx.meta.postTokenBalances) =>
    balances?.find((b) => b.owner === ownerPubkey && b.mint === mint)?.uiTokenAmount.amount;

  const pre = BigInt(findAmount(tx.meta.preTokenBalances) ?? '0');
  const post = BigInt(findAmount(tx.meta.postTokenBalances) ?? '0');
  return post - pre;
}

/**
 * The verification RPC call (getParsedTransaction) frequently fails with
 * "Could not fetch confirmed transaction" for a few seconds right after a
 * swap lands — the tx is confirmed on-chain but hasn't propagated to the RPC
 * node's own view yet. Live-verified 2026-07-11: two real production BUYs
 * landed on-chain and failed verification on the first attempt with exactly
 * this transient error, permanently locking that wallet+token pair out of
 * further auto-buys (see unverifiedSwapLocks) even though the transaction
 * was simply not yet visible. Retrying a few times with a short delay before
 * giving up fixes the root cause instead of just working around its effect.
 */
async function withVerificationRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Production Bug Fix (2026-07-14): tags a thrown error with its classified
 * SELL-failure category so callers further up the stack (PriceMonitor's tick
 * loop, EmergencyExitMonitor's tick loop) can log something more useful than
 * a raw, unclassified `err` — without those callers needing to re-import or
 * re-run the classifier themselves. Never changes the error's message/type,
 * only attaches metadata; existing `.rejects.toThrow(/pattern/)` assertions
 * in tests are unaffected.
 */
function tagSellFailure<E>(err: E, category: SellFailureCategory): E {
  if (err && typeof err === 'object') {
    (err as { sellFailureCategory?: SellFailureCategory }).sellFailureCategory = category;
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same idea as getActualTokenDelta, but for native SOL (lamports), which isn't an SPL token balance. */
async function getActualSolDelta(
  connection: Connection,
  signature: string,
  ownerPubkey: string,
): Promise<bigint> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) {
    throw new Error(
      `Could not fetch confirmed transaction ${signature} to verify the actual amount received`,
    );
  }
  const accountIndex = tx.transaction.message.accountKeys.findIndex(
    (k) => k.pubkey.toBase58() === ownerPubkey,
  );
  if (accountIndex === -1) {
    throw new Error(`Owner ${ownerPubkey} not found in transaction ${signature}`);
  }
  // The signer is also the fee payer, so this delta is already net of the network fee.
  return BigInt(tx.meta.postBalances[accountIndex]!) - BigInt(tx.meta.preBalances[accountIndex]!);
}

/**
 * The wallet's real, current on-chain balance of a token — the only safe source
 * of truth for "how much can we actually sell." Never sell a stored/estimated
 * amount without checking this first.
 */
export async function getRealTokenBalance(
  connection: Connection,
  ownerPubkey: string,
  mint: string,
): Promise<bigint> {
  const resp = await connection.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkey), {
    mint: new PublicKey(mint),
  });
  if (resp.value.length === 0) return 0n;
  return BigInt(resp.value[0]!.account.data.parsed.info.tokenAmount.amount);
}

export interface OpenPositionParams {
  userId: string;
  walletId: string;
  walletPublicKey: string;
  encryptedSecret: string;
  encryptionKey: string;
  tokenId: string;
  mint: string;
  symbol?: string;
  amountSol: number;
  slippageBps: number;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  trailingStopPercent?: number;
  /** Optional exit strategy — see adaptiveTrailingStop.ts. Frozen onto the Position at open time. */
  trailingStopPreset?: string;
  /** Display-only, for the BUY trade card — the score that actually gated this buy. */
  aiScore?: number;
  /** Institutional Mode — "max 3 simultaneous positions," see safety.ts's CheckOpenParams. */
  maxOpenPositionsOverride?: number;
  /** Institutional Mode — gates safety.ts's capital-reserve + daily-loss-%
   * checks, AND is frozen onto the Position at open time (see schema.prisma). */
  institutionalModeEnabled?: boolean;
  /** moonbagPercent (0-100, from SnipeConfig) is converted to a token-amount
   * floor here, once the actual bought amount is known post-swap. */
  moonbagPercent?: number;
  /** Frozen at open — the combined min(ruleScore, aiScore) that gated+sized
   * this trade, for later trade-report display (Position.riskScoreAtEntry). */
  riskScoreAtEntry?: number;
  /** Frozen at open — see partialExitEngine.ts. Undefined/omitted means "not
   * an institutional position," same as every other institutional field here. */
  partialTakeProfitTiers?: readonly PartialExitTier[];
  /**
   * Latency Optimization Stage 1 (2026-07-14): epoch-ms timestamps captured
   * upstream (worker.ts's handleNewTokenLaunch) for the token-level stages
   * that happen before any per-user buy attempt exists — token detection and
   * AI scoring are shared across every user's SnipeConfig fan-out for this
   * mint, so they're passed in rather than re-measured per attempt. All
   * optional: a caller that omits them (copyTrading.ts, every existing test)
   * simply doesn't get those two stages in its latency trace — everything
   * else about the buy is unaffected.
   */
  tokenDetectedAt?: number;
  aiScoringStartAt?: number;
  aiScoringEndAt?: number;
  /**
   * Two-stage discovery pipeline (2026-07-22): epoch-ms timestamps for the
   * candidatePipeline.ts checkpoints (queue pickup, DexScreener validation,
   * critical-security-gate completion, sellability verification) and the
   * decision/buy-submission checkpoints captured in worker.ts/autoTrader.ts —
   * all upstream of any per-user buy attempt, same optional/pass-through
   * convention as the three fields above.
   */
  analysisStartedAt?: number;
  dexValidatedAt?: number;
  safetyCompletedAt?: number;
  sellabilityVerifiedAt?: number;
  decisionAt?: number;
  buySubmittedAt?: number;
}

/**
 * Production Bug Fix (2026-07-14): opt-in tuning for sendSwap, undefined by
 * default so every field individually preserves today's behavior. See
 * PositionManager.SELL_SEND_SWAP_OPTIONS for the concrete SELL-only values.
 */
interface SendSwapOptions {
  side?: 'BUY' | 'SELL';
  /** Total attempts (including the first) at the pre-broadcast quote+build step. */
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  priorityLevel?: PriorityLevel;
  /**
   * BUY Engine V2 (2026-07-14): explicit override of which classifySellFailure
   * categories are safe to retry pre-broadcast for this call. Undefined falls
   * back to the classifier's own `retryablePreBroadcast` flag — the exact
   * behavior SELL_SEND_SWAP_OPTIONS already relied on, unchanged. Named after
   * the SELL classifier (it's the same taxonomy reused for BUY failures, not
   * a separate one) — see sellFailureClassifier.ts.
   */
  retryableCategories?: readonly SellFailureCategory[];
  /**
   * Latency Optimization Stage 1 (2026-07-14): when set, threaded into
   * jupiter.prepareSwap (quote_request/quote_received/tx_build/tx_sign
   * marks) and into broadcastTransaction (broadcast/rpc_confirmation marks)
   * — pure measurement, see latencyTracker.ts's doc comment. Undefined for
   * every caller that hasn't opted in.
   */
  traceId?: string;
}

/** A random-looking signature so paper trades are visually distinct from real (base58) ones. */
function paperSignature(): string {
  return `PAPER${randomBytes(16).toString('hex')}`;
}

export class PositionManager {
  private readonly solPriceOracle: SolPriceOracle = sharedSolPriceOracle;

  /**
   * Guards against re-submitting a brand-new swap for a position/wallet+token
   * whose previous attempt already landed on-chain but couldn't be verified
   * (getActualTokenDelta/getActualSolDelta itself failing, e.g. an RPC outage
   * right after the swap confirmed). Without this, the swap's own on-chain
   * effect is real and done, but the DB never learns about it (recordFailedTrade
   * has no signature to store), so the position stays OPEN with its original
   * amountToken untouched — and PriceMonitor's next tick (or a retried manual
   * buy) sees the same "still needs to execute" state and submits ANOTHER real
   * swap. closePosition's own realBalance-vs-recordedAmount cap prevents any
   * single resubmit from overselling past the wallet's actual balance, but does
   * nothing to stop a second, third, Nth resubmit from each selling another
   * full recordedAmount out of whatever balance is left — which is exactly what
   * happened live on 2026-07-11: 3 consecutive verification-RPC failures on one
   * position produced 3 separate real on-chain sells of the same amount, 2 of
   * which drained tokens that had nothing to do with the position being closed.
   * Keyed by positionId for sells, `${walletId}:${tokenId}` for buys (no
   * positionId exists yet at buy time). Deliberately process-lifetime only, not
   * persisted — see the doc comment on the catch blocks that set it.
   *
   * Value is the timestamp the lock was set. A lock is never permanent: after
   * RECONCILIATION_LOCK_TTL_MS it auto-expires and trading recovers on its
   * own (see isLockActive). Root-cause investigation 2026-07-12 found the
   * previous Set-based version blocked a wallet+token pair forever once a
   * single verification RPC call failed, with no recovery path short of a
   * full process restart — a real "no buy ever executes again for this pair"
   * bug, not a deliberate safety gate.
   */
  private readonly unverifiedSwapLocks = new Map<string, number>();

  /**
   * 2026-07-21 audit (section F): the swap-broadcast-failure catch below used
   * to log but never alert — unlike the verification-failure catch a few
   * lines further down, which already does. A position stuck on a transient
   * failure (blockhash expiry, simulation rejection) can retry every price
   * tick — live-verified 2026-07-21, one real position had 6 failures ~1
   * minute apart before succeeding — so this is deduped per position for an
   * hour rather than firing on every single retry.
   */
  private readonly sellFailureAlerted = new TtlCache<string>(60 * 60 * 1000);

  /**
   * BUY Engine V2 (2026-07-14): guards against two concurrent openPosition
   * calls for the same wallet+token both passing safety checks and both
   * submitting a real on-chain swap before either's Position row exists to
   * be caught by the DB's own one-open-position-per-token unique index (see
   * schema.prisma's doc comment on that index) — the BUY-side counterpart to
   * positionCloseLock.ts's concurrent-close guard. Deliberately a plain
   * in-process Set, not a DB-backed claim like positionCloseLock: unlike a
   * close (which can be raced by independent tick loops over a position's
   * entire OPEN lifetime — hours to days), an open's critical section is
   * only the duration of one openPosition() call (seconds), and this process
   * is the only writer (nova-api runs as a single pm2 fork instance, not a
   * cluster — see ecosystem.config.cjs), so an in-process lock already
   * covers every real race without a schema migration for it.
   */
  private readonly openLocks = new Set<string>();

  /** How long a stuck reconciliation lock is honored before auto-recovering. */
  private static readonly RECONCILIATION_LOCK_TTL_MS = 10 * 60 * 1000;

  /**
   * Checks (and lazily clears) a reconciliation lock. Never permanently blocks
   * trading: once the TTL elapses, the lock is treated as stale and removed
   * automatically, with an explicit log line explaining the recovery.
   */
  private isLockActive(key: string): boolean {
    const lockedAt = this.unverifiedSwapLocks.get(key);
    if (lockedAt === undefined) return false;
    const lockedForMs = Date.now() - lockedAt;
    if (lockedForMs < PositionManager.RECONCILIATION_LOCK_TTL_MS) return true;
    this.logger.warn(
      { key, lockedForMs },
      'unverifiedSwapLocks: reconciliation lock expired — automatically recovering, trading is no longer blocked for this key',
    );
    this.unverifiedSwapLocks.delete(key);
    return false;
  }

  constructor(
    private readonly prisma: PrismaClient,
    private readonly connection: Connection,
    private readonly jupiter: JupiterClient,
    private readonly dexScreener: DexScreenerClient,
    private readonly logger: Logger,
    private readonly safety: TradingSafety,
    private readonly notifier?: NotificationService,
    /** Real swaps only ever execute when this is explicitly false (LIVE_TRADING=true). */
    private readonly paperTrading: boolean = true,
    /** Optional: enables a native-DEX fallback when Jupiter can't route a live swap. */
    private readonly dexRegistry?: DexRegistry,
    /** Optional: gated on JITO_BLOCK_ENGINE_URL being configured; unset means every send goes direct. */
    private readonly jito?: JitoClient,
    private readonly maxPriorityFeeLamports: number = DEFAULT_MAX_PRIORITY_FEE_LAMPORTS,
    /** Delay between verification retries (withVerificationRetry) — overridable so tests don't wait on real timers. */
    private readonly verificationRetryDelayMs: number = 2000,
    /** Institutional Mode master switches — see autoTrader.ts's AutoTraderDeps
     * for the same double-opt-in convention. Both default false, so existing
     * callers/tests that don't pass them get exactly today's checkAndMaybeClose
     * behavior (plain evaluateExit, no partial-exit branch). */
    private readonly institutionalModeGloballyEnabled: boolean = false,
    private readonly partialExitsGloballyEnabled: boolean = false,
    /**
     * SELL_MAX_PERMANENT_ROUTE_RETRIES (2026-07-26): how many consecutive
     * `permanent` (no-route) SELL failures — see sellFailureClassifier.ts —
     * a position may accumulate before it's marked unsellable and stops
     * being retried. Fixes a production bug where a position with no
     * Jupiter route was retried forever, once per price tick, with its
     * failure counter reaching the thousands.
     */
    private readonly maxPermanentRouteRetries: number = 3,
  ) {}

  /**
   * Sends a signed transaction via a Jito bundle (tip + swap) when Jito is
   * configured, falling back to a plain direct send if bundle submission fails —
   * Jito can never be the reason a trade doesn't happen. Confirmation uses the
   * swap transaction's own signature either way, since a Jito-landed transaction
   * still appears on-chain under its normal signature once it lands.
   */
  /**
   * `lastValidBlockHeight`, when known (Jupiter returns it alongside the built
   * transaction — see JupiterClient.buildSwapTransaction), lets confirmTransaction
   * use the precise blockhash-expiry confirmation strategy instead of the
   * bare-signature one. Optional and unused unless a caller passes it, so the
   * native-DEX-fallback path (which has no such value) keeps today's exact
   * behavior. This changes only how fast/precisely a *failure* is detected —
   * never what counts as a successful send.
   */
  /**
   * 2026-07-23 audit (real on-chain referral/owner payout): the actual logic
   * (Jito-bundle-first, direct-send fallback, explicit on-chain revert check
   * on both paths) now lives in the standalone `../solana/broadcast.ts`, so
   * the new payout-transfer code can reuse it verbatim instead of a second,
   * potentially-drifting copy. This method is now a pure delegate — same
   * signature, same behavior, zero semantic change.
   */
  private async broadcastTransaction(
    transaction: VersionedTransaction,
    signer: Keypair,
    lastValidBlockHeight?: number,
    traceId?: string,
  ): Promise<string> {
    return broadcastTransactionShared(
      { connection: this.connection, logger: this.logger, jito: this.jito },
      transaction,
      signer,
      lastValidBlockHeight,
      traceId,
    );
  }

  /**
   * Best-effort durability record for a live swap attempt that never reached (or
   * was reverted after) broadcastTransaction — previously such attempts left no
   * Trade row at all, only a log line, so a failed buy/sell was invisible in Trade
   * History. Never throws itself: a DB hiccup while recording a failure must not
   * mask the original error from the caller.
   */
  private async recordFailedTrade(params: {
    walletId: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    amountSol: number;
    amountToken?: number;
    slippageBps?: number;
    /** Set when the swap itself actually landed on-chain and only later verification
     *  failed — without this, a real, successful on-chain transaction was recorded
     *  with no signature at all, making it nearly impossible to find/reconcile later. */
    signature?: string;
    err: unknown;
  }): Promise<void> {
    try {
      await this.prisma.trade.create({
        data: {
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: params.side,
          status: 'FAILED',
          amountSol: params.amountSol,
          amountToken: params.amountToken,
          txSignature: params.signature,
          slippageBps: params.slippageBps ?? 100,
          isPaperTrade: false,
        },
      });
    } catch (recordErr) {
      this.logger.error(
        { recordErr, originalErr: params.err, side: params.side, tokenId: params.tokenId },
        'failed to record a FAILED trade attempt',
      );
    }
  }

  /**
   * Permanent (no-route) SELL failure tracking (2026-07-26 fix): called only
   * when classifySellFailure marked the failure `permanent: true` — currently
   * just `route_unavailable` (NO_ROUTES_FOUND / ROUTE_NOT_FOUND / a Jupiter
   * failure whose message indicates no route exists — see
   * sellFailureClassifier.ts). Unlike the generic sellFailureCount tracked
   * alongside this, that counter never gated a retry; this one does. Once
   * noRouteSellFailureCount reaches maxPermanentRouteRetries
   * (SELL_MAX_PERMANENT_ROUTE_RETRIES, default 3), the position is marked
   * sellUnsellable so checkAndMaybeClose/closePositionLocked/
   * executePartialSellLocked all refuse to attempt another sell for it —
   * fixing the production bug where a routeless position retried forever,
   * once per price tick, with its failure count reaching the thousands.
   */
  private async recordPermanentSellFailure(
    positionId: string,
    mint: string,
    symbolOrMint: string,
    classification: SellFailureClassification,
  ): Promise<void> {
    const updated = await this.prisma.position.update({
      where: { id: positionId },
      data: { noRouteSellFailureCount: { increment: 1 } },
      select: { noRouteSellFailureCount: true, sellUnsellable: true },
    });
    if (updated.sellUnsellable || updated.noRouteSellFailureCount < this.maxPermanentRouteRetries) {
      return;
    }
    await this.prisma.position.update({
      where: { id: positionId },
      data: {
        sellUnsellable: true,
        unsellableAt: new Date(),
        unsellableReason: classification.detail,
      },
    });
    this.logger.error(
      {
        positionId,
        mint,
        attempts: updated.noRouteSellFailureCount,
        category: classification.category,
        detail: classification.detail,
      },
      'Skipping position permanently because no Jupiter route exists.',
    );
    await this.notifier?.notifyError(
      'Position marked unsellable — no Jupiter route',
      `Position ${positionId} (${symbolOrMint}) failed to sell ${updated.noRouteSellFailureCount} consecutive times because no Jupiter (or fallback) route exists for this mint [${classification.category}]. Stop-loss/take-profit/trailing-stop auto-sell is now permanently disabled for this position — manual intervention required.`,
    );
    eventBus.publish('position.updated', { positionId, status: 'OPEN' });
  }

  /**
   * Production Bug Fix (2026-07-14): SELL-only tuning, threaded through as an
   * options object so the BUY call site (openPosition) — which never passes
   * this — is byte-identical to its pre-fix behavior: single attempt, 'high'
   * priority, no fetch timeout. Only closePositionLocked/executePartialSellLocked
   * opt in, since SELL failures are the ones under investigation here and a
   * stuck SELL (unlike a stuck BUY) leaves capital exposed to further downside.
   */
  private static readonly SELL_SEND_SWAP_OPTIONS: SendSwapOptions = {
    side: 'SELL',
    maxAttempts: 2,
    retryDelayMs: 300,
    timeoutMs: 8_000,
    priorityLevel: 'veryHigh',
  };

  /**
   * Broadcast-stage SELL retry (2026-07-23, USOH incident production fix).
   *
   * Root cause: sendSwap's own retry loop (maxAttempts above) only covers a
   * failure at the pre-broadcast quote/build step (this.jupiter.prepareSwap)
   * — broadcastTransaction is called exactly once, outside that loop, by
   * deliberate 2026-07-14 design (see sendSwap's own doc comment) so an
   * ambiguous confirmation-timeout can never trigger a second, potentially
   * double-selling broadcast. But a blockhash that expires AT the broadcast
   * stage (built fine, then the Jito-bundle attempt + fallback direct send in
   * broadcast.ts took long enough that the blockhash was no longer valid by
   * the time it was actually sent) was never retried at all — confirmed live
   * 2026-07-23: two USOH positions retried their SELL every ~45-70s (one full
   * price-monitor cycle apart) for over 10 minutes straight, each attempt
   * dying the exact same way, because nothing inside sendSwap ever rebuilt
   * with a fresh blockhash after a broadcast-stage failure.
   *
   * This wraps sendSwap in an outer loop that, ONLY for the categories
   * classifySellFailure marks `retryablePreBroadcast: true` (blockhash_expired,
   * rpc_timeout, jupiter_failure — see that module's own doc comment: each is
   * a GUARANTEED-never-landed rejection, not merely a likely one), calls
   * sendSwap again from scratch — a fresh prepareSwap call means a fresh quote
   * AND a fresh blockhash, not a resend of the same stale transaction.
   *
   * Duplicate-sell safety (2026-07-23 requirement): before every retry, this
   * re-verifies the wallet's real on-chain token balance still covers the
   * amount being sold. classifySellFailure's guarantee already makes this
   * belt-and-braces rather than load-bearing, but it costs one cheap RPC read
   * and closes the gap completely — if the balance has dropped, some other
   * transaction must have actually landed, and this aborts further retries
   * immediately rather than risking a second sell of tokens already gone.
   */
  private static readonly SELL_BROADCAST_RETRY_MAX_ATTEMPTS = 3;
  private static readonly SELL_BROADCAST_RETRY_DELAY_MS = 500;
  private static readonly SELL_BROADCAST_RETRYABLE_CATEGORIES: readonly SellFailureCategory[] = [
    'blockhash_expired',
    'rpc_timeout',
    'jupiter_failure',
  ];

  private async sendSwapWithBroadcastRetry(
    keypair: Keypair,
    swapParams: {
      inputMint: string;
      outputMint: string;
      amountLamports: bigint;
      slippageBps: number;
    },
    getFallbackTarget: () => Promise<{ dex: Dex; poolAddress: string | null } | undefined>,
    options: SendSwapOptions,
    duplicateGuard: { mint: string; expectedAtLeastRaw: bigint; positionId: string },
  ): Promise<string> {
    const maxAttempts = PositionManager.SELL_BROADCAST_RETRY_MAX_ATTEMPTS;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.sendSwap(keypair, swapParams, getFallbackTarget, options);
      } catch (err) {
        lastErr = err;
        const classification = classifySellFailure(err);
        const isBroadcastRetryable = PositionManager.SELL_BROADCAST_RETRYABLE_CATEGORIES.includes(
          classification.category,
        );
        if (!isBroadcastRetryable || attempt >= maxAttempts) throw err;

        const realBalance = await getRealTokenBalance(
          this.connection,
          keypair.publicKey.toBase58(),
          duplicateGuard.mint,
        ).catch((balanceErr) => {
          this.logger.warn(
            { err: balanceErr, positionId: duplicateGuard.positionId },
            'sendSwapWithBroadcastRetry: balance recheck failed — proceeding with retry anyway (classifier already guarantees this category never landed)',
          );
          return duplicateGuard.expectedAtLeastRaw; // treat as "still there" — don't block a legitimate retry on an unrelated RPC hiccup
        });
        if (realBalance < duplicateGuard.expectedAtLeastRaw) {
          this.logger.error(
            {
              positionId: duplicateGuard.positionId,
              mint: duplicateGuard.mint,
              expected: duplicateGuard.expectedAtLeastRaw.toString(),
              realBalance: realBalance.toString(),
              category: classification.category,
            },
            'sendSwapWithBroadcastRetry: wallet balance dropped mid-retry — a prior attempt may have actually landed; aborting further retries to avoid a duplicate sell',
          );
          throw err;
        }

        this.logger.warn(
          {
            err,
            positionId: duplicateGuard.positionId,
            category: classification.category,
            attempt,
            maxAttempts,
          },
          'sendSwap: broadcast-stage failure is safely retryable (classifier guarantees it never landed) — rebuilding with a fresh quote/blockhash and retrying',
        );
        await sleep(PositionManager.SELL_BROADCAST_RETRY_DELAY_MS);
      }
    }
    // Unreachable — the loop above always either returns or throws.
    throw lastErr;
  }

  /**
   * BUY Engine V2 (2026-07-14): BUY-side counterpart to SELL_SEND_SWAP_OPTIONS
   * above. Added after live production BUY failures (2026-07-14, post SELL
   * fix deploy) went straight to a permanent BUY CANCELLED on the first
   * attempt: "Simulation failed. Transaction simulation failed: Blockhash not
   * found" and a bare "Simulation failed" with no further detail — both
   * guaranteed pre-broadcast (simulateTransaction never reaches a validator),
   * so retrying with a fresh quote/blockhash carries the exact same "can
   * never cause a double-buy" safety property SELL's blockhash_expired retry
   * already had. retryableCategories explicitly widens past the classifier's
   * default retryablePreBroadcast set to also include 'simulation_failed' —
   * see SendSwapOptions.retryableCategories's doc comment. maxAttempts=3
   * (one more than SELL's 2): a missed BUY only costs a trading opportunity,
   * never leaves capital already at risk the way a stuck SELL does, so an
   * extra attempt is pure upside. priorityLevel stays 'high' (openPosition's
   * pre-existing default) rather than SELL's 'veryHigh' — a BUY has no
   * capital-already-exposed urgency to justify outbidding other traffic.
   */
  private static readonly BUY_SEND_SWAP_OPTIONS: SendSwapOptions = {
    side: 'BUY',
    maxAttempts: 3,
    retryDelayMs: 300,
    timeoutMs: 8_000,
    priorityLevel: 'high',
    retryableCategories: [
      'blockhash_expired',
      'simulation_failed',
      'rpc_timeout',
      'jupiter_failure',
    ],
  };

  /**
   * Jupiter first, always — it already aggregates every DEX this platform knows
   * about and is the far more battle-tested path. Only on a Jupiter failure (e.g.
   * "no route found," which can happen for a token that's too new for Jupiter's
   * indexer to have picked up yet) does this fall back to a native DEX executor,
   * and only if one is registered and the token's pool is known. The native
   * builder's own simulation gate (mirroring JupiterClient.prepareSwap's) means a
   * malformed fallback transaction is caught here, never sent.
   *
   * `options.maxAttempts > 1` retries ONLY the pre-broadcast quote+build+sign+
   * simulate step (nothing has touched the network in a way that could land on
   * mainnet), and only when the failure classifies as `retryablePreBroadcast`
   * (see sellFailureClassifier.ts) — e.g. a transient RPC/Jupiter 5xx or a
   * blockhash rejected before ever reaching a block.
   *
   * Production Bug Fix (2026-07-14): broadcastTransaction is called exactly
   * ONCE per sendSwap invocation, and it sits OUTSIDE the retry/fallback try
   * block below — not inside it. The pre-fix version called
   * `return await this.broadcastTransaction(...)` from directly inside the
   * try, which meant ANY broadcastTransaction failure (including an ambiguous
   * confirmation timeout, where the transaction may have already landed and
   * simply wasn't observed in time) fell into the same catch as a genuine
   * pre-broadcast Jupiter failure and triggered a second, fully independent
   * broadcast via the native-DEX fallback — a real double-sell path with
   * dexRegistry configured (production always configures it; the existing
   * unit tests happened to leave it undefined, which is why this never
   * surfaced there). Building the transaction (with retry/fallback) and
   * broadcasting it are now two separate phases, so a broadcast failure can
   * never cause a second broadcast from within this function — it always
   * propagates straight to the caller, which already has the correct
   * ambiguous-landing handling (unverifiedSwapLocks + manual reconciliation).
   */
  private async sendSwap(
    keypair: Keypair,
    swapParams: {
      inputMint: string;
      outputMint: string;
      amountLamports: bigint;
      slippageBps: number;
    },
    getFallbackTarget: () => Promise<{ dex: Dex; poolAddress: string | null } | undefined>,
    options?: SendSwapOptions,
  ): Promise<string> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 1);
    let lastErr: unknown;
    let transaction: VersionedTransaction | undefined;
    let lastValidBlockHeight: number | undefined;

    buildLoop: for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const prepared = await this.jupiter.prepareSwap(this.connection, keypair, swapParams, {
          maxPriorityFeeLamports: this.maxPriorityFeeLamports,
          priorityLevel: options?.priorityLevel ?? 'high',
          dynamicSlippage: true,
          timeoutMs: options?.timeoutMs,
          traceId: options?.traceId,
        });
        transaction = prepared.transaction;
        lastValidBlockHeight = prepared.lastValidBlockHeight;
        break buildLoop;
      } catch (jupiterErr) {
        lastErr = jupiterErr;
        const classification = classifySellFailure(jupiterErr);
        const isRetryable = options?.retryableCategories
          ? options.retryableCategories.includes(classification.category)
          : classification.retryablePreBroadcast;

        if (isRetryable && attempt < maxAttempts) {
          this.logger.warn(
            {
              err: jupiterErr,
              category: classification.category,
              attempt,
              maxAttempts,
              side: options?.side,
              // For a BUY, inputMint is always SOL_MINT — the token being
              // traded is outputMint. For a SELL it's the reverse. Logging
              // whichever one is the actual token keeps this line useful for
              // either side (pre-fix this always logged inputMint, which was
              // fine for SELL-only but would have been SOL_MINT for BUY).
              mint: options?.side === 'BUY' ? swapParams.outputMint : swapParams.inputMint,
            },
            'sendSwap: pre-broadcast failure is safely retryable (nothing broadcast yet) — retrying with a fresh quote',
          );
          await sleep(options?.retryDelayMs ?? 300);
          continue buildLoop;
        }

        const target = await getFallbackTarget();
        const executor = target ? this.dexRegistry?.getExecutor(target.dex) : undefined;
        if (!executor || !target?.poolAddress)
          throw tagSellFailure(jupiterErr, classification.category);

        this.logger.warn(
          {
            err: jupiterErr,
            dex: target.dex,
            poolAddress: target.poolAddress,
            category: classification.category,
          },
          'Jupiter could not route this swap — falling back to the native DEX executor',
        );

        const tx = await executor.buildSwap({
          connection: this.connection,
          signer: keypair,
          ...swapParams,
          poolAddress: target.poolAddress,
        });
        if (!(tx instanceof VersionedTransaction)) {
          throw tagSellFailure(
            new Error(`Native ${target.dex} executor returned an unsupported transaction type`),
            'other',
          );
        }
        const sim = await this.connection.simulateTransaction(tx, { sigVerify: false });
        if (sim.value.err) {
          throw tagSellFailure(
            new Error(
              `Native ${target.dex} swap simulation failed: ${JSON.stringify(sim.value.err)}`,
            ),
            'simulation_failed',
          );
        }
        transaction = tx;
        lastValidBlockHeight = undefined;
        break buildLoop;
      }
    }

    if (!transaction) {
      // Unreachable in practice (the loop above always either sets
      // `transaction` and breaks, or throws) — kept for TypeScript's
      // control-flow analysis and as a defensive backstop.
      throw tagSellFailure(lastErr, classifySellFailure(lastErr).category);
    }

    return await this.broadcastTransaction(
      transaction,
      keypair,
      lastValidBlockHeight,
      options?.traceId,
    );
  }

  /**
   * Never trust a caller-supplied entry price (an auto-buy fires before any swap has
   * happened, so callers can only ever guess) — resolve it for real, from the same
   * DexScreener price source PriceMonitor will use on every later tick, so entry and
   * exit prices are apples-to-apples. Falls back to deriving a price from what was
   * actually spent vs. actually received if DexScreener has nothing yet, and only
   * as an absolute last resort returns 0 — which evaluateExit treats as "unknown,"
   * never as a real price to compute PnL against.
   */
  private async resolveEntryPriceUsd(
    mint: string,
    amountSol: number,
    tokensReceivedRaw: bigint,
  ): Promise<number> {
    try {
      const pair = await this.dexScreener.getBestSolanaPair(mint);
      const price = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (price !== undefined && Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      this.logger.debug(
        { mint, err },
        'dexscreener price lookup failed while resolving entry price',
      );
    }

    try {
      const [solPriceUsd, mintInfo] = await Promise.all([
        this.solPriceOracle.getPriceUsd(this.dexScreener),
        getMint(this.connection, new PublicKey(mint)),
      ]);
      const tokensReceived = Number(tokensReceivedRaw) / 10 ** mintInfo.decimals;
      if (solPriceUsd !== undefined && tokensReceived > 0) {
        return (amountSol * solPriceUsd) / tokensReceived;
      }
    } catch (err) {
      this.logger.debug({ mint, err }, 'fallback entry price derivation failed');
    }

    this.logger.warn(
      { mint },
      'could not resolve a real entry price for this position — recording 0 (treated as unknown, not a real price, so TP/SL cannot fire off it)',
    );
    return 0;
  }

  /**
   * BUY Engine V2 (2026-07-14): the real open logic moved to
   * openPositionLocked below, unchanged — this wrapper's only job is
   * acquiring openLocks before it and releasing it after, no matter which of
   * openPositionLocked's many return/throw paths fires. Mirrors
   * closePosition/closePositionLocked's split above exactly.
   */
  async openPosition(params: OpenPositionParams) {
    const lockKey = `${params.walletId}:${params.tokenId}`;
    if (this.openLocks.has(lockKey)) {
      const reason = `A buy for wallet ${params.walletId} / token ${params.tokenId} is already in progress — refusing to start a second concurrent attempt (prevents duplicate positions).`;
      this.logger.warn(
        {
          walletId: params.walletId,
          mint: params.mint,
          tokenId: params.tokenId,
          location: 'apps/api/src/trading/positionManager.ts:openPosition',
        },
        `BUY CANCELLED (concurrent open)\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }
    this.openLocks.add(lockKey);
    try {
      return await this.openPositionLocked(params);
    } finally {
      this.openLocks.delete(lockKey);
    }
  }

  private async openPositionLocked(params: OpenPositionParams) {
    const lockKey = `${params.walletId}:${params.tokenId}`;
    if (this.isLockActive(lockKey)) {
      const reason = `A previous buy for wallet ${params.walletId} / token ${params.tokenId} landed on-chain but could not be verified — refusing to submit another swap until this is manually reconciled (or until the lock auto-expires).`;
      this.logger.warn(
        {
          walletId: params.walletId,
          mint: params.mint,
          tokenId: params.tokenId,
          location: 'apps/api/src/trading/positionManager.ts:openPosition',
        },
        `BUY CANCELLED\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }

    // Latency Optimization Stage 1 (2026-07-14): only real swaps get a trace —
    // a paper fill never reaches broadcast/rpc_confirmation, so mixing it into
    // the same report would understate real BUY latency. traceId stays
    // undefined in paper mode, and every latencyTracker call below is already
    // a no-op on undefined, so nothing else needs to branch on this.
    const traceId = this.paperTrading ? undefined : randomUUID();
    latencyTracker.start(traceId, 'BUY', { mint: params.mint, walletId: params.walletId });
    if (params.tokenDetectedAt !== undefined) {
      latencyTracker.mark(traceId, 'token_detected', params.tokenDetectedAt);
    }
    if (params.aiScoringStartAt !== undefined) {
      latencyTracker.mark(traceId, 'ai_scoring_start', params.aiScoringStartAt);
    }
    if (params.aiScoringEndAt !== undefined) {
      latencyTracker.mark(traceId, 'ai_scoring_end', params.aiScoringEndAt);
    }
    if (params.analysisStartedAt !== undefined) {
      latencyTracker.mark(traceId, 'analysis_started', params.analysisStartedAt);
    }
    if (params.dexValidatedAt !== undefined) {
      latencyTracker.mark(traceId, 'dex_validated', params.dexValidatedAt);
    }
    if (params.safetyCompletedAt !== undefined) {
      latencyTracker.mark(traceId, 'safety_completed', params.safetyCompletedAt);
    }
    if (params.sellabilityVerifiedAt !== undefined) {
      latencyTracker.mark(traceId, 'sellability_verified', params.sellabilityVerifiedAt);
    }
    if (params.decisionAt !== undefined) {
      latencyTracker.mark(traceId, 'decision', params.decisionAt);
    }
    if (params.buySubmittedAt !== undefined) {
      latencyTracker.mark(traceId, 'buy_submitted', params.buySubmittedAt);
    }

    const check = await this.safety.checkBeforeOpen(
      {
        userId: params.userId,
        walletId: params.walletId,
        walletPublicKey: params.walletPublicKey,
        amountSol: params.amountSol,
        tokenId: params.tokenId,
      },
      { isLive: !this.paperTrading },
    );
    if (!check.allowed) {
      const reason = check.reason ?? 'unknown safety violation';
      this.logger.warn(
        {
          reason,
          walletId: params.walletId,
          mint: params.mint,
          location: 'apps/api/src/trading/safety.ts:checkBeforeOpen',
        },
        `BUY CANCELLED\nReason:\n${reason}`,
      );
      latencyTracker.finish(traceId, 'failure');
      throw new SafetyCheckError(reason, check.code, check.details);
    }
    latencyTracker.mark(traceId, 'filters_complete');
    this.logger.debug(
      { walletId: params.walletId, mint: params.mint, paperTrading: this.paperTrading },
      'Wallet: safety check passed — Buy Executor starting',
    );

    const amountLamports = BigInt(Math.floor(params.amountSol * LAMPORTS_PER_SOL));

    let outAmount: string;
    let signature: string;

    if (this.paperTrading) {
      // Simulated fill: get a real Jupiter quote for realistic sizing, but never touch
      // the wallet's private key or broadcast anything.
      const quote = await this.jupiter.getQuote({
        inputMint: SOL_MINT,
        outputMint: params.mint,
        amountLamports,
        slippageBps: params.slippageBps,
      });
      outAmount = quote.outAmount;
      signature = paperSignature();
    } else {
      const keypair = unsealKeypair(params.encryptedSecret, params.encryptionKey);
      this.logger.debug(
        { walletPublicKey: keypair.publicKey.toBase58(), mint: params.mint },
        'Buy Executor: sending live swap',
      );
      try {
        signature = await this.sendSwap(
          keypair,
          {
            inputMint: SOL_MINT,
            outputMint: params.mint,
            amountLamports,
            slippageBps: params.slippageBps,
          },
          async () => {
            const token = await this.prisma.token.findUnique({ where: { id: params.tokenId } });
            return token ? { dex: token.dex, poolAddress: token.poolAddress } : undefined;
          },
          { ...PositionManager.BUY_SEND_SWAP_OPTIONS, traceId },
        );
      } catch (err) {
        // BUY Engine V2 (2026-07-14): pre-fix this branch had no logger call
        // at all — sendSwap's own retry attempts (now covering BUY too, see
        // BUY_SEND_SWAP_OPTIONS) are already exhausted or the failure was
        // non-retryable by the time execution reaches here, so this really is
        // "BUY definitively failed," not a transient blip. Same classified
        // logging SELL already had (closePositionLocked), so "why do BUYs
        // fail" is answerable from production logs without re-reading stack
        // traces — the exact gap this codebase's SELL failure classifier was
        // built to close, now closed for BUY too.
        const classification = classifySellFailure(err);
        this.logger.error(
          {
            err,
            walletId: params.walletId,
            tokenId: params.tokenId,
            mint: params.mint,
            category: classification.category,
            detail: classification.detail,
            location: 'apps/api/src/trading/positionManager.ts:openPositionLocked',
          },
          `BUY FAILED\nCategory: ${classification.category}\nReason:\n${classification.detail}`,
        );
        await this.recordFailedTrade({
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: 'BUY',
          amountSol: params.amountSol,
          slippageBps: params.slippageBps,
          err,
        });
        latencyTracker.finish(traceId, 'failure');
        throw tagSellFailure(err, classification.category);
      }

      // The swap itself landed on-chain from here on — any further failure is a
      // verification problem, not a "nothing happened" problem, so this wallet+token
      // is locked out of further auto-buys until a human reconciles it (see
      // unverifiedSwapLocks's doc comment: retrying blind here would submit a
      // second real buy on top of one that already landed).
      this.unverifiedSwapLocks.set(lockKey, Date.now());
      try {
        // The quote is only an estimate — record what actually landed in the wallet,
        // since a later sell has to work with the real balance, not the estimate.
        // Retried: the RPC node frequently hasn't caught up with a just-landed tx yet
        // (see withVerificationRetry's doc comment) — most "verification failures" are
        // this transient lag, not a real problem.
        const actualReceived = await withVerificationRetry(
          () =>
            getActualTokenDelta(
              this.connection,
              signature,
              keypair.publicKey.toBase58(),
              params.mint,
            ),
          3,
          this.verificationRetryDelayMs,
        );
        outAmount = actualReceived.toString();
        this.unverifiedSwapLocks.delete(lockKey);
      } catch (err) {
        const reason = `BUY landed on-chain (signature ${signature}) but could not be verified after retries for wallet ${params.walletId} / token ${params.tokenId}. Position was NOT recorded. Manual reconciliation required — further auto-buys for this wallet+token are blocked for up to ${PositionManager.RECONCILIATION_LOCK_TTL_MS / 60_000} minutes, then automatically recover.`;
        this.logger.error(
          {
            err,
            walletId: params.walletId,
            tokenId: params.tokenId,
            signature,
            location: 'apps/api/src/trading/positionManager.ts:openPosition',
          },
          `BUY CANCELLED\nReason:\n${reason}`,
        );
        await this.recordFailedTrade({
          walletId: params.walletId,
          tokenId: params.tokenId,
          side: 'BUY',
          amountSol: params.amountSol,
          slippageBps: params.slippageBps,
          signature,
          err,
        });
        await this.notifier?.notifyError('openPosition verification', reason);
        latencyTracker.finish(traceId, 'failure');
        throw err;
      }
    }

    const entryPriceUsd = await this.resolveEntryPriceUsd(
      params.mint,
      params.amountSol,
      BigInt(outAmount),
    );

    // Never allow a position to be created with no exit strategy at all — a
    // position with every TP/SL/trailing field null can only ever be closed
    // manually (evaluateExit has nothing to compare against), and no caller in
    // this app currently exposes a manual-close action either. Falls back to
    // defaultExitParams() only when the caller supplied none of the three
    // fields; any explicit configuration (a preset's resolved params, or a
    // user's own manual custom values) is always respected as-is and never
    // overridden here.
    const hasExitStrategy =
      params.takeProfitPercent != null ||
      params.stopLossPercent != null ||
      params.trailingStopPercent != null;
    const fallbackExit = hasExitStrategy ? undefined : defaultExitParams();
    if (fallbackExit) {
      this.logger.warn(
        { walletId: params.walletId, tokenId: params.tokenId, mint: params.mint },
        'openPosition: caller supplied no exit strategy — applying the balanced-preset default so this position is never unclosable',
      );
    }

    // Emergency Exit Engine's "developer wallet" dump proxy — resolved only
    // for institutional positions (the only ones emergencyExitMonitor.ts
    // watches), best-effort: a failure here never blocks the buy, it just
    // means the dev-wallet-dump check is unavailable for this position (see
    // schema.prisma's devWalletAddress doc comment on the real limitation —
    // this is the largest real holder, not a verified deployer identity).
    // Only the bonding-curve vault is excluded (cheap, no RPC) — this
    // function has no dex/poolAddress to also exclude a post-migration AMM
    // pool's vaults the way riskAnalyzer.ts's resolveExcludedVaultAddresses
    // does, a known imprecision for entries that happen post-migration.
    let devWalletAddress: string | undefined;
    let devWalletAmountRawAtEntry: string | undefined;
    if (params.institutionalModeEnabled) {
      try {
        const excludeAddresses = [getBondingCurveVaultAta(new PublicKey(params.mint)).toBase58()];
        const topHolder = await getTopHolder(this.connection, params.mint, excludeAddresses);
        if (topHolder) {
          devWalletAddress = topHolder.address;
          devWalletAmountRawAtEntry = topHolder.amountRaw.toString();
        }
      } catch (err) {
        this.logger.debug(
          { mint: params.mint, err },
          'dev-wallet-proxy resolution failed at open — emergency exit dev-dump signal unavailable for this position',
        );
      }
    }

    const tradeData = {
      walletId: params.walletId,
      tokenId: params.tokenId,
      side: 'BUY' as const,
      status: 'CONFIRMED' as const,
      amountSol: params.amountSol,
      amountToken: Number(outAmount),
      priceUsd: entryPriceUsd,
      txSignature: signature,
      slippageBps: params.slippageBps,
      isPaperTrade: this.paperTrading,
      confirmedAt: new Date(),
    };
    // Hard Loss Ceiling (2026-07-18): the one choke point every open (auto-buy,
    // copy-trade, any future caller) already passes through, so this can never
    // be bypassed by a caller forgetting to clamp its own exit params — see
    // exitEngine.ts's resolveEffectiveStopLossPercent doc comment.
    const { effectiveStopLossPercent, isSystemDefault } = resolveEffectiveStopLossPercent(
      params.stopLossPercent ?? fallbackExit?.stopLossPercent,
    );
    const positionData = {
      walletId: params.walletId,
      tokenId: params.tokenId,
      entryPriceUsd,
      amountToken: Number(outAmount),
      amountSolInvested: params.amountSol,
      highWaterMarkUsd: entryPriceUsd,
      takeProfitPercent: params.takeProfitPercent ?? fallbackExit?.takeProfitPercent,
      stopLossPercent: effectiveStopLossPercent,
      stopLossIsSystemDefault: isSystemDefault,
      trailingStopPercent: params.trailingStopPercent ?? fallbackExit?.trailingStopPercent,
      trailingStopPreset: params.trailingStopPreset ?? (fallbackExit ? 'balanced' : undefined),
      isPaperTrade: this.paperTrading,
      // Institutional Mode — frozen at open time, same convention as
      // trailingStopPreset above. originalAmountToken/remainingAmountToken
      // both start equal to the bought amount; remainingAmountToken is the
      // one partial sells (executePartialSell) decrement going forward.
      institutionalModeEnabled: params.institutionalModeEnabled ?? false,
      originalAmountToken: Number(outAmount),
      remainingAmountToken: Number(outAmount),
      moonbagReserveAmountToken:
        params.moonbagPercent && params.moonbagPercent > 0
          ? Number(outAmount) * (params.moonbagPercent / 100)
          : undefined,
      riskScoreAtEntry: params.riskScoreAtEntry,
      partialTakeProfitTiers: params.institutionalModeEnabled
        ? ((params.partialTakeProfitTiers ?? DEFAULT_PARTIAL_EXIT_TIERS) as unknown as object)
        : undefined,
      devWalletAddress,
      devWalletAmountRawAtEntry,
    };

    // BUY Engine V2 (2026-07-14): the Trade and Position rows for one buy are
    // written atomically — previously two independent awaited creates, so a
    // crash (or, now that duplicate-position creation is DB-enforced via a
    // partial unique index, a rejected second-create) between them left a
    // CONFIRMED Trade with no Position ever tracking it for exit: real SOL
    // spent, real tokens sitting in the wallet, and nothing watching TP/SL/
    // trailing-stop for them. `$transaction([...])` makes the pair all-or-
    // nothing. On failure, the swap has already landed on-chain — real money
    // already moved — so this falls back to recording the Trade alone
    // (outside the failed transaction) rather than losing all record of it,
    // then notifies and rethrows for manual reconciliation, exactly like the
    // existing post-broadcast verification-failure branch above.
    const [trade, position] = await this.prisma
      .$transaction([
        this.prisma.trade.create({ data: tradeData }),
        this.prisma.position.create({ data: positionData }),
      ])
      .catch(async (err) => {
        this.logger.error(
          {
            err,
            walletId: params.walletId,
            tokenId: params.tokenId,
            mint: params.mint,
            signature,
            location: 'apps/api/src/trading/positionManager.ts:openPositionLocked',
          },
          'openPosition: atomic trade+position write failed after a real swap already landed on-chain — recording the trade alone, manual reconciliation required',
        );
        await this.prisma.trade.create({ data: tradeData });
        await this.notifier?.notifyError(
          'openPosition atomic write',
          `BUY for wallet ${params.walletId} / token ${params.tokenId} (signature ${signature}) landed on-chain but position bookkeeping failed (${err instanceof Error ? err.message : String(err)}). No TP/SL/trailing-stop is tracking this position — manual reconciliation required.`,
        );
        latencyTracker.finish(traceId, 'failure');
        throw err;
      });

    latencyTracker.mark(traceId, 'position_opened');
    latencyTracker.finish(traceId, 'success');

    this.logger.info(
      {
        tradeId: trade.id,
        positionId: position.id,
        signature,
        walletId: params.walletId,
        mint: params.mint,
      },
      `BUY EXECUTED\nSignature:\n${signature}`,
    );

    eventBus.publish('trade.created', { tradeId: trade.id, side: 'BUY', mint: params.mint });
    eventBus.publish('position.updated', { positionId: position.id, status: 'OPEN' });

    // Notification-only enrichment (DEX name/buy link/trade card) — a single
    // indexed PK lookup, never gates or affects the trade itself, which has already
    // fully executed above.
    const token = await this.prisma.token.findUnique({ where: { id: params.tokenId } });

    this.logger.debug(
      { positionId: position.id, hasNotifier: !!this.notifier },
      'Telegram Notification: dispatching BUY notifyTrade',
    );
    await this.notifier?.notifyTrade({
      side: 'BUY',
      symbol: params.symbol ?? params.mint.slice(0, 8),
      mint: params.mint,
      dex: token?.dex,
      amountSol: params.amountSol,
      priceUsd: entryPriceUsd || undefined,
      signature,
      isPaperTrade: this.paperTrading,
    });

    if (token) {
      // Best-effort fresh momentum for the card — never blocks/risks the trade
      // above, which has already fully executed; a failed lookup just omits it.
      const freshPair = await this.dexScreener
        .getBestSolanaPair(params.mint)
        .catch(() => undefined);
      await this.notifier?.notifyBuyCard({
        token: {
          mint: params.mint,
          name: token.name ?? undefined,
          symbol: token.symbol ?? params.symbol,
          dex: token.dex,
          imageUrl: token.imageUrl ?? undefined,
          marketCapUsd: token.marketCapUsd ?? undefined,
          liquidityUsd: token.liquidityUsd ?? undefined,
          aiScore: params.aiScore ?? token.aiScore ?? undefined,
          holderCount: token.holderCount ?? undefined,
          priceChangeH1: freshPair?.priceChange?.h1,
          isHoneypotSuspected: token.isHoneypotSuspected ?? undefined,
          mintAuthorityRevoked: token.mintAuthorityRevoked ?? undefined,
          freezeAuthorityRevoked: token.freezeAuthorityRevoked ?? undefined,
          lpBurnedOrLocked: token.lpBurnedOrLocked ?? undefined,
          top10HolderPercent: token.top10HolderPercent ?? undefined,
        },
        entryPriceUsd,
        amountSol: params.amountSol,
        estimatedUsdValue:
          entryPriceUsd > 0
            ? entryPriceUsd * (Number(outAmount) / 10 ** token.decimals)
            : undefined,
        walletPublicKey: params.walletPublicKey,
        positionId: position.id,
        signature,
        timestamp: new Date(),
      });
    }

    return { trade, position };
  }

  /** Called on each price tick for every open position; closes it if an exit rule fires. */
  async checkAndMaybeClose(
    positionId: string,
    currentPriceUsd: number,
    encryptedSecret: string,
    encryptionKey: string,
  ) {
    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });
    if (position.status !== 'OPEN') return { closed: false as const };

    // Permanent (no-route) SELL failure gate (2026-07-26 fix) — see
    // recordPermanentSellFailure's doc comment. Checked here, once per tick,
    // before evaluateExit/the institutional branch even run, so a position
    // with no Jupiter route stops costing a lock acquisition + swap attempt
    // every tick instead of just being marked unsellable inside the deeper
    // swap-execution path (kept there too, as defense-in-depth for callers
    // that reach closePosition/executePartialSell directly, e.g.
    // EmergencyExitMonitor or a manual sell).
    if (position.sellUnsellable) {
      this.logger.debug(
        { positionId, mint: position.token.mint, reason: position.unsellableReason },
        'Skipping position permanently because no Jupiter route exists.',
      );
      return { closed: false as const };
    }

    const institutionalActive =
      position.institutionalModeEnabled && this.institutionalModeGloballyEnabled;

    if (institutionalActive) {
      return this.checkAndMaybeCloseInstitutional(
        position,
        currentPriceUsd,
        encryptedSecret,
        encryptionKey,
      );
    }

    const decision = evaluateExit({
      entryPriceUsd: position.entryPriceUsd,
      currentPriceUsd,
      highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
      takeProfitPercent: position.takeProfitPercent,
      stopLossPercent: position.stopLossPercent,
      trailingStopPercent: position.trailingStopPercent,
    });
    this.logger.debug(
      {
        positionId,
        currentPriceUsd,
        pnlPercent: decision.pnlPercent,
        shouldExit: decision.shouldExit,
        reason: decision.reason,
      },
      'Sell Executor checkpoint: evaluateExit result',
    );

    if (!decision.shouldExit) {
      await this.prisma.position.update({
        where: { id: positionId },
        data: { highWaterMarkUsd: decision.newHighWaterMarkUsd },
      });
      return { closed: false as const };
    }

    return this.closePosition(position.id, position.walletId, encryptedSecret, encryptionKey, {
      currentPriceUsd,
      reason: decision.reason,
    });
  }

  /**
   * Institutional Mode's own tick evaluation — kept as a separate method
   * rather than branches sprinkled through the generic path above, so the
   * non-institutional behavior above is trivially unchanged/unaffected.
   *
   * Order: (1) partial-exit ladder (never past the moonbag reserve), then
   * (2) a fixed stop-loss (disabled once the position is moonbag-only — "the
   * moonbag may never exit on a normal pullback") and the profit-tiered
   * institutional trailing stop (recomputed fresh every tick, "never cap
   * upside" — takeProfitPercent is never used here at all).
   */
  private async checkAndMaybeCloseInstitutional(
    position: NonNullable<Awaited<ReturnType<typeof this.prisma.position.findUniqueOrThrow>>>,
    currentPriceUsd: number,
    encryptedSecret: string,
    encryptionKey: string,
  ) {
    const entryPriceUsd = position.entryPriceUsd;
    const originalAmountToken = position.originalAmountToken ?? position.amountToken;
    const remainingAmountToken = position.remainingAmountToken ?? position.amountToken;
    const moonbagReserveAmountToken = position.moonbagReserveAmountToken ?? 0;
    const inMoonbagOnlyMode =
      moonbagReserveAmountToken > 0 && remainingAmountToken <= moonbagReserveAmountToken;
    const pnlPercent =
      entryPriceUsd > 0 ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100 : 0;

    if (this.partialExitsGloballyEnabled && !inMoonbagOnlyMode) {
      const tiersAlreadyTaken = (
        await this.prisma.positionPartialExit.findMany({
          where: { positionId: position.id },
          select: { tierIndex: true },
        })
      ).map((t) => t.tierIndex);
      const tiers =
        (position.partialTakeProfitTiers as unknown as PartialExitTier[] | null) ??
        DEFAULT_PARTIAL_EXIT_TIERS;

      const partialDecision = evaluateNextPartialExit({
        pnlPercent,
        originalAmountToken,
        remainingAmountToken,
        moonbagReserveAmountToken,
        tiers,
        tiersAlreadyTaken,
      });
      if (partialDecision) {
        return this.executePartialSell(
          position.id,
          position.walletId,
          partialDecision.tierIndex,
          partialDecision.sellAmountToken,
          currentPriceUsd,
          encryptedSecret,
          encryptionKey,
        );
      }
    }

    // takeProfitPercent is never passed — "never cap upside." stopLossPercent
    // is disabled entirely once only the moonbag remains — a normal pullback
    // must never sell it; only the trailing stop / emergency exit can.
    const decision = evaluateExit({
      entryPriceUsd,
      currentPriceUsd,
      highWaterMarkUsd: position.highWaterMarkUsd ?? entryPriceUsd,
      takeProfitPercent: undefined,
      stopLossPercent: inMoonbagOnlyMode ? undefined : INSTITUTIONAL_STOP_LOSS_PERCENT,
      trailingStopPercent: undefined,
    });

    if (decision.shouldExit) {
      // Fired on the fixed institutional stop-loss above.
      return this.closePosition(position.id, position.walletId, encryptedSecret, encryptionKey, {
        currentPriceUsd,
        reason: decision.reason,
      });
    }

    const peakRoiPercent =
      entryPriceUsd > 0
        ? ((decision.newHighWaterMarkUsd - entryPriceUsd) / entryPriceUsd) * 100
        : 0;
    const trailingStopPriceUsd = computeInstitutionalTrailingStopPriceUsd(
      entryPriceUsd,
      decision.newHighWaterMarkUsd,
      peakRoiPercent,
    );
    this.logger.debug(
      {
        positionId: position.id,
        currentPriceUsd,
        pnlPercent,
        peakRoiPercent,
        trailingStopPriceUsd,
        inMoonbagOnlyMode,
      },
      'Sell Executor checkpoint: institutional trailing-stop evaluation',
    );

    if (trailingStopPriceUsd !== undefined && currentPriceUsd <= trailingStopPriceUsd) {
      return this.closePosition(position.id, position.walletId, encryptedSecret, encryptionKey, {
        currentPriceUsd,
        reason: 'trailing_stop',
      });
    }

    await this.prisma.position.update({
      where: { id: position.id },
      data: { highWaterMarkUsd: decision.newHighWaterMarkUsd },
    });
    return { closed: false as const };
  }

  /**
   * Sells one partial-exit tier's worth of tokens, keeps the position OPEN,
   * and records the slice in PositionPartialExit — structurally mirroring
   * closePosition's live-swap/paper-fill branches, but never marks the
   * position CLOSED and never sells past what the caller already computed
   * (evaluateNextPartialExit already clamped to the moonbag reserve).
   *
   * Production blocking fix (2026-07-14): shares positionCloseLock with
   * closePosition — a partial sell and a full close (e.g. EmergencyExitMonitor
   * firing on an institutional-mode position mid-ladder) must never run
   * concurrently against the same position, since both read/write
   * remainingAmountToken and the wallet's real on-chain balance.
   */
  async executePartialSell(
    positionId: string,
    walletId: string,
    tierIndex: number,
    sellAmountToken: number,
    currentPriceUsd: number,
    encryptedSecret: string,
    encryptionKey: string,
  ) {
    // Production Bug Fix (2026-07-14): closePosition already refused to run
    // while a previous swap for this position landed on-chain but couldn't be
    // verified (see unverifiedSwapLocks's doc comment on the class) — this
    // sibling entry point didn't have the same check, so a partial-sell tick
    // firing in the same window as an unverified full-close could submit a
    // second real sell against a wallet balance the bot no longer had an
    // accurate read on. Mirrors closePosition's check exactly.
    if (this.isLockActive(positionId)) {
      const reason = `A previous sell for position ${positionId} landed on-chain but could not be verified — refusing to submit another swap until this is manually reconciled (or until the lock auto-expires).`;
      this.logger.warn(
        {
          positionId,
          walletId,
          tierIndex,
          category: 'position_lock' satisfies SellFailureCategory,
          location: 'apps/api/src/trading/positionManager.ts:executePartialSell',
        },
        `SELL CANCELLED\nReason:\n${reason}`,
      );
      throw tagSellFailure(new Error(reason), 'position_lock');
    }

    const lock = await positionCloseLock.acquire(this.prisma, positionId, this.logger);
    if (!lock) {
      this.logger.warn(
        {
          positionId,
          walletId,
          tierIndex,
          location: 'apps/api/src/trading/positionManager.ts:executePartialSell',
        },
        'PARTIAL SELL SKIPPED (concurrent close/partial-sell already in flight for this position)',
      );
      return { sold: false as const };
    }

    // Latency Optimization Stage 1 (2026-07-14) — same convention as
    // closePosition's traceId above, a partial exit just never gets a
    // position_closed mark (the position stays OPEN).
    const traceId = this.paperTrading ? undefined : randomUUID();
    latencyTracker.start(traceId, 'SELL', { positionId, walletId });
    latencyTracker.mark(traceId, 'exit_decision');

    try {
      return await this.executePartialSellLocked(
        positionId,
        walletId,
        tierIndex,
        sellAmountToken,
        currentPriceUsd,
        encryptedSecret,
        encryptionKey,
        traceId,
      );
    } finally {
      await lock.release();
    }
  }

  private async executePartialSellLocked(
    positionId: string,
    walletId: string,
    tierIndex: number,
    sellAmountToken: number,
    currentPriceUsd: number,
    encryptedSecret: string,
    encryptionKey: string,
    traceId?: string,
  ) {
    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });

    // Re-checked now that positionCloseLock is held — a full close that won
    // the race (or a duplicate partial-sell decision queued behind the lock)
    // must make this a no-op rather than selling out of a position that's
    // already CLOSED or has already taken this exact tier.
    if (position.status !== 'OPEN') {
      this.logger.info(
        { positionId, status: position.status },
        'executePartialSell: position is no longer OPEN once the close lock was acquired — skipping',
      );
      latencyTracker.finish(traceId, 'failure');
      return { sold: false as const };
    }
    // Permanent (no-route) SELL failure gate — see recordPermanentSellFailure's
    // doc comment / checkAndMaybeClose's matching gate above. Defense-in-depth
    // here since executePartialSell can also be reached with the lock already
    // held by a caller that skipped checkAndMaybeClose's own check.
    if (position.sellUnsellable) {
      this.logger.warn(
        { positionId, tierIndex, mint: position.token.mint, reason: position.unsellableReason },
        'Skipping position permanently because no Jupiter route exists.',
      );
      latencyTracker.finish(traceId, 'failure');
      return { sold: false as const };
    }
    const tierAlreadyTaken = await this.prisma.positionPartialExit.findFirst({
      where: { positionId, tierIndex },
      select: { id: true },
    });
    if (tierAlreadyTaken) {
      this.logger.info(
        { positionId, tierIndex },
        'executePartialSell: this tier was already sold by a queued/earlier attempt — skipping duplicate',
      );
      latencyTracker.finish(traceId, 'failure');
      return { sold: false as const };
    }

    let outAmountLamports: number;
    let signature: string;

    if (this.paperTrading) {
      const quote = await this.jupiter.getQuote({
        inputMint: position.token.mint,
        outputMint: SOL_MINT,
        amountLamports: BigInt(Math.floor(sellAmountToken)),
        slippageBps: 300,
      });
      outAmountLamports = Number(quote.outAmount);
      signature = paperSignature();
    } else {
      const keypair = unsealKeypair(encryptedSecret, encryptionKey);
      const realBalance = await getRealTokenBalance(
        this.connection,
        keypair.publicKey.toBase58(),
        position.token.mint,
      );
      const sellAmountRaw = BigInt(Math.min(Math.floor(sellAmountToken), Number(realBalance)));
      if (sellAmountRaw <= 0n) {
        this.logger.warn(
          { positionId, tierIndex, realBalance: realBalance.toString() },
          'executePartialSell: wallet holds 0 sellable tokens for this tier — skipping, position stays OPEN',
        );
        latencyTracker.finish(traceId, 'failure');
        return { sold: false as const };
      }

      const sendSwapStartedAt = Date.now();
      try {
        signature = await this.sendSwapWithBroadcastRetry(
          keypair,
          {
            inputMint: position.token.mint,
            outputMint: SOL_MINT,
            amountLamports: sellAmountRaw,
            slippageBps: 300,
          },
          async () => ({ dex: position.token.dex, poolAddress: position.token.poolAddress }),
          { ...PositionManager.SELL_SEND_SWAP_OPTIONS, traceId },
          { mint: position.token.mint, expectedAtLeastRaw: sellAmountRaw, positionId },
        );
      } catch (err) {
        const classification = classifySellFailure(err);
        this.logger.error(
          {
            err,
            positionId,
            tierIndex,
            walletId,
            category: classification.category,
            detail: classification.detail,
            latencyMs: Date.now() - sendSwapStartedAt,
            location: 'apps/api/src/trading/positionManager.ts:executePartialSellLocked',
          },
          `SELL FAILED (partial exit)\nCategory: ${classification.category}\nReason:\n${classification.detail}`,
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          err,
        });
        if (classification.permanent) {
          await this.recordPermanentSellFailure(
            positionId,
            position.token.mint,
            position.token.symbol ?? position.token.mint,
            classification,
          );
        }
        latencyTracker.finish(traceId, 'failure');
        throw tagSellFailure(err, classification.category);
      }

      try {
        const actualSolReceived = await withVerificationRetry(
          () => getActualSolDelta(this.connection, signature, keypair.publicKey.toBase58()),
          3,
          this.verificationRetryDelayMs,
        );
        outAmountLamports = Number(actualSolReceived);
      } catch (err) {
        this.logger.error(
          {
            err,
            positionId,
            tierIndex,
            signature,
            category: 'confirmation_timeout' satisfies SellFailureCategory,
          },
          'executePartialSell: SELL landed on-chain but could not be verified — position left OPEN with stale remainingAmountToken, manual reconciliation required',
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          signature,
          err,
        });
        latencyTracker.finish(traceId, 'failure');
        throw tagSellFailure(err, 'confirmation_timeout');
      }
      sellAmountToken = Number(sellAmountRaw);
    }

    const realizedPnlUsdThisTier =
      (currentPriceUsd - position.entryPriceUsd) *
      (sellAmountToken / 10 ** position.token.decimals);

    const sellTrade = await this.prisma.trade.create({
      data: {
        walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        amountSol: outAmountLamports / LAMPORTS_PER_SOL,
        amountToken: sellAmountToken,
        priceUsd: currentPriceUsd,
        txSignature: signature,
        isPaperTrade: this.paperTrading,
        confirmedAt: new Date(),
      },
    });

    await this.prisma.positionPartialExit.create({
      data: {
        positionId,
        tierIndex,
        gainPercent:
          position.entryPriceUsd > 0
            ? ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
            : 0,
        tokenAmountSold: sellAmountToken,
        priceUsd: currentPriceUsd,
        realizedPnlUsd: realizedPnlUsdThisTier,
        txSignature: signature,
      },
    });
    latencyTracker.finish(traceId, 'success');

    const newRemainingAmountToken =
      (position.remainingAmountToken ?? position.amountToken) - sellAmountToken;
    const updated = await this.prisma.position.update({
      where: { id: positionId },
      data: {
        remainingAmountToken: Math.max(0, newRemainingAmountToken),
        realizedPnlUsd: (position.realizedPnlUsd ?? 0) + realizedPnlUsdThisTier,
      },
    });

    this.logger.info(
      { positionId, tierIndex, sellAmountToken, signature, realizedPnlUsdThisTier },
      'PARTIAL EXIT EXECUTED',
    );

    eventBus.publish('trade.created', {
      tradeId: sellTrade.id,
      side: 'SELL',
      mint: position.token.mint,
    });
    eventBus.publish('position.updated', { positionId: updated.id, status: 'OPEN' });

    // Isolated SELL-fix build note: cast to a local structural type instead of
    // @nova/telegram-bot's NotificationService — this deploy intentionally
    // excludes telegram-bot's uncommitted changes (which add notifyPartialExit
    // to that interface), so this shim lets institutional-mode partial-exit
    // notifications keep working at runtime (optional chaining already made
    // them a no-op on any notifier that lacks the method) without touching
    // telegram-bot's source at all.
    await (
      this.notifier as unknown as
        | {
            notifyPartialExit?: (params: Record<string, unknown>) => Promise<void>;
          }
        | undefined
    )?.notifyPartialExit?.({
      symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
      mint: position.token.mint,
      dex: position.token.dex,
      tierIndex,
      pnlPercent:
        position.entryPriceUsd > 0
          ? ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
          : 0,
      realizedPnlUsd: realizedPnlUsdThisTier,
      remainingPositionPercent:
        ((position.originalAmountToken ?? position.amountToken) > 0
          ? Math.max(0, newRemainingAmountToken) /
            (position.originalAmountToken ?? position.amountToken)
          : 0) * 100,
      isPaperTrade: this.paperTrading,
    });

    return { sold: true as const, position: updated, signature };
  }

  /**
   * Production blocking fix (2026-07-14): the real close logic moved to
   * closePositionLocked below, unchanged — this wrapper's only job is
   * acquiring positionCloseLock before it, and releasing it after, no matter
   * which of closePositionLocked's many return/throw paths fires. Every
   * caller (PriceMonitor's normal TP/SL, EmergencyExitMonitor, and any future
   * manual-close route) goes through this same single entry point, so
   * guarding here covers all of them at once.
   */
  async closePosition(
    positionId: string,
    walletId: string,
    encryptedSecret: string,
    encryptionKey: string,
    exit: { currentPriceUsd: number; reason?: ExitReason },
  ) {
    if (this.isLockActive(positionId)) {
      const reason = `A previous sell for position ${positionId} landed on-chain but could not be verified — refusing to submit another swap until this is manually reconciled (or until the lock auto-expires).`;
      this.logger.warn(
        { positionId, walletId, location: 'apps/api/src/trading/positionManager.ts:closePosition' },
        `SELL CANCELLED\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }

    const lock = await positionCloseLock.acquire(this.prisma, positionId, this.logger);
    if (!lock) {
      const reason = `Position ${positionId} is already being closed or partially sold by another in-flight operation — refusing to submit a duplicate close.`;
      this.logger.warn(
        { positionId, walletId, location: 'apps/api/src/trading/positionManager.ts:closePosition' },
        `SELL CANCELLED (concurrent close)\nReason:\n${reason}`,
      );
      throw new Error(reason);
    }
    // Latency Optimization Stage 1 (2026-07-14): only real sells get a trace
    // — same reasoning as openPositionLocked's traceId above. "exit_decision"
    // is marked here (the moment closePosition was actually invoked) rather
    // than back in checkAndMaybeClose/evaluateExit — negligible difference in
    // practice (they're synchronous, back-to-back), and keeping trace
    // creation at this one single entry point (shared by every caller —
    // normal TP/SL, EmergencyExitMonitor, any future manual close) is
    // simpler than threading a traceId through each of them individually.
    const traceId = this.paperTrading ? undefined : randomUUID();
    latencyTracker.start(traceId, 'SELL', { positionId, walletId });
    latencyTracker.mark(traceId, 'exit_decision');

    try {
      return await this.closePositionLocked(
        positionId,
        walletId,
        encryptedSecret,
        encryptionKey,
        exit,
        traceId,
      );
    } finally {
      await lock.release();
    }
  }

  private async closePositionLocked(
    positionId: string,
    walletId: string,
    encryptedSecret: string,
    encryptionKey: string,
    exit: { currentPriceUsd: number; reason?: ExitReason },
    traceId?: string,
  ) {
    const position = await this.prisma.position.findUniqueOrThrow({
      where: { id: positionId },
      include: { token: true },
    });

    // Re-checked now that positionCloseLock is held (not just at whatever
    // moment the caller decided to close): a second, now-redundant close
    // attempt that queued up behind the lock — e.g. two ticks that both saw
    // this position OPEN before either could claim the lock — must be a
    // no-op once it's this attempt's turn, not a second real sell.
    if (position.status !== 'OPEN') {
      this.logger.info(
        { positionId, status: position.status },
        'closePosition: position is no longer OPEN once the close lock was acquired — skipping duplicate close',
      );
      latencyTracker.finish(traceId, 'failure');
      return { closed: false as const, position, signature: null };
    }
    // Permanent (no-route) SELL failure gate — see recordPermanentSellFailure's
    // doc comment / checkAndMaybeClose's matching gate above. Defense-in-depth
    // here for callers that reach closePosition directly (EmergencyExitMonitor,
    // a manual sell) without going through checkAndMaybeClose's own check.
    if (position.sellUnsellable) {
      this.logger.warn(
        { positionId, mint: position.token.mint, reason: position.unsellableReason },
        'Skipping position permanently because no Jupiter route exists.',
      );
      latencyTracker.finish(traceId, 'failure');
      return { closed: false as const, position, signature: null };
    }

    // A position that already had one or more partial exits (institutional
    // mode's profit ladder — see partialExitEngine.ts) has fewer tokens left
    // to sell than it originally bought: position.amountToken always means
    // "the amount bought" (frozen at open), never "what's left." Falls back
    // to the full original amount for a position that never partially
    // exited (remainingAmountToken null), so this is byte-identical to the
    // old behavior for every non-institutional close.
    const remainingAmountToken = position.remainingAmountToken ?? position.amountToken;

    let outAmountLamports: number;
    let soldAmountToken: number;
    let signature: string;

    if (this.paperTrading) {
      const quote = await this.jupiter.getQuote({
        inputMint: position.token.mint,
        outputMint: SOL_MINT,
        amountLamports: BigInt(Math.floor(remainingAmountToken)),
        slippageBps: 300,
      });
      outAmountLamports = Number(quote.outAmount);
      soldAmountToken = remainingAmountToken;
      signature = paperSignature();
    } else {
      const keypair = unsealKeypair(encryptedSecret, encryptionKey);
      // Never sell the stored/estimated amount blindly — it can exceed what's actually
      // in the wallet (e.g. from a quote-vs-actual gap at buy time) and get rejected
      // on-chain. Cap to the real balance, whichever is smaller.
      const realBalance = await getRealTokenBalance(
        this.connection,
        keypair.publicKey.toBase58(),
        position.token.mint,
      );
      const recordedAmount = BigInt(Math.floor(remainingAmountToken));
      const sellAmountRaw = realBalance < recordedAmount ? realBalance : recordedAmount;
      this.logger.debug(
        {
          walletPublicKey: keypair.publicKey.toBase58(),
          mint: position.token.mint,
          realBalance: realBalance.toString(),
          recordedAmount: recordedAmount.toString(),
          sellAmountRaw: sellAmountRaw.toString(),
        },
        'Sell Executor: sending live swap',
      );

      // Live-verified 2026-07-11: a position recorded OPEN with a real, confirmed
      // buy on file can still have a wallet balance of exactly 0 — the tokens left
      // the wallet through some path this bot never recorded (most plausibly an
      // out-of-band/manual transfer or sale, since the buy tx itself was verified
      // on-chain and no sell ever landed through this codebase). Submitting a sell
      // for 0 tokens isn't a retryable failure — the PumpSwap program rejects a
      // zero-amount swap outright — so every future price tick would repeat this
      // exact failed attempt forever, burning an RPC/simulation call each time with
      // no possible resolution. Reconcile immediately instead: close the position
      // (no realizedPnlUsd — what actually happened to the tokens is unknown, so a
      // number here would just be a guess) and flag it for manual review.
      if (sellAmountRaw <= 0n) {
        this.logger.error(
          {
            positionId,
            walletPublicKey: keypair.publicKey.toBase58(),
            mint: position.token.mint,
            recordedAmount: recordedAmount.toString(),
          },
          'closePosition: wallet holds 0 of this token for a position recorded OPEN — closing for manual reconciliation instead of retrying forever',
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: 0,
          err: new Error(
            'Wallet balance is 0 for this open position — tokens left the wallet outside this bot; closed for manual reconciliation, no realized PnL recorded',
          ),
        });
        const reconciled = await this.prisma.position.update({
          where: { id: positionId },
          data: { status: 'CLOSED', closedAt: new Date() },
        });
        eventBus.publish('position.updated', { positionId: reconciled.id, status: 'CLOSED' });
        await this.notifier?.notifyError(
          'closePosition zero-balance reconciliation',
          `Position ${positionId} (${position.token.symbol ?? position.token.mint}) was recorded OPEN with ${recordedAmount} tokens on file, but the wallet holds 0. Closed automatically to stop the retry loop — no realized PnL was recorded since the actual disposition of the tokens is unknown. Manual reconciliation required.`,
        );
        latencyTracker.finish(traceId, 'failure');
        return { closed: true as const, position: reconciled, signature: null };
      }

      const sendSwapStartedAt = Date.now();
      try {
        signature = await this.sendSwapWithBroadcastRetry(
          keypair,
          {
            inputMint: position.token.mint,
            outputMint: SOL_MINT,
            amountLamports: sellAmountRaw,
            slippageBps: 300,
          },
          async () => ({ dex: position.token.dex, poolAddress: position.token.poolAddress }),
          { ...PositionManager.SELL_SEND_SWAP_OPTIONS, traceId },
          { mint: position.token.mint, expectedAtLeastRaw: sellAmountRaw, positionId },
        );
      } catch (err) {
        // Position deliberately stays OPEN here — nothing below this point runs,
        // so status/realizedPnlUsd are never touched. The caller (checkAndMaybeClose
        // via priceMonitor, or a manual sell) retries on its own next pass. Safe to
        // retry freely: the swap itself never landed, so nothing real happened yet.
        const classification = classifySellFailure(err);
        this.logger.error(
          {
            err,
            positionId,
            walletId,
            category: classification.category,
            detail: classification.detail,
            latencyMs: Date.now() - sendSwapStartedAt,
            location: 'apps/api/src/trading/positionManager.ts:closePositionLocked',
          },
          `SELL FAILED\nCategory: ${classification.category}\nReason:\n${classification.detail}`,
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          err,
        });
        // Persisted retry-state fix (2026-07-23, USOH incident follow-up):
        // an in-memory-only counter loses its history on every process
        // restart, which would silently understate how many times a
        // stop-loss has already failed to execute — see schema.prisma's
        // Position.sellFailureCount doc comment. Never gates whether a retry
        // happens (that's still purely the next price tick), only alerting.
        const updatedPosition = await this.prisma.position.update({
          where: { id: positionId },
          data: { sellFailureCount: { increment: 1 }, lastSellFailureAt: new Date() },
          select: { sellFailureCount: true },
        });
        const totalFailures = updatedPosition.sellFailureCount;
        // Same TTL-deduped "don't spam the same ongoing failure" gate as
        // before (regression 2026-07-21 audit) is still the primary rule —
        // ONLY overridden at escalation milestones, where a persisted,
        // restart-proof count crossing a threshold re-alerts even within the
        // same hour, since "still failing after 10+ attempts" is materially
        // more urgent than "failed once."
        const isEscalationMilestone =
          totalFailures === 10 ||
          totalFailures === 25 ||
          (totalFailures > 50 && totalFailures % 25 === 0);
        const shouldAlert = !this.sellFailureAlerted.has(positionId) || isEscalationMilestone;
        if (shouldAlert) {
          this.sellFailureAlerted.add(positionId);
          const severity = totalFailures >= 10 ? 'CRITICAL — ' : '';
          const retryOutlook = classification.permanent
            ? `This failure has no route to retry successfully — it counts toward the ${this.maxPermanentRouteRetries}-attempt permanent-failure threshold before auto-sell is disabled for this position.`
            : 'Will keep retrying on the next price tick.';
          await this.notifier?.notifyError(
            'SELL execution failed',
            `${severity}Position ${positionId} (${position.token.symbol ?? position.token.mint}): stop-loss/take-profit/trailing-stop should sell but the swap failed [${classification.category}]: ${classification.detail}. This is failure #${totalFailures} for this position. ${retryOutlook}`,
          );
        }
        // Permanent (no-route) failure gate (2026-07-26 fix) — unlike
        // sellFailureCount above, this DOES eventually stop future retries.
        // See recordPermanentSellFailure's doc comment.
        if (classification.permanent) {
          await this.recordPermanentSellFailure(
            positionId,
            position.token.mint,
            position.token.symbol ?? position.token.mint,
            classification,
          );
        }
        latencyTracker.finish(traceId, 'failure');
        throw tagSellFailure(err, classification.category);
      }

      // The swap itself landed on-chain from here on — any further failure is a
      // verification problem, not a "nothing happened" problem. Locking the
      // position out of further auto-sell attempts is what actually matters here:
      // live-verified 2026-07-11, a transient verification-RPC failure at this
      // exact point let PriceMonitor's next tick see the position still OPEN with
      // its original amountToken untouched, and resubmit a fresh sell of the same
      // amount — twice — draining unrelated token balance out of the wallet each
      // time. See unverifiedSwapLocks's doc comment.
      this.unverifiedSwapLocks.set(positionId, Date.now());
      try {
        // Retried for the same reason as the BUY-side verification — see
        // withVerificationRetry's doc comment.
        const actualSolReceived = await withVerificationRetry(
          () => getActualSolDelta(this.connection, signature, keypair.publicKey.toBase58()),
          3,
          this.verificationRetryDelayMs,
        );
        outAmountLamports = Number(actualSolReceived);
        soldAmountToken = Number(sellAmountRaw);
        this.unverifiedSwapLocks.delete(positionId);
      } catch (err) {
        const reason = `SELL landed on-chain (signature ${signature}) but could not be verified after retries for position ${positionId}. Position was left OPEN with stale amountToken. Manual reconciliation required — further auto-sell attempts for this position are blocked for up to ${PositionManager.RECONCILIATION_LOCK_TTL_MS / 60_000} minutes, then automatically recover.`;
        this.logger.error(
          {
            err,
            positionId,
            walletId,
            signature,
            location: 'apps/api/src/trading/positionManager.ts:closePosition',
          },
          `SELL CANCELLED\nReason:\n${reason}`,
        );
        await this.recordFailedTrade({
          walletId,
          tokenId: position.tokenId,
          side: 'SELL',
          amountSol: 0,
          amountToken: Number(sellAmountRaw),
          signature,
          err,
        });
        await this.notifier?.notifyError('closePosition verification', reason);
        latencyTracker.finish(traceId, 'failure');
        throw err;
      }
    }

    // soldAmountToken is the RAW on-chain integer amount actually sold in THIS
    // closing leg (already the remaining/moonbag amount for a position with
    // prior partial exits, not the original full amountToken — see
    // remainingAmountToken above) — must be decimal-adjusted before
    // multiplying by a USD price delta, exactly like
    // computeTrailingStopDisplay's currentProfitUsd does. Live-verified
    // failure: an un-adjusted calc here produced a phantom -$395,414.07
    // "loss" on a real ~-$0.04 close, which then tripped the daily loss
    // safety limit and blocked every subsequent trade for the rest of the day.
    //
    // Production bug fixed here (Profit Distribution Audit, 2026-07-12): this
    // used to compute PnL against the FULL original amountToken and then
    // OVERWRITE position.realizedPnlUsd with it — for any position with
    // prior partial exits (institutional mode), that discarded the real,
    // already-recorded profit from each earlier tier (sold at their own,
    // different prices) and replaced it with a fabricated "what if the
    // entire original position sold at today's price" number. Fixed to
    // ADD this leg's real PnL to whatever partial exits already
    // accumulated — for a position with no partial exits,
    // position.realizedPnlUsd is null (?? 0) and soldAmountToken already
    // equals the full amountToken, so this is byte-identical to the old
    // result in that case.
    const finalLegPnlUsd =
      (exit.currentPriceUsd - position.entryPriceUsd) *
      (soldAmountToken / 10 ** position.token.decimals);
    const realizedPnlUsd = (position.realizedPnlUsd ?? 0) + finalLegPnlUsd;

    const sellTrade = await this.prisma.trade.create({
      data: {
        walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        amountSol: outAmountLamports / LAMPORTS_PER_SOL,
        amountToken: soldAmountToken,
        priceUsd: exit.currentPriceUsd,
        txSignature: signature,
        isPaperTrade: this.paperTrading,
        confirmedAt: new Date(),
      },
    });

    const updated = await this.prisma.position.update({
      where: { id: positionId },
      data: {
        status: 'CLOSED',
        realizedPnlUsd,
        closedAt: new Date(),
        // Previously computed (line below, for the SellCardData notification)
        // but never actually persisted onto the row the schema documents it
        // for — fixed here so Position.exitReason is real, queryable history,
        // not just a transient notification field.
        exitReason: exit.reason ?? 'manual',
      },
    });

    latencyTracker.mark(traceId, 'position_closed');
    latencyTracker.finish(traceId, 'success');

    this.logger.info(
      { positionId, signature, reason: exit.reason, realizedPnlUsd },
      'position closed',
    );

    eventBus.publish('trade.created', {
      tradeId: sellTrade.id,
      side: 'SELL',
      mint: position.token.mint,
    });
    eventBus.publish('position.updated', {
      positionId: updated.id,
      status: 'CLOSED',
      realizedPnlUsd,
    });

    // Sell Signal: fires for every real sell regardless of what triggered it. This is
    // additional to the TP/SL/trailing-specific alert below, not a replacement for
    // it — before this, a manual close (exit.reason undefined) had no alert path at
    // all, since notifyExit only ever fired when a reason was set.
    this.logger.debug(
      { positionId, hasNotifier: !!this.notifier },
      'Telegram Notification: dispatching SELL notifyTrade',
    );
    await this.notifier?.notifyTrade({
      side: 'SELL',
      symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
      mint: position.token.mint,
      dex: position.token.dex,
      amountSol: outAmountLamports / LAMPORTS_PER_SOL,
      priceUsd: exit.currentPriceUsd || undefined,
      signature,
      isPaperTrade: this.paperTrading,
    });

    if (exit.reason) {
      const pnlPercent =
        ((exit.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
      const display = computeTrailingStopDisplay({
        entryPriceUsd: position.entryPriceUsd,
        currentPriceUsd: exit.currentPriceUsd,
        highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
        amountToken: position.amountToken,
        tokenDecimals: position.token.decimals,
        trailingStopPercent: position.trailingStopPercent,
      });
      await this.notifier?.notifyExit({
        symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
        mint: position.token.mint,
        dex: position.token.dex,
        reason: exit.reason,
        pnlPercent,
        pnlUsd: realizedPnlUsd,
        isPaperTrade: this.paperTrading,
        entryPriceUsd: display.entryPriceUsd,
        athUsd: display.athUsd,
        lockedProfitPercent: display.lockedProfitPercent,
      });
    }

    // The sell already landed and the position is already CLOSED above — everything
    // from here on is purely a notification/share-caption side effect. Wrapped in
    // its own try/catch so a DB hiccup here (e.g. the best-effort buy-trade lookup)
    // can never surface as a "close failed" error for a trade that in fact succeeded.
    try {
      if (this.notifier) {
        // No Trade->Position FK exists (extend-only scope, not a schema
        // rearchitecture) — best-effort match: the most recent BUY trade for this
        // wallet+token. Correct for the common case (one open position per token,
        // matching this app's own MAX_OPEN_POSITIONS usage); ambiguous only if the
        // same wallet held multiple concurrent/rapid positions in the same token.
        const buyTrade = await this.prisma.trade.findFirst({
          where: { walletId, tokenId: position.tokenId, side: 'BUY' },
          orderBy: { createdAt: 'desc' },
        });
        const holdingTimeMs =
          (updated.closedAt ?? new Date()).getTime() - position.createdAt.getTime();
        const pnlPercentForCard =
          ((exit.currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

        // Production bug fixed here (Profit Distribution Audit, 2026-07-12):
        // profitSol/roiPercent below used to be computed from ONLY this final
        // leg's outAmountLamports vs. the position's FULL original
        // amountSolInvested — for a position with prior partial exits, that
        // silently dropped the SOL already returned by each earlier tier,
        // understating the sell card's shown profit/ROI. Sum every CONFIRMED
        // SELL trade for this wallet+token since this position was opened
        // (the just-created final-leg trade is already in this set) instead
        // of just the final leg. Scoped to createdAt >= position.createdAt so
        // a prior, already-closed position for the same wallet+token (no
        // Trade->Position FK exists) is never double-counted here.
        const allSellTradesThisPosition = await this.prisma.trade.findMany({
          where: {
            walletId,
            tokenId: position.tokenId,
            side: 'SELL',
            status: 'CONFIRMED',
            createdAt: { gte: position.createdAt },
          },
        });
        const totalSellAmountSol = allSellTradesThisPosition.reduce(
          (sum, t) => sum + t.amountSol,
          0,
        );
        const totalProfitSol = totalSellAmountSol - position.amountSolInvested;
        const displayForCard = computeTrailingStopDisplay({
          entryPriceUsd: position.entryPriceUsd,
          currentPriceUsd: exit.currentPriceUsd,
          highWaterMarkUsd: position.highWaterMarkUsd ?? position.entryPriceUsd,
          amountToken: position.amountToken,
          tokenDecimals: position.token.decimals,
          trailingStopPercent: position.trailingStopPercent,
        });
        const cardCaption = await this.notifier.notifySellCard({
          token: {
            mint: position.token.mint,
            name: position.token.name ?? undefined,
            symbol: position.token.symbol ?? undefined,
            dex: position.token.dex,
            imageUrl: position.token.imageUrl ?? undefined,
            marketCapUsd: position.token.marketCapUsd ?? undefined,
            liquidityUsd: position.token.liquidityUsd ?? undefined,
            aiScore: position.token.aiScore ?? undefined,
            holderCount: position.token.holderCount ?? undefined,
            isHoneypotSuspected: position.token.isHoneypotSuspected ?? undefined,
            mintAuthorityRevoked: position.token.mintAuthorityRevoked ?? undefined,
            freezeAuthorityRevoked: position.token.freezeAuthorityRevoked ?? undefined,
            lpBurnedOrLocked: position.token.lpBurnedOrLocked ?? undefined,
            top10HolderPercent: position.token.top10HolderPercent ?? undefined,
          },
          entryPriceUsd: position.entryPriceUsd,
          exitPriceUsd: exit.currentPriceUsd,
          buyAmountSol: position.amountSolInvested,
          sellAmountSol: totalSellAmountSol,
          profitSol: totalProfitSol,
          profitUsd: realizedPnlUsd,
          roiPercent:
            position.amountSolInvested > 0
              ? (totalProfitSol / position.amountSolInvested) * 100
              : 0,
          pnlPercent: pnlPercentForCard,
          holdingTimeMs,
          exitReason: exit.reason ?? 'manual',
          highestProfitPercent: displayForCard.highestProfitPercent,
          lockedProfitPercent: displayForCard.lockedProfitPercent,
          walletPublicKey:
            (
              await this.prisma.wallet.findUnique({
                where: { id: walletId },
                select: { publicKey: true },
              })
            )?.publicKey ?? walletId,
          positionId,
          buySignature: buyTrade?.txSignature ?? '—',
          sellSignature: signature,
        });
        if (cardCaption) {
          await this.prisma.position.update({
            where: { id: positionId },
            data: { shareCaption: cardCaption },
          });
        }
      }
    } catch (err) {
      this.logger.error({ err, positionId }, 'failed to build/send SELL trade card');
    }

    return { closed: true as const, position: updated, signature };
  }
}
