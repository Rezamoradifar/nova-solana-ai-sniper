import { PublicKey, type Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { NotificationService } from '@nova/telegram-bot';
import type { DexScreenerClient } from '../solana/dexscreener.js';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';
import { RiskAnalyzer } from '../detection/riskAnalyzer.js';
import type { PositionManager } from './positionManager.js';
import { evaluateEmergencyExit } from './emergencyExit.js';

export interface EmergencyExitMonitorDeps {
  prisma: PrismaClient;
  connection: Connection;
  dexScreener: DexScreenerClient;
  jupiter: JupiterClient;
  riskAnalyzer: RiskAnalyzer;
  positionManager: PositionManager;
  logger: Logger;
  encryptionKey: string;
  notifier?: NotificationService;
}

/**
 * The system-wide safety net — polls every OPEN position (any exit strategy:
 * legacy manual TP/SL/trailing, a preset, Institutional Mode, or the new
 * tp1_trailing_v1 strategy) on its own (slower — see
 * EMERGENCY_EXIT_CHECK_INTERVAL_MS's doc comment) interval, independent of
 * PriceMonitor's plain TP/SL/trailing-stop loop.
 *
 * 2026-07-28 fix: this used to filter to `institutionalModeEnabled: true`
 * only, which — combined with Institutional Mode never actually being
 * enabled in production (see positionManager.ts's own history) — meant this
 * fully-built engine protected zero real positions. There is no principled
 * reason a legacy/preset/new-strategy position should be unprotected from a
 * liquidity collapse, a re-enabled mint/freeze authority, a rug-score
 * collapse, or a no-sell-route condition while only an institutional one is —
 * every OPEN position is now in scope. The dev-wallet-dump signal
 * (devWalletAddress/devWalletAmountRawAtEntry) is a proxy resolved at open
 * time; positions opened before this fix (or any position this proxy
 * couldn't resolve) simply won't have that one signal available — the other
 * five (liquidity collapse, no-sell-route, mint/freeze re-enabled, critical
 * rug score) are unaffected and still fully active for every position.
 *
 * A trigger sells 100% of whatever remains via the ordinary closePosition
 * path (which already reads the real live wallet balance for a real sell,
 * so this correctly sells through an institutional-mode moonbag too, or a
 * tp1_trailing_v1 position's post-TP1 remainder) — never a partial sell.
 */
export class EmergencyExitMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: EmergencyExitMonitorDeps) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    // A slow RPC/API round-trip on one tick should never overlap the next timer fire.
    if (this.ticking) return;
    this.ticking = true;
    try {
      // NO_SELL_ROUTE fix (2026-07-26, Phase 6): same exclusion as
      // priceMonitor.ts's tick — a sellUnsellable position is archived from
      // active monitoring (PositionManager has already given up on it after
      // maxPermanentRouteRetries consecutive no-route failures), so there's
      // no point spending a fresh riskAnalyzer.analyze + Jupiter quote on it
      // every tick when any resulting closePosition call would just be
      // rejected by PositionManager's own sellUnsellable gate anyway.
      //
      // institutionalModeEnabled filter removed (2026-07-28) — see this
      // class's own doc comment: every OPEN position is now in scope, not
      // just institutional-mode ones.
      const positions = await this.deps.prisma.position.findMany({
        where: { status: 'OPEN', sellUnsellable: false },
        include: { token: true, wallet: true },
      });

      for (const position of positions) {
        try {
          const mint = position.token.mint;

          // bypassCache: true — the whole point is a fresh on-chain read
          // every tick, not whatever an unrelated AutoBuy/Discovery call
          // cached in the last 60s for this same mint. See riskAnalyzer.ts's
          // doc comment.
          const riskFlags = await this.deps.riskAnalyzer.analyze(
            { mint, dex: position.token.dex, poolAddress: position.token.poolAddress ?? undefined },
            { bypassCache: true },
          );
          const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);

          const remainingRaw = BigInt(
            Math.max(1, Math.floor(position.remainingAmountToken ?? position.amountToken)),
          );
          const canSell = await this.deps.jupiter
            .getQuote({
              inputMint: mint,
              outputMint: SOL_MINT,
              amountLamports: remainingRaw,
              slippageBps: 500,
            })
            .then(() => true)
            .catch(() => false);

          // A closed (fully-drained-then-closed) token account reads as an
          // RPC error here, not a balance of 0 — that's itself the maximal
          // dump signal, not "signal unavailable", so it's treated as 0n
          // rather than left undefined.
          let devWalletCurrentAmountRaw: bigint | undefined;
          if (position.devWalletAddress) {
            devWalletCurrentAmountRaw = await this.deps.connection
              .getTokenAccountBalance(new PublicKey(position.devWalletAddress))
              .then((res) => BigInt(res.value.amount))
              .catch(() => 0n);
          }

          const decision = evaluateEmergencyExit({
            liquidityUsd: riskFlags.liquidityUsd,
            mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
            freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
            canSell,
            ruleScore,
            devWalletAmountRawAtEntry: position.devWalletAmountRawAtEntry
              ? BigInt(position.devWalletAmountRawAtEntry)
              : undefined,
            devWalletCurrentAmountRaw,
          });

          if (!decision.shouldExit || !decision.reason) continue;

          this.deps.logger.warn(
            { positionId: position.id, mint, reason: decision.reason, detail: decision.detail },
            'EMERGENCY EXIT triggered',
          );

          const pair = await this.deps.dexScreener.getBestSolanaPair(mint).catch(() => undefined);
          const currentPriceUsd = pair?.priceUsd
            ? Number(pair.priceUsd)
            : (position.highWaterMarkUsd ?? position.entryPriceUsd);

          // Sell failures propagate to the catch below (logged, position
          // stays OPEN and institutionalModeEnabled, so it's re-checked and
          // re-attempted next tick) rather than falling through to
          // logging/notifying an exit that never actually happened.
          const result = await this.deps.positionManager.closePosition(
            position.id,
            position.walletId,
            position.wallet.encryptedSecret,
            this.deps.encryptionKey,
            { currentPriceUsd, reason: 'emergency' },
          );

          await this.deps.prisma.emergencyExitLog.create({
            data: {
              positionId: position.id,
              reason: decision.reason,
              detail: decision.detail ?? '',
              liquidityUsd: riskFlags.liquidityUsd,
              ruleScore,
              txSignature: result.signature ?? undefined,
            },
          });

          const pnlPercent =
            position.entryPriceUsd > 0
              ? ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
              : 0;
          await this.deps.notifier?.notifyEmergencyExit({
            symbol: position.token.symbol ?? mint.slice(0, 8),
            mint,
            dex: position.token.dex,
            reason: decision.reason,
            detail: decision.detail ?? '',
            pnlPercent,
            pnlUsd: result.position.realizedPnlUsd ?? undefined,
            isPaperTrade: position.isPaperTrade,
          });
        } catch (err) {
          // Production Bug Fix (2026-07-14): see priceMonitor.ts's tick catch
          // for why this distinguishes a categorized SELL execution failure
          // (tagged by PositionManager via sellFailureClassifier.ts) from
          // any other failure in this tick (risk-flag lookups, etc).
          const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
          if (category) {
            this.deps.logger.error(
              { err, positionId: position.id, mint: position.token.mint, category },
              `SELL execution failed [${category}] (emergency exit)`,
            );
          } else {
            this.deps.logger.error(
              { err, positionId: position.id },
              'emergency exit check failed for open position',
            );
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
