import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
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
import { PumpFunMonitor, type PumpFunLaunchEvent } from './solana/pumpfun.js';
import { JupiterClient } from './solana/jupiter.js';
import { DexScreenerClient } from './solana/dexscreener.js';
import { TokenEventClassifier } from './detection/detectors.js';
import { RiskAnalyzer, isFastPathCandidate, type LaunchableDex } from './detection/riskAnalyzer.js';
import { extractMintFromParsedTx } from './detection/extractMint.js';
import { MigrationMonitor } from './detection/migrationMonitor.js';
import { DexRegistry } from './solana/dex/registry.js';
import { PumpSwapExecutor } from './solana/dex/pumpswapExecutor.js';
import type { DexLaunchEvent } from './solana/dex/types.js';
import { SourceHealthMonitor } from './detection/sourceHealthMonitor.js';
import { JitoClient } from './solana/jito.js';
import { PositionManager } from './trading/positionManager.js';
import { AutoTrader } from './trading/autoTrader.js';
import { TradingSafety, verifySafetySystemReady, type SafetyConfig } from './trading/safety.js';
import { PriceMonitor } from './trading/priceMonitor.js';
import { EmergencyExitMonitor } from './trading/emergencyExitMonitor.js';
import { DepositMonitor } from './wallet/depositMonitor.js';
import { runCandidatePipeline, type CandidatePipelineDeps } from './detection/candidatePipeline.js';
import { PriorityConcurrencyQueue } from './lib/priorityQueue.js';
import { SmartWalletTrackerService } from './trading/smartWalletTracker.js';
import { EarlyMomentumDetectorService } from './trading/earlyMomentumDetector.js';
import {
  evaluateSmartMoneyAndMomentum,
  type SmartMoneyMomentumResult,
} from './trading/smartMoneyMomentumEvaluator.js';
import { recordShadowDecision } from './trading/shadowModeEvaluator.js';
import { ShadowModePriceSampler } from './trading/shadowModePriceSampler.js';
import {
  hasAnyAiProvider,
  resolveAiProvider,
  resolveGeminiProvider,
  resolveOpenRouterProvider,
  scoreToken,
  evaluateMultiLlmConsensus,
} from '@nova/ai';
import type { AiScore, Dex, RiskFlags } from '@nova/shared';
import {
  calculateOpportunityScore,
  getOrCreateBusinessSettings,
  getTelegramTrendEnabled,
} from '@nova/shared';
import { createBot, NotificationService, AI_HIGH_SCORE_THRESHOLD } from '@nova/telegram-bot';
import { eventBus } from './lib/eventBus.js';
import { metrics } from './lib/metrics.js';
import { TtlCache } from './lib/ttlCache.js';
import { evaluateNotifyGate } from './notify/notifyGate.js';
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
    opportunityScoreGateGloballyEnabled: app.config.OPPORTUNITY_SCORE_GATE_ENABLED,
    notifier,
  });

  // Smart Money + Early Pump Detection (Sections 3-4, 2026-07-22): shadow-mode
  // only — see smartMoneyMomentumEvaluator.ts's doc comment. Both master
  // switches default false; SHADOW_MODE_ENABLED (default true) is the pure
  // logging layer's own switch, independent of whether either scoring engine
  // is actually on (score fields are simply null in the log if not).
  const smartWalletTracker = new SmartWalletTrackerService({
    prisma: app.prisma,
    connection,
    logger: app.log as never,
  });
  const earlyMomentumDetector = new EarlyMomentumDetectorService({
    dexScreener,
    logger: app.log as never,
  });
  const smartMoneyMomentumDeps = {
    smartWalletTracker,
    earlyMomentumDetector,
    logger: app.log as never,
    smartMoneyEnabled: app.config.SMART_MONEY_ANALYSIS_ENABLED,
    momentumEnabled: app.config.EARLY_MOMENTUM_DETECTION_ENABLED,
  };
  app.log.info(
    {
      smartMoneyAnalysisEnabled: app.config.SMART_MONEY_ANALYSIS_ENABLED,
      earlyMomentumDetectionEnabled: app.config.EARLY_MOMENTUM_DETECTION_ENABLED,
      shadowModeEnabled: app.config.SHADOW_MODE_ENABLED,
    },
    'Smart Money + Early Pump Detection: shadow-mode status',
  );
  // Fire-and-forget evaluations are stashed here by mint, keyed to the exact
  // Promise (not a resolved value) so processAiCall can await it with a
  // bounded wait without ever having awaited it itself on the fast path — see
  // maybeStartSmartMoneyMomentumEvaluation/processAiCall below. Read-once:
  // deleted on the same tick it's consumed.
  const smartMoneyMomentumPromises = new Map<string, Promise<SmartMoneyMomentumResult>>();
  const SMART_MONEY_MOMENTUM_WAIT_MS = 1_500;

  function maybeStartSmartMoneyMomentumEvaluation(mint: string, tokenId: string): void {
    if (!app.config.SMART_MONEY_ANALYSIS_ENABLED && !app.config.EARLY_MOMENTUM_DETECTION_ENABLED)
      return;
    // Never awaited here — this is exactly what keeps this stage off the fast
    // path (token_detected -> aiQueue.enqueue). processAiCall reads the
    // result later with its own bounded wait.
    smartMoneyMomentumPromises.set(
      mint,
      evaluateSmartMoneyAndMomentum(smartMoneyMomentumDeps, { mint, tokenId }),
    );
  }

  // Shadow-mode price sampling — independent of priceMonitor.ts (scoped to
  // OPEN positions only). See shadowModePriceSampler.ts's doc comment.
  let shadowModePriceSampler: ShadowModePriceSampler | undefined;
  if (app.config.SHADOW_MODE_ENABLED) {
    shadowModePriceSampler = new ShadowModePriceSampler({
      prisma: app.prisma,
      dexScreener,
      logger: app.log as never,
    });
    shadowModePriceSampler.start();
  }

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
    connection,
    notifier,
    staleReminderIntervalMs: app.config.STALE_POSITION_REMINDER_INTERVAL_MS,
    manualReviewAfterMs: app.config.STALE_POSITION_MANUAL_REVIEW_AFTER_MS,
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

  // Multi-LLM consensus (2026-07-22): bypasses resolveAiProvider's single-pick
  // priority chain entirely — consensus mode needs Gemini AND OpenRouter
  // specifically, not "whichever one that function would prefer." See
  // packages/ai/src/consensus.ts and this file's processAiCall below.
  const geminiProvider = resolveGeminiProvider({ geminiApiKey: app.config.GEMINI_API_KEY });
  const openRouterProvider = resolveOpenRouterProvider({
    openrouterApiKey: app.config.OPENROUTER_API_KEY,
    openrouterModel: app.config.OPENROUTER_MODEL,
  });
  const consensusModeActive = Boolean(geminiProvider && openRouterProvider);

  // Single-provider fallback (today's pre-existing behavior) — used only when
  // consensus mode isn't available (e.g. an Anthropic/OpenAI key is set, or
  // only one of Gemini/OpenRouter is configured).
  const aiEnabled = hasAnyAiProvider({
    anthropicApiKey: app.config.ANTHROPIC_API_KEY,
    openaiApiKey: app.config.OPENAI_API_KEY,
    geminiApiKey: app.config.GEMINI_API_KEY,
  });
  const aiProvider =
    aiEnabled && !consensusModeActive
      ? resolveAiProvider({
          anthropicApiKey: app.config.ANTHROPIC_API_KEY,
          openaiApiKey: app.config.OPENAI_API_KEY,
          geminiApiKey: app.config.GEMINI_API_KEY,
        })
      : undefined;

  // Status lines only — never the key itself, only presence/model name.
  app.log.info(geminiProvider ? 'Gemini: ACTIVE' : 'Gemini: NOT CONFIGURED');
  if (openRouterProvider) {
    app.log.info({ model: app.config.OPENROUTER_MODEL }, 'OpenRouter: ACTIVE');
  } else {
    app.log.info('OpenRouter: NOT CONFIGURED');
  }
  if (consensusModeActive) {
    app.log.info('Multi-LLM Consensus: ACTIVE');
  } else {
    app.log.warn('Multi-LLM Consensus: INACTIVE (requires both Gemini and OpenRouter configured)');
  }
  if (!aiEnabled && !consensusModeActive) {
    app.log.warn(
      'No ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY set — AI scoring disabled, rule-based only',
    );
  } else if (aiProvider) {
    // Provider name only — never the key itself.
    app.log.info({ aiProvider: aiProvider.name }, 'AI scoring enabled (single-provider)');
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

  // Shared by every detection source (pump.fun create, a brand-new pool on
  // PumpSwap/Raydium/Orca/Meteora, or the Telegram-trend source) so the
  // Token row's core metadata is recorded identically regardless of where a
  // candidate came from or whether it ultimately passes the mandatory gate.
  // `extra` carries fields only ever set at creation time (Telegram source
  // tagging) — never touched on the `update` branch, matching this
  // function's pre-refactor behavior exactly.
  async function upsertTokenRow(
    mint: string,
    dex: LaunchableDex,
    poolAddress: string | undefined,
    riskFlags: RiskFlags,
    extra?: { discoverySource: 'TELEGRAM'; telegramChannel: string; telegramMessageUrl?: string },
  ) {
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
        ...extra,
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
    return token;
  }

  /**
   * Shared by every detection source: computes + persists the Final
   * Opportunity Score (Section 7, 2026-07-18) and evaluates the notify gate
   * (notifyGate.ts — liquidity, honeypot, freeze authority, mint risk, LP
   * lock, and AI/rule score, ALL must pass) for the "New Launch"/"AI High
   * Score" Telegram alerts. Runs for EVERY token that reaches this point —
   * including one candidatePipeline.ts already rejected — so a token that
   * never becomes a Position still leaves a durable record of why it scored
   * what it did. Never touches AutoTrader — that only ever runs for a
   * candidate that has already passed candidatePipeline (see
   * runCandidateThroughPipeline/processAiCall below), never from here.
   */
  async function recordOpportunityScoreAndNotify(
    tokenId: string,
    mint: string,
    dex: LaunchableDex,
    riskFlags: RiskFlags,
    aiScoreValue: number,
    // True only when aiScoreValue came from a real AI provider call, false
    // when it's the ruleScore fallback (no AI provider configured, or the
    // candidate never reached the AI stage at all) — see
    // formatNewTokenMessage/formatAiHighScoreMessage, which label the score
    // accordingly instead of always claiming "AI Score".
    usedRealAi: boolean,
    // Smart Money + Early Pump Detection (Sections 3-4, 2026-07-22): purely
    // additive plug points calculateOpportunityScore was already built to
    // accept — undefined for a failed candidate (momentum/wallet analysis
    // never runs there) or when the relevant engine is disabled. Stays inert
    // on finalScore while BusinessSettings.momentumWeightBps/walletWeightBps
    // remain at their default of 0.
    momentumWalletScores?: { momentumScore?: number; walletScore?: number },
  ) {
    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
    const businessSettings = await getOrCreateBusinessSettings(app.prisma);
    const opportunityScore = calculateOpportunityScore(
      {
        safetyScore: ruleScore,
        aiScore: usedRealAi ? aiScoreValue : undefined,
        momentumScore: momentumWalletScores?.momentumScore,
        walletScore: momentumWalletScores?.walletScore,
      },
      businessSettings,
    );
    await app.prisma.opportunityScoreLog.create({
      data: {
        tokenId,
        mint,
        safetyScore: opportunityScore.breakdown.safetyScore,
        momentumScore: opportunityScore.breakdown.momentumScore,
        walletScore: opportunityScore.breakdown.walletScore,
        socialScore: opportunityScore.breakdown.socialScore,
        aiScore: opportunityScore.breakdown.aiScore,
        finalScore: opportunityScore.finalScore,
        // Prisma's Json input type wants a plain index-signature object, not
        // the named OpportunityScoreWeights interface — round-tripping
        // through JSON is the simplest way to satisfy that structurally.
        weightsSnapshot: JSON.parse(JSON.stringify(opportunityScore.weightsUsed)),
      },
    });

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
      // AutoTrader.evaluateAndMaybeBuy queries, when it runs at all) — see notifications.ts.
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

    return opportunityScore;
  }

  interface AiQueueItem {
    mint: string;
    dex: LaunchableDex;
    tokenId: string;
    riskFlags: RiskFlags;
    pipelineTimestamps: {
      tokenDetectedAt: number;
      analysisStartedAt: number;
      dexValidatedAt: number;
      safetyCompletedAt: number;
      sellabilityVerifiedAt: number;
    };
    /** Telegram-source-specific post-AI quality gate (pre-existing
     * cost-avoidance design — see handleTelegramSignal below). undefined for
     * on-chain candidates, which have no equivalent extra filter. */
    telegramPostAiGate?: { minScore: number; channel: string };
  }

  /**
   * Two-stage discovery pipeline (2026-07-22): the one place the AI provider
   * is ever called from, for BOTH on-chain and Telegram-sourced candidates —
   * routed through `aiQueue` (see below) so concurrent AI-provider calls stay
   * bounded and a momentum-flagged (FAST_PATH) candidate can jump ahead of
   * ordinary ones waiting for theirs. By the time an item reaches here,
   * candidatePipeline.ts has already unconditionally passed it — this
   * function only ever calls AutoTrader for a candidate that already cleared
   * every mandatory deterministic check.
   */
  async function processAiCall(item: AiQueueItem): Promise<void> {
    const { mint, dex, tokenId, riskFlags, pipelineTimestamps } = item;
    const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
    let aiScoreValue = ruleScore;
    let usedRealAi = false;
    let aiScoringStartAt: number | undefined;
    let aiScoringEndAt: number | undefined;
    // Only set in consensus mode — used for the consensus gate below, after
    // the Opportunity Score is known.
    let geminiResult: AiScore | undefined;
    let openRouterResult: AiScore | undefined;

    // Smart Money + Early Pump Detection (Sections 3-4, 2026-07-22): consumed
    // (read + deleted) here, at the top, so the map entry is always cleaned
    // up regardless of which branch below returns early — but not actually
    // awaited until just before recordOpportunityScoreAndNotify, so it
    // resolves concurrently with the AI-scoring call below rather than
    // adding its own latency on top.
    const pendingSmartMoneyMomentum = smartMoneyMomentumPromises.get(mint);
    smartMoneyMomentumPromises.delete(mint);
    const smartMoneyMomentumSettled: Promise<SmartMoneyMomentumResult | undefined> =
      pendingSmartMoneyMomentum
        ? Promise.race([
            pendingSmartMoneyMomentum,
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), SMART_MONEY_MOMENTUM_WAIT_MS),
            ),
          ])
        : Promise.resolve(undefined);

    const tokenInfo = {
      mint,
      decimals: 9,
      createdAt: new Date(pipelineTimestamps.tokenDetectedAt).toISOString(),
      dex: dex.toLowerCase() as Dex,
    };

    if (consensusModeActive) {
      // Multi-LLM consensus (2026-07-22): genuinely parallel — neither call
      // waits on the other. A hard failure on either side is handled purely
      // by scoreToken's own existing fail-closed contract (score 0, decision
      // SKIP, flagged) — see evaluateMultiLlmConsensus, which is what
      // actually enforces "either fails -> SKIP" once the Opportunity Score
      // is known below.
      aiScoringStartAt = Date.now();
      [geminiResult, openRouterResult] = await Promise.all([
        scoreToken(geminiProvider!, tokenInfo, riskFlags),
        scoreToken(openRouterProvider!, tokenInfo, riskFlags),
      ]);
      aiScoringEndAt = Date.now();
      // Conservative combination — same Math.min convention already used for
      // ruleScore vs. a single AI score elsewhere in this codebase.
      aiScoreValue = Math.min(geminiResult.score, openRouterResult.score);
      usedRealAi = true;
      app.log.info(
        {
          mint,
          gemini: { score: geminiResult.score, decision: geminiResult.decision },
          openrouter: { score: openRouterResult.score, decision: openRouterResult.decision },
        },
        'Multi-LLM consensus scoring complete',
      );
      await app.prisma.token.update({
        where: { id: tokenId },
        data: {
          aiScore: aiScoreValue,
          aiSummary: `gemini: ${geminiResult.summary} | openrouter: ${openRouterResult.summary}`,
        },
      });
    } else if (aiProvider) {
      aiScoringStartAt = Date.now();
      const aiScore = await scoreToken(aiProvider, tokenInfo, riskFlags);
      aiScoringEndAt = Date.now();
      aiScoreValue = aiScore.score;
      usedRealAi = true;
      app.log.info(
        {
          mint,
          aiProvider: aiScore.provider,
          aiScore: aiScore.score,
          riskLevel: aiScore.riskLevel,
          decision: aiScore.decision,
        },
        'AI analysis complete',
      );
      await app.prisma.token.update({
        where: { id: tokenId },
        data: { aiScore: aiScore.score, aiSummary: aiScore.summary },
      });
    }

    // Telegram-source-only: a combined score below this source's own bar
    // still skips entirely (no opportunity-score record, no notify, no
    // AutoTrader) — same cost-avoidance rationale as the pre-AI ruleScore
    // filter in handleTelegramSignal, just evaluated once the real AI score
    // (if any) is known.
    if (
      item.telegramPostAiGate &&
      Math.min(ruleScore, aiScoreValue) < item.telegramPostAiGate.minScore
    ) {
      metrics.increment('aiRejected');
      telegramAiCooldownCache.add(mint);
      app.log.debug(
        { mint, channel: item.telegramPostAiGate.channel, ruleScore, aiScoreValue },
        'AI Filter: combined score below Telegram-source minimum — skipping, 5 min cooldown',
      );
      return;
    }
    if (item.telegramPostAiGate) {
      metrics.increment('qualifiedOpportunities');
    }

    const decisionAt = Date.now();
    const smartMoneyMomentum = await smartMoneyMomentumSettled;
    const opportunityScore = await recordOpportunityScoreAndNotify(
      tokenId,
      mint,
      dex,
      riskFlags,
      aiScoreValue,
      usedRealAi,
      {
        momentumScore: smartMoneyMomentum?.earlyMomentumScore,
        walletScore: smartMoneyMomentum?.smartMoneyScore,
      },
    );

    // Shadow-mode logging (Sections 3-4, 2026-07-22): exactly one row per
    // token that reaches this point (i.e. already passed the critical
    // security gate — see candidatePipeline.ts) — never for a rejected
    // candidate, since this function only runs from processAiCall. Purely
    // observational: decideShadowVerdict's output is only ever logged here,
    // never fed to autoTrader.evaluateAndMaybeBuy below.
    if (app.config.SHADOW_MODE_ENABLED) {
      await recordShadowDecision(
        { prisma: app.prisma, logger: app.log as never },
        {
          tokenId,
          mint,
          safetyScore: ruleScore,
          aiScore: usedRealAi ? aiScoreValue : undefined,
          smartMoneyScore: smartMoneyMomentum?.smartMoneyScore,
          earlyMomentumScore: smartMoneyMomentum?.earlyMomentumScore,
          opportunityScore: opportunityScore.finalScore,
          smartMoneyClusterBuy: smartMoneyMomentum?.smartMoneyClusterBuy ?? false,
          clusterWalletCount: smartMoneyMomentum?.clusterWalletCount,
          sybilDiscountApplied: smartMoneyMomentum?.sybilDiscountApplied ?? false,
          momentumBreakdown: smartMoneyMomentum?.momentumBreakdown,
          priceAtDetectionUsd: smartMoneyMomentum?.priceUsd,
        },
      );
    }

    // Multi-LLM consensus gate (2026-07-22): the mandatory, unconditional
    // check that both models must agree BUY and both score >=80 — evaluated
    // once per token, strictly before AutoTrader, exactly like
    // candidatePipeline.ts's own gates upstream of this function. Never
    // loosens anything: critical security checks (candidatePipeline.ts)
    // already ran, unconditionally, before this candidate ever reached the
    // AI stage at all. Does NOT gate on Opportunity Score (2026-07-22 audit
    // — see evaluateMultiLlmConsensus's own doc comment): that's
    // autoTrader.ts's opt-in job, per config, downstream.
    if (consensusModeActive && geminiResult && openRouterResult) {
      const consensus = evaluateMultiLlmConsensus(geminiResult, openRouterResult);
      if (consensus.decision !== 'BUY') {
        app.log.warn(
          {
            mint,
            decision: consensus.decision,
            reasons: consensus.reasons,
            geminiScore: geminiResult.score,
            openrouterScore: openRouterResult.score,
            opportunityScore: opportunityScore.finalScore,
            location: 'apps/api/src/worker.ts:processAiCall (multi-LLM consensus)',
          },
          `BUY CANCELLED — MULTI-LLM CONSENSUS\nDecision:\n${consensus.decision}\nReasons:\n${consensus.reasons.join(', ')}`,
        );
        await notifier?.notifyError(
          'multi-LLM consensus',
          `Auto-buy blocked for ${mint}: ${consensus.decision} (${consensus.reasons.join(', ')})`,
        );
        return;
      }
    }

    const results = await autoTrader.evaluateAndMaybeBuy(
      mint,
      tokenId,
      riskFlags,
      aiScoreValue,
      { ...pipelineTimestamps, aiScoringStartAt, aiScoringEndAt, decisionAt },
      opportunityScore.finalScore,
    );
    metrics.increment('executedTrades', results.filter((r) => r.bought).length);
  }

  const aiQueue = new PriorityConcurrencyQueue<AiQueueItem>(
    app.config.AI_QUEUE_CONCURRENCY,
    processAiCall,
    (err, item) => app.log.error({ err, mint: item.mint }, 'processAiCall failed'),
  );

  const candidatePipelineDeps: CandidatePipelineDeps = {
    riskAnalyzer,
    jupiter,
    prisma: app.prisma,
    logger: app.log as never,
    notifier,
  };

  /**
   * Shared by every on-chain detection source (pump.fun create, or a
   * brand-new pool on PumpSwap/Raydium/Orca/Meteora for a mint we've never
   * seen): runs candidatePipeline.ts's mandatory checks, upserts the Token
   * row regardless of outcome (preserves the existing mint-dedupe guarantee
   * against a re-delivered WS event), and — only on a pass — queues the
   * candidate for AI scoring with FAST_PATH priority when its momentum
   * clears the configured thresholds.
   */
  async function runCandidateThroughPipeline(
    mint: string,
    dex: LaunchableDex,
    tokenDetectedAt: number,
    poolAddress: string | undefined,
    deployerAddress: string | undefined,
  ): Promise<void> {
    const result = await runCandidatePipeline(candidatePipelineDeps, {
      mint,
      dex,
      poolAddress,
      deployerAddress,
    });

    if (!result.riskFlags) {
      // riskAnalyzer.analyze() itself threw — candidatePipeline already
      // logged it; nothing here to upsert or score.
      return;
    }

    const token = await upsertTokenRow(mint, dex, poolAddress, result.riskFlags);

    if (!result.passed) {
      // Still leaves a durable, rule-score-only record of why this token
      // scored what it did (Section 7's original intent) — but never queues
      // for AI or reaches AutoTrader; the mandatory gate has already spoken.
      await recordOpportunityScoreAndNotify(
        token.id,
        mint,
        dex,
        result.riskFlags,
        RiskAnalyzer.ruleBasedScore(result.riskFlags),
        false,
      );
      return;
    }

    const fastPath = isFastPathCandidate(result.riskFlags, {
      minRecentBuys: app.config.FAST_PATH_MIN_RECENT_BUYS,
      minRecentVolumeUsd: app.config.FAST_PATH_MIN_RECENT_VOLUME_USD,
    });
    // Structurally unreachable for a failed candidate — the `!result.passed`
    // branch above already returned. Fire-and-forget, never awaited: see
    // maybeStartSmartMoneyMomentumEvaluation's own doc comment.
    maybeStartSmartMoneyMomentumEvaluation(mint, token.id);
    aiQueue.enqueue(
      {
        mint,
        dex,
        tokenId: token.id,
        riskFlags: result.riskFlags,
        pipelineTimestamps: { tokenDetectedAt, ...result.timestamps },
      },
      fastPath ? 'FAST_PATH' : 'NORMAL',
    );
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
    // Latency Optimization Stage 1 (2026-07-14) — see
    // runCandidateThroughPipeline's identical tokenDetectedAt capture above;
    // this is the Telegram-trend source's own convergence point.
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

    // Two-stage discovery pipeline (2026-07-22): the same mandatory,
    // fail-closed checks every on-chain candidate goes through — Telegram is
    // a signal source only, never a direct path to a buy, so it must clear
    // exactly the same bar. No creation tx exists for a bare Telegram mint
    // mention, so deployerAddress is omitted (pass-through, not a skip — see
    // candidatePipeline.ts's CandidateInput doc comment).
    const result = await runCandidatePipeline(candidatePipelineDeps, {
      mint,
      dex: cheapLiquidity.dex,
      poolAddress: cheapLiquidity.poolAddress,
    });
    if (!result.passed) {
      // No Token row is created here — matches this source's pre-existing
      // "junk never gets a DB footprint" convention; telegramAiCooldownCache
      // is this source's own short-term dedupe for a rejected mint.
      telegramAiCooldownCache.add(mint);
      return;
    }
    const { riskFlags } = result;
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

    const token = await upsertTokenRow(
      mint,
      cheapLiquidity.dex,
      cheapLiquidity.poolAddress,
      riskFlags,
      {
        discoverySource: 'TELEGRAM',
        telegramChannel: channel,
        telegramMessageUrl: messageUrl,
      },
    );

    // AI Filter, part 2 (deferred): the AI score itself can still drag the
    // combined score below threshold even though ruleScore alone passed
    // above — evaluated inside processAiCall (item.telegramPostAiGate) once
    // the real AI score (if any) is known, since AI now runs from the
    // shared, concurrency-bounded aiQueue rather than inline here.
    const fastPath = isFastPathCandidate(riskFlags, {
      minRecentBuys: app.config.FAST_PATH_MIN_RECENT_BUYS,
      minRecentVolumeUsd: app.config.FAST_PATH_MIN_RECENT_VOLUME_USD,
    });
    maybeStartSmartMoneyMomentumEvaluation(mint, token.id);
    aiQueue.enqueue(
      {
        mint,
        dex: cheapLiquidity.dex,
        tokenId: token.id,
        riskFlags,
        pipelineTimestamps: { tokenDetectedAt, ...result.timestamps },
        telegramPostAiGate: { minScore: app.config.TELEGRAM_TREND_MIN_AI_SCORE, channel },
      },
      fastPath ? 'FAST_PATH' : 'NORMAL',
    );
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
      () => getTelegramTrendEnabled(app.redis),
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

  // 2026-07-19 production investigation: sourceHealthMonitor above (fed by raw
  // log delivery) never fired despite 20-190 minute gaps in genuine pump.fun
  // launch detection — proof the subscription kept receiving *some* traffic
  // throughout, so raw liveness alone can't catch this failure mode. This
  // second monitor is fed only by qualified new-token detections (recorded
  // inside processDiscoveryItem below, not on every raw log), so it
  // specifically catches "subscription alive but silently dropping Creates."
  // Not applied to PUMPSWAP/RAYDIUM/ORCA/METEORA — see sourceHealthMonitor.ts's
  // own doc comment on why a qualifying-count gate would false-alarm
  // constantly on those (direct pool creation is genuinely rare there).
  const launchHealthMonitor = new SourceHealthMonitor(
    ['PUMPFUN'],
    app.config.PUMPFUN_LAUNCH_SILENCE_ALERT_MS,
    app.log as never,
    async ({ silentForMs }) => {
      const minutes = Math.round(silentForMs / 60_000);
      // Production incident (2026-07-22): this alert used to be purely
      // observational — a Telegram message and nothing else — leaving a
      // confirmed silently-dropping subscription dead until the next blind
      // periodic resubscribe (if configured at all) or a manual restart.
      // This is the one health check specifically designed to distinguish
      // "quiet market" from "subscription silently dropping Creates" (see
      // SourceHealthMonitor's and PumpFunMonitor's own doc comments) — a
      // confirmed hit here, not raw-traffic noise, is exactly the signal
      // that should force an immediate resubscribe rather than wait.
      app.log.warn(
        { silentForMs },
        'pump.fun launch silence confirmed — forcing an immediate resubscribe (not waiting for the next periodic one)',
      );
      await monitor.forceResubscribe().catch((err) => {
        app.log.error({ err }, 'pump.fun watchdog-triggered resubscribe failed');
      });
      await notifier?.notifyError(
        'Pump.fun launch detection',
        `No new pump.fun token launches detected in ${minutes} minutes, despite normal raw program traffic — the websocket subscription was likely silently dropping Create notifications (see PumpFunMonitor's doc comment). Forced an immediate resubscribe.`,
      );
    },
  );
  launchHealthMonitor.start();

  // Fee payer of a parsed transaction — always the first account key by
  // Solana convention. Best-effort creator/deployer identity (same
  // "documented limitation, not a guarantee" caveat as positionManager.ts's
  // dev-wallet proxy): a Jito-bundled or aggregator-routed create could in
  // principle have a different fee payer than the "true" creator, but this
  // is the cheapest available signal and costs zero extra RPC calls, since
  // the parsed tx is already fetched to resolve the mint itself.
  function resolveDeployerAddress(tx: ParsedTransactionWithMeta): string | undefined {
    return tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
  }

  /** Best-effort fast path only (see migrationMonitor.ts on why this log hint
   * isn't authoritative) — kept as direct fire-and-forget, not routed through
   * discoveryQueue: this is neither AI nor holder analysis, just a single
   * bonding-curve completeness check, so it doesn't need the bounded-queue/
   * FAST_PATH treatment the new candidate pipeline does. The periodic poll
   * (migrationMonitor.start) is the reliable backstop either way. */
  async function processMigrationHint(event: PumpFunLaunchEvent): Promise<void> {
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
  }

  type DiscoveryItem =
    | { source: 'pumpfun'; event: PumpFunLaunchEvent }
    | { source: 'dexRegistry'; event: DexLaunchEvent };

  /**
   * Two-stage discovery pipeline (2026-07-22): everything that used to run
   * directly inside the WS scanner callbacks (getParsedTransaction, mint
   * extraction, the mint-dedupe check, and the full candidate pipeline) now
   * runs here instead, under discoveryQueue's bounded concurrency — the
   * scanner callbacks below do nothing but a cheap in-memory classification
   * and an `enqueue` call, so a burst of launches can no longer fan out
   * unbounded concurrent RPC/AI calls.
   */
  async function processDiscoveryItem(item: DiscoveryItem): Promise<void> {
    // Latency Optimization Stage 1 (2026-07-14): first pipeline-stage
    // timestamp — captured here (queue dequeue), not in the scanner callback
    // that enqueued this item, so token_detected -> analysis_started
    // (marked next, inside candidatePipeline.ts) reflects real processing
    // time, not queue-wait — queue-wait is instead the gap between this and
    // the raw WS event, both of which are visible via /metrics/latency.
    const tokenDetectedAt = Date.now();

    if (item.source === 'pumpfun') {
      const { event } = item;
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
        // Same guard the DEX-registry branch below already has: connection.onLogs
        // can redeliver the same signature on reconnect/resubscribe, which would
        // otherwise re-run the full pipeline (RPC calls, AI scoring cost, a second
        // Telegram alert, and — before TradingSafety's own duplicate-position check
        // — a real risk of a second live buy for a mint already tracked).
        const existing = await app.prisma.token.findUnique({ where: { mint } });
        if (existing) {
          app.log.debug(
            { mint },
            'token already tracked — skipping duplicate pump.fun launch event',
          );
          return;
        }
        launchHealthMonitor.recordActivity('PUMPFUN');
        await runCandidateThroughPipeline(
          mint,
          'PUMPFUN',
          tokenDetectedAt,
          undefined,
          resolveDeployerAddress(tx),
        );
      } catch (err) {
        app.log.error({ err, signature: event.signature }, 'failed to process launch event');
      }
      return;
    }

    const { event } = item;
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

      await runCandidateThroughPipeline(
        pool.baseMint,
        event.dex,
        tokenDetectedAt,
        pool.poolAddress,
        resolveDeployerAddress(tx),
      );
    } catch (err) {
      app.log.error(
        { err, signature: event.signature, dex: event.dex },
        'failed to process DEX launch event',
      );
    }
  }

  const discoveryQueue = new PriorityConcurrencyQueue<DiscoveryItem>(
    app.config.DISCOVERY_QUEUE_CONCURRENCY,
    processDiscoveryItem,
    (err, item) => app.log.error({ err, source: item.source }, 'processDiscoveryItem failed'),
  );

  monitor.start((event) => {
    sourceHealthMonitor.recordActivity('PUMPFUN');
    const detection = classifier.classify(event);
    if (!detection) return;

    if (detection.kind === 'migration') {
      void processMigrationHint(event);
      return;
    }
    if (detection.kind !== 'new_token') return;

    discoveryQueue.enqueue({ source: 'pumpfun', event }, 'NORMAL');
  }, app.config.PUMPFUN_RESUBSCRIBE_INTERVAL_MS || undefined);

  // PumpSwap/Raydium/Orca/Meteora: a new pool for a mint we've never tracked is a
  // direct launch on that DEX; a new pool for a mint already tracked as PUMPFUN is
  // the migration signal, same handling as the pump.fun-side hint above — both
  // decided inside processDiscoveryItem now, not in this callback.
  dexRegistry.startAll(
    (event) => {
      discoveryQueue.enqueue({ source: 'dexRegistry', event }, 'NORMAL');
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
    launchHealthMonitor.stop();
    shadowModePriceSampler?.stop();
    await dexRegistry.stopAll();
  };
}
