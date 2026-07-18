import type { Connection } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import { getConnection } from './solana/connection.js';

declare module 'fastify' {
  interface FastifyInstance {
    solanaConnection?: Connection;
    // Exposed so routes (positions.ts's manual sell/partial-sell/emergency-sell
    // actions) can call the existing, already-tested PositionManager methods
    // directly — same instance the background PriceMonitor/AutoTrader use, not
    // a second one. Only set once background workers actually start (mirrors
    // solanaConnection's own optionality above), so routes must check for it.
    positionManager?: PositionManager;
    dexScreener?: DexScreenerClient;
    // 2026-07-15 Helius credit audit: exposed so /metrics/rpc can report
    // "last successful event received from each discovery source" — same
    // instance the background detection pipeline feeds, not a second one.
    sourceHealthMonitor?: SourceHealthMonitor;
  }
}
import { PumpFunMonitor } from './solana/pumpfun.js';
import { JupiterClient } from './solana/jupiter.js';
import { DexScreenerClient } from './solana/dexscreener.js';
import { TokenEventClassifier } from './detection/detectors.js';
import { RiskAnalyzer, type LaunchableDex } from './detection/riskAnalyzer.js';
import { extractMintFromParsedTx } from './detection/extractMint.js';
import { MigrationMonitor } from './detection/migrationMonitor.js';
import { DexRegistry } from './solana/dex/registry.js';
import { PumpSwapExecutor } from './solana/dex/pumpswapExecutor.js';
import { SourceHealthMonitor } from './detection/sourceHealthMonitor.js';
import { JitoClient } from './solana/jito.js';
import { PositionManager } from './trading/positionManager.js';
import { AutoTrader } from './trading/autoTrader.js';
import { TradingSafety, verifySafetySystemReady, type SafetyConfig } from './trading/safety.js';
import { PriceMonitor } from './trading/priceMonitor.js';
import { EmergencyExitMonitor } from './trading/emergencyExitMonitor.js';
import { DepositMonitor } from './wallet/depositMonitor.js';
import { hasAnyAiProvider, resolveAiProvider, scoreToken } from '@nova/ai';
import type { Dex, RiskFlags } from '@nova/shared';
import { createBot, NotificationService, AI_HIGH_SCORE_THRESHOLD } from '@nova/telegram-bot';
import { eventBus } from './lib/eventBus.js';
import { metrics } from './lib/metrics.js';
import { TtlCache } from './lib/ttlCache.js';
import { evaluateHardRiskGate, evaluateNotifyGate } from './notify/notifyGate.js';
import { TwitterClient } from './social/twitter.js';
import { TwitterMonitor } from './social/twitterMonitor.js';
import { TelegramTrendClient } from './social/telegramTrend.js';
import {
  TelegramTrendMonitor,
  type TelegramSignalCandidate,
} from './social/telegramTrendMonitor.js';

/**
 * Wires the detection -> risk -> AI-score -> auto-trade pipeline together and
 * starts the pump.fun log subscription. Returns a stop function for graceful
 * shutdown. Safe to run without AI keys configured (falls back to rule-based
 * score only) — it is NOT safe to run without a Solana RPC endpoint, so that
 * is the one hard requirement here.
 */
