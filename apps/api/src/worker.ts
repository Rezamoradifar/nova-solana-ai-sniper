import { Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import { getConnection, resolveAllRpcEndpoints } from './solana/connection.js';

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
    // Recurring pump.fun outage follow-up (2026-07-23) — exposed for
    // /metrics/rpc, same "same instance, not a second one" convention as
    // sourceHealthMonitor above.
    pumpFunMonitor?: PumpFunMonitor;
    fallbackLaunchDiscovery?: FallbackLaunchDiscovery;
    scannerHealthCoordinator?: ScannerHealthCoordinator;
    // Massive Scanner Scalability (Phase 2, 2026-07-26) — exposed for
    // /metrics/rpc, same "same instance, not a second one" convention as
    // every other decorator above.
    scannerConcurrencyGovernor?: ScannerConcurrencyGovernor;
  }
}
import {
  PumpFunMonitor,
  type PumpFunLaunchEvent,
  type PumpFunWsProvider,
} from './solana/pumpfun.js';
import { FallbackLaunchDiscovery } from './detection/fallbackLaunchDiscovery.js';
import { ScannerHealthCoordinator } from './detection/scannerHealth.js';
import { SecurityGateSummaryReporter } from './notify/securityGateSummaryReporter.js';
import { MemberGrowthReporter } from './notify/memberGrowthReporter.js';
import { securityGateStats } from './detection/securityGateStats.js';
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
import { resolveTokenAgeMs } from './trading/riskTier.js';
import { checkMintBlacklist } from './trading/mintBlacklist.js';
import { TradingSafety, verifySafetySystemReady, type SafetyConfig } from './trading/safety.js';
import { PriceMonitor } from './trading/priceMonitor.js';
import { EmergencyExitMonitor } from './trading/emergencyExitMonitor.js';
import { DepositMonitor } from './wallet/depositMonitor.js';
import {
  runCandidatePipeline,
  isRetryableRejection,
  type CandidatePipelineDeps,
} from './detection/candidatePipeline.js';
import { PriorityConcurrencyQueue } from './lib/priorityQueue.js';
import { PerfMonitor } from './lib/perfMonitor.js';
import { ScannerConcurrencyGovernor } from './detection/scannerConcurrencyGovernor.js';
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
  resolveOpenRouterProvider,
  resolveOllamaProvider,
  scoreToken,
  evaluateMultiLlmConsensus,
  DEFAULT_CONSENSUS_MIN_BUY_VOTES,
  DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE,
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
  const solanaConfig = {
    rpcUrl: app.config.SOLANA_RPC_URL,
    wsUrl: app.config.SOLANA_WS_URL,
    heliusApiKey: app.config.HELIUS_API_KEY,
    quicknodeRpcUrl: app.config.QUICKNODE_RPC_URL,
    quicknodeWsUrl: app.config.QUICKNODE_WS_URL,
    chainstackRpcUrl: app.config.CHAINSTACK_RPC_URL,
    additionalRpcUrls: app.config.ADDITIONAL_RPC_URLS,
  };
  const connection = getConnection(solanaConfig, app.log as never);
  // Exposed for the /health/ready check — decorating here (before app.listen(),
  // see server.ts) rather than via a plugin since the connection only exists once
  // background workers actually start (not guaranteed — see this function's own
  // doc comment on being the one hard requirement).
  if (!app.hasDecorator('solanaConnection')) {
    app.decorate('solanaConnection', connection);
  }

  // Multi-provider WS failover for the pump.fun launch subscription
  // (2026-07-23, recurring silent-drop incident follow-up) — a dedicated,
  // real `Connection` per WS-capable endpoint, deliberately NOT the
  // `resilientConnection`-wrapped `connection` above: subscriptions must stay
  // bound to one real socket (see resilientConnection.ts's SUBSCRIPTION_METHODS
  // doc comment), so PumpFunMonitor itself owns rotating across these. Same
  // endpoint resolution/ordering (Helius primary, QuickNode/Chainstack/custom
  // fallback, public last) `getConnection` already uses for ordinary RPC calls.
  const pumpFunWsProviders: PumpFunWsProvider[] = resolveAllRpcEndpoints(solanaConfig)
    .filter((endpoint) => endpoint.wsUrl)
    .map((endpoint) => ({
      label: endpoint.label,
      connection: new Connection(endpoint.url, {
        commitment: 'confirmed',
        wsEndpoint: endpoint.wsUrl,
        disableRetryOnRateLimit: true,
      }),
    }));
  if (pumpFunWsProviders.length === 0) {
    // No configured endpoint exposes a wsUrl (e.g. only a bare SOLANA_RPC_URL
    // with no matching WS URL) — fall back to the primary connection's own
    // endpoint so pump.fun detection still has exactly one provider to use,
    // matching today's pre-2026-07-23 single-subscription behavior rather
    // than throwing at startup.
    pumpFunWsProviders.push({ label: 'primary', connection });
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
    // Bundled-wallet clustering (2026-07-23 USOH incident follow-up) —
    // operator-tunable, defaults calibrated against the incident's own data.
    {
      similarityToleranceBps: app.config.BUNDLE_CLUSTER_SIMILARITY_TOLERANCE_BPS,
      minClusterWalletCount: app.config.BUNDLE_CLUSTER_MIN_WALLET_COUNT,
      minClusterSupplyPercent: app.config.BUNDLE_CLUSTER_MIN_SUPPLY_PERCENT,
    },
    { extremePumpH1ThresholdPercent: app.config.EXTREME_PUMP_H1_THRESHOLD_PERCENT },
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
    undefined, // verificationRetryDelayMs — keep default
    undefined, // institutionalModeGloballyEnabled — keep default
    undefined, // partialExitsGloballyEnabled — keep default
    app.config.SELL_MAX_PERMANENT_ROUTE_RETRIES,
    app.config.SELL_PERMANENT_RETRY_BACKOFF_BASE_MS,
    app.config.SELL_PERMANENT_RETRY_BACKOFF_MAX_MS,
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
    // Dynamic Risk Tiers (2026-07-23 USOH incident follow-up) — operator-
    // tunable via env, always active (not a staged opt-in feature flag).
    riskTierAgeThresholds: {
      ultraEarlyMaxAgeMs: app.config.RISK_TIER_ULTRA_EARLY_MAX_AGE_MS,
      earlyMaxAgeMs: app.config.RISK_TIER_EARLY_MAX_AGE_MS,
    },
    riskTierSizeConfig: {
      ultraEarlySizeBps: app.config.RISK_TIER_ULTRA_EARLY_SIZE_BPS,
      earlySizeBps: app.config.RISK_TIER_EARLY_SIZE_BPS,
      establishedSizeBps: app.config.RISK_TIER_ESTABLISHED_SIZE_BPS,
    },
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
  const monitor = new PumpFunMonitor(pumpFunWsProviders, app.log as never);
  app.decorate('pumpFunMonitor', monitor);

  // Multi-LLM consensus (2026-07-27: Gemini fully removed from the trading
  // pipeline — see packages/ai/src/consensus.ts's module-level comment).
  // Consensus mode needs only OpenRouter; Ollama is an optional second voter.
  // apps/api's own config schema (config/env.ts) doesn't even pick
  // GEMINI_API_KEY anymore — there is nothing Gemini-related left to read,
  // call, or wait on anywhere in this file. Gemini's provider code still
  // lives in packages/ai/src/provider.ts because apps/marketing-engine (a
  // separate, independent app) uses it directly for its own content/image
  // generation — that is not part of this trading path.
  const openRouterProvider = resolveOpenRouterProvider({
    openrouterApiKey: app.config.OPENROUTER_API_KEY,
    openrouterModel: app.config.OPENROUTER_MODEL,
  });
  const consensusModeActive = Boolean(openRouterProvider);

  // Self-hosted Ollama (2026-07-26): optional second consensus vote — see
  // packages/ai/src/consensus.ts's `ollama` parameter. Only ever consulted
  // when consensus mode itself is active (OpenRouter configured) — it
  // supplements that gate, it doesn't replace it or run standalone. A
  // boot-time health probe (GET /api/tags, 5s budget) verifies both that the
  // host answers AND that the configured model is actually loaded there —
  // logged clearly so "is Ollama really wired in" is answerable from the boot
  // log alone, not just from config presence. A failed probe does NOT disable
  // the provider for the process lifetime (Ollama might come up seconds
  // later) — it only affects this boot's log line; every real call still
  // goes through scoreToken's own fail-closed handling per-request, and
  // consensus.ts's `ollamaParticipated` already makes a per-request Ollama
  // failure fail OPEN (never blocks a BUY, never delays one).
  const ollamaProvider = resolveOllamaProvider({
    ollamaHost: app.config.OLLAMA_HOST,
    ollamaModel: app.config.OLLAMA_MODEL,
  });
  if (ollamaProvider && consensusModeActive) {
    try {
      const tagsRes = await fetch(`${app.config.OLLAMA_HOST}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!tagsRes.ok) throw new Error(`GET /api/tags returned ${tagsRes.status}`);
      const tags = (await tagsRes.json()) as { models?: { name?: string; model?: string }[] };
      // Ollama's /api/tags always reports names with an explicit tag
      // (e.g. "phi4:latest"), even for a model pulled/referenced without one
      // — comparing the untagged base name on both sides is what matches
      // Ollama's own resolution behavior for a bare "phi4" request.
      const configuredBase = app.config.OLLAMA_MODEL?.split(':')[0];
      const modelLoaded = (tags.models ?? []).some(
        (m) =>
          m.name?.split(':')[0] === configuredBase || m.model?.split(':')[0] === configuredBase,
      );
      app.log.info({ host: app.config.OLLAMA_HOST }, 'OLLAMA connected');
      if (modelLoaded) {
        app.log.info({ model: app.config.OLLAMA_MODEL }, `Model: ${app.config.OLLAMA_MODEL}`);
      } else {
        app.log.warn(
          {
            model: app.config.OLLAMA_MODEL,
            availableModels: (tags.models ?? []).map((m) => m.name),
          },
          `Model: ${app.config.OLLAMA_MODEL} — NOT FOUND on this Ollama host (requests will fail per-call and be excluded from consensus; never blocks a BUY)`,
        );
      }
    } catch (err) {
      app.log.warn(
        { err, host: app.config.OLLAMA_HOST },
        'OLLAMA NOT REACHABLE at boot — will keep retrying per-request; never blocks a BUY on its own',
      );
    }
  } else if (ollamaProvider && !consensusModeActive) {
    app.log.warn(
      'OLLAMA_HOST/OLLAMA_MODEL configured but Multi-LLM Consensus is INACTIVE (requires OpenRouter) — Ollama has nothing to vote alongside, so it is not used',
    );
  }

  // Single-provider fallback (today's pre-existing behavior) — used only when
  // consensus mode isn't available (OPENROUTER_API_KEY not configured) and an
  // Anthropic/OpenAI key is set instead. resolveAiProvider/hasAnyAiProvider no
  // longer consider Gemini at all (see provider.ts) — there is no key or
  // priority-chain branch left that could pick it as the BUY-pipeline's AI
  // scorer.
  const aiEnabled = hasAnyAiProvider({
    anthropicApiKey: app.config.ANTHROPIC_API_KEY,
    openaiApiKey: app.config.OPENAI_API_KEY,
  });
  const aiProvider =
    aiEnabled && !consensusModeActive
      ? resolveAiProvider({
          anthropicApiKey: app.config.ANTHROPIC_API_KEY,
          openaiApiKey: app.config.OPENAI_API_KEY,
        })
      : undefined;

  // Status lines only — never the key itself, only presence/model name.
  // Gemini is unconditionally DISABLED here — it has no config, no provider
  // instance, and no call site anywhere in this worker (2026-07-27 full
  // removal from the trading pipeline).
  app.log.info('AI Providers:');
  if (openRouterProvider) {
    app.log.info({ model: app.config.OPENROUTER_MODEL }, 'AI Providers: OpenRouter: ACTIVE');
  } else {
    app.log.info('AI Providers: OpenRouter: INACTIVE');
  }
  if (ollamaProvider) {
    app.log.info(
      { host: app.config.OLLAMA_HOST, model: app.config.OLLAMA_MODEL },
      'AI Providers: Ollama: ACTIVE',
    );
  } else {
    app.log.info('AI Providers: Ollama: INACTIVE');
  }
  app.log.info('AI Providers: Gemini: DISABLED');
  if (consensusModeActive) {
    app.log.info('Multi-LLM Consensus: ACTIVE (OpenRouter + optional Ollama)');
  } else {
    app.log.warn('Multi-LLM Consensus: INACTIVE (requires OpenRouter configured)');
  }
  if (!aiEnabled && !consensusModeActive) {
    app.log.warn(
      'No ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY set — AI scoring disabled, rule-based only',
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
        // Production bug fix (2026-07-23 USOH post-mortem): real on-chain
        // decimals from riskAnalyzer.ts, not the schema's `@default(9)`
        // fallback. Undefined (failed mint-authority read) omits the field
        // entirely, so `create` still falls back to the schema default rather
        // than persisting a guess.
        decimals: riskFlags.decimals,
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
        // Undefined leaves the existing stored value untouched (never
        // overwrites a correct value with a guess) — see the `create` branch
        // above for the same convention.
        decimals: riskFlags.decimals,
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
    let openRouterResult: AiScore | undefined;
    // Only set when ollamaProvider is configured — best-effort second vote,
    // see evaluateMultiLlmConsensus's `ollama` param.
    let ollamaResult: AiScore | undefined;

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
      // Production bug fix (2026-07-23 USOH post-mortem): was hardcoded to 9
      // regardless of the mint's real decimals — see riskFlags.decimals' own
      // doc comment. Falls back to 9 only when the mint-authority read itself
      // failed (riskFlags.decimals undefined), same as before this fix in
      // that one case.
      decimals: riskFlags.decimals ?? 9,
      createdAt: new Date(pipelineTimestamps.tokenDetectedAt).toISOString(),
      dex: dex.toLowerCase() as Dex,
    };

    if (consensusModeActive) {
      // Multi-LLM consensus (2026-07-27 redesign: Gemini removed entirely —
      // see consensus.ts's module-level comment): OpenRouter and Ollama are
      // called genuinely in parallel, neither waits on the other, and neither
      // is a single point of failure — a hard failure or timeout on one
      // never blocks the pipeline or delays a BUY; the remaining provider's
      // result alone can still drive a decision (see evaluateMultiLlmConsensus).
      aiScoringStartAt = Date.now();
      // Ollama (2026-07-26): fired in the same Promise.all so it never adds
      // its own latency on top of OpenRouter, but wrapped separately so
      // "request sent"/"response received" are logged specifically for it,
      // regardless of what OpenRouter is doing. undefined (not awaited at
      // all) when unconfigured — a missing OLLAMA_HOST costs nothing here.
      const ollamaCall = ollamaProvider
        ? (async () => {
            app.log.info(
              { mint, host: app.config.OLLAMA_HOST, model: app.config.OLLAMA_MODEL },
              'Ollama: request sent',
            );
            const result = await scoreToken(ollamaProvider, tokenInfo, riskFlags);
            if (result.flags.includes('ai_call_error') || result.flags.includes('ai_parse_error')) {
              app.log.warn(
                { mint, flags: result.flags },
                'Ollama: request failed — excluded from consensus this round (fails open, never blocks or delays a BUY)',
              );
            } else {
              app.log.info(
                { mint, score: result.score, decision: result.decision },
                'Ollama: response received',
              );
            }
            return result;
          })()
        : undefined;
      [openRouterResult, ollamaResult] = await Promise.all([
        scoreToken(openRouterProvider!, tokenInfo, riskFlags),
        ollamaCall,
      ]);
      aiScoringEndAt = Date.now();
      const openrouterParticipatedInScore =
        !openRouterResult.flags.includes('ai_call_error') &&
        !openRouterResult.flags.includes('ai_parse_error');
      const ollamaParticipatedInScore =
        ollamaResult !== undefined &&
        !ollamaResult.flags.includes('ai_call_error') &&
        !ollamaResult.flags.includes('ai_parse_error');
      // Conservative combination when both participate — same Math.min
      // convention already used for ruleScore vs. a single AI score elsewhere
      // in this codebase. When only one participates, its score alone drives
      // this (never blocked by the other's unavailability). Only when BOTH
      // hard-fail is there no usable AI signal at all, which fails closed to
      // 0 rather than silently falling back to the rule-based score.
      if (openrouterParticipatedInScore && ollamaParticipatedInScore) {
        aiScoreValue = Math.min(openRouterResult.score, ollamaResult!.score);
        usedRealAi = true;
      } else if (openrouterParticipatedInScore) {
        aiScoreValue = openRouterResult.score;
        usedRealAi = true;
      } else if (ollamaParticipatedInScore) {
        aiScoreValue = ollamaResult!.score;
        usedRealAi = true;
      } else {
        aiScoreValue = 0;
      }
      app.log.info(
        {
          mint,
          openrouter: { score: openRouterResult.score, decision: openRouterResult.decision },
          ...(ollamaResult && {
            ollama: { score: ollamaResult.score, decision: ollamaResult.decision },
          }),
        },
        'Multi-LLM consensus scoring complete',
      );
      await app.prisma.token.update({
        where: { id: tokenId },
        data: {
          aiScore: aiScoreValue,
          aiSummary:
            `openrouter: ${openRouterResult.summary}` +
            (ollamaResult ? ` | ollama: ${ollamaResult.summary}` : ''),
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

    // Weighted Multi-LLM consensus gate (2026-07-27 redesign: Gemini removed
    // entirely from scoring/consensus/voting — see consensus.ts's
    // module-level comment) — evaluated once per token, strictly before
    // AutoTrader, exactly like candidatePipeline.ts's own gates upstream of
    // this function. Never loosens anything: critical security checks
    // (candidatePipeline.ts — honeypot/holder-concentration/bundled-wallet/
    // mint-freeze-authority/LP-lock) already ran, unconditionally, before
    // this candidate ever reached the AI stage at all, and this gate is
    // strictly downstream of (never a replacement for) them. Does NOT gate on
    // Opportunity Score (2026-07-22 audit — see evaluateMultiLlmConsensus's
    // own doc comment): that's autoTrader.ts's opt-in job, per config,
    // downstream. Neither OpenRouter nor Ollama being temporarily unavailable
    // blocks or delays this — see evaluateMultiLlmConsensus's fail-open
    // single-voter degrade.
    if (consensusModeActive && openRouterResult) {
      const consensus = evaluateMultiLlmConsensus(openRouterResult, ollamaResult);
      // Evidence line (2026-07-26): every model's individual vote (score,
      // decision, weight actually applied, whether it participated) plus the
      // final weighted decision — logged unconditionally, on every token,
      // regardless of outcome, so "how did we get to this decision" is
      // answerable from this one line alone.
      app.log.info(
        {
          mint,
          votes: consensus.votes,
          weightedConfidence: consensus.weightedConfidence,
          buyVotes: consensus.buyVotes,
          minBuyVotesRequired: DEFAULT_CONSENSUS_MIN_BUY_VOTES,
          minWeightedConfidenceRequired: DEFAULT_CONSENSUS_MIN_WEIGHTED_CONFIDENCE,
          ollamaParticipated: consensus.ollamaParticipated,
          decision: consensus.decision,
        },
        `Multi-LLM weighted consensus: ${consensus.decision} (weightedConfidence=${consensus.weightedConfidence.toFixed(1)}, buyVotes=${consensus.buyVotes}/${consensus.votes.filter((v) => v.participated).length})`,
      );
      if (consensus.ollamaParticipated) {
        app.log.info(
          {
            mint,
            decision: consensus.decision,
            ollamaScore: ollamaResult!.score,
            ollamaDecision: ollamaResult!.decision,
          },
          'BUY decision influenced by Ollama',
        );
      }
      if (consensus.decision !== 'BUY') {
        app.log.warn(
          {
            mint,
            decision: consensus.decision,
            reasons: consensus.reasons,
            votes: consensus.votes,
            weightedConfidence: consensus.weightedConfidence,
            buyVotes: consensus.buyVotes,
            opportunityScore: opportunityScore.finalScore,
            location: 'apps/api/src/worker.ts:processAiCall (multi-LLM consensus)',
          },
          `BUY CANCELLED — MULTI-LLM CONSENSUS\nDecision:\n${consensus.decision}\nReasons:\n${consensus.reasons.join(', ')}`,
        );
        // Section 8/9 audit (2026-07-23): a consensus non-BUY is a normal,
        // correctly-working outcome, not a system error — folded into the
        // same periodic securityGateSummaryReporter.ts report as every other
        // gate rejection instead of its own individual Telegram alert.
        securityGateStats.recordAiConsensusRejected();
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
      // Dynamic Risk Tiers (2026-07-23): real on-chain token age, fails
      // closed to 0 (Tier A: ULTRA_EARLY) when DexScreener hasn't resolved a
      // pair-creation timestamp yet — see riskTier.ts's resolveTokenAgeMs.
      resolveTokenAgeMs(Date.now(), riskFlags.pairCreatedAt),
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
   *
   * Retry (2026-07-23 audit): a rejection whose reasons are all "couldn't
   * verify yet" (isRetryableRejection — DexScreener hasn't indexed this brand
   * new launch, or an on-chain read raced the RPC node) re-runs the whole
   * pipeline after CANDIDATE_RETRY_INTERVAL_MS instead of rejecting for good
   * on the very first attempt, up to CANDIDATE_RETRY_MAX_ATTEMPTS times. A
   * rejection with even one confirmed-bad reason (honeypot, blacklisted
   * deployer, ...) still falls straight through to the permanent-rejection
   * path below, unchanged from before this audit.
   */
  async function runCandidateThroughPipeline(
    mint: string,
    dex: LaunchableDex,
    tokenDetectedAt: number,
    poolAddress: string | undefined,
    deployerAddress: string | undefined,
    attempt = 0,
  ): Promise<void> {
    if (attempt === 0) {
      securityGateStats.recordScanned();
    } else {
      // This attempt is the retry timer firing, i.e. the retry scheduled
      // below actually resolving — see recordRetryResolved's own doc comment.
      securityGateStats.recordRetryResolved();
    }

    const result = await runCandidatePipeline(candidatePipelineDeps, {
      mint,
      dex,
      poolAddress,
      deployerAddress,
    });

    const canRetry =
      !result.passed &&
      attempt < app.config.CANDIDATE_RETRY_MAX_ATTEMPTS &&
      isRetryableRejection(result.reasons);
    if (canRetry) {
      app.log.info(
        { mint, dex, attempt: attempt + 1, reasons: result.reasons },
        'candidate pipeline: rejection reasons are all transient — retrying instead of rejecting for good',
      );
      securityGateStats.recordRetryStarted();
      setTimeout(() => {
        void runCandidateThroughPipeline(
          mint,
          dex,
          tokenDetectedAt,
          poolAddress,
          deployerAddress,
          attempt + 1,
        );
      }, app.config.CANDIDATE_RETRY_INTERVAL_MS);
      return;
    }

    // Final resolution (pass or permanent block) from here on — see
    // securityGateStats.ts's verificationLatencyMsSum doc comment.
    securityGateStats.recordVerificationLatency(Date.now() - tokenDetectedAt);
    if (attempt > 0 && result.passed) {
      securityGateStats.recordRetrySuccess();
    }

    if (!result.riskFlags) {
      // riskAnalyzer.analyze() itself threw and retries (if any were left)
      // are exhausted — candidatePipeline already logged it; nothing here to
      // upsert or score.
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

    // Blacklist consistency fix (2026-07-23 USOH incident follow-up): this is
    // the same checkMintBlacklist function candidatePipeline.ts's
    // runCandidatePipeline now also calls unconditionally for every
    // on-chain-detected candidate — kept here too (ahead of the cheap
    // liquidity precheck below) purely as a cost-avoidance fast path so a
    // known-bad mint doesn't pay for a DexScreener call it's going to be
    // rejected after anyway; candidatePipeline.ts's own check is the actual
    // guarantee, not this one.
    const mintBlacklistCheck = await checkMintBlacklist(app.prisma, mint);
    if (mintBlacklistCheck.blacklisted) {
      metrics.increment('blacklistRejected');
      app.log.debug(
        { mint, channel, reason: mintBlacklistCheck.reason },
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

  // Re-verified 2026-07-23 (USOH incident follow-up): this was deliberately
  // turned off 2026-07-18 (near-zero PnL, and every candidate — including
  // eventual junk — paid for the full expensive riskAnalyzer.analyze() call
  // before the cheap rule-score gate ran, see project memory). It's back to
  // `true` in the live .env now, which is NOT a blind re-enable: the
  // handleTelegramSignal flow above already runs riskAnalyzer.cheapLiquidityPrecheck
  // (one HTTP call, at most one cheap on-chain read) BEFORE runCandidatePipeline
  // (the expensive analyze() call) — the exact reordering the 2026-07-18 note
  // said would be needed, landed as part of the 2026-07-22 two-stage discovery
  // pipeline refactor. Telegram signals go through the IDENTICAL
  // runCandidatePipeline as on-chain detection (see handleTelegramSignal above),
  // so they cannot bypass the critical security gate or the pre-buy
  // sellability check either way — and now that runCandidatePipeline itself
  // checks the MINT blacklist (2026-07-23 fix, see mintBlacklist.ts), they
  // can't bypass that anymore either. Do not flip this without re-checking
  // that ordering still holds.
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

  // 2026-07-23 recurring-incident follow-up: the old PUMPFUN-only
  // "qualifying Create" SourceHealthMonitor that used to live here (fed by
  // processDiscoveryItem, purely observational plus a same-provider
  // forceResubscribe) is superseded by PumpFunMonitor's own internal watchdog
  // (which now escalates all the way to multi-provider failover, not just a
  // same-provider resubscribe) and ScannerHealthCoordinator below (which owns
  // all launch-detection-health alerting on real state transitions instead of
  // a raw silence-duration trigger) — kept in one place instead of two
  // independent, potentially-conflicting alerting paths.
  const fallbackLaunchDiscovery = new FallbackLaunchDiscovery(
    {
      connection,
      prisma: app.prisma,
      logger: app.log as never,
      onCandidate: ({ mint, deployerAddress }) =>
        runCandidateThroughPipeline(mint, 'PUMPFUN', Date.now(), undefined, deployerAddress),
    },
    {
      idleIntervalMs: app.config.FALLBACK_DISCOVERY_IDLE_INTERVAL_MS,
      maxLookbackMs: app.config.FALLBACK_DISCOVERY_MAX_LOOKBACK_MS,
    },
  );
  fallbackLaunchDiscovery.start();
  app.decorate('fallbackLaunchDiscovery', fallbackLaunchDiscovery);

  const scannerHealthCoordinator = new ScannerHealthCoordinator(
    {
      pumpFunMonitor: monitor,
      fallbackDiscovery: fallbackLaunchDiscovery,
      redis: app.redis,
      logger: app.log as never,
      notifier,
    },
    {
      checkIntervalMs: app.config.SCANNER_HEALTH_CHECK_INTERVAL_MS,
      autoBuyAutoResumeEnabled: app.config.SCANNER_AUTO_BUY_AUTO_RESUME_ENABLED,
    },
  );
  scannerHealthCoordinator.start();
  app.decorate('scannerHealthCoordinator', scannerHealthCoordinator);

  const securityGateSummaryReporter = new SecurityGateSummaryReporter(notifier, app.log as never);
  securityGateSummaryReporter.start(app.config.SECURITY_GATE_SUMMARY_INTERVAL_MS);

  // Telegram Member Counter (2026-07-27) — see memberGrowthReporter.ts's doc comment.
  const memberGrowthReporter = new MemberGrowthReporter(app.prisma, notifier, app.log as never);
  memberGrowthReporter.start(app.config.MEMBER_GROWTH_REPORT_INTERVAL_MS);

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
        // Feeds PumpFunMonitor's own internal watchdog (see pumpfun.ts) — a
        // genuine, classified Create, distinct from the raw-event tracking it
        // already does for every onLogs delivery regardless of classification.
        monitor.recordValidCreate();
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

  // Massive Scanner Scalability (Phase 2, 2026-07-26): re-tunes
  // discoveryQueue's concurrency from live signals instead of leaving it
  // fixed at DISCOVERY_QUEUE_CONCURRENCY for the process's whole lifetime.
  // Default on, same convention as DEPOSIT_MONITOR_ENABLED (core capacity
  // management, not an opt-in experiment) — disable via
  // SCANNER_CONCURRENCY_GOVERNOR_ENABLED=false to pin the fixed env value.
  const perfMonitor = new PerfMonitor();
  const scannerConcurrencyGovernor = new ScannerConcurrencyGovernor(
    {
      queue: discoveryQueue,
      perfMonitor,
      logger: app.log as never,
      // Same ordering resolveAllRpcEndpoints/getConnection already use
      // elsewhere in this function (Helius primary, QuickNode/Chainstack/
      // custom fallback, public last) — see connection.ts's tier doc comment
      // for why only this one label may ever gate scaling down.
      primaryProviderLabel: resolveAllRpcEndpoints(solanaConfig)[0]?.label ?? 'primary',
    },
    {
      intervalMs: app.config.SCANNER_CONCURRENCY_GOVERNOR_INTERVAL_MS,
      minConcurrency: app.config.SCANNER_CONCURRENCY_MIN,
      maxConcurrency: app.config.SCANNER_CONCURRENCY_MAX,
      eventLoopLagCeilingMs: app.config.SCANNER_EVENT_LOOP_LAG_CEILING_MS,
    },
  );
  if (app.config.SCANNER_CONCURRENCY_GOVERNOR_ENABLED) {
    scannerConcurrencyGovernor.start();
  } else {
    perfMonitor.stop();
  }
  app.decorate('scannerConcurrencyGovernor', scannerConcurrencyGovernor);

  monitor.start(
    (event) => {
      sourceHealthMonitor.recordActivity('PUMPFUN');
      const detection = classifier.classify(event);
      if (!detection) return;

      if (detection.kind === 'migration') {
        void processMigrationHint(event);
        return;
      }
      if (detection.kind !== 'new_token') return;

      discoveryQueue.enqueue({ source: 'pumpfun', event }, 'NORMAL');
    },
    {
      resubscribeIntervalMs: app.config.PUMPFUN_RESUBSCRIBE_INTERVAL_MS || undefined,
      launchSilenceThresholdMs: app.config.PUMPFUN_LAUNCH_SILENCE_ALERT_MS,
      watchdogVerifyWindowMs: app.config.PUMPFUN_WATCHDOG_VERIFY_WINDOW_MS,
      providerCooldownBaseMs: app.config.PUMPFUN_PROVIDER_COOLDOWN_BASE_MS,
      providerCooldownMaxMs: app.config.PUMPFUN_PROVIDER_COOLDOWN_MAX_MS,
      primaryRecoveryProbeIntervalMs: app.config.PUMPFUN_PRIMARY_RECOVERY_PROBE_INTERVAL_MS,
    },
  );

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
    fallbackLaunchDiscovery.stop();
    scannerHealthCoordinator.stop();
    securityGateSummaryReporter.stop();
    memberGrowthReporter.stop();
    twitterMonitor?.stop();
    telegramTrendMonitor?.stop();
    priceMonitor.stop();
    emergencyExitMonitor?.stop();
    migrationMonitor.stop();
    depositMonitor?.stop();
    sourceHealthMonitor.stop();
    shadowModePriceSampler?.stop();
    if (app.config.SCANNER_CONCURRENCY_GOVERNOR_ENABLED) {
      scannerConcurrencyGovernor.stop();
    }
    await dexRegistry.stopAll();
  };
}
