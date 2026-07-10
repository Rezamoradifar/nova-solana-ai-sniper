import type { FastifyInstance } from 'fastify';
import { getConnection } from './solana/connection.js';
import { PumpFunMonitor } from './solana/pumpfun.js';
import { JupiterClient } from './solana/jupiter.js';
import { DexScreenerClient } from './solana/dexscreener.js';
import { TokenEventClassifier } from './detection/detectors.js';
import { RiskAnalyzer } from './detection/riskAnalyzer.js';
import { PositionManager } from './trading/positionManager.js';
import { AutoTrader } from './trading/autoTrader.js';
import { hasAnyAiProvider, resolveAiProvider, scoreToken } from '@nova/ai';

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
  const riskAnalyzer = new RiskAnalyzer(connection, dexScreener);
  const positionManager = new PositionManager(app.prisma, connection, jupiter, app.log as never);
  const autoTrader = new AutoTrader({
    prisma: app.prisma,
    riskAnalyzer,
    positionManager,
    logger: app.log as never,
    encryptionKey: app.config.ENCRYPTION_KEY,
  });

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

  monitor.start(async (event) => {
    const detection = classifier.classify(event);
    if (!detection || detection.kind !== 'new_token') return;

    try {
      const tx = await connection.getParsedTransaction(event.signature, {
        maxSupportedTransactionVersion: 0,
      });
      const mint = extractMintFromTx(tx);
      if (!mint) return;

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

      await autoTrader.evaluateAndMaybeBuy(mint, token.id, riskFlags, aiScoreValue);
    } catch (err) {
      app.log.error({ err, signature: event.signature }, 'failed to process launch event');
    }
  });

  return async () => {
    await monitor.stop();
  };
}

function extractMintFromTx(
  tx: Awaited<ReturnType<import('@solana/web3.js').Connection['getParsedTransaction']>>,
): string | undefined {
  if (!tx) return undefined;
  const accountKeys = tx.transaction.message.accountKeys;
  // pump.fun `create` places the new mint as the 2nd account key by convention;
  // this is a heuristic and should be validated against the IDL for production hardening.
  return accountKeys[1]?.pubkey?.toBase58();
}
