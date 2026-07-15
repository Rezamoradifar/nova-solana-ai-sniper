import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ExitReason } from '../trading/exitEngine.js';

const updateSchema = z.object({
  takeProfitPercent: z.number().positive().optional(),
  stopLossPercent: z.number().positive().optional(),
  trailingStopPercent: z.number().positive().optional(),
});

export const partialSellSchema = z.object({
  /** Percent of the position's currently-remaining tokens to sell — the
   * route computes the raw token amount from this, the same unit convention
   * PositionManager.executePartialSell already expects. */
  percent: z.number().min(1).max(99),
});

// Real fund movement — tighter than the global 100/min limit, generous
// enough that a legitimate retry after a transient failure isn't blocked.
const SELL_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

/** Raw token amount to sell for a manual partial-sell percent — same unit
 * convention (raw base units, not decimal-adjusted) as amountToken/
 * remainingAmountToken elsewhere on Position. */
export function manualPartialSellAmount(remainingAmountToken: number, percent: number): number {
  return Math.floor(remainingAmountToken * (percent / 100));
}

/** See the tierIndex namespace comment at the /partial-sell route below —
 * negative, one per manual sell so far, never collides with the
 * institutional ladder's non-negative tier indices. */
export function nextManualTierIndex(manualSellsSoFar: number): number {
  return -(manualSellsSoFar + 1);
}

export async function loadOwnedOpenPosition(fastify: FastifyInstance, userId: string, id: string) {
  const position = await fastify.prisma.position.findUnique({
    where: { id },
    include: { token: true, wallet: true },
  });
  if (!position || position.wallet.userId !== userId) return { error: 404 as const };
  if (position.status !== 'OPEN') return { error: 409 as const };
  return { position };
}

function sendSellError(reply: FastifyReply, err: unknown) {
  const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
  const message = err instanceof Error ? err.message : 'Sell failed';
  return reply.code(422).send({ error: message, category: category ?? 'other' });
}

