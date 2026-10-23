import type { FastifyInstance } from 'fastify';
import { KILL_SWITCH_REDIS_KEY, SCANNER_AUTOBUY_PAUSE_REDIS_KEY } from '@nova/shared';
import { fetchGmgnSmartMoney } from '../integrations/gmgn.js';
import { loadRankedCopyWallets, COPY_RECOMMENDATION_POLICY } from '../trading/copyWalletRanking.js';
import { copyBuyReadiness } from '../trading/copyExecutionReadiness.js';

export function publicWalletScore(wallet: {
  confidenceScore: number | null;
  sybilConfidencePct: number | null;
  rugExposureRatePct: number | null;
}): number {
  const confidence = Math.max(0, Math.min(100, wallet.confidenceScore ?? 0));
  const sybilPenalty = Math.max(0, Math.min(100, wallet.sybilConfidencePct ?? 0));
  const rugPenalty = Math.max(0, Math.min(100, wallet.rugExposureRatePct ?? 0));
  return Math.max(0, Math.round(confidence * (1 - sybilPenalty / 100) * (1 - rugPenalty / 100)));
}

export default async function publicCopyTradingRoutes(fastify: FastifyInstance) {
  const RANKED_WALLET_CACHE_TTL_MS = 60_000;
  let rankedWalletCache:
    { expiresAt: number; value: Awaited<ReturnType<typeof loadRankedCopyWallets>> } | undefined;
  let rankedWalletLoad: Promise<Awaited<ReturnType<typeof loadRankedCopyWallets>>> | undefined;

  async function getRankedWallets() {
    if (rankedWalletCache && rankedWalletCache.expiresAt > Date.now()) {
      return rankedWalletCache.value;
    }
    if (!rankedWalletLoad) {
      rankedWalletLoad = loadRankedCopyWallets(fastify.prisma)
        .then((value) => {
          rankedWalletCache = { value, expiresAt: Date.now() + RANKED_WALLET_CACHE_TTL_MS };
          return value;
        })
        .finally(() => {
          rankedWalletLoad = undefined;
        });
    }
    return rankedWalletLoad;
  }

  async function readStops(): Promise<Array<string | null> | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fastify.redis.mget(KILL_SWITCH_REDIS_KEY, SCANNER_AUTOBUY_PAUSE_REDIS_KEY),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  fastify.get(
    '/public/copy-trading',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');

      const localWallets = await getRankedWallets();

      const gmgnApiKey = fastify.config.GMGN_API_KEY?.trim();
      let gmgn:
        | { status: 'not_configured'; trades: []; wallets: [] }
        | {
            status: 'connected';
            trades: Awaited<ReturnType<typeof fetchGmgnSmartMoney>>;
            wallets: Array<{
              address: string;
              trades: number;
              volumeUsd: number;
              buys: number;
              sells: number;
              tags: string[];
            }>;
          }
        | { status: 'unavailable'; trades: []; wallets: []; reason: string };

      if (!gmgnApiKey) {
        gmgn = { status: 'not_configured', trades: [], wallets: [] };
      } else {
        try {
          const trades = await fetchGmgnSmartMoney(gmgnApiKey, 50);
          const byMaker = new Map<
            string,
            {
              address: string;
              trades: number;
              volumeUsd: number;
              buys: number;
              sells: number;
              tags: Set<string>;
            }
          >();
          for (const trade of trades) {
            const current = byMaker.get(trade.maker) ?? {
              address: trade.maker,
              trades: 0,
              volumeUsd: 0,
              buys: 0,
              sells: 0,
              tags: new Set<string>(),
            };
            current.trades += 1;
            current.volumeUsd += trade.amountUsd ?? 0;
            if (trade.side === 'buy') current.buys += 1;
            if (trade.side === 'sell') current.sells += 1;
            for (const tag of trade.tags) current.tags.add(tag);
            byMaker.set(trade.maker, current);
          }
          const wallets = [...byMaker.values()]
            .map((wallet) => ({ ...wallet, tags: [...wallet.tags].slice(0, 8) }))
            .sort((a, b) => b.volumeUsd - a.volumeUsd || b.trades - a.trades)
            .slice(0, 30);
          gmgn = { status: 'connected', trades, wallets };
        } catch (error) {
          gmgn = {
            status: 'unavailable',
            trades: [],
            wallets: [],
            reason: error instanceof Error ? error.message : 'GMGN data unavailable',
          };
        }
      }

      const watcher = fastify.copyTradeWatcher?.getStatus();
      const watcherReady = watcher?.healthy === true;
      const executionMode = !watcher?.running
        ? 'disabled'
        : fastify.tradingMode === 'LIVE'
          ? 'live'
          : 'paper';
      const readiness = copyBuyReadiness({
        enabled: fastify.config.COPY_TRADING_EXECUTION_ENABLED === true,
        mode: fastify.tradingMode,
        workersReady: fastify.backgroundWorkersReady === true,
        watcher,
        scanner: fastify.scannerHealthCoordinator?.snapshot(),
        envKillSwitch: fastify.config.KILL_SWITCH === true,
        stops: await readStops(),
      });

      return {
        chain: 'solana',
        mode: 'buy_and_proportional_sell_mirror_independent_exits',
        watcher: watcher ?? null,
        recommendationPolicy: COPY_RECOMMENDATION_POLICY,
        recommendations: localWallets.filter((w) => w.recommendation.eligible).slice(0, 3),
        limits: {
          maxBuySol: fastify.config.COPY_TRADING_MAX_BUY_SOL,
          maxDailyBuys: fastify.config.COPY_TRADING_MAX_DAILY_BUYS,
          maxOpenPositions: fastify.config.COPY_TRADING_MAX_OPEN_POSITIONS,
          slippageBps: fastify.config.COPY_TRADING_SLIPPAGE_BPS,
        },
        copyConfigEnabled: true,
        copyWatcherReady: watcherReady,
        executionMode,
        liveExecutionEnabled: executionMode === 'live',
        buyReadiness: { ...readiness, checkedAt: Date.now() },
        updatedAt: Date.now(),
        localWallets,
        gmgn,
      };
    },
  );
}
