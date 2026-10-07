import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  getKillSwitchState,
  getOrCreateBusinessSettings,
  getScannerAutoBuyPauseReason,
  getScannerAutoBuyPauseState,
  setKillSwitchState,
  setPlatformFee,
  setReferralLevel,
  setReferralProgramEnabled,
  setScannerAutoBuyPauseState,
  setTreasuryWallet,
} from '@nova/shared';
import { requireAdminUser } from '../lib/adminAccess.js';
import { getActiveArbitrageScanner } from '../trading/arbitrageScanner.js';
import { ADMIN_FEATURES, isAdminFeatureKey } from '../lib/adminFeatureOverrides.js';
import {
  computePerformance,
  INVALID_PAPER_HOLD_MS,
  type ClosedPositionResult,
} from '../lib/performance.js';

const percentBody = z.object({ percent: z.number().min(0).max(100) });
const treasuryBody = z.object({ address: z.string().min(1).max(100) });
const flagBody = z.object({ enabled: z.boolean() });
const levelParams = z.object({ level: z.coerce.number().int().min(1).max(10) });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Admin-only endpoints behind the Mini App's Admin tab. Every write goes
 * through the same @nova/shared helpers as the bot's /admin panel, so both
 * enforce identical rules and write the same audit log entries.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAdminUser };
  const actorOf = (userId: string) => ({ userId });

  async function sendResult(reply: FastifyReply, error: string | undefined) {
    if (error) return reply.code(400).send({ error });
    return reply.send({ ok: true });
  }

  fastify.get('/admin/features', guard, async () => {
    const overrides = await fastify.prisma.adminFeatureOverride.findMany();
    const desired = new Map(overrides.map((row) => [row.key, row.enabled]));
    const effective = fastify.config as unknown as Record<string, unknown>;
    return ADMIN_FEATURES.map((feature) => ({
      key: feature.key,
      label: feature.label,
      effectiveEnabled: Boolean(effective[feature.key]),
      desiredEnabled: desired.get(feature.key) ?? Boolean(effective[feature.key]),
      restartRequired: true,
      pendingRestart:
        desired.has(feature.key) && desired.get(feature.key) !== Boolean(effective[feature.key]),
    }));
  });

  fastify.put('/admin/features/:key', guard, async (req, reply) => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(req.params);
    const { enabled } = flagBody.parse(req.body);
    if (!isAdminFeatureKey(key)) {
      return reply.code(400).send({ error: 'Feature is not admin-toggleable' });
    }
    await fastify.prisma.adminFeatureOverride.upsert({
      where: { key },
      create: { key, enabled, updatedByUserId: req.user.userId },
      update: { enabled, updatedByUserId: req.user.userId },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.feature_override',
        metadata: { key, enabled, restartRequired: true },
      },
    });
    return reply.send({ ok: true, key, desiredEnabled: enabled, restartRequired: true });
  });

  fastify.get('/admin/overview', guard, async () => {
    const prisma = fastify.prisma;
    const since24h = new Date(Date.now() - DAY_MS);
    const since10m = new Date(Date.now() - 10 * 60 * 1000);

    const [
      settings,
      killSwitch,
      autoBuyPaused,
      autoBuyPausedReason,
      users,
      newUsers24h,
      openPositions,
      trades24h,
      totalTrades,
      volume24h,
      volumeTotal,
      feeRevenue,
      referralPaid,
      activeSnipeConfigs,
      tokens10m,
      tokens24h,
    ] = await Promise.all([
      getOrCreateBusinessSettings(prisma),
      getKillSwitchState(fastify.redis),
      getScannerAutoBuyPauseState(fastify.redis),
      getScannerAutoBuyPauseReason(fastify.redis),
      prisma.user.count({ where: { telegramId: { not: null } } }),
      prisma.user.count({ where: { telegramId: { not: null }, createdAt: { gte: since24h } } }),
      prisma.position.count({ where: { status: 'OPEN' } }),
      prisma.trade.count({ where: { status: 'CONFIRMED', createdAt: { gte: since24h } } }),
      prisma.trade.count({ where: { status: 'CONFIRMED' } }),
      prisma.trade.aggregate({
        _sum: { amountSol: true },
        where: { status: 'CONFIRMED', createdAt: { gte: since24h } },
      }),
      prisma.trade.aggregate({ _sum: { amountSol: true }, where: { status: 'CONFIRMED' } }),
      prisma.performanceFeeLedger.aggregate({ _sum: { feeUsd: true } }),
      prisma.referralReward.aggregate({ _sum: { rewardUsd: true } }),
      prisma.snipeConfig.count({ where: { isActive: true, autoBuyOnLaunch: true } }),
      prisma.token.count({ where: { createdAt: { gte: since10m } } }),
      prisma.token.count({ where: { createdAt: { gte: since24h } } }),
    ]);

    const scanner = fastify.scannerHealthCoordinator?.snapshot();

    return {
      settings: {
        treasuryWalletAddress: settings.treasuryWalletAddress,
        envTreasuryWalletAddress: fastify.config.PLATFORM_TREASURY_WALLET_ADDRESS,
        performanceFeeBps: settings.performanceFeeBps,
        referralProgramEnabled: settings.referralProgramEnabled,
        referralLevels: settings.referralLevels
          .map((l) => ({ level: l.level, percentBps: l.percentBps, enabled: l.enabled }))
          .sort((a, b) => a.level - b.level),
      },
      trading: {
        mode: fastify.tradingMode ?? null,
        killSwitch,
        autoBuyPaused,
        autoBuyPausedReason: autoBuyPausedReason ?? null,
        activeSnipeConfigs,
      },
      stats: {
        users,
        newUsers24h,
        openPositions,
        trades24h,
        totalTrades,
        volumeSol24h: volume24h._sum.amountSol ?? 0,
        volumeSolTotal: volumeTotal._sum.amountSol ?? 0,
        feeRevenueUsd: feeRevenue._sum.feeUsd ?? 0,
        referralPaidUsd: referralPaid._sum.rewardUsd ?? 0,
      },
      health: {
        scannerState: scanner?.state ?? null,
        activeProvider: scanner?.activeProviderLabel ?? null,
        tokens10m,
        tokens24h,
      },
    };
  });

  fastify.put('/admin/settings/treasury', guard, async (req, reply) => {
    const { address } = treasuryBody.parse(req.body);
    return sendResult(
      reply,
      await setTreasuryWallet(fastify.prisma, actorOf(req.user.userId), address),
    );
  });

  fastify.put('/admin/settings/fee', guard, async (req, reply) => {
    const { percent } = percentBody.parse(req.body);
    const bps = Math.round(percent * 100);
    return sendResult(reply, await setPlatformFee(fastify.prisma, actorOf(req.user.userId), bps));
  });

  fastify.put('/admin/settings/referral/:level', guard, async (req, reply) => {
    const { level } = levelParams.parse(req.params);
    const { percent } = percentBody.parse(req.body);
    const bps = Math.round(percent * 100);
    return sendResult(
      reply,
      await setReferralLevel(fastify.prisma, actorOf(req.user.userId), level, bps),
    );
  });

  fastify.put('/admin/settings/referral-program', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setReferralProgramEnabled(fastify.prisma, actorOf(req.user.userId), enabled);
    return reply.send({ ok: true });
  });

  fastify.put('/admin/trading/kill-switch', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setKillSwitchState(fastify.redis, enabled);
    await fastify.prisma.auditLog.create({
      data: { userId: req.user.userId, action: 'admin.kill_switch', metadata: { active: enabled } },
    });
    fastify.log.warn({ userId: req.user.userId, active: enabled }, 'admin set the kill switch');
    return reply.send({ ok: true });
  });

  fastify.put('/admin/trading/auto-buy', guard, async (req, reply) => {
    const { enabled } = flagBody.parse(req.body);
    await setScannerAutoBuyPauseState(fastify.redis, !enabled, 'manually paused by admin');
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.auto_buy',
        metadata: { enabled },
      },
    });
    fastify.log.warn({ userId: req.user.userId, enabled }, 'admin changed auto-buy');
    return reply.send({ ok: true });
  });


  // ---------------------------------------------------------------------------
  // Full web backoffice
  // ---------------------------------------------------------------------------
  const pageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  const searchPageQuery = pageQuery.extend({
    search: z.string().trim().max(120).optional(),
  });
  const tradeListQuery = pageQuery.extend({
    mode: z.enum(['all', 'paper', 'live']).default('all'),
    status: z.enum(['all', 'PENDING', 'CONFIRMED', 'FAILED']).default('all'),
  });
  const positionListQuery = pageQuery.extend({
    mode: z.enum(['all', 'paper', 'live']).default('all'),
    status: z.enum(['all', 'OPEN', 'CLOSED']).default('all'),
  });
  const statusListQuery = pageQuery.extend({ status: z.string().max(64).optional() });
  const bulkSnipeBody = z
    .object({
      scope: z.enum(['all', 'active']).default('all'),
      isActive: z.boolean().optional(),
      autoBuyOnLaunch: z.boolean().optional(),
      buyAmountSol: z.number().positive().max(1000).optional(),
      maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
      minLiquidityUsd: z.number().min(0).max(100_000_000).optional(),
      minAiScore: z.number().min(0).max(100).optional(),
      takeProfitPercent: z.number().positive().max(10_000).nullable().optional(),
      // Hard platform loss ceiling: admin may tighten it, never loosen past 20%.
      stopLossPercent: z.number().positive().max(20).nullable().optional(),
      trailingStopPercent: z.number().positive().max(100).nullable().optional(),
      entryFilterEnabled: z.boolean().optional(),
      institutionalModeEnabled: z.boolean().optional(),
      useOpportunityScoreGate: z.boolean().optional(),
      exitStrategy: z.enum(['tp1_trailing_v1']).nullable().optional(),
    })
    .refine(
      (v) => Object.keys(v).some((k) => k !== 'scope'),
      'At least one setting must be supplied',
    );
  const userTradingBody = z.object({ enabled: z.boolean() });

  fastify.get('/admin/control-center', guard, async () => {
    const prisma = fastify.prisma;
    const since24h = new Date(Date.now() - DAY_MS);
    const [
      killSwitch,
      autoBuyPaused,
      users,
      wallets,
      activeSnipes,
      autoBuySnipes,
      copyConfigs,
      openPositions,
      closed24h,
      liveTrades24h,
      paperTrades24h,
      fees24h,
      referrals24h,
      withdrawalsPending,
      payoutsPending,
      failedPayouts,
      networkBroadcastPending,
      recentAudit,
    ] = await Promise.all([
      getKillSwitchState(fastify.redis),
      getScannerAutoBuyPauseState(fastify.redis),
      prisma.user.count(),
      prisma.wallet.count({ where: { isActive: true } }),
      prisma.snipeConfig.count({ where: { isActive: true } }),
      prisma.snipeConfig.count({ where: { isActive: true, autoBuyOnLaunch: true } }),
      prisma.copyTradeConfig.count({ where: { isActive: true } }),
      prisma.position.count({ where: { status: 'OPEN' } }),
      prisma.position.count({ where: { status: 'CLOSED', closedAt: { gte: since24h } } }),
      prisma.trade.count({
        where: { isPaperTrade: false, status: 'CONFIRMED', createdAt: { gte: since24h } },
      }),
      prisma.trade.count({
        where: { isPaperTrade: true, status: 'CONFIRMED', createdAt: { gte: since24h } },
      }),
      prisma.performanceFeeLedger.aggregate({
        where: { createdAt: { gte: since24h } },
        _sum: { feeUsd: true, netProfitUsd: true },
      }),
      prisma.referralReward.aggregate({
        where: { createdAt: { gte: since24h } },
        _sum: { rewardUsd: true },
      }),
      prisma.withdrawalRequest.count({ where: { status: 'PENDING' } }),
      prisma.payoutAttempt.count({ where: { status: { in: ['PENDING', 'SUBMITTED'] } } }),
      prisma.payoutAttempt.count({ where: { status: 'FAILED' } }),
      prisma.networkTradeBroadcast.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: { select: { email: true, telegramId: true } } },
      }),
    ]);

    const configured = (value: unknown) => Boolean(
      typeof value === 'string' ? value.trim() : value,
    );
    const config = fastify.config;
    const scanner = fastify.scannerHealthCoordinator?.snapshot() ?? null;
    const arbitrage = getActiveArbitrageScanner()?.report() ?? { enabled: false as const };

    return {
      runtime: {
        nodeEnv: config.NODE_ENV,
        tradingMode: fastify.tradingMode ?? null,
        backgroundWorkersReady: fastify.backgroundWorkersReady,
        killSwitch,
        autoBuyPaused,
        scanner,
      },
      safety: {
        maxTradeSol: config.MAX_TRADE_SOL,
        maxDailyLossUsd: config.MAX_DAILY_LOSS_USD,
        maxOpenPositions: config.MAX_OPEN_POSITIONS,
        minWalletReserveSol: config.MIN_WALLET_RESERVE_SOL,
        maxStopLossPercent: 20,
        maxBuyPriceImpactPercent: config.MAX_BUY_PRICE_IMPACT_PERCENT,
      },
      features: [
        { key: 'liveTrading', label: 'Live trading', enabled: config.LIVE_TRADING, source: 'env', restartRequired: true },
        { key: 'entryFilter', label: 'Smart entry filter', enabled: config.ENTRY_FILTER_ENABLED, source: 'env', restartRequired: true },
        { key: 'dynamicSizing', label: 'Dynamic sizing', enabled: config.DYNAMIC_SIZING_ENABLED, source: 'env', restartRequired: true },
        { key: 'partialExits', label: 'Partial exits', enabled: config.PARTIAL_EXITS_ENABLED, source: 'env', restartRequired: true },
        { key: 'bestRoute', label: 'Best route execution', enabled: config.BEST_ROUTE_EXECUTION_ENABLED, source: 'env', restartRequired: true },
        { key: 'opportunityScore', label: 'Opportunity score gate', enabled: config.OPPORTUNITY_SCORE_GATE_ENABLED, source: 'env', restartRequired: true },
        { key: 'smartMoney', label: 'Smart money analysis', enabled: config.SMART_MONEY_ANALYSIS_ENABLED, source: 'env', restartRequired: true },
        { key: 'earlyMomentum', label: 'Early momentum detection', enabled: config.EARLY_MOMENTUM_DETECTION_ENABLED, source: 'env', restartRequired: true },
        { key: 'emergencyExit', label: 'Emergency exit engine', enabled: config.EMERGENCY_EXIT_ENABLED, source: 'env', restartRequired: true },
        { key: 'exitV2', label: 'TP1 / breakeven / trailing', enabled: config.EXIT_STRATEGY_V2_ENABLED, source: 'env', restartRequired: true },
        { key: 'arbitrage', label: 'Arbitrage radar', enabled: config.ARBITRAGE_SCANNER_ENABLED, source: 'env', restartRequired: true },
        { key: 'networkTradeScanner', label: 'External network trade scanner', enabled: config.NETWORK_TRADE_SCANNER_ENABLED || config.TELEGRAM_TRADES_ONLY, source: 'env', restartRequired: true },
        { key: 'copyTrading', label: 'Copy-trade watcher', enabled: config.COPY_TRADING_EXECUTION_ENABLED, source: 'env', restartRequired: true },
        { key: 'telegramTrend', label: 'Telegram trend source', enabled: config.TELEGRAM_TREND_SOURCE_ENABLED, source: 'env', restartRequired: true },
        { key: 'depositMonitor', label: 'Deposit monitor', enabled: config.DEPOSIT_MONITOR_ENABLED, source: 'env', restartRequired: true },
      ],
      integrations: [
        { key: 'telegram', label: 'Telegram Bot', configured: configured(config.TELEGRAM_BOT_TOKEN) },
        { key: 'quicknode', label: 'QuickNode RPC', configured: configured(config.QUICKNODE_RPC_URL) },
        { key: 'helius', label: 'Helius RPC', configured: configured(config.HELIUS_API_KEY) },
        { key: 'chainstack', label: 'Chainstack RPC', configured: configured(config.CHAINSTACK_RPC_URL) },
        { key: 'jito', label: 'Jito', configured: configured(config.JITO_BLOCK_ENGINE_URL) },
        { key: 'openrouter', label: 'OpenRouter AI', configured: configured(config.OPENROUTER_API_KEY) },
        { key: 'anthropic', label: 'Anthropic AI', configured: configured(config.ANTHROPIC_API_KEY) },
        { key: 'openai', label: 'OpenAI', configured: configured(config.OPENAI_API_KEY) },
        { key: 'ollama', label: 'Ollama', configured: configured(config.OLLAMA_HOST) },
        { key: 'twitter', label: 'X / Twitter', configured: configured(config.TWITTER_BEARER_TOKEN) },
      ],
      counters: {
        users,
        activeWallets: wallets,
        activeSnipes,
        autoBuySnipes,
        activeCopyConfigs: copyConfigs,
        openPositions,
        closedPositions24h: closed24h,
        liveTrades24h,
        paperTrades24h,
        withdrawalsPending,
        payoutsPending,
        failedPayouts,
        networkBroadcastPending,
      },
      profit: {
        netProfitUsd24h: fees24h._sum.netProfitUsd ?? 0,
        platformFeeUsd24h: fees24h._sum.feeUsd ?? 0,
        referralRewardsUsd24h: referrals24h._sum.rewardUsd ?? 0,
      },
      arbitrage,
      recentAudit: recentAudit.map((row) => ({
        id: row.id,
        action: row.action,
        status: row.status,
        createdAt: row.createdAt,
        actor: row.user?.email ?? row.user?.telegramId ?? row.userId,
      })),
    };
  });

  fastify.get('/admin/users', guard, async (req) => {
    const { limit, offset, search } = searchPageQuery.parse(req.query);
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { telegramId: { contains: search } },
            { referralCode: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      fastify.prisma.user.count({ where }),
      fastify.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          email: true,
          telegramId: true,
          role: true,
          planKey: true,
          planExpiresAt: true,
          telegramActive: true,
          isSuspended: true,
          suspendedAt: true,
          suspensionReason: true,
          deletedAt: true,
          createdAt: true,
          _count: { select: { wallets: true, snipeConfigs: true, copyConfigs: true } },
        },
      }),
    ]);
    return { total, rows };
  });

  fastify.put('/admin/users/:id/trading', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { enabled } = userTradingBody.parse(req.body);
    const exists = await fastify.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'User not found' });
    const changed = await fastify.prisma.snipeConfig.updateMany({
      where: { userId: id },
      data: { isActive: enabled },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.user_trading',
        metadata: { targetUserId: id, enabled, changed: changed.count },
      },
    });
    return { ok: true, changed: changed.count };
  });

  fastify.put('/admin/snipes/bulk', guard, async (req) => {
    const body = bulkSnipeBody.parse(req.body);
    const { scope, ...data } = body;
    const result = await fastify.prisma.snipeConfig.updateMany({
      where: scope === 'active' ? { isActive: true } : {},
      data,
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.snipes_bulk_update',
        metadata: { scope, changed: result.count, fields: Object.keys(data) },
      },
    });
    return { ok: true, changed: result.count };
  });

  fastify.get('/admin/trades', guard, async (req) => {
    const { limit, offset, mode, status } = tradeListQuery.parse(req.query);
    const where = {
      ...(mode === 'paper' ? { isPaperTrade: true } : mode === 'live' ? { isPaperTrade: false } : {}),
      ...(status === 'all' ? {} : { status }),
    };
    const [total, rows] = await Promise.all([
      fastify.prisma.trade.count({ where }),
      fastify.prisma.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          token: { select: { mint: true, symbol: true, name: true, dex: true } },
          wallet: {
            select: {
              publicKey: true,
              user: { select: { id: true, email: true, telegramId: true } },
            },
          },
        },
      }),
    ]);
    return { total, rows };
  });

  fastify.get('/admin/positions', guard, async (req) => {
    const { limit, offset, mode, status } = positionListQuery.parse(req.query);
    const where = {
      ...(mode === 'paper' ? { isPaperTrade: true } : mode === 'live' ? { isPaperTrade: false } : {}),
      ...(status === 'all' ? {} : { status }),
    };
    const [total, rows] = await Promise.all([
      fastify.prisma.position.count({ where }),
      fastify.prisma.position.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          token: { select: { mint: true, symbol: true, name: true, dex: true } },
          wallet: {
            select: {
              publicKey: true,
              user: { select: { id: true, email: true, telegramId: true } },
            },
          },
        },
      }),
    ]);
    return { total, rows };
  });

  fastify.get('/admin/audit', guard, async (req) => {
    const { limit, offset } = pageQuery.parse(req.query);
    const [total, rows] = await Promise.all([
      fastify.prisma.auditLog.count(),
      fastify.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { user: { select: { email: true, telegramId: true } } },
      }),
    ]);
    return { total, rows };
  });

  fastify.get('/admin/withdrawals', guard, async (req) => {
    const { limit, offset, status } = statusListQuery.parse(req.query);
    const where = status ? { status: status as never } : {};
    const [total, rows] = await Promise.all([
      fastify.prisma.withdrawalRequest.count({ where }),
      fastify.prisma.withdrawalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);
    return { total, rows };
  });

  fastify.get('/admin/payouts', guard, async (req) => {
    const { limit, offset, status } = statusListQuery.parse(req.query);
    const where = status ? { status: status as never } : {};
    const [total, rows] = await Promise.all([
      fastify.prisma.payoutAttempt.count({ where }),
      fastify.prisma.payoutAttempt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);
    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        treasuryLamports: row.treasuryLamports.toString(),
        totalLamports: row.totalLamports.toString(),
        estimatedFeeLamports: row.estimatedFeeLamports.toString(),
      })),
    };
  });

  fastify.put('/admin/copy-trades/:id', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { enabled } = flagBody.parse(req.body);
    const existing = await fastify.prisma.copyTradeConfig.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Copy trade config not found' });
    await fastify.prisma.copyTradeConfig.update({
      where: { id },
      data: { isActive: enabled },
    });
    await fastify.prisma.auditLog.create({
      data: {
        userId: req.user.userId,
        action: 'admin.copy_trade_toggle',
        metadata: { configId: id, targetUserId: existing.userId, enabled },
      },
    });
    return reply.send({ ok: true, enabled });
  });

  fastify.get('/admin/copy-trades', guard, async (req) => {
    const { limit, offset } = pageQuery.parse(req.query);
    const [total, rows] = await Promise.all([
      fastify.prisma.copyTradeConfig.count(),
      fastify.prisma.copyTradeConfig.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { user: { select: { email: true, telegramId: true } } },
      }),
    ]);
    return { total, rows };
  });

  const performanceQuery = z.object({
    mode: z.enum(['paper', 'live']).default('paper'),
    days: z.coerce.number().int().min(1).max(365).default(30),
  });

  fastify.get('/admin/performance', guard, async (req) => {
    const { mode, days } = performanceQuery.parse(req.query);
    const since = new Date(Date.now() - days * DAY_MS);
    const positions = await fastify.prisma.position.findMany({
      where: { status: 'CLOSED', isPaperTrade: mode === 'paper', closedAt: { gte: since } },
      include: { token: { select: { dex: true } } },
      orderBy: { closedAt: 'desc' },
      take: 1000,
    });
    if (positions.length === 0)
      return { mode, days, excludedInvalid: 0, ...computePerformance([]) };

    const sells = await fastify.prisma.trade.findMany({
      where: {
        side: 'SELL',
        status: 'CONFIRMED',
        walletId: { in: [...new Set(positions.map((p) => p.walletId))] },
        tokenId: { in: [...new Set(positions.map((p) => p.tokenId))] },
        createdAt: { gte: new Date(Math.min(...positions.map((p) => p.createdAt.getTime()))) },
      },
      select: { walletId: true, tokenId: true, amountSol: true, createdAt: true },
    });

    let excludedInvalid = 0;
    const rows: ClosedPositionResult[] = [];
    for (const p of positions) {
      const closedAt = p.closedAt ?? p.createdAt;
      const holdMs = closedAt.getTime() - p.createdAt.getTime();
      if (p.isPaperTrade && holdMs < INVALID_PAPER_HOLD_MS && p.exitReason === 'stop_loss') {
        excludedInvalid++;
        continue;
      }
      // A position's sells land between its open and a little after its close.
      const windowEnd = closedAt.getTime() + 2 * 60_000;
      const returnedSol = sells
        .filter(
          (t) =>
            t.walletId === p.walletId &&
            t.tokenId === p.tokenId &&
            t.createdAt.getTime() >= p.createdAt.getTime() &&
            t.createdAt.getTime() <= windowEnd,
        )
        .reduce((sum, t) => sum + t.amountSol, 0);
      rows.push({
        investedSol: p.amountSolInvested,
        returnedSol,
        exitReason: p.exitReason,
        dex: p.token.dex,
        holdMs,
      });
    }
    return { mode, days, excludedInvalid, ...computePerformance(rows) };
  });
}
