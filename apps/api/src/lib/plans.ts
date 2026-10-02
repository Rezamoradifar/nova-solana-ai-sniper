import type { PrismaClient, SubscriptionPlan } from '@prisma/client';
import { effectivePlanKey, FREE_PLAN_KEY, type PlanLimits } from '@nova/shared';

/** Shown when the plans table is somehow empty: today's behaviour, no limits. */
const UNLIMITED_FREE: PlanLimits = {
  key: FREE_PLAN_KEY,
  feeBps: null,
  maxBuySol: null,
  maxOpenPositions: null,
  autoBuyEnabled: true,
};

const CACHE_MS = 30_000;
let cache: { at: number; plans: Map<string, SubscriptionPlan> } | undefined;

export function invalidatePlanCache(): void {
  cache = undefined;
}

export async function loadPlans(prisma: PrismaClient): Promise<Map<string, SubscriptionPlan>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.plans;
  const rows = await prisma.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' } });
  cache = { at: Date.now(), plans: new Map(rows.map((p) => [p.key, p])) };
  return cache.plans;
}

export function toLimits(plan: SubscriptionPlan): PlanLimits {
  return {
    key: plan.key,
    feeBps: plan.feeBps,
    maxBuySol: plan.maxBuySol,
    maxOpenPositions: plan.maxOpenPositions,
    autoBuyEnabled: plan.autoBuyEnabled,
  };
}

/** The limits of the plan a user is on right now (expired paid plans count as free). */
export async function getUserPlanLimits(prisma: PrismaClient, userId: string): Promise<PlanLimits> {
  const [user, plans] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { planKey: true, planExpiresAt: true },
    }),
    loadPlans(prisma),
  ]);
  const key = user ? effectivePlanKey(user) : FREE_PLAN_KEY;
  const plan = plans.get(key) ?? plans.get(FREE_PLAN_KEY);
  return plan ? toLimits(plan) : UNLIMITED_FREE;
}

/** Public shape of a plan (website, bot, Mini App). */
export function publicPlan(p: SubscriptionPlan) {
  return {
    key: p.key,
    name: p.name,
    priceSol: p.priceSol,
    durationDays: p.durationDays,
    feeBps: p.feeBps,
    maxBuySol: p.maxBuySol,
    maxOpenPositions: p.maxOpenPositions,
    autoBuyEnabled: p.autoBuyEnabled,
    features: p.features
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
  };
}
