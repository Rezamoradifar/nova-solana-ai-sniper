import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { PlanPurchaseResult } from './planPurchase.js';

type Intent = { requestId: string; planKey: string; walletId: string; expectedPriceSol: number };
const ACTION = 'subscription.payment_intent';
const uncertain: PlanPurchaseResult = {
  ok: false,
  paymentUncertain: true,
  error:
    'A payment is pending or its result is uncertain. Check your subscription and contact support before paying again.',
};

/** Durable, append-only payment intent. The short DB lock ends before any RPC
 * call; an unfinished intent survives Redis loss and blocks another payment. */
export async function reviewedPlanPurchase(
  prisma: PrismaClient,
  userId: string,
  intent: Intent,
  purchase: () => Promise<PlanPurchaseResult>,
): Promise<PlanPurchaseResult> {
  const fingerprint = JSON.stringify([intent.planKey, intent.walletId, intent.expectedPriceSol]);
  const id = 'plan:' + createHash('sha256').update(`${userId}:${intent.requestId}`).digest('hex');
  const previous = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`plan:${userId}`}, 0))`;
    const old = await tx.auditLog.findUnique({ where: { id } });
    if (old) {
      if ((old.metadata as { fingerprint?: string } | null)?.fingerprint !== fingerprint)
        return {
          ok: false,
          error: 'This payment reference belongs to another purchase.',
        } as PlanPurchaseResult;
      const completed = await tx.auditLog.findUnique({ where: { id: `${id}:result` } });
      return completed ? (completed.metadata as unknown as PlanPurchaseResult) : uncertain;
    }
    const latest = await tx.auditLog.findFirst({
      where: { userId, action: ACTION },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) {
      const result = await tx.auditLog.findUnique({ where: { id: `${latest.id}:result` } });
      if (!result || result.status === 'PENDING') return uncertain;
    }
    await tx.auditLog.create({
      data: {
        id,
        userId,
        walletId: intent.walletId,
        action: ACTION,
        status: 'PENDING',
        metadata: {
          fingerprint,
          requestId: intent.requestId,
          planKey: intent.planKey,
          expectedPriceSol: intent.expectedPriceSol,
        },
      },
    });
    return null;
  });
  if (previous) return previous;
  let result: PlanPurchaseResult;
  try {
    result = await purchase();
  } catch {
    return uncertain;
  }
  try {
    await prisma.auditLog.create({
      data: {
        id: `${id}:result`,
        userId,
        action: `${ACTION}.result`,
        status: result.ok ? 'SUCCESS' : result.paymentUncertain ? 'PENDING' : 'FAILED',
        ...(result.ok ? { txSignature: result.txSignature } : {}),
        metadata: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
      },
    });
  } catch {
    return uncertain;
  }
  return result;
}
