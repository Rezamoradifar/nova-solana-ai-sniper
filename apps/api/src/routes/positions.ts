import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

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

/**
 * Same shape as loadOwnedOpenPosition, minus the ownership check — for the
 * admin force-close route below, which exists because no user-facing sell
 * route can ever reach a position that isn't the caller's own (2026-07-22:
 * an operator needed to close a honeypot-suspected position that belonged
 * to a different platform user's wallet and had no way to).
 */
export async function loadOpenPositionAny(fastify: FastifyInstance, id: string) {
  const position = await fastify.prisma.position.findUnique({
    where: { id },
    include: { token: true, wallet: true },
  });
  if (!position) return { error: 404 as const };
  if (position.status !== 'OPEN') return { error: 409 as const };
  return { position };
}

function sendSellError(reply: FastifyReply, err: unknown) {
  const category = (err as { sellFailureCategory?: string } | null)?.sellFailureCategory;
  const message = err instanceof Error ? err.message : 'Sell failed';
  return reply.code(422).send({ error: message, category: category ?? 'other' });
}

export interface CloseAllSummary {
  closed: number;
  failed: number;
  skipped: number;
  failures: Array<{ positionId: string; symbol: string; reason: string }>;
}

/**
 * Bulk close — same `closePosition` primitive as /positions/:id/sell, looped
 * over every OPEN position belonging to `userId`. Sequential (not
 * Promise.all) so concurrent swaps from the same wallet never race each other
 * for a blockhash/nonce, and so one failed sell can never take down the rest
 * of the batch — every iteration is individually caught and bucketed into the
 * summary rather than letting a thrown error abort the loop. Duplicate-close
 * protection for each position is inherited for free from closePosition's own
 * positionCloseLock acquire/release (positionCloseLock.ts) — no separate
 * locking needed here. Extracted from the route handler so it's directly
 * unit-testable with a mocked `fastify`, same convention as
 * loadOwnedOpenPosition above.
 */
export async function closeAllOpenPositions(
  fastify: FastifyInstance,
  userId: string,
): Promise<CloseAllSummary> {
  const wallets = await fastify.prisma.wallet.findMany({
    where: { userId },
    select: { id: true },
  });
  const openPositions = await fastify.prisma.position.findMany({
    where: { status: 'OPEN', walletId: { in: wallets.map((w) => w.id) } },
    include: { token: true, wallet: true },
  });

  let closed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: CloseAllSummary['failures'] = [];

  for (const position of openPositions) {
    const symbol = position.token.symbol ?? position.token.mint.slice(0, 6);
    const pair = await fastify
      .dexScreener!.getBestSolanaPair(position.token.mint)
      .catch(() => undefined);
    const currentPriceUsd = pair?.priceUsd ? Number(pair.priceUsd) : undefined;
    if (currentPriceUsd === undefined || !Number.isFinite(currentPriceUsd)) {
      skipped++;
      failures.push({
        positionId: position.id,
        symbol,
        reason: 'No current price available for this token right now',
      });
      continue;
    }

    try {
      const result = await fastify.positionManager!.closePosition(
        position.id,
        position.walletId,
        position.wallet.encryptedSecret,
        fastify.config.ENCRYPTION_KEY,
        { currentPriceUsd },
      );
      // signature === null covers both closePosition's own zero-balance
      // reconciliation (see positionManager.ts) and the "no longer OPEN by
      // the time the close lock was acquired" no-op — neither is a real
      // sell, so neither should be counted (or fabricate a PnL) as "closed".
      if (result.signature === null) {
        skipped++;
        failures.push({
          positionId: position.id,
          symbol,
          reason:
            result.closed && result.position.status === 'CLOSED'
              ? 'Zero on-chain balance — reconciled without a sell, no PnL recorded'
              : 'Already handled by another in-flight operation',
        });
      } else {
        closed++;
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : 'Sell failed';
      failures.push({ positionId: position.id, symbol, reason: message });
    }
  }

  return { closed, failed, skipped, failures };
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
          { currentPriceUsd, reason: 'manual_emergency' },
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

  // Admin-only: force-close any user's position, not just the caller's own.
  // Every other manual-sell route above 404s on a position it doesn't own —
  // by design, so one user's session can never touch another's funds — but
  // that also means there was no way for an operator to close a position
  // that a normal user's own bot/dashboard session can't reach (stuck on a
  // different account, or the owning user unreachable). Same
  // closePosition primitive, same rate limit; the only difference is the
  // missing ownership check, gated behind fastify.requireAdmin instead.
  fastify.post(
    '/admin/positions/:id/close',
    { preHandler: fastify.requireAdmin, config: { rateLimit: SELL_RATE_LIMIT } },
    async (req, reply) => {
      if (!fastify.positionManager || !fastify.dexScreener) {
        return reply.code(503).send({ error: 'Trading engine is not available' });
      }
      const { id } = req.params as { id: string };
      const loaded = await loadOpenPositionAny(fastify, id);
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

      fastify.log.warn(
        {
          positionId: position.id,
          mint: position.token.mint,
          symbol: position.token.symbol,
          ownerUserId: position.wallet.userId,
          adminUserId: req.user.userId,
          location: 'apps/api/src/routes/positions.ts:/admin/positions/:id/close',
        },
        'ADMIN FORCE-CLOSE — closing a position on behalf of another user',
      );

      try {
        // Reuses 'manual_emergency' rather than adding a new ExitReason value —
        // this is an emergency-style forced close same as /emergency-sell, just
        // triggered by an admin instead of the position's own owner. The
        // fastify.log.warn above is what distinguishes an admin override in
        // the audit trail; adding a distinct ExitReason would also require
        // updating the telegram-bot's exhaustive EXIT_REASON_LABELS/reason
        // unions for no reporting benefit this task needs.
        const result = await fastify.positionManager.closePosition(
          position.id,
          position.walletId,
          position.wallet.encryptedSecret,
          fastify.config.ENCRYPTION_KEY,
          { currentPriceUsd, reason: 'manual_emergency' },
        );
        return reply.send(result);
      } catch (err) {
        return sendSellError(reply, err);
      }
    },
  );

  fastify.post(
    '/positions/close-all',
    { preHandler: fastify.authenticate, config: { rateLimit: SELL_RATE_LIMIT } },
    async (req, reply) => {
      if (!fastify.positionManager || !fastify.dexScreener) {
        return reply.code(503).send({ error: 'Trading engine is not available' });
      }
      const summary = await closeAllOpenPositions(fastify, req.user.userId);
      return reply.send(summary);
    },
  );
}
