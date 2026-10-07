import type { FastifyInstance } from 'fastify';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { JupiterClient, SOL_MINT } from '../solana/jupiter.js';

const MARKET_MINTS = [
  SOL_MINT,
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
] as const;

const ARB_MINTS = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
]);

const ARB_DEXES = new Set(['Raydium CLMM', 'Whirlpool', 'Meteora DLMM']);

const walletParams = z.object({
  address: z.string().min(32).max(44),
});

const quoteQuery = z.object({
  inputMint: z.string().min(32).max(44),
  outputMint: z.string().min(32).max(44),
  amount: z.string().regex(/^\d{1,20}$/),
  slippageBps: z.coerce.number().int().min(1).max(500),
  dex: z.string().min(1).max(64),
});

const winnersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
  days: z.coerce.number().int().min(1).max(30).default(7),
});

export default async function publicNetworkRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/public/network/status',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!fastify.solanaConnection) {
        return reply.code(503).send({
          chain: 'solana',
          cluster: 'mainnet-beta',
          status: 'not_ready',
          tradingMode: fastify.tradingMode ?? 'PAPER',
          workersReady: fastify.backgroundWorkersReady,
          slot: null,
          scanner: fastify.scannerHealthCoordinator?.snapshot() ?? null,
          checkedAt: Date.now(),
        });
      }
      try {
        const slot = await fastify.solanaConnection.getSlot('confirmed');
        return {
          chain: 'solana',
          cluster: 'mainnet-beta',
          status: 'ready',
          tradingMode: fastify.tradingMode ?? 'PAPER',
          workersReady: fastify.backgroundWorkersReady,
          slot,
          scanner: fastify.scannerHealthCoordinator?.snapshot() ?? null,
          checkedAt: Date.now(),
        };
      } catch (error) {
        fastify.log.warn({ error }, 'public network status RPC check failed');
        return reply.code(503).send({
          chain: 'solana',
          cluster: 'mainnet-beta',
          status: 'degraded',
          tradingMode: fastify.tradingMode ?? 'PAPER',
          workersReady: fastify.backgroundWorkersReady,
          slot: null,
          scanner: fastify.scannerHealthCoordinator?.snapshot() ?? null,
          checkedAt: Date.now(),
        });
      }
    },
  );

  fastify.get(
    '/public/wallet/:address',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!fastify.solanaConnection) {
        return reply.code(503).send({ error: 'Solana RPC is not ready' });
      }
      const { address } = walletParams.parse(req.params);
      let publicKey: PublicKey;
      try {
        publicKey = new PublicKey(address);
      } catch {
        return reply.code(400).send({ error: 'Invalid Solana address' });
      }

      const [lamports, signatures, slot] = await Promise.all([
        fastify.solanaConnection.getBalance(publicKey, 'confirmed'),
        fastify.solanaConnection.getSignaturesForAddress(publicKey, { limit: 10 }, 'confirmed'),
        fastify.solanaConnection.getSlot('confirmed'),
      ]);

      return {
        chain: 'solana',
        cluster: 'mainnet-beta',
        address,
        lamports: lamports.toString(),
        sol: lamports / 1e9,
        slot,
        signatures: signatures.map((row) => ({
          signature: row.signature,
          slot: row.slot,
          err: row.err,
          blockTime: row.blockTime,
          confirmationStatus: row.confirmationStatus,
        })),
        checkedAt: Date.now(),
      };
    },
  );

  fastify.get(
    '/public/markets',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const base = fastify.config.DEXSCREENER_API_BASE.replace(/\/$/, '');
      const url = `${base}/tokens/v1/solana/${MARKET_MINTS.join(',')}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        return reply
          .code(response.status === 429 ? 429 : 502)
          .send({ error: 'Market source unavailable' });
      }
      reply.header('Cache-Control', 'public, max-age=1, stale-while-revalidate=5');
      return reply.send(await response.json());
    },
  );

  fastify.get(
    '/public/arbitrage/quote',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const query = quoteQuery.parse(req.query);
      if (!ARB_MINTS.has(query.inputMint) || !ARB_MINTS.has(query.outputMint)) {
        return reply.code(400).send({ error: 'Unsupported arbitrage asset' });
      }
      if (!ARB_DEXES.has(query.dex)) {
        return reply.code(400).send({ error: 'Unsupported arbitrage venue' });
      }

      const amount = BigInt(query.amount);
      if (amount <= 0n || amount > (1n << 64n) - 1n) {
        return reply.code(400).send({ error: 'Invalid quote amount' });
      }

      const jupiter = new JupiterClient({ apiBase: fastify.config.JUPITER_API_BASE });
      try {
        const quote = await jupiter.getQuote(
          {
            inputMint: query.inputMint,
            outputMint: query.outputMint,
            amountLamports: amount,
            slippageBps: query.slippageBps,
            dexes: [query.dex],
          },
          { timeoutMs: 10_000 },
        );
        return reply.send(quote);
      } catch (error) {
        fastify.log.debug({ error, dex: query.dex }, 'public Jupiter quote failed');
        return reply.code(502).send({ error: 'No direct route is currently available' });
      }
    },
  );

  fastify.get(
    '/public/network-winners',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { limit, days } = winnersQuery.parse(req.query);
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await fastify.prisma.smartWalletTokenEntry.findMany({
        where: {
          status: 'EXITED',
          exitAt: { gte: since },
          realizedRoiPercent: { gt: 0 },
          realizedPnlUsd: { gt: 0 },
          entryAmountSol: { not: null },
          exitAmountSol: { not: null },
        },
        orderBy: [{ realizedRoiPercent: 'desc' }, { exitAt: 'desc' }],
        take: Math.min(limit * 3, 90),
        include: {
          token: { select: { name: true, symbol: true, dex: true, imageUrl: true } },
          wallet: {
            select: {
              confidenceScore: true,
              rugExposureRatePct: true,
              sybilConfidencePct: true,
            },
          },
        },
      });

      const internal = await fastify.prisma.wallet.findMany({
        where: { publicKey: { in: rows.map((row) => row.walletAddress) } },
        select: { publicKey: true },
      });
      const internalKeys = new Set(internal.map((row) => row.publicKey));

      return rows
        .filter(
          (row) =>
            !internalKeys.has(row.walletAddress) &&
            (row.wallet.rugExposureRatePct ?? 0) <= 50 &&
            (row.wallet.sybilConfidencePct ?? 0) <= 70,
        )
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          mint: row.mint,
          tokenName: row.token?.name ?? null,
          tokenSymbol: row.token?.symbol ?? null,
          dex: row.token?.dex ?? null,
          imageUrl: row.token?.imageUrl ?? null,
          walletAddress: row.walletAddress,
          walletConfidenceScore: row.wallet.confidenceScore ?? null,
          entryAt: row.entryAt,
          exitAt: row.exitAt,
          entrySignature: row.entrySignature,
          exitSignature: row.exitSignature,
          entryAmountSol: row.entryAmountSol,
          exitAmountSol: row.exitAmountSol,
          realizedRoiPercent: row.realizedRoiPercent,
          realizedPnlSol: row.realizedPnlSol,
          realizedPnlUsd: row.realizedPnlUsd,
        }));
    },
  );
}