export async function startBackgroundWorkers(app: FastifyInstance) {
  const connection = getConnection(
    {
      rpcUrl: app.config.SOLANA_RPC_URL,
      wsUrl: app.config.SOLANA_WS_URL,
      heliusApiKey: app.config.HELIUS_API_KEY,
      quicknodeRpcUrl: app.config.QUICKNODE_RPC_URL,
      quicknodeWsUrl: app.config.QUICKNODE_WS_URL,
      chainstackRpcUrl: app.config.CHAINSTACK_RPC_URL,
      additionalRpcUrls: app.config.ADDITIONAL_RPC_URLS,
    },
    app.log as never,
  );
  // Exposed for the /health/ready check — decorating here (before app.listen(),
  // see server.ts) rather than via a plugin since the connection only exists once
  // background workers actually start (not guaranteed — see this function's own
  // doc comment on being the one hard requirement).
  if (!app.hasDecorator('solanaConnection')) {
    app.decorate('solanaConnection', connection);
  }

  const dexScreener = new DexScreenerClient(app.config.DEXSCREENER_API_BASE);
  const jupiter = new JupiterClient({ apiBase: app.config.JUPITER_API_BASE });
  // Stage 2 latency optimization (2026-07-14) — fire-and-forget, never
  // delays startup or the caller; see JupiterClient.warmConnection's doc
  // comment.
  void jupiter.warmConnection();
  const dexRegistry = new DexRegistry(connection, dexScreener, app.log as never, {
    PUMPSWAP: new PumpSwapExecutor(),
  });
  // No-ops (undefined) when unset, same convention as every other optional
  // integration in this codebase — sends just go direct, never blocked on Jito.
  const jito = app.config.JITO_BLOCK_ENGINE_URL
    ? new JitoClient({ blockEngineUrl: app.config.JITO_BLOCK_ENGINE_URL })
    : undefined;
  if (!jito) {
    app.log.warn('JITO_BLOCK_ENGINE_URL not set — sends go direct, no Jito bundle protection');
  }
  const riskAnalyzer = new RiskAnalyzer(
    connection,
    dexScreener,
    jupiter,
    app.log as never,
    dexRegistry,
  );

  const safetyConfig: SafetyConfig = {
    maxTradeSol: app.config.MAX_TRADE_SOL,
    maxDailyLossUsd: app.config.MAX_DAILY_LOSS_USD,
    maxOpenPositions: app.config.MAX_OPEN_POSITIONS,
    minWalletReserveSol: app.config.MIN_WALLET_RESERVE_SOL,
    killSwitchEnv: app.config.KILL_SWITCH,
  };
  const safety = new TradingSafety(
    app.prisma,
    app.redis,
    connection,
    safetyConfig,
    app.log as never,
  );

  // The one hard safety switch: real swaps only ever fire when LIVE_TRADING is
  // explicitly "true" AND the safety system verifiably works. Everything else
  // (unset, "false", a broken safety net) keeps every auto-buy as a simulated
  // fill — no wallet key is ever unsealed.
  let paperTrading = true;
  if (app.config.LIVE_TRADING) {
    const readiness = await verifySafetySystemReady(safetyConfig, app.redis);
    if (readiness.ready) {
      paperTrading = false;
    } else {
      app.log.error(
        { errors: readiness.errors },
        '🔴 LIVE_TRADING=true was requested but the safety system is not ready — forcing PAPER TRADING instead',
      );
    }
  }
  app.log.warn(
    paperTrading
      ? '📝 PAPER TRADING mode — auto-buys are simulated, no real swaps or wallet keys used'
      : '🔴 LIVE TRADING mode — auto-buys will execute real on-chain swaps',
  );

  // NotificationService itself now fans every sniper alert type (trade/exit/new-token)
  // out to the owner chat plus every user with a live SnipeConfig — see
  // apps/telegram-bot/src/notifications.ts. Nothing else in this file needs to know
  // about per-user delivery; every existing notifier?.notifyX(...) call site already
  // gets it for free.
  let notifier: NotificationService | undefined;
  if (app.config.TELEGRAM_BOT_TOKEN && app.config.TELEGRAM_CHAT_ID) {
    const telegramBot = createBot(app.config.TELEGRAM_BOT_TOKEN, app.log as never);
    notifier = new NotificationService(
      telegramBot,
      app.config.TELEGRAM_CHAT_ID,
      app.prisma,
      app.log as never,
    );
  } else {
    app.log.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — trade notifications disabled');
  }

  const positionManager = new PositionManager(
    app.prisma,
    connection,
    jupiter,
    dexScreener,
    app.log as never,
    safety,
    notifier,
    paperTrading,
    dexRegistry,
    jito,
    app.config.MAX_PRIORITY_FEE_LAMPORTS,
  );
  if (!app.hasDecorator('positionManager')) {
    app.decorate('positionManager', positionManager);
  }
  if (!app.hasDecorator('dexScreener')) {
    app.decorate('dexScreener', dexScreener);
  }
  const autoTrader = new AutoTrader({
    prisma: app.prisma,
    riskAnalyzer,
    positionManager,
    logger: app.log as never,
    encryptionKey: app.config.ENCRYPTION_KEY,
    entryFilterGloballyEnabled: app.config.ENTRY_FILTER_ENABLED,
  });

  // Drives TP/SL/trailing-stop: without this loop those fields are just stored
  // numbers with nothing evaluating them against the live price.
  const priceMonitor = new PriceMonitor({
    prisma: app.prisma,
    dexScreener,
    positionManager,
    logger: app.log as never,
    encryptionKey: app.config.ENCRYPTION_KEY,
    jupiter,
    dexRegistry,
  });
  priceMonitor.start(app.config.PRICE_CHECK_INTERVAL_MS);

  // Institutional Mode's safety net — force-closes an OPEN institutional-mode
  // position on a detected liquidity-removal/rug signal, independent of that
  // position's own TP/SL/trailing-stop. Currently a no-op even when enabled:
  // institutional mode has no wiring on the position-open side of this
  // codebase yet (PositionManager's institutionalModeGloballyEnabled always
  // resolves false below), so no position ever has institutionalModeEnabled
  // set for this monitor's query to find. Ported and wired now so it's ready
  // the moment that wiring lands, rather than left as another orphaned
  // subsystem — see emergencyExitMonitor.ts's own doc comment.
  let emergencyExitMonitor: EmergencyExitMonitor | undefined;
  if (app.config.EMERGENCY_EXIT_ENABLED) {
    emergencyExitMonitor = new EmergencyExitMonitor({
      prisma: app.prisma,
      connection,
      dexScreener,
      jupiter,
      riskAnalyzer,
      positionManager,
      logger: app.log as never,
      encryptionKey: app.config.ENCRYPTION_KEY,
      notifier,
    });
    emergencyExitMonitor.start(app.config.EMERGENCY_EXIT_CHECK_INTERVAL_MS);
  } else {
    app.log.warn(
      'EMERGENCY_EXIT_ENABLED not set — no rug-signal safety net for institutional positions (currently moot: institutional mode has no open-side wiring yet either)',
    );
  }

  // Detects pump.fun -> PumpSwap/Raydium/Orca/Meteora migration via the bonding
  // curve's own `complete` flag (ground truth, not log-guessing — see
  // migrationMonitor.ts) and retargets Token.dex/poolAddress automatically.
  // PriceMonitor/RiskAnalyzer need no changes to "follow" a migrated token: both
  // already re-resolve liquidity/price fresh from the mint on every call.
  const migrationMonitor = new MigrationMonitor({
    prisma: app.prisma,
    connection,
    dexScreener,
    logger: app.log as never,
    notifier,
  });
  migrationMonitor.start(app.config.MIGRATION_CHECK_INTERVAL_MS);

  // Polls every active wallet's live balance and records deposits — see
  // wallet/depositMonitor.ts's doc comment. Independent on/off switch from
  // every trading-related monitor above; deposits are core wallet
  // functionality, not a staged/experimental feature, so this defaults on.
  let depositMonitor: DepositMonitor | undefined;
  if (app.config.DEPOSIT_MONITOR_ENABLED) {
    depositMonitor = new DepositMonitor({
      prisma: app.prisma,
      connection,
      logger: app.log as never,
    });
    depositMonitor.start(app.config.DEPOSIT_MONITOR_INTERVAL_MS);
  } else {
    app.log.warn('DEPOSIT_MONITOR_ENABLED not set — wallet deposits will not be auto-detected');
  }

  // dexRegistry (constructed above, alongside riskAnalyzer) also drives
  // PumpSwap/Raydium(CPMM)/Orca(Whirlpool)/Meteora(DLMM) pool-creation scanners,
  // run in parallel alongside the pump.fun monitor below (all independent onLogs
  // websocket subscriptions on the shared connection). A new pool for a mint we've
  // never seen is a genuine direct launch on that DEX; a new pool for a mint we
  // already track as PUMPFUN is a migration signal, handled the same way as the
  // pump.fun-side hint.
  const classifier = new TokenEventClassifier(app.log as never);
  const monitor = new PumpFunMonitor(connection, app.log as never);

  const aiEnabled = hasAnyAiProvider({
    anthropicApiKey: app.config.ANTHROPIC_API_KEY,
    openaiApiKey: app.config.OPENAI_API_KEY,
  });
  const aiProvider = aiEnabled
    ? resolveAiProvider({
        anthropicApiKey: app.config.ANTHROPIC_API_KEY,
        openaiApiKey: app.config.OPENAI_API_KEY,
      })
    : undefined;

  if (!aiEnabled) {
    app.log.warn('No ANTHROPIC_API_KEY/OPENAI_API_KEY set — AI scoring disabled, rule-based only');
  }

  let twitterMonitor: TwitterMonitor | undefined;
  if (app.config.TWITTER_BEARER_TOKEN) {
    const twitterClient = new TwitterClient({ bearerToken: app.config.TWITTER_BEARER_TOKEN });
    twitterMonitor = new TwitterMonitor(
      twitterClient,
      app.config.TWITTER_SEARCH_QUERY,
      app.config.TWITTER_POLL_INTERVAL_MS,
      app.log as never,
    );
    twitterMonitor.start(async (tweet) => {
      eventBus.publish('social.mention', { tweetId: tweet.id, text: tweet.text });
      await notifier?.notifySocialMention(tweet.text, tweet.id);
    });
  } else {
    app.log.warn('TWITTER_BEARER_TOKEN not set — Twitter/X monitor disabled');
  }

  // Shared by every detection source (pump.fun create, or a brand-new pool on
  // PumpSwap/Raydium/Orca/Meteora for a mint we've never seen) so risk analysis,
  // AI scoring, notification, and auto-trading behave identically regardless of
  // which DEX a token actually launched on.
  async function handleNewTokenLaunch(
    mint: string,
    dex: LaunchableDex,
    detectedAt: string,
    poolAddress?: string,
  ) {
    // Pipeline checkpoint: Scanner reached. Every detection source (pump.fun's own
    // monitor and dexRegistry.startAll's per-DEX pool-creation watchers) funnels
    // through this one function, so this line firing confirms a scanner actually
    // produced a launch event for this mint, before any filtering happens.
    app.log.debug({ mint, dex, poolAddress }, 'Scanner: handleNewTokenLaunch reached');
    // Latency Optimization Stage 1 (2026-07-14): first pipeline-stage
    // timestamp — see latencyTracker.ts. Captured here rather than at the
    // scanner callback that invoked this function, since this is the one
    // place every detection source (on-chain and Telegram-trend) converges.
    const tokenDetectedAt = Date.now();
    const riskFlags = await riskAnalyzer.analyze({ mint, dex, poolAddress });

    const token = await app.prisma.token.upsert({
      where: { mint },
      create: {
        mint,
        dex,
        poolAddress,
        name: riskFlags.name,
        symbol: riskFlags.symbol,
        liquidityUsd: riskFlags.liquidityUsd,
        marketCapUsd: riskFlags.marketCapUsd,
        mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
        freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
        lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
        top10HolderPercent: riskFlags.top10HolderPercent,
        holderCount: riskFlags.holderCount,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        imageUrl: riskFlags.imageUrl,
      },
      update: {
        name: riskFlags.name,
        symbol: riskFlags.symbol,
        liquidityUsd: riskFlags.liquidityUsd,
        marketCapUsd: riskFlags.marketCapUsd,
        top10HolderPercent: riskFlags.top10HolderPercent,
        holderCount: riskFlags.holderCount,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        imageUrl: riskFlags.imageUrl,
      },
    });

    eventBus.publish('token.created', { tokenId: token.id, mint, dex });

    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
    let aiScoreValue = ruleScore;

    // Skip the paid AI provider call when the token already fails the hard
    // risk gate (liquidity/honeypot/freeze/mint/LP) — no AI score can change
    // that outcome (see notifyGate.ts's evaluateNotifyGate: it's additive on
    // top of these, never a rescue), so there's no reason to spend on a
    // verdict that can't affect whether this token gets notified about.
    const hardGatePassed = evaluateHardRiskGate(riskFlags, {
      minLiquidityUsd: app.config.NOTIFY_MIN_LIQUIDITY_USD,
    }).allowed;

    let aiScoringStartAt: number | undefined;
    let aiScoringEndAt: number | undefined;
    // 2026-07-15 Telegram alert audit: distinct from aiScoreValue itself —
    // aiScoreValue always holds a number (falls back to ruleScore when no AI
    // provider is configured), so a caller can't tell from that alone whether
    // it's a real AI verdict or a rule-based approximation. Threaded through
    // to notifyAndAutoTrade so alert text never mislabels a rule score as an
    // "AI Score" (found live: ANTHROPIC_API_KEY/OPENAI_API_KEY both blank in
    // the running process, so every alert since was silently doing this).
    let usedRealAi = false;
    if (aiProvider && hardGatePassed) {
      aiScoringStartAt = Date.now();
      const aiScore = await scoreToken(
        aiProvider,
        { mint, decimals: 9, createdAt: detectedAt, dex: dex.toLowerCase() as Dex },
        riskFlags,
      );
      aiScoringEndAt = Date.now();
      aiScoreValue = aiScore.score;
      usedRealAi = true;
      await app.prisma.token.update({
        where: { id: token.id },
        data: { aiScore: aiScore.score, aiSummary: aiScore.summary },
      });
    }

    await notifyAndAutoTrade(mint, dex, token.id, riskFlags, aiScoreValue, usedRealAi, {
      tokenDetectedAt,
      aiScoringStartAt,
      aiScoringEndAt,
    });
  }

  /**
   * Shared by every detection source (on-chain + the Telegram trend source):
   * gates the New Launch / AI High Score alerts behind the notify gate
   * (notifyGate.ts — liquidity, honeypot, freeze authority, mint risk, LP
   * lock, and AI/rule score, ALL must pass) and evaluates every active
   * SnipeConfig for an auto-buy. The notify gate never affects auto-buying —
   * AutoTrader.evaluateAndMaybeBuy always runs, exactly as before; it has its
   * own independent, per-user, already-correct gates for that decision. This
   * is the one place a "New Launch" alert can be produced, so gating here
   * closes the bug for both detection sources at once, regardless of what
   * upstream shortcuts either path already takes.
   */
  async function notifyAndAutoTrade(
    mint: string,
    dex: LaunchableDex,
    tokenId: string,
    riskFlags: RiskFlags,
    aiScoreValue: number,
    // 2026-07-15 Telegram alert audit: true only when aiScoreValue came from a
    // real AI provider call, false when it's the ruleScore fallback (no AI
    // provider configured, or the token failed the hard gate before AI would've
    // been called) — see formatNewTokenMessage/formatAiHighScoreMessage, which
    // label the score accordingly instead of always claiming "AI Score".
    usedRealAi: boolean,
    pipelineTimestamps?: {
      tokenDetectedAt?: number;
      aiScoringStartAt?: number;
      aiScoringEndAt?: number;
    },
  ): Promise<{ boughtCount: number }> {
    const notifyGate = evaluateNotifyGate(
      {
        liquidityUsd: riskFlags.liquidityUsd,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
        mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
        lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
        aiScore: aiScoreValue,
      },
      {
        minLiquidityUsd: app.config.NOTIFY_MIN_LIQUIDITY_USD,
        minAiScore: app.config.NOTIFY_MIN_AI_SCORE,
      },
    );

    if (notifyGate.allowed) {
      metrics.increment('launchNotificationsSent');
      // NotificationService.notifyNewToken fans this out to the owner chat plus every
      // user with a live snipe config (isActive + autoBuyOnLaunch — the exact set
      // AutoTrader.evaluateAndMaybeBuy is about to query below) — see notifications.ts.
      await notifier?.notifyNewToken({
        mint,
        dex,
        name: riskFlags.name,
        symbol: riskFlags.symbol,
        liquidityUsd: riskFlags.liquidityUsd,
        marketCapUsd: riskFlags.marketCapUsd,
        aiScore: aiScoreValue,
        isAiScore: usedRealAi,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
        freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
        lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
        top10HolderPercent: riskFlags.top10HolderPercent,
        priceChangeH1: riskFlags.priceChangeH1,
      });

      // Distinct alert type, in addition to the New Launch alert above — only for
      // the top slice of launches (see AI_HIGH_SCORE_THRESHOLD's own doc comment).
      if (aiScoreValue >= AI_HIGH_SCORE_THRESHOLD) {
        await notifier?.notifyAiHighScore({
          mint,
          dex,
          name: riskFlags.name,
          symbol: riskFlags.symbol,
          aiScore: aiScoreValue,
          isAiScore: usedRealAi,
          liquidityUsd: riskFlags.liquidityUsd,
        });
      }
    } else {
      metrics.increment('launchNotificationsSuppressed');
      app.log.debug(
        { mint, dex, reasons: notifyGate.reasons },
        'Notify Gate: rejected — no Telegram notification sent',
      );
    }

    const results = await autoTrader.evaluateAndMaybeBuy(
      mint,
      tokenId,
      riskFlags,
      aiScoreValue,
      pipelineTimestamps,
    );
    return { boughtCount: results.filter((r) => r.bought).length };
  }

  // Telegram trend channels (t.me/trendingssol, t.me/trending) are a signal
  // source only — they never buy directly. A mint mentioned there is just a
  // candidate that must clear its own dedupe/blacklist/liquidity/AI gates
  // (all RPC/AI-free or cheap, in that order, so junk is rejected before any
  // expensive work) before it reaches the exact same upsert/notify/AutoTrader
  // path as an on-chain detection. AutoTrader's own per-user SnipeConfig gating
  // (isActive + autoBuyOnLaunch) is completely unchanged — this only adds one
  // more way for a mint to arrive at that same gate.
  const telegramDedupeCache = new TtlCache<string>(10 * 60 * 1000);
  const telegramAiCooldownCache = new TtlCache<string>(5 * 60 * 1000);

  async function handleTelegramSignal(candidate: TelegramSignalCandidate): Promise<void> {
    const { mint, channel, messageUrl } = candidate;
    // Latency Optimization Stage 1 (2026-07-14) — see handleNewTokenLaunch's
    // identical tokenDetectedAt capture above; this is the Telegram-trend
    // source's own convergence point.
    const tokenDetectedAt = Date.now();

    if (telegramDedupeCache.has(mint) || telegramAiCooldownCache.has(mint)) {
      metrics.increment('duplicateRejected');
      app.log.debug(
        { mint, channel },
        'Duplicate Check: recently processed via Telegram — skipping',
      );
      return;
    }

    const existing = await app.prisma.token.findUnique({ where: { mint } });
    telegramDedupeCache.add(mint);
    if (existing) {
      metrics.increment('duplicateRejected');
      app.log.debug({ mint, channel }, 'Duplicate Check: token already tracked — skipping');
      return;
    }

    const blacklisted = await app.prisma.blacklistEntry.findUnique({
      where: { type_value: { type: 'MINT', value: mint } },
    });
    if (blacklisted) {
      metrics.increment('blacklistRejected');
      app.log.debug(
        { mint, channel, reason: blacklisted.reason },
        'Blacklist: mint is blacklisted — skipping',
      );
      return;
    }

    // Cheap Filters / Liquidity Filter: DexScreener HTTP call, at most one cheap
    // getAccountInfo RPC read — never the mint-authority/holder-concentration
    // calls analyze() makes, and never an AI call, for a candidate that turns
    // out to have no real liquidity on a supported venue.
    const cheapLiquidity = await riskAnalyzer.cheapLiquidityPrecheck(mint);
    if (cheapLiquidity.liquidityUsd <= 0 || !cheapLiquidity.dex) {
      metrics.increment('liquidityZeroRejected');
      metrics.increment('rpcCallsSavedEstimate', 2);
      app.log.debug(
        { mint, channel },
        'Liquidity Filter: liquidity == 0 or unsupported venue — skipping before AI/expensive RPC',
      );
      return;
    }

    const riskFlags = await riskAnalyzer.analyze({
      mint,
      dex: cheapLiquidity.dex,
      poolAddress: cheapLiquidity.poolAddress,
    });
    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);

    // AI Filter, part 1: min(ruleScore, aiScore) can never exceed ruleScore, so if
    // the rule score alone is already below this source's minimum, no AI score can
    // rescue it — skip the AI provider call entirely rather than paying for a
    // verdict that cannot change the outcome. Reject before ever creating a Token
    // row, publishing to the Launch Feed, or notifying. 5-minute cooldown so a
    // channel repeating the same low-quality mint doesn't re-run this every tick.
    if (ruleScore < app.config.TELEGRAM_TREND_MIN_AI_SCORE) {
      metrics.increment('aiRejected');
      telegramAiCooldownCache.add(mint);
      app.log.debug(
        { mint, channel, ruleScore },
        'AI Filter: rule score alone already below minimum — skipping AI call entirely, 5 min cooldown',
      );
      return;
    }

    let aiScoreValue = ruleScore;
    let aiSummary: string | undefined;
    let aiScoringStartAt: number | undefined;
    let aiScoringEndAt: number | undefined;
    let usedRealAi = false;
    if (aiProvider) {
      aiScoringStartAt = Date.now();
      const aiScore = await scoreToken(
        aiProvider,
        {
          mint,
          decimals: 9,
          createdAt: new Date().toISOString(),
          dex: cheapLiquidity.dex.toLowerCase() as Dex,
        },
        riskFlags,
      );
      aiScoringEndAt = Date.now();
      aiScoreValue = aiScore.score;
      aiSummary = aiScore.summary;
      usedRealAi = true;
    }

    // AI Filter, part 2: the AI score itself (when a provider is configured) can
    // still drag the combined score below threshold even though ruleScore alone
    // passed above.
    if (Math.min(ruleScore, aiScoreValue) < app.config.TELEGRAM_TREND_MIN_AI_SCORE) {
      metrics.increment('aiRejected');
      telegramAiCooldownCache.add(mint);
      app.log.debug(
        { mint, channel, ruleScore, aiScoreValue },
        'AI Filter: combined score below Telegram-source minimum — skipping, 5 min cooldown',
      );
      return;
    }

    metrics.increment('qualifiedOpportunities');

    const token = await app.prisma.token.upsert({
      where: { mint },
      create: {
        mint,
        dex: cheapLiquidity.dex,
        poolAddress: cheapLiquidity.poolAddress,
        name: riskFlags.name,
        symbol: riskFlags.symbol,
        liquidityUsd: riskFlags.liquidityUsd,
        marketCapUsd: riskFlags.marketCapUsd,
        mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
        freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
        lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
        top10HolderPercent: riskFlags.top10HolderPercent,
        holderCount: riskFlags.holderCount,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        imageUrl: riskFlags.imageUrl,
        aiScore: aiScoreValue,
        aiSummary,
        discoverySource: 'TELEGRAM',
        telegramChannel: channel,
        telegramMessageUrl: messageUrl,
      },
      update: {
        name: riskFlags.name,
        symbol: riskFlags.symbol,
        liquidityUsd: riskFlags.liquidityUsd,
        marketCapUsd: riskFlags.marketCapUsd,
        top10HolderPercent: riskFlags.top10HolderPercent,
        holderCount: riskFlags.holderCount,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        imageUrl: riskFlags.imageUrl,
        aiScore: aiScoreValue,
        aiSummary,
      },
    });

    eventBus.publish('token.created', { tokenId: token.id, mint, dex: cheapLiquidity.dex });

    const { boughtCount } = await notifyAndAutoTrade(
      mint,
      cheapLiquidity.dex,
      token.id,
      riskFlags,
      aiScoreValue,
      usedRealAi,
      { tokenDetectedAt, aiScoringStartAt, aiScoringEndAt },
    );
    metrics.increment('executedTrades', boughtCount);
  }

  let telegramTrendMonitor: TelegramTrendMonitor | undefined;
  if (app.config.TELEGRAM_TREND_SOURCE_ENABLED) {
    const telegramTrendClient = new TelegramTrendClient();
    const telegramTrendChannels = app.config.TELEGRAM_TREND_CHANNELS.split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    telegramTrendMonitor = new TelegramTrendMonitor(
      telegramTrendClient,
      telegramTrendChannels,
      app.config.TELEGRAM_TREND_POLL_INTERVAL_MS,
      app.log as never,
    );
    telegramTrendMonitor.start(async (candidate) => {
      try {
        await handleTelegramSignal(candidate);
      } catch (err) {
        app.log.error(
          { err, mint: candidate.mint, channel: candidate.channel },
          'failed to process telegram trend signal',
        );
      }
    });
  } else {
    app.log.warn('TELEGRAM_TREND_SOURCE_ENABLED not set — Telegram trend channel monitor disabled');
  }

  // Discovery source health: alerts if any on-chain source goes silent for
  // 30+ minutes. Fed from raw program traffic, not qualifying "new token"
  // discoveries — Orca/Raydium/Meteora routinely go well past 30 minutes
  // between real launches even when fully healthy (see the 2026-07-14
  // production audit), so gating on discovery count would false-alarm
  // constantly on those; a live program still emits swap/other traffic
  // continuously, so raw traffic is what actually distinguishes "quiet
  // market" from "dead subscription." Pump.fun's own onEvent below fires on
  // every raw log; PumpSwap/Raydium/Orca/Meteora are fed the same way via
  // DexRegistry's `onRawActivity` callback (see dexRegistry.startAll below)
  // instead of a second, independent onLogs subscription per DEX program —
  // 2026-07-15 Helius credit audit: that second subscription doubled WS
  // registration and full raw-log delivery volume for all 4 DEX programs
  // (Meteora alone: ~100+ events/sec) purely to get a signal DexRegistry's
  // own subscription already receives; onRawActivity taps the same
  // subscription before its pool-creation filter, so liveness tracking is
  // unchanged, just no longer duplicated at the WS layer.
  const sourceHealthMonitor = new SourceHealthMonitor(
    ['PUMPFUN', 'PUMPSWAP', 'RAYDIUM', 'ORCA', 'METEORA'],
    30 * 60 * 1000,
    app.log as never,
    async ({ source, silentForMs }) => {
      const minutes = Math.round(silentForMs / 60_000);
      await notifier?.notifyError(
        'Discovery source health',
        `${source} has produced no on-chain activity for ${minutes} minutes — websocket/RPC may be down.`,
      );
    },
  );
  sourceHealthMonitor.start();
  app.decorate('sourceHealthMonitor', sourceHealthMonitor);

  monitor.start(async (event) => {
    sourceHealthMonitor.recordActivity('PUMPFUN');
    const detection = classifier.classify(event);
    if (!detection) return;

    if (detection.kind === 'migration') {
      // Best-effort fast path only (see migrationMonitor.ts on why this log hint
      // isn't authoritative) — extract the mint and, if it's a token we're
      // already tracking as PUMPFUN, check it immediately instead of waiting for
      // the next poll tick. The periodic poll is the reliable backstop.
      try {
        const tx = await connection.getParsedTransaction(event.signature, {
          maxSupportedTransactionVersion: 0,
        });
        const mint = tx ? extractMintFromParsedTx(tx) : undefined;
        if (!mint) return;
        const token = await app.prisma.token.findUnique({ where: { mint } });
        if (token && token.dex === 'PUMPFUN') {
          await migrationMonitor.checkOne(token.id, mint);
        }
      } catch (err) {
        app.log.debug({ err, signature: event.signature }, 'migration hint check failed');
      }
      return;
    }

    if (detection.kind !== 'new_token') return;

    try {
      const tx = await connection.getParsedTransaction(event.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return;
      const mint = extractMintFromParsedTx(tx);
      if (!mint) {
        app.log.warn(
          { signature: event.signature },
          'could not confidently resolve the mint for a detected pump.fun create — skipping rather than guessing',
        );
        return;
      }
      // Same guard the DEX-registry path below already has: connection.onLogs can
      // redeliver the same signature on reconnect/resubscribe, which would
      // otherwise re-run the full pipeline (RPC calls, AI scoring cost, a second
      // Telegram alert, and — before TradingSafety's own duplicate-position check
      // — a real risk of a second live buy for a mint already tracked).
      const existing = await app.prisma.token.findUnique({ where: { mint } });
      if (existing) {
        app.log.debug({ mint }, 'token already tracked — skipping duplicate pump.fun launch event');
        return;
      }
      await handleNewTokenLaunch(mint, 'PUMPFUN', event.detectedAt);
    } catch (err) {
      app.log.error({ err, signature: event.signature }, 'failed to process launch event');
    }
  });

  // PumpSwap/Raydium/Orca/Meteora: a new pool for a mint we've never tracked is a
  // direct launch on that DEX; a new pool for a mint already tracked as PUMPFUN is
  // the migration signal, same handling as the pump.fun-side hint above.
  dexRegistry.startAll(
    async (event) => {
      try {
        const tx = await connection.getParsedTransaction(event.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) return;
        const pool = await dexRegistry.resolveNewPool(event.dex, tx);
        if (!pool) return;

        const existing = await app.prisma.token.findUnique({ where: { mint: pool.baseMint } });
        if (existing?.dex === 'PUMPFUN') {
          await migrationMonitor.checkOne(existing.id, pool.baseMint);
          return;
        }
        if (existing) return;

        await handleNewTokenLaunch(pool.baseMint, event.dex, event.detectedAt, pool.poolAddress);
      } catch (err) {
        app.log.error(
          { err, signature: event.signature, dex: event.dex },
          'failed to process DEX launch event',
        );
      }
    },
    (dex) => sourceHealthMonitor.recordActivity(dex),
  );

  return async () => {
    await monitor.stop();
    twitterMonitor?.stop();
    telegramTrendMonitor?.stop();
    priceMonitor.stop();
    emergencyExitMonitor?.stop();
    migrationMonitor.stop();
    depositMonitor?.stop();
    sourceHealthMonitor.stop();
    await dexRegistry.stopAll();
  };
}
