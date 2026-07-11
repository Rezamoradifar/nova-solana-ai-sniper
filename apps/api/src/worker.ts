import type { FastifyInstance } from 'fastify';
import { getConnection } from './solana/connection.js';
import { PumpFunMonitor } from './solana/pumpfun.js';
import { JupiterClient } from './solana/jupiter.js';
import { DexScreenerClient } from './solana/dexscreener.js';
import { TokenEventClassifier } from './detection/detectors.js';
import { RiskAnalyzer } from './detection/riskAnalyzer.js';
import { extractMintFromParsedTx } from './detection/extractMint.js';
import { MigrationMonitor } from './detection/migrationMonitor.js';
import { DexRegistry } from './solana/dex/registry.js';
import { PumpSwapExecutor } from './solana/dex/pumpswapExecutor.js';
import { JitoClient } from './solana/jito.js';
import { PositionManager } from './trading/positionManager.js';
import { AutoTrader } from './trading/autoTrader.js';
import { TradingSafety, verifySafetySystemReady, type SafetyConfig } from './trading/safety.js';
import { PriceMonitor } from './trading/priceMonitor.js';
import { hasAnyAiProvider, resolveAiProvider, scoreToken } from '@nova/ai';
import type { Dex } from '@nova/shared';
import { createBot, NotificationService, AI_HIGH_SCORE_THRESHOLD } from '@nova/telegram-bot';
import { eventBus } from './lib/eventBus.js';
import { TwitterClient } from './social/twitter.js';
import { TwitterMonitor } from './social/twitterMonitor.js';

/**
 * Wires the detection -> risk -> AI-score -> auto-trade pipeline together and
 * starts the pump.fun log subscription. Returns a stop function for graceful
 * shutdown. Safe to run without AI keys configured (falls back to rule-based
 * score only) — it is NOT safe to run without a Solana RPC endpoint, so that
 * is the one hard requirement here.
 */
export async function startBackgroundWorkers(app: FastifyInstance) {
  const connection = getConnection({
    rpcUrl: app.config.SOLANA_RPC_URL,
    wsUrl: app.config.SOLANA_WS_URL,
    heliusApiKey: app.config.HELIUS_API_KEY,
  });

  const dexScreener = new DexScreenerClient(app.config.DEXSCREENER_API_BASE);
  const jupiter = new JupiterClient({ apiBase: app.config.JUPITER_API_BASE });
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
  const autoTrader = new AutoTrader({
    prisma: app.prisma,
    riskAnalyzer,
    positionManager,
    logger: app.log as never,
    encryptionKey: app.config.ENCRYPTION_KEY,
  });

  // Drives TP/SL/trailing-stop: without this loop those fields are just stored
  // numbers with nothing evaluating them against the live price.
  const priceMonitor = new PriceMonitor({
    prisma: app.prisma,
    dexScreener,
    positionManager,
    logger: app.log as never,
    encryptionKey: app.config.ENCRYPTION_KEY,
  });
  priceMonitor.start(app.config.PRICE_CHECK_INTERVAL_MS);

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
    dex: 'PUMPFUN' | 'PUMPSWAP' | 'RAYDIUM' | 'ORCA' | 'METEORA',
    detectedAt: string,
    poolAddress?: string,
  ) {
    // Pipeline checkpoint: Scanner reached. Every detection source (pump.fun's own
    // monitor and dexRegistry.startAll's per-DEX pool-creation watchers) funnels
    // through this one function, so this line firing confirms a scanner actually
    // produced a launch event for this mint, before any filtering happens.
    app.log.debug({ mint, dex, poolAddress }, 'Scanner: handleNewTokenLaunch reached');
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

    if (aiProvider) {
      const aiScore = await scoreToken(
        aiProvider,
        { mint, decimals: 9, createdAt: detectedAt, dex: dex.toLowerCase() as Dex },
        riskFlags,
      );
      aiScoreValue = aiScore.score;
      await app.prisma.token.update({
        where: { id: token.id },
        data: { aiScore: aiScore.score, aiSummary: aiScore.summary },
      });
    }

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
        liquidityUsd: riskFlags.liquidityUsd,
      });
    }

    await autoTrader.evaluateAndMaybeBuy(mint, token.id, riskFlags, aiScoreValue);
  }

  monitor.start(async (event) => {
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
      await handleNewTokenLaunch(mint, 'PUMPFUN', event.detectedAt);
    } catch (err) {
      app.log.error({ err, signature: event.signature }, 'failed to process launch event');
    }
  });

  // PumpSwap/Raydium/Orca/Meteora: a new pool for a mint we've never tracked is a
  // direct launch on that DEX; a new pool for a mint already tracked as PUMPFUN is
  // the migration signal, same handling as the pump.fun-side hint above.
  dexRegistry.startAll(async (event) => {
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
  });

  return async () => {
    await monitor.stop();
    twitterMonitor?.stop();
    priceMonitor.stop();
    migrationMonitor.stop();
    await dexRegistry.stopAll();
  };
}
