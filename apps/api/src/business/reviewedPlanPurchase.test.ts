import { describe, expect, it, vi } from 'vitest';
import { reviewedPlanPurchase } from './reviewedPlanPurchase.js';
import type { PlanPurchaseResult } from './planPurchase.js';

function database() {
  const rows = new Map<string, any>();
  const auditLog = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
    findFirst: vi.fn(
      async ({ where }: any) =>
        [...rows.values()]
          .reverse()
          .find((r) => r.userId === where.userId && r.action === where.action) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      if (rows.has(data.id)) throw new Error('Duplicate');
      rows.set(data.id, data);
      return data;
    }),
  };
  let tail = Promise.resolve();
  const prisma = {
    auditLog,
    $transaction: async (fn: any) => {
      const result = tail.then(() =>
        fn({ auditLog, $queryRaw: vi.fn(async () => [{ locked: 1 }]) }),
      );
      tail = result.catch(() => {});
      return result;
    },
  };
  return { prisma: prisma as never, rows };
}
const intent = { requestId: 'r1', planKey: 'pro', walletId: 'w1', expectedPriceSol: 1.5 };
const success: PlanPurchaseResult = {
  ok: true,
  planKey: 'pro',
  amountSol: 1.5,
  expiresAt: new Date(),
  txSignature: 'sig',
};

describe('reviewed plan payments', () => {
  it('does not broadcast twice for concurrent or repeated requests', async () => {
    const { prisma } = database();
    const pay = vi.fn(async () => success);
    const answers = await Promise.all([
      reviewedPlanPurchase(prisma, 'u1', intent, pay),
      reviewedPlanPurchase(prisma, 'u1', intent, pay),
    ]);
    expect(answers.some((r) => r.ok)).toBe(true);
    expect(pay).toHaveBeenCalledTimes(1);
    expect((await reviewedPlanPurchase(prisma, 'u1', intent, pay)).ok).toBe(true);
    expect(pay).toHaveBeenCalledTimes(1);
  });
  it('blocks a new request after a crash or unknown transfer outcome', async () => {
    const { prisma } = database();
    const pay = vi.fn(async () => {
      throw new Error('DB failed after transfer');
    });
    expect(await reviewedPlanPurchase(prisma, 'u1', intent, pay)).toMatchObject({
      ok: false,
      paymentUncertain: true,
    });
    await reviewedPlanPurchase(prisma, 'u1', { ...intent, requestId: 'new' }, pay);
    expect(pay).toHaveBeenCalledTimes(1);
  });
  it('allows another reviewed attempt after a known validation failure', async () => {
    const { prisma } = database();
    await reviewedPlanPurchase(prisma, 'u1', intent, async () => ({
      ok: false,
      error: 'Insufficient balance',
    }));
    const pay = vi.fn(async () => success);
    expect(
      (await reviewedPlanPurchase(prisma, 'u1', { ...intent, requestId: 'new' }, pay)).ok,
    ).toBe(true);
  });
  it('rejects reuse of an identity for a different price and isolates users', async () => {
    const { prisma } = database();
    const pay = vi.fn(async () => success);
    await reviewedPlanPurchase(prisma, 'u1', intent, pay);
    expect(
      (await reviewedPlanPurchase(prisma, 'u1', { ...intent, expectedPriceSol: 2 }, pay)).ok,
    ).toBe(false);
    expect((await reviewedPlanPurchase(prisma, 'u2', intent, pay)).ok).toBe(true);
    expect(pay).toHaveBeenCalledTimes(2);
  });
  it('keeps an uncertain broadcast result pending across later requests', async () => {
    const { prisma } = database();
    const pay = vi.fn(async (): Promise<PlanPurchaseResult> => ({
      ok: false,
      error: 'Check signature',
      paymentUncertain: true,
    }));
    await reviewedPlanPurchase(prisma, 'u1', intent, pay);
    await reviewedPlanPurchase(prisma, 'u1', { ...intent, requestId: 'new' }, pay);
    expect(pay).toHaveBeenCalledTimes(1);
  });
});
