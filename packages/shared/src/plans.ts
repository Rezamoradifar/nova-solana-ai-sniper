/** Package (subscription plan) rules shared by the api, bot and Mini App. Pure. */

export interface PlanLimits {
  key: string;
  feeBps: number | null;
  maxBuySol: number | null;
  maxOpenPositions: number | null;
  autoBuyEnabled: boolean;
}

export const FREE_PLAN_KEY = 'free';

/** The plan a user is on right now: a paid plan past its expiry falls back to free. */
export function effectivePlanKey(
  user: { planKey: string; planExpiresAt: Date | null },
  now: Date = new Date(),
): string {
  if (user.planKey === FREE_PLAN_KEY) return FREE_PLAN_KEY;
  if (!user.planExpiresAt || user.planExpiresAt.getTime() <= now.getTime()) return FREE_PLAN_KEY;
  return user.planKey;
}

/**
 * When a newly bought plan ends. Renewing the same, still-active plan extends
 * it from its current expiry; anything else starts now.
 */
export function computePlanExpiry(
  current: { planKey: string; planExpiresAt: Date | null },
  newPlanKey: string,
  durationDays: number,
  now: Date = new Date(),
): { startsAt: Date; expiresAt: Date } {
  const stillActive =
    current.planKey === newPlanKey && current.planExpiresAt !== null && current.planExpiresAt > now;
  const startsAt = stillActive ? current.planExpiresAt! : now;
  return { startsAt, expiresAt: new Date(startsAt.getTime() + durationDays * 86_400_000) };
}

/** The buy size a plan allows: the configured size, capped by the plan. */
export function capBuyAmountForPlan(
  amountSol: number,
  plan: Pick<PlanLimits, 'maxBuySol'>,
): number {
  return plan.maxBuySol !== null && plan.maxBuySol > 0
    ? Math.min(amountSol, plan.maxBuySol)
    : amountSol;
}

/** Why a plan blocks a new auto-buy, or undefined when it doesn't. */
export function planBlocksAutoBuy(
  plan: Pick<PlanLimits, 'autoBuyEnabled' | 'maxOpenPositions'>,
  openPositions: number,
): string | undefined {
  if (!plan.autoBuyEnabled) return 'plan_auto_buy_disabled';
  if (plan.maxOpenPositions !== null && openPositions >= plan.maxOpenPositions) {
    return `plan_max_open_positions: ${openPositions}/${plan.maxOpenPositions}`;
  }
  return undefined;
}

/** The fee for a plan: its own override, else the global setting. */
export function planFeeBps(
  plan: Pick<PlanLimits, 'feeBps'> | undefined,
  globalFeeBps: number,
): number {
  return plan?.feeBps ?? globalFeeBps;
}
