import type { Connection } from '@solana/web3.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import {
  calculatePerformanceFee,
  calculateFixedProfitDistribution,
  FIXED_USER_SHARE_BPS,
  getOrCreateBusinessSettings,
  isEligibleForFeeProcessing,
  resolveReferralChain,
  writeLedgerAndAudit,
} from '@nova/shared';
import { createBot, NotificationService, type TradeReportData } from '@nova/telegram-bot';
import { eventBus } from '../lib/eventBus.js';
import { DexScreenerClient } from '../solana/dexscreener.js';
import { sharedSolPriceOracle } from '../solana/pumpfunBondingCurve.js';
import { getConnection } from '../solana/connection.js';
import { JitoClient } from '../solana/jito.js';
import { executeReferralAndPlatformPayout, type PayoutOutcome } from './payoutExecutor.js';
import type { ReferrerWalletLookup } from './payoutCalculation.js';

export interface FeeSystemDeps {
  prisma: PrismaClient;
  log: Logger;
  config: {
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    DEXSCREENER_API_BASE: string;
    // Real on-chain payout (2026-07-23) — see payoutExecutor.ts. Every field
    // here is already present on app.config (apiEnvSchema already picks all
    // of them for other purposes), so wiring this in app.ts needs no change
    // at all — this is a type-only widening.
    ENCRYPTION_KEY: string;
    PLATFORM_TREASURY_WALLET_ADDRESS: string;
    MIN_WALLET_RESERVE_SOL: number;
    PAYOUT_ATTEMPT_STALE_MS: number;
    SOLANA_RPC_URL?: string;
    SOLANA_WS_URL?: string;
    HELIUS_API_KEY?: string;
    QUICKNODE_RPC_URL?: string;
    QUICKNODE_WS_URL?: string;
    CHAINSTACK_RPC_URL?: string;
    ADDITIONAL_RPC_URLS?: string;
    JITO_BLOCK_ENGINE_URL?: string;
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
  // Real on-chain payout (2026-07-23): this module constructs its own
  // connection/Jito client, same self-contained-dependencies convention it
  // already uses for dexScreener/the notifier's bot instance above — no
  // change needed to app.ts's/worker.ts's own wiring or startup order.
  const connection = getConnection(
    {
      rpcUrl: deps.config.SOLANA_RPC_URL,
      wsUrl: deps.config.SOLANA_WS_URL,
      heliusApiKey: deps.config.HELIUS_API_KEY,
      quicknodeRpcUrl: deps.config.QUICKNODE_RPC_URL,
      quicknodeWsUrl: deps.config.QUICKNODE_WS_URL,
      chainstackRpcUrl: deps.config.CHAINSTACK_RPC_URL,
      additionalRpcUrls: deps.config.ADDITIONAL_RPC_URLS,
    },
    deps.log,
  );
  const jito = deps.config.JITO_BLOCK_ENGINE_URL
    ? new JitoClient({ blockEngineUrl: deps.config.JITO_BLOCK_ENGINE_URL })
    : undefined;

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
      connection,
      jito,
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
  connection: Connection,
  jito: JitoClient | undefined,
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
  //
  // Production bug fixed here (Profit Distribution Audit, 2026-07-12): this
  // used to fetch only the single MOST RECENT SELL trade (findFirst). For a
  // position with prior partial exits (institutional mode's profit ladder —
  // see partialExitEngine.ts), that's just the final leg — comparing it
  // alone against the position's FULL original buyTrade.amountSol massively
  // understated (often to a false negative) actualNetProfitUsd, since it
  // silently dropped the SOL every earlier partial exit already returned.
  // calculatePerformanceFee clamps netProfitUsd to the smaller of gross and
  // actual, so this could wrongly zero out (or shrink) the fee — and
  // therefore the referral rewards derived from it — on a genuinely
  // profitable institutional-mode close. Fixed to sum every CONFIRMED SELL
  // trade for this wallet+token since this position opened, scoped by
  // `createdAt >= position.createdAt` so an earlier, already-closed position
  // for the same wallet+token (no Trade->Position FK exists) is never
  // double-counted. For a position with no partial exits this returns
  // exactly one row (the final sell), so the result is byte-identical to
  // the old calculation in that case.
  const [sellTrades, buyTrade] = await Promise.all([
    deps.prisma.trade.findMany({
      where: {
        walletId: position.walletId,
        tokenId: position.tokenId,
        side: 'SELL',
        status: 'CONFIRMED',
        createdAt: { gte: position.createdAt },
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
  const sellTrade = sellTrades[0]; // latest, for the ledger's own reference field only

  // The real on-chain SOL delta between the matched trades already reflects
  // actual slippage/gas (they're real fill amounts, not quotes) — the gap
  // between this and the price-based grossProfitUsd IS the trading cost.
  let actualNetProfitUsd: number | undefined;
  if (sellTrades.length > 0 && buyTrade) {
    const totalSellAmountSol = sellTrades.reduce((sum, t) => sum + t.amountSol, 0);
    const solPriceUsd = await sharedSolPriceOracle.getPriceUsd(dexScreener).catch(() => undefined);
    if (solPriceUsd !== undefined) {
      actualNetProfitUsd = (totalSellAmountSol - buyTrade.amountSol) * solPriceUsd;
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
  // Section 14 (2026-07-18): the actual credited amounts (user/L1/L2/platform)
  // now come from the fixed 80/10/5/5 split, not from feeResult's
  // performanceFeeBps-derived feeUsd/userShareUsd — calculatePerformanceFee is
  // still called above only for its real-cost reconciliation (netProfitUsd
  // clamped to the real on-chain SOL delta) and its "no fee on a loss" gate.
  // poolUsd is the fixed 20% non-user pool (never derived from
  // settings.performanceFeeBps) — used for both the PerformanceFeeLedger row
  // and the OWNER_FEE debit below, same convention as before: the full pool
  // is debited regardless of how much of it is subsequently paid to
  // referrers, so the platform's own implicit net stays `poolUsd -
  // referralPayouts` exactly as it always has.
  const distribution = calculateFixedProfitDistribution(feeResult.netProfitUsd, chain);
  const poolUsd = feeResult.netProfitUsd - distribution.userShareUsd;
  const poolBps = 10_000 - FIXED_USER_SHARE_BPS;

  // Real on-chain payout (2026-07-23): a paper-trade position never had real
  // money to move in the first place — Trade.isPaperTrade (set once, at
  // creation, by positionManager.ts) is the cleanest available signal for
  // this, requiring no new plumbing. Paper trades keep the exact pre-existing
  // behavior below (pure bookkeeping, no transfer attempted).
  const isPaperTrade = sellTrade?.isPaperTrade ?? false;
  let payoutOutcome: PayoutOutcome | undefined;
  // referrerUserId -> their resolved payout Wallet row (id + public key), so
  // ReferralReward.payoutWalletId can store the actual Wallet.id (a real FK-
  // shaped reference) rather than the raw address payoutCalculation.ts deals
  // in — that module has no DB dependency by design, so this mapping is kept
  // here instead.
  const referrerWalletById = new Map<string, { walletId: string; publicKey: string }>();
  if (!isPaperTrade) {
    const referralRewardsWithWallets: ReferrerWalletLookup[] = await Promise.all(
      distribution.referralRewards.map(async (reward) => {
        const wallet = await resolveReferrerPayoutWallet(deps.prisma, reward.referrerUserId);
        if (wallet) referrerWalletById.set(reward.referrerUserId, wallet);
        return {
          referrerUserId: reward.referrerUserId,
          level: reward.level,
          rewardUsd: reward.rewardUsd,
          payoutPublicKey: wallet?.publicKey,
        };
      }),
    );
    payoutOutcome = await executeReferralAndPlatformPayout(
      {
        prisma: deps.prisma,
        connection,
        jito,
        logger: deps.log,
        encryptionKey: deps.config.ENCRYPTION_KEY,
        treasuryAddress: deps.config.PLATFORM_TREASURY_WALLET_ADDRESS,
        minWalletReserveSol: deps.config.MIN_WALLET_RESERVE_SOL,
        staleMs: deps.config.PAYOUT_ATTEMPT_STALE_MS,
        notifier,
        getSolPriceUsd: () => sharedSolPriceOracle.getPriceUsd(dexScreener),
      },
      {
        positionId,
        walletId: position.walletId,
        walletPublicKey: position.wallet.publicKey,
        encryptedSecret: position.wallet.encryptedSecret,
        referralRewards: referralRewardsWithWallets,
        platformShareUsd: poolUsd,
      },
    );
    if (payoutOutcome.kind === 'deferred') {
      // A concurrent duplicate fire, or a stuck attempt already alerted —
      // either way, this invocation must not also write the fee ledger
      // (that would race the other in-flight attempt's own eventual write).
      return;
    }
  }
  // Real money actually moved only when isPaperTrade (nothing to move, but
  // the DEBIT/CREDIT rows are still valid bookkeeping) or the payout
  // genuinely confirmed on-chain — never on skipped/failed, since no debit
  // happened in those cases.
  const realTransferHappened = isPaperTrade || payoutOutcome?.kind === 'confirmed';
  const txSignature = payoutOutcome?.kind === 'confirmed' ? payoutOutcome.txSignature : undefined;
  const referralOutcomeByKey = new Map(
    payoutOutcome?.kind === 'confirmed'
      ? payoutOutcome.referralOutcomes.map((o) => [`${o.referrerUserId}:${o.level}`, o])
      : [],
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
          feeBps: poolBps,
          feeUsd: poolUsd,
          userShareUsd: distribution.userShareUsd,
          payoutTxSignature: txSignature,
        },
      });

      // Immutable ledger/audit trail for this close — see writeLedgerAndAudit's
      // doc comment. Both entries reference the PerformanceFeeLedger row
      // above so they can be reconciled against it. PROFIT_CREDIT never
      // needed a real transfer (the trader already holds their own share in
      // full) so it's always written; OWNER_FEE/REFERRAL_CREDIT below are
      // only written once a real debit has actually happened (paper trade,
      // or a confirmed on-chain payout) — see realTransferHappened above.
      await writeLedgerAndAudit(tx, {
        type: 'PROFIT_CREDIT',
        asset: 'USD',
        direction: 'CREDIT',
        amountUsd: distribution.userShareUsd,
        userId: position.wallet.userId,
        walletId: position.walletId,
        referenceType: 'performance_fee_ledger',
        referenceId: created.id,
        action: 'fee.profit_credited',
      });

      if (realTransferHappened) {
        await writeLedgerAndAudit(tx, {
          type: 'OWNER_FEE',
          asset: 'USD',
          direction: 'DEBIT',
          amountUsd: poolUsd,
          userId: position.wallet.userId,
          walletId: position.walletId,
          txSignature,
          referenceType: 'performance_fee_ledger',
          referenceId: created.id,
          action: 'fee.owner_fee_charged',
        });

        for (const reward of distribution.referralRewards) {
          const outcome = referralOutcomeByKey.get(`${reward.referrerUserId}:${reward.level}`);
          const referralReward = await tx.referralReward.create({
            data: {
              performanceFeeLedgerId: created.id,
              referrerUserId: reward.referrerUserId,
              referredUserId: position.wallet.userId,
              level: reward.level,
              percentBps: reward.percentBps,
              rewardUsd: reward.rewardUsd,
              payoutWalletId:
                outcome && !outcome.rolledUpToTreasury
                  ? referrerWalletById.get(reward.referrerUserId)?.walletId
                  : undefined,
              payoutTxSignature: txSignature,
              rolledUpToTreasury: outcome?.rolledUpToTreasury ?? false,
            },
          });
          // Referral credits belong to the referrer, not the trader whose
          // close triggered them — walletId is intentionally omitted (the
          // referrer's own wallet isn't a Wallet-table row this ledger entry
          // is scoped to).
          await writeLedgerAndAudit(tx, {
            type: 'REFERRAL_CREDIT',
            asset: 'USD',
            direction: 'CREDIT',
            amountUsd: reward.rewardUsd,
            userId: reward.referrerUserId,
            txSignature,
            referenceType: 'referral_reward',
            referenceId: referralReward.id,
            action: 'fee.referral_credited',
            metadata: { level: reward.level, referredUserId: position.wallet.userId },
          });
        }
      } else {
        deps.log.warn(
          { positionId, payoutOutcome },
          'real payout did not complete — PerformanceFeeLedger/PROFIT_CREDIT recorded, but OWNER_FEE/REFERRAL_CREDIT were skipped since no real debit happened',
        );
      }
      return created;
    })
    .catch((err: unknown) => {
      // Unique constraint on positionId — a concurrent duplicate fire, not a real error.
      if ((err as { code?: string }).code === 'P2002') return undefined;
      throw err;
    });
  if (!ledger) return;

  for (const reward of distribution.referralRewards) {
    await notifier?.notifyReferralEarned(reward.referrerUserId, {
      level: reward.level as 1 | 2,
      rewardUsd: reward.rewardUsd,
      sourceSymbol: position.token.symbol ?? position.token.mint.slice(0, 8),
    });
  }

  const report: TradeReportData = {
    symbol: position.token.symbol ?? position.token.mint.slice(0, 8),
    grossProfitUsd: feeResult.grossProfitUsd,
    tradingCostsUsd: feeResult.tradingCostsUsd,
    netProfitUsd: feeResult.netProfitUsd,
    feeBps: poolBps,
    feeUsd: poolUsd,
    userShareUsd: distribution.userShareUsd,
    referralRewardsTotalUsd: distribution.referralRewards.reduce((sum, r) => sum + r.rewardUsd, 0),
    referenceId: ledger.id,
  };
  await notifier?.notifyTradeReport(position.wallet.userId, report);
}

/**
 * Real on-chain payout (2026-07-23): resolves a referrer's own payout
 * wallet — "first active wallet" is the same pattern already used elsewhere
 * in this codebase (autoTrader.ts, copyTrading.ts) for "a user's own
 * wallet," with an explicit `orderBy` added here for reproducibility/
 * auditability of a real funds transfer (a small, deliberate addition, not
 * a behavior change for any referrer with a single wallet — the overwhelming
 * common case). Returns undefined when the referrer has zero active
 * wallets — the caller rolls that share into the treasury payment instead
 * of dropping it, never a hard failure.
 */
async function resolveReferrerPayoutWallet(
  prisma: PrismaClient,
  referrerUserId: string,
): Promise<{ walletId: string; publicKey: string } | undefined> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId: referrerUserId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  return wallet ? { walletId: wallet.id, publicKey: wallet.publicKey } : undefined;
}
