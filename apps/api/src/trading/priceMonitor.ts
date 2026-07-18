import type { PrismaClient, Token } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import type { JupiterClient } from '../solana/jupiter.js';
import { SOL_MINT } from '../solana/jupiter.js';
import type { DexRegistry } from '../solana/dex/registry.js';
import { sharedSolPriceOracle } from '../solana/pumpfunBondingCurve.js';
import type { PositionManager } from './positionManager.js';
import {
  isPlausiblePriceUpdate,
  reconcilePriceOutlier,
  evaluateHardLossCeiling,
  OUTLIER_RECONCILE_AFTER_CONSECUTIVE_REJECTIONS,
  OUTLIER_FORCE_ACCEPT_AFTER_MS,
  DEFAULT_MAX_LOSS_PERCENT,
  type PriceReconciliationResult,
} from './exitEngine.js';

export interface PriceMonitorDeps {
  prisma: PrismaClient;
  dexScreener: DexScreenerClient;
  positionManager: PositionManager;
  logger: Logger;
  encryptionKey: string;
  /**
   * Root-cause fix (2026-07-18): both used only to reconcile a price tick
   * that already failed isPlausiblePriceUpdate, against a second, independent
   * source, before it can starve a position of updates indefinitely — see
   * exitEngine.ts's reconcilePriceOutlier doc comment. Optional so any
   * existing test construction of PriceMonitorDeps without these keeps
   * working unchanged; reconciliation is simply skipped (falls straight
   * through to the force-accept-after-ceiling path) if either is omitted.
   */
  jupiter?: JupiterClient;
  dexRegistry?: DexRegistry;
}

/**
 * Polls every OPEN position's current price and hands it to
 * PositionManager.checkAndMaybeClose, which decides (via the pure evaluateExit
 * logic) whether take-profit/stop-loss/trailing-stop should fire. This is the
 * piece that makes those fields actually do something — without a loop
 * driving it, they're just stored numbers nothing ever reads.
 */
