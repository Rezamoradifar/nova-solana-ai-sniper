import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  calculatePerformanceFee,
  calculateReferralRewards,
  getOrCreateBusinessSettings,
  isEligibleForFeeProcessing,
  resolveReferralChain,
} from '@nova/shared';
import { createBot, NotificationService, type TradeReportData } from '@nova/telegram-bot';
import { eventBus } from '../lib/eventBus.js';
import { DexScreenerClient } from '../solana/dexscreener.js';
import { sharedSolPriceOracle } from '../solana/pumpfunBondingCurve.js';

export interface FeeSystemDeps {
  prisma: PrismaClient;
  log: Logger;
  config: {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    DEXSCREENER_API_BASE: string;
  };
}

/**
 * The one integration point between the fee/referral system and trading:
 * a pure event-bus subscriber reacting to the *already-existing*
 * 'position.updated' event (apps/api/src/lib/eventBus.ts) after
 * positionManager.ts has already closed a position — never before, never by
 * calling into it. Zero lines changed in positionManager.ts, autoTrader.ts,
 * riskAnalyzer.ts, or worker.ts. Registered once from app.ts.
 *
 * The zero-balance-reconciliation close path (positionManager.ts) publishes
 * 'position.updated' without realizedPnlUsd — that's excluded here by the
 * `realizedPnlUsd == null` check, so a position we couldn't verify never
 * generates a fee, matching "never charge fees on failed trades."
 */
export function registerFeeSystem(deps: FeeSystemDeps): void {
  const notifier = buildNotifier(deps);
  const dexScreener = new DexScreenerClient(deps.config.DEXSCREENER_API_BASE);

  eventBus.subscribe((event) => {
    if (event.type !== 'position.updated') return;
    const payload = event.payload as {
      positionId?: string;
      status?: string;
      realizedPnlUsd?: number;
    };
    if (
      payload.status !== 'CLOSED' ||
      payload.realizedPnlUsd == null ||
      payload.realizedPnlUsd <= 0 ||
      !payload.positionId
    ) {
      return;
    }

    void processProfitableClose(
      deps,
      notifier,
      dexScreener,
      payload.positionId,
      payload.realizedPnlUsd,
    ).catch((err) => {
      deps.log.error(
        { err, positionId: payload.positionId },
        'fee/referral processing failed for a closed position',
      );
    });
  });

  deps.log.info('fee & referral system registered (event-bus subscriber on position.updated)');
}

function buildNotifier(deps: FeeSystemDeps): NotificationService | undefined {
  if (!deps.config.TELEGRAM_BOT_TOKEN || !deps.config.TELEGRAM_CHAT_ID) {
    deps.log.warn(
      'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — trade-report notifications disabled (fee ledger is still recorded)',
    );
    return undefined;
  }
  // A second Bot instance, same token — never calls .start() (no long-polling),
  // only ever used to send a message, so this can't conflict with the real
  // bot process (apps/telegram-bot) also holding this token.
  const bot = createBot(deps.config.TELEGRAM_BOT_TOKEN, deps.log as never);
  return new NotificationService(bot, deps.config.TELEGRAM_CHAT_ID, deps.prisma, deps.log as never);
}