export default async function positionRoutes(fastify: FastifyInstance) {
  fastify.get('/positions', { preHandler: fastify.authenticate }, async (req) => {
    const wallets = await fastify.prisma.wallet.findMany({
      where: { userId: req.user.userId },
      select: { id: true },
    });
    const positions = await fastify.prisma.position.findMany({
      where: { walletId: { in: wallets.map((w) => w.id) } },
      include: { token: true },
      orderBy: { createdAt: 'desc' },
    });

    // Additive-only enrichment for OPEN positions — currentPriceUsd/
    // unrealizedPnlUsd are new fields, existing consumers (apps/dashboard)
    // ignore fields they don't know about. Same live-price-map fix as
    // /portfolio (see portfolio.ts's doc comment): without a real current
    // price, unrealized PnL cannot be computed at all, so a position without
    // one gets `null`, never a fabricated 0.
    if (!fastify.dexScreener) return positions;
    const openMints = [
      ...new Set(positions.filter((p) => p.status === 'OPEN').map((p) => p.token.mint)),
    ];
    const priceByMint = new Map<string, number>();
    await Promise.all(
      openMints.map(async (mint) => {
        const pair = await fastify.dexScreener!.getBestSolanaPair(mint).catch(() => undefined);
        const price = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
        if (price !== undefined && Number.isFinite(price)) priceByMint.set(mint, price);
      }),
    );

    return positions.map((p) => {
      if (p.status !== 'OPEN') return p;
      const currentPriceUsd = priceByMint.get(p.token.mint) ?? null;
      const unrealizedPnlUsd =
        currentPriceUsd !== null ? (currentPriceUsd - p.entryPriceUsd) * p.amountToken : null;
      return { ...p, currentPriceUsd, unrealizedPnlUsd };
    });
  });

  fastify.patch('/positions/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);

    const position = await fastify.prisma.position.findUnique({
      where: { id },
      include: { wallet: true },
    });
    if (!position || position.wallet.userId !== req.user.userId) {
      return reply.code(404).send({ error: 'Position not found' });
    }

    return fastify.prisma.position.update({ where: { id }, data: body });
  });

  // --- Manual sell actions -------------------------------------------------
  // Thin wrappers over PositionManager.closePosition/executePartialSell — the
  // exact same methods PriceMonitor's automatic TP/SL/trailing-stop and the
  // institutional-mode partial-exit ladder already call. No trading-engine
  // logic changes; these routes only decide *when* to call them (user tap,
  // not a price condition) and supply the wallet key material + a fresh
  // price, same as every existing caller does.

  fastify.post(
    '/positions/:id/sell',
    { preHandler: fastify.authenticate, config: { rateLimit: SELL_RATE_LIMIT } },
    async (req, reply) => {
      if (!fastify.positionManager || !fastify.dexScreener) {
        return reply.code(503).send({ error: 'Trading engine is not available' });
      }
      const { id } = req.params as { id: string };
      const loaded = await loadOwnedOpenPosition(fastify, req.user.userId, id);
      if (loaded.error === 404) return reply.code(404).send({ error: 'Position not found' });
      if (loaded.error === 409) return reply.code(409).send({ error: 'Position is not open' });
      const { position } = loaded;

      const pair = await fastify.dexScreener.getBestSolanaPair(position.token.mint);
      const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) {
        return reply
          .code(422)
          .send({ error: 'No current price available for this token right now' });
      }

      try {
        const result = await fastify.positionManager.closePosition(
          position.id,
          position.walletId,
          position.wallet.encryptedSecret,
          fastify.config.ENCRYPTION_KEY,
          { currentPriceUsd },
        );
        return reply.send(result);
      } catch (err) {
        return sendSellError(reply, err);
      }
    },
  );

  fastify.post(
    '/positions/:id/emergency-sell',
    { preHandler: fastify.authenticate, config: { rateLimit: SELL_RATE_LIMIT } },
    async (req, reply) => {
      if (!fastify.positionManager || !fastify.dexScreener) {
        return reply.code(503).send({ error: 'Trading engine is not available' });
      }
      const { id } = req.params as { id: string };
      const loaded = await loadOwnedOpenPosition(fastify, req.user.userId, id);
      if (loaded.error === 404) return reply.code(404).send({ error: 'Position not found' });
      if (loaded.error === 409) return reply.code(409).send({ error: 'Position is not open' });
      const { position } = loaded;

      const pair = await fastify.dexScreener.getBestSolanaPair(position.token.mint);
      const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) {
        return reply
          .code(422)
          .send({ error: 'No current price available for this token right now' });
      }

      try {
        // Same closePosition primitive as a normal sell — "emergency" is
        // reflected in the recorded exitReason (for reporting/audit) and in
        // the Mini App's own confirmation UX, not a different execution path;
        // there is no separate urgent/bypass-slippage swap mode in the engine
        // to call into without changing PositionManager itself, which is out
        // of scope here.
        const result = await fastify.positionManager.closePosition(
          position.id,
          position.walletId,
          position.wallet.encryptedSecret,
          fastify.config.ENCRYPTION_KEY,
          { currentPriceUsd, reason: 'manual_emergency' as ExitReason },
        );
        return reply.send(result);
      } catch (err) {
        return sendSellError(reply, err);
      }
    },
  );

  fastify.post(
    '/positions/:id/partial-sell',
    { preHandler: fastify.authenticate, config: { rateLimit: SELL_RATE_LIMIT } },
    async (req, reply) => {
      if (!fastify.positionManager || !fastify.dexScreener) {
        return reply.code(503).send({ error: 'Trading engine is not available' });
      }
      const { id } = req.params as { id: string };
      const body = partialSellSchema.parse(req.body);
      const loaded = await loadOwnedOpenPosition(fastify, req.user.userId, id);
      if (loaded.error === 404) return reply.code(404).send({ error: 'Position not found' });
      if (loaded.error === 409) return reply.code(409).send({ error: 'Position is not open' });
      const { position } = loaded;

      const remainingAmountToken = position.remainingAmountToken ?? position.amountToken;
      const sellAmountToken = manualPartialSellAmount(remainingAmountToken, body.percent);
      if (sellAmountToken <= 0) {
        return reply.code(422).send({ error: 'Nothing sellable at that percentage' });
      }

      const pair = await fastify.dexScreener.getBestSolanaPair(position.token.mint);
      const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
      if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) {
        return reply
          .code(422)
          .send({ error: 'No current price available for this token right now' });
      }

      // tierIndex namespace: evaluateNextPartialExit (the institutional-mode
      // ladder) only ever produces non-negative indices into a small tiers
      // array (see partialExitEngine.ts) and executePartialSellLocked dedupes
      // strictly on (positionId, tierIndex). Negative indices, one per manual
      // partial sell so far on this position, can never collide with a real
      // ladder tier and are never "already taken" — this does not touch or
      // reinterpret the ladder's own tier semantics.
      const manualSellsSoFar = await fastify.prisma.positionPartialExit.count({
        where: { positionId: position.id, tierIndex: { lt: 0 } },
      });
      const tierIndex = nextManualTierIndex(manualSellsSoFar);

      try {
        const result = await fastify.positionManager.executePartialSell(
          position.id,
          position.walletId,
          tierIndex,
          sellAmountToken,
          currentPriceUsd,
          position.wallet.encryptedSecret,
          fastify.config.ENCRYPTION_KEY,
        );
        return reply.send(result);
      } catch (err) {
        return sendSellError(reply, err);
      }
    },
  );
}