export class PriceMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  // Root-cause fix (2026-07-18): per-position consecutive-outlier-rejection
  // streak, in-memory for the process lifetime — same lifetime assumption
  // PositionManager's unverifiedSwapLocks/openLocks already rely on. Cleared
  // on any accepted (plausible or reconciled) tick for that position.
  private readonly outlierState = new Map<string, { count: number; firstRejectedAt: number }>();

  constructor(private readonly deps: PriceMonitorDeps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A slow RPC/API round-trip on one tick should never overlap with the next timer fire.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const openPositions = await this.deps.prisma.position.findMany({
        where: { status: 'OPEN' },
        include: { token: true, wallet: true },
      });

      for (const position of openPositions) {
        try {
          const pair = await this.deps.dexScreener.getBestSolanaPair(position.token.mint);
          const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
          if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) continue;

          // Reject an implausible single-tick outlier before it can corrupt this
          // position's (monotonic, self-reinforcing) high-water mark or fire a
          // bogus exit off a phantom price — see exitEngine.ts's
          // isPlausiblePriceUpdate doc comment for the live-verified incident.
          const referencePriceUsd = position.highWaterMarkUsd ?? position.entryPriceUsd;
          if (!isPlausiblePriceUpdate(referencePriceUsd, currentPriceUsd)) {
            // Hard Loss Ceiling (2026-07-18): a rejected tick doesn't wait for
            // the normal 3-rejection/10-minute reconciliation cycle if it
            // already implies a loss beyond this position's ceiling — that
            // wait is exactly what let a real position (ANSEMCOIN) sit
            // unprotected for hours before its stop-loss could even see a
            // real price. Cheap arithmetic first; only pays for a
            // corroboration probe when the answer is yes.
            const hardLoss = evaluateHardLossCeiling(
              position.entryPriceUsd,
              currentPriceUsd,
              position.stopLossPercent ?? DEFAULT_MAX_LOSS_PERCENT, // defensive fallback — Step 3 means this is always populated
            );
            if (hardLoss.breached) {
              const reconciliation = await this.probeAndReconcile(
                position.token,
                currentPriceUsd,
                false,
              );
              if (reconciliation.accepted) {
                this.outlierState.delete(position.id);
                this.deps.logger.error(
                  {
                    positionId: position.id,
                    mint: position.token.mint,
                    entryPriceUsd: position.entryPriceUsd,
                    currentPriceUsd,
                    pnlPercent: hardLoss.pnlPercent,
                    effectiveStopLossPercent: position.stopLossPercent,
                    isSystemDefault: position.stopLossIsSystemDefault,
                    source: reconciliation.source,
                  },
                  'HARD_LOSS_CEILING_TRIGGERED — forcing immediate exit ahead of normal outlier reconciliation',
                );
                await this.deps.positionManager.closePosition(
                  position.id,
                  position.walletId,
                  position.wallet.encryptedSecret,
                  this.deps.encryptionKey,
                  { currentPriceUsd, reason: 'stop_loss' },
                );
                continue;
              }
              // Not corroborated — fall through to the routine path below unchanged.
            }

            const accepted = await this.handleOutlierRejection(
              position.id,
              position.token,
              referencePriceUsd,
              currentPriceUsd,
            );
            if (!accepted) continue;
          }
          this.outlierState.delete(position.id);

          await this.deps.positionManager.checkAndMaybeClose(
            position.id,
            currentPriceUsd,
            position.wallet.encryptedSecret,
            this.deps.encryptionKey,
          );
        } catch (err) {
          // Production Bug Fix (2026-07-14): this catch previously covered both
          // a DexScreener price-fetch failure above AND a SELL execution
          // failure from checkAndMaybeClose below under the same generic
          // message, with no way to tell which happened or why from the log
          // line alone. PositionManager tags every SELL failure it throws
          // with `.sellFailureCategory` (see sellFailureClassifier.ts) — when
          // present, log it as a distinct, categorized SELL failure instead.
          const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
          if (category) {
            this.deps.logger.error(
              { err, positionId: position.id, mint: position.token.mint, category },
              `SELL execution failed [${category}]`,
            );
          } else {
            this.deps.logger.error(
              { err, positionId: position.id },
              'price check failed for open position',
            );
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Root-cause fix (2026-07-18) for a position being starved of price
   * updates indefinitely by a stale/corrupted reference price: only reaches
   * here once a tick has already failed isPlausiblePriceUpdate. Below the
   * consecutive-rejection/elapsed-time thresholds, keeps today's exact
   * behavior (log + skip this tick). Once past them, cross-checks the
   * candidate against a second, independently-sourced price read before
   * accepting it — and after OUTLIER_FORCE_ACCEPT_AFTER_MS of sustained
   * rejection with no corroboration, accepts it anyway so a genuine sustained
   * crash is never misclassified as bad data forever. Returns whether the
   * caller should now treat currentPriceUsd as accepted.
   */
  private async handleOutlierRejection(
    positionId: string,
    token: Token,
    referencePriceUsd: number,
    currentPriceUsd: number,
  ): Promise<boolean> {
    const state = this.outlierState.get(positionId) ?? { count: 0, firstRejectedAt: Date.now() };
    state.count += 1;
    this.outlierState.set(positionId, state);
    const elapsedMs = Date.now() - state.firstRejectedAt;

    const shouldAttemptReconciliation =
      state.count >= OUTLIER_RECONCILE_AFTER_CONSECUTIVE_REJECTIONS ||
      elapsedMs >= OUTLIER_FORCE_ACCEPT_AFTER_MS;

    if (!shouldAttemptReconciliation) {
      this.deps.logger.warn(
        {
          positionId,
          mint: token.mint,
          referencePriceUsd,
          currentPriceUsd,
          consecutiveRejections: state.count,
        },
        'price tick rejected as implausible outlier — skipping this position this tick',
      );
      return false;
    }

    const forcedAfterCeiling = elapsedMs >= OUTLIER_FORCE_ACCEPT_AFTER_MS;
    const reconciliation = await this.probeAndReconcile(token, currentPriceUsd, forcedAfterCeiling);

    if (!reconciliation.accepted) {
      this.deps.logger.warn(
        {
          positionId,
          mint: token.mint,
          referencePriceUsd,
          currentPriceUsd,
          consecutiveRejections: state.count,
        },
        'price tick rejected as implausible outlier — reconciliation attempted but no independent source corroborated it',
      );
      return false;
    }

    // A distinct, loud line — never confused with the routine rejection
    // above — so a human reviewing logs sees exactly when and why a
    // previously-stuck position's reference price was overridden.
    this.deps.logger.error(
      {
        positionId,
        mint: token.mint,
        referencePriceUsd,
        currentPriceUsd,
        consecutiveRejections: state.count,
        elapsedMs,
        source: reconciliation.source,
      },
      reconciliation.source === 'forced_after_ceiling'
        ? `PRICE OUTLIER FORCE-ACCEPTED after ${OUTLIER_FORCE_ACCEPT_AFTER_MS}ms of sustained rejection with no corroborating source — a genuine sustained move is assumed over indefinite starvation`
        : `PRICE OUTLIER RECONCILED — accepting tick, corroborated by ${reconciliation.source}`,
    );
    return true;
  }

  /**
   * Runs both independent price-corroboration probes and hands the result to
   * reconcilePriceOutlier — shared by handleOutlierRejection's normal
   * 3-rejection/10-minute cycle and the Hard Loss Ceiling fast path (2026-07-18),
   * which calls this immediately on a single rejection instead of waiting.
   * Extracted so the two call sites can't drift apart on how corroboration
   * actually works.
   */
  private async probeAndReconcile(
    token: Token,
    candidatePriceUsd: number,
    forcedAfterCeiling: boolean,
  ): Promise<PriceReconciliationResult> {
    const [jupiterReverseQuotePriceUsd, nativeDexReservesPriceUsd] = await Promise.all([
      this.probeJupiterReversePrice(token),
      this.probeNativeDexPrice(token),
    ]);
    return reconcilePriceOutlier({
      candidatePriceUsd,
      jupiterReverseQuotePriceUsd,
      nativeDexReservesPriceUsd,
      forcedAfterCeiling,
    });
  }

  /**
   * A reverse (token -> SOL) Jupiter quote at a small slice of the position's
   * own holdings, converted to a USD-per-token price via the shared SOL/USD
   * oracle — same math already used by PositionManager.resolveEntryPriceUsd,
   * reused here as one of two independent price sources for outlier
   * reconciliation (see exitEngine.ts's reconcilePriceOutlier).
   */
  private async probeJupiterReversePrice(token: Token): Promise<number | undefined> {
    if (!this.deps.jupiter) return undefined;
    try {
      const amountToken = Math.max(1, Math.floor(10 ** token.decimals * 0.01));
      const [quote, solPriceUsd] = await Promise.all([
        this.deps.jupiter.getQuote({
          inputMint: token.mint,
          outputMint: SOL_MINT,
          amountLamports: BigInt(amountToken),
          slippageBps: 500,
        }),
        sharedSolPriceOracle.getPriceUsd(this.deps.dexScreener),
      ]);
      if (solPriceUsd === undefined) return undefined;
      const solReceived = Number(quote.outAmount) / 1e9;
      const tokensSold = amountToken / 10 ** token.decimals;
      if (tokensSold <= 0) return undefined;
      const priceUsd = (solReceived * solPriceUsd) / tokensSold;
      return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined;
    } catch (err) {
      this.deps.logger.debug(
        { mint: token.mint, err },
        'outlier reconciliation: jupiter reverse-quote probe failed',
      );
      return undefined;
    }
  }

  /**
   * Derives a price from a native DEX pool's own reserve ratio (base/quote
   * vault balances), when the token's pool is known — the second independent
   * source for outlier reconciliation. Only ever resolves for tokens whose
   * dex/poolAddress map to one of DexRegistry's four native monitors; returns
   * undefined (never throws) for anything else, including pre-migration
   * pump.fun bonding-curve tokens.
   */
  private async probeNativeDexPrice(token: Token): Promise<number | undefined> {
    if (!this.deps.dexRegistry || !token.poolAddress) return undefined;
    try {
      const pool = await this.deps.dexRegistry.getLiquidity(token.dex, token.poolAddress);
      if (!pool || pool.baseReserve <= 0 || pool.quoteReserve <= 0) return undefined;
      if (pool.baseMint !== token.mint) return undefined;

      if (pool.quoteMint === SOL_MINT) {
        const solPriceUsd = await sharedSolPriceOracle.getPriceUsd(this.deps.dexScreener);
        if (solPriceUsd === undefined) return undefined;
        return (pool.quoteReserve / pool.baseReserve) * solPriceUsd;
      }
      // Any other quote mint in this codebase's native pools is a USD-pegged
      // stablecoin — the reserve ratio is already ~USD per token.
      return pool.quoteReserve / pool.baseReserve;
    } catch (err) {
      this.deps.logger.debug(
        { mint: token.mint, err },
        'outlier reconciliation: native DEX reserve probe failed',
      );
      return undefined;
    }
  }
}
