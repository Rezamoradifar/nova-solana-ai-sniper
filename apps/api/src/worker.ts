import type { FastifyInstance } from 'fastify';
import { getConnection } from './solana/connection.js';
import { PumpFunMonitor } from './solana/pumpfun.js';
import { JupiterClient } from './solana/jupiter.js';
import { DexScreenerClient } from './solana/dexscreener.js';
import { TokenEventClassifier } from './detection/detectors.js';
import { RiskAnalyzer } from './detection/riskAnalyzer.js';
import { extractMintFromParsedTx } from './detection/extractMint.js';
import { PositionManager } from './trading/positionManager.js';
import { AutoTrader } from './trading/autoTrader.js';
import { TradingSafety, verifySafetySystemReady, type SafetyConfig } from './trading/safety.js';
import { PriceMonitor } from './trading/priceMonitor.js';
import { hasAnyAiProvider, resolveAiProvider, scoreToken } from '@nova/ai';
import { createBot, NotificationService } from '@nova/telegram-bot';
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
  const riskAnalyzer = new RiskAnalyzer(connection, dexScreener, jupiter, app.log as never);

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

  let notifier: NotificationService | undefined;
  if (app.config.TELEGRAM_BOT_TOKEN && app.config.TELEGRAM_CHAT_ID) {
    const bot = createBot(app.config.TELEGRAM_BOT_TOKEN, app.log as never);
    notifier = new NotificationService(bot, app.config.TELEGRAM_CHAT_ID, app.log as never);
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

  monitor.start(async (event) => {
    const detection = classifier.classify(event);
    if (!detection || detection.kind !== 'new_token') return;

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

      const riskFlags = await riskAnalyzer.analyze({ mint });

      const token = await app.prisma.token.upsert({
        where: { mint },
        create: {
          mint,
          dex: 'PUMPFUN',
          liquidityUsd: riskFlags.liquidityUsd,
          mintAuthorityRevoked: riskFlags.mintAuthorityRevoked,
          freezeAuthorityRevoked: riskFlags.freezeAuthorityRevoked,
          lpBurnedOrLocked: riskFlags.lpBurnedOrLocked,
          top10HolderPercent: riskFlags.top10HolderPercent,
          isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        },
        update: {
          liquidityUsd: riskFlags.liquidityUsd,
          top10HolderPercent: riskFlags.top10HolderPercent,
          isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        },
      });

      eventBus.publish('token.created', { tokenId: token.id, mint, dex: 'PUMPFUN' });

      const ruleScore = RiskAnalyzer.ruleBasedScore(riskFlags);
      let aiScoreValue = ruleScore;

      if (aiProvider) {
        const aiScore = await scoreToken(
          aiProvider,
          { mint, decimals: 9, createdAt: event.detectedAt, dex: 'pumpfun' },
          riskFlags,
        );
        aiScoreValue = aiScore.score;
        await app.prisma.token.update({
          where: { id: token.id },
          data: { aiScore: aiScore.score, aiSummary: aiScore.summary },
        });
      }

      await notifier?.notifyNewToken({
        mint,
        dex: 'PUMPFUN',
        liquidityUsd: riskFlags.liquidityUsd,
        isHoneypotSuspected: riskFlags.isHoneypotSuspected,
        aiScore: aiScoreValue,
      });

      await autoTrader.evaluateAndMaybeBuy(mint, token.id, riskFlags, aiScoreValue);
    } catch (err) {
      app.log.error({ err, signature: event.signature }, 'failed to process launch event');
    }
  });

  return async () => {
    await monitor.stop();
    twitterMonitor?.stop();
    priceMonitor.stop();
  };
}
