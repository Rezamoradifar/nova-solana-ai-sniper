import type { PrismaClient } from '@prisma/client';

/**
 * Pure performance-fee and referral-distribution calculations — no DB/RPC
 * access, exhaustively unit-testable, same style as entryFilter.ts's
 * evaluateEntry. The only DB-touching helpers here are resolveReferralChain
 * (a read-only walk of the already-existing referredByCode linkage) and
 * getOrCreateBusinessSettings (lazy-seeds sane defaults).
 */

export interface FeeCalculationInput {
  /** Position.realizedPnlUsd — the existing price-based PnL figure, unchanged. */
  grossProfitUsd: number;
  /** Derived from the real on-chain SOL deltas of the matched BUY/SELL trades,
   * when they can be found — undefined means "unknown," not "zero." */
  actualNetProfitUsd: number | undefined;
  feeBps: number;
}

export interface FeeCalculationResult {
  grossProfitUsd: number;
  tradingCostsUsd: number;
  netProfitUsd: number;
  feeBps: number;
  feeUsd: number;
  userShareUsd: number;
}

/**
 * Never charges a fee on a losing or break-even trade. netProfitUsd is
 * clamped to the smaller of the price-based gross figure and the real
 * SOL-delta-based figure (when known) — a conservative choice in both
 * directions: never charge more than the "official" gross PnL already shown
 * elsewhere in the app, and never charge on a gross figure that looks
 * profitable on paper but wasn't in real on-chain terms once slippage/gas
 * are accounted for. tradingCostsUsd is the gap between the two — a
 * genuinely derived number, not a guess or a persisted-but-unmeasured field.
 */
export function calculatePerformanceFee(
  input: FeeCalculationInput,
): FeeCalculationResult | undefined {
  const netProfitUsd =
    input.actualNetProfitUsd !== undefined
      ? Math.min(input.grossProfitUsd, input.actualNetProfitUsd)
      : input.grossProfitUsd;

  if (netProfitUsd <= 0) return undefined;

  const tradingCostsUsd = Math.max(0, input.grossProfitUsd - netProfitUsd);
  const feeUsd = netProfitUsd * (input.feeBps / 10_000);
  const userShareUsd = netProfitUsd - feeUsd;

  return {
    grossProfitUsd: input.grossProfitUsd,
    tradingCostsUsd,
    netProfitUsd,
    feeBps: input.feeBps,
    feeUsd,
    userShareUsd,
  };
}

/**
 * The hard, explicit backward-compatibility guarantee: a position is only
 * ever eligible for fee processing if it closed at or after the moment the
 * fee system was activated (BusinessSettings.feeSystemActivatedAt — see the
 * migration's own doc comment for why this is always "the deployment
 * moment," not something requiring manual backfill). Deliberately checks
 * ONLY the trade's own close time — never the user's own createdAt/account
 * age — so an existing user from before this feature shipped is charged
 * exactly like a brand-new one on any trade that closes from now on, with
 * zero migration step of their own. A null closedAt (shouldn't happen for a
 * CLOSED position, but never trust that blindly) is treated as ineligible,
 * not as "unknown, charge anyway."
 */
export function isEligibleForFeeProcessing(
  positionClosedAt: Date | null,
  feeSystemActivatedAt: Date,
): boolean {
  if (!positionClosedAt) return false;
  return positionClosedAt.getTime() >= feeSystemActivatedAt.getTime();
}

export interface ReferralChainLink {
  userId: string;
}

export interface ReferralLevelInput {
  level: number;
  percentBps: number;
  enabled: boolean;
}

export interface ReferralRewardDistribution {
  referrerUserId: string;
  level: number;
  percentBps: number;
  rewardUsd: number;
}

/**
 * Splits the platform's fee (not the trader's profit) across an already-
 * resolved referrer chain — chain[0] is the level-1 (direct) referrer,
 * chain[1] is level 2, etc. A disabled level or a level with no configured
 * percent yields nothing, and the chain is never walked past maxDepth even
 * if it's longer (resolveReferralChain already stops there too — this is a
 * second, cheap guard, not a correctness dependency on the caller).
 */
export function calculateReferralRewards(
  feeUsd: number,
  chain: ReferralChainLink[],
  levels: ReferralLevelInput[],
  maxDepth: number,
): ReferralRewardDistribution[] {
  const results: ReferralRewardDistribution[] = [];
  const depth = Math.min(chain.length, maxDepth);

  for (let i = 0; i < depth; i++) {
    const level = i + 1;
    const levelConfig = levels.find((l) => l.level === level);
    if (!levelConfig || !levelConfig.enabled || levelConfig.percentBps <= 0) continue;

    const rewardUsd = feeUsd * (levelConfig.percentBps / 10_000);
    if (rewardUsd <= 0) continue;

    results.push({
      referrerUserId: chain[i]!.userId,
      level,
      percentBps: levelConfig.percentBps,
      rewardUsd,
    });
  }

  return results;
}

/**
 * Section 14 (2026-07-18): a FIXED, permanent profit split — 80% to the
 * trader, 10% to their Level-1 referrer, 5% to Level-2, 5% to the platform —
 * deliberately independent of BusinessSettings.performanceFeeBps (which stays
 * admin-adjustable for reporting/display purposes only). Before this, the
 * live referral system split the platform's *fee* 10%/5% between L1/L2 (a
 * cut of a cut — with the fee at its current 20% default, that worked out to
 * only 2%/1% of actual profit); this replaces that computation so referrers
 * get 10%/5% of profit directly, regardless of what performanceFeeBps is set
 * to now or in the future.
 */