export async function processProfitableClose(
  deps: FeeSystemDeps,
  notifier: NotificationService | undefined,
  dexScreener: DexScreenerClient,
  positionId: string,
  grossProfitUsd: number,
): Promise<void> {
  const already = await deps.prisma.performanceFeeLedger.findUnique({ where: { positionId } });
  if (already) return;

  const position = await deps.prisma.position.findUnique({
    where: { id: positionId },
    include: { wallet: true, token: true },
  });
  if (!position) return;

  // Backward-compatibility guarantee, checked before any further work: a
  // position is only eligible if it closed at or after the fee system's own
  // activation timestamp — see isEligibleForFeeProcessing's doc comment.
  // Deliberately independent of the user's own account age (User.createdAt
  // is never read here or anywhere in this file) — an existing user from
  // before this feature shipped is charged exactly like a new one on any
  // trade that closes from now on, with no migration step of their own.
  const settings = await getOrCreateBusinessSettings(deps.prisma);
  if (!isEligibleForFeeProcessing(position.closedAt, settings.feeSystemActivatedAt)) {
    deps.log.debug(
      { positionId, closedAt: position.closedAt, activatedAt: settings.feeSystemActivatedAt },
      'fee system: position closed before activation — skipping (never reprocess history)',
    );
    return;
  }

  // Best-effort lookback, mirroring the exact same strategy positionManager.ts
  // already uses to match a BUY trade to a position (no Trade->Position FK
  // exists) — same convention, not a new join strategy.
  const [sellTrade, buyTrade] = await Promise.all([
    deps.prisma.trade.findFirst({
      where: {
        walletId: position.walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'desc' },
    }),
    deps.prisma.trade.findFirst({
      where: {
        walletId: position.walletId,
        tokenId: position.tokenId,
        side: 'BUY',
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // The real on-chain SOL delta between the matched trades already reflects
  // actual slippage/gas (they're real fill amounts, not quotes) — the gap
  // between this and the price-based grossProfitUsd IS the trading cost.
  let actualNetProfitUsd: number | undefined;
  if (sellTrade && buyTrade) {
    const solPriceUsd = await sharedSolPriceOracle.getPriceUsd(dexScreener).catch(() => undefined);
    if (solPriceUsd !== undefined) {
      actualNetProfitUsd = (sellTrade.amountSol - buyTrade.amountSol) * solPriceUsd;
    }
  }

  const feeResult = calculatePerformanceFee({
    grossProfitUsd,
    actualNetProfitUsd,
    feeBps: settings.performanceFeeBps,
  });
  if (!feeResult) return; // net profit <= 0 once real costs are counted — no fee

  const chain = settings.referralProgramEnabled
    ? await resolveReferralChain(deps.prisma, position.wallet.userId, settings.maxReferralDepth)
    : [];
  const referralDistribution = calculateReferralRewards(
    feeResult.feeUsd,
    chain,
    settings.referralLevels,
    settings.maxReferralDepth,
  );

  const ledger = await deps.prisma
    .$transaction(async (tx) => {
      const created = await tx.performanceFeeLedger.create({
        data: {
          positionId,
          sellTradeId: sellTrade?.id,
          userId: position.wallet.userId,
          walletId: position.walletId,
          tokenId: position.tokenId,
          grossProfitUsd: feeResult.grossProfitUsd,
          tradingCostsUsd: feeResult.tradingCostsUsd,
          netProfitUsd: feeResult.netProfitUsd,
          feeBps: feeResult.feeBps,
          feeUsd: feeResult.feeUsd,
          userShareUsd: feeResult.userShareUsd,
        },
      });
      for (const reward of referralDistribution) {
        await tx.referralReward.create({
          data: {
            performanceFeeLedgerId: created.id,
            referrerUserId: reward.referrerUserId,
            referredUserId: position.wallet.userId,
            level: reward.level,
            percentBps: reward.percentBps,
            rewardUsd: reward.rewardUsd,
          },
        });
      }
      return created;
    })
    .catch((err: unknown) => {
      // Unique constraint on positionId — a concurrent duplicate fire, not a real error.
      if ((err as { code?: string }).code === 'P2002') return undefined;
      throw err;
    });
  if (!ledger) return;

  const report: TradeReportData = {
    symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
    grossProfitUsd: feeResult.grossProfitUsd,
    tradingCostsUsd: feeResult.tradingCostsUsd,
    netProfitUsd: feeResult.netProfitUsd,
    feeBps: feeResult.feeBps,
    feeUsd: feeResult.feeUsd,
    userShareUsd: feeResult.userShareUsd,
    referralRewardsTotalUsd: referralDistribution.reduce((sum, r) => sum + r.rewardUsd, 0),
    referenceId: ledger.id,
  };
  await notifier?.notifyTradeReport(position.wallet.userId, report);
}