export const FIXED_USER_SHARE_BPS = 8000; // 80% of net profit, always
export const FIXED_REFERRAL_L1_BPS = 1000; // 10% of net profit
export const FIXED_REFERRAL_L2_BPS = 500; // 5% of net profit
// The remaining 20% (poolUsd below) is the platform's base pool; unclaimed
// referrer shares (no L1 and/or no L2) roll into the platform's share
// automatically via the subtraction in calculateFixedProfitDistribution —
// never a separate branch, so the four shares always sum to exactly 100%.

export interface ProfitDistributionResult {
  userShareUsd: number;
  platformShareUsd: number;
  referralRewards: ReferralRewardDistribution[];
}

/**
 * chain[0] is the Level-1 referrer, chain[1] is Level-2 — same ordering as
 * resolveReferralChain, whose own walk-upward construction means index 1 can
 * only be present if index 0 also is (so "L2 present but not L1" can't
 * occur). Assumes netProfitUsd > 0 — callers already gate on that via
 * calculatePerformanceFee's own `netProfitUsd <= 0 -> undefined` return, so
 * this never runs on a losing or break-even close.
 */
export function calculateFixedProfitDistribution(
  netProfitUsd: number,
  chain: ReferralChainLink[],
): ProfitDistributionResult {
  const userShareUsd = netProfitUsd * (FIXED_USER_SHARE_BPS / 10_000);
  const poolUsd = netProfitUsd - userShareUsd;

  const referralRewards: ReferralRewardDistribution[] = [];
  if (chain[0]) {
    referralRewards.push({
      referrerUserId: chain[0].userId,
      level: 1,
      percentBps: FIXED_REFERRAL_L1_BPS,
      rewardUsd: netProfitUsd * (FIXED_REFERRAL_L1_BPS / 10_000),
    });
  }
  if (chain[1]) {
    referralRewards.push({
      referrerUserId: chain[1].userId,
      level: 2,
      percentBps: FIXED_REFERRAL_L2_BPS,
      rewardUsd: netProfitUsd * (FIXED_REFERRAL_L2_BPS / 10_000),
    });
  }

  const platformShareUsd = poolUsd - referralRewards.reduce((sum, r) => sum + r.rewardUsd, 0);

  return { userShareUsd, platformShareUsd, referralRewards };
}

const DEFAULT_MAX_REFERRAL_DEPTH = 2;

/**
 * Walks User.referredByCode upward from userId — chain[0] is userId's own
 * direct referrer (level 1), chain[1] is that referrer's own referrer
 * (level 2), and so on, stopping at maxDepth or the first user with no
 * referrer on file. Cycle-guarded (a visited-userId set) in case of a data
 * anomaly — this is a read-only traversal of data that already exists for
 * an unrelated purpose (the free-config referral reward), not a new
 * relation.
 */
export async function resolveReferralChain(
  prisma: PrismaClient,
  userId: string,
  maxDepth: number = DEFAULT_MAX_REFERRAL_DEPTH,
): Promise<ReferralChainLink[]> {
  const chain: ReferralChainLink[] = [];
  const visited = new Set<string>([userId]);

  let current = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredByCode: true },
  });

  while (current?.referredByCode && chain.length < maxDepth) {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: current.referredByCode },
      select: { id: true, referredByCode: true },
    });
    if (!referrer || visited.has(referrer.id)) break;

    chain.push({ userId: referrer.id });
    visited.add(referrer.id);
    current = referrer;
  }

  return chain;
}

export interface BusinessSettingsWithLevels {
  id: string;
  performanceFeeBps: number;
  referralProgramEnabled: boolean;
  maxReferralDepth: number;
  feeSystemActivatedAt: Date;
  referralLevels: ReferralLevelInput[];
  // Final Opportunity Score (Section 7) weights — see opportunityScore.ts.
  safetyWeightBps: number;
  momentumWeightBps: number;
  walletWeightBps: number;
  socialWeightBps: number;
  aiWeightBps: number;
}

const DEFAULT_PERFORMANCE_FEE_BPS = 2000; // 20%
const DEFAULT_REFERRAL_LEVELS: Omit<ReferralLevelInput, 'level'>[] = [
  { percentBps: 1000, enabled: true }, // level 1: 10% of the platform fee
  { percentBps: 500, enabled: true }, // level 2: 5% of the platform fee
];

/**
 * Lazily seeds one BusinessSettings row (+ its default referral levels) on
 * first access, so the system works with sane, disclosed defaults before any
 * admin has touched it — same "works out of the box, admin can override"
 * convention as everything else configurable in this app.
 */
export async function getOrCreateBusinessSettings(
  prisma: PrismaClient,
): Promise<BusinessSettingsWithLevels> {
  const existing = await prisma.businessSettings.findFirst({
    include: { referralLevels: true },
    orderBy: { id: 'asc' },
  });
  if (existing) return existing;

  const created = await prisma.businessSettings.create({
    data: {
      performanceFeeBps: DEFAULT_PERFORMANCE_FEE_BPS,
      maxReferralDepth: DEFAULT_MAX_REFERRAL_DEPTH,
      referralLevels: {
        create: DEFAULT_REFERRAL_LEVELS.map((level, i) => ({ level: i + 1, ...level })),
      },
    },
    include: { referralLevels: true },
  });
  return created;
}
