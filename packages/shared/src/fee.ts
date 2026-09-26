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

export interface ProfitDistributionResult {
  userShareUsd: number;
  platformShareUsd: number;
  referralRewards: ReferralRewardDistribution[];
}

/**
 * Splits net profit using the admin's BusinessSettings: the platform fee
 * (`platformFeeBps` of net profit) forms the pool, each referral level takes its
 * `percentBps` of net profit out of that pool, and whatever is left (including
 * any level with no referrer) goes to the platform. chain[0] is the Level-1
 * referrer. If the configured levels ever exceed the pool they are scaled down
 * so the four shares still sum to exactly net profit. Callers only invoke this
 * on a profitable close.
 */
export function calculateProfitDistribution(
  netProfitUsd: number,
  chain: ReferralChainLink[],
  config: { platformFeeBps: number; levels: ReferralLevelInput[] },
): ProfitDistributionResult {
  const feeBps = Math.min(10_000, Math.max(0, config.platformFeeBps));
  const poolUsd = netProfitUsd * (feeBps / 10_000);
  const userShareUsd = netProfitUsd - poolUsd;

  let referralRewards: ReferralRewardDistribution[] = [];
  chain.forEach((link, i) => {
    const level = i + 1;
    const levelConfig = config.levels.find((l) => l.level === level);
    if (!levelConfig || !levelConfig.enabled || levelConfig.percentBps <= 0) return;
    referralRewards.push({
      referrerUserId: link.userId,
      level,
      percentBps: levelConfig.percentBps,
      rewardUsd: netProfitUsd * (levelConfig.percentBps / 10_000),
    });
  });

  const referralTotal = referralRewards.reduce((sum, r) => sum + r.rewardUsd, 0);
  if (referralTotal > poolUsd && referralTotal > 0) {
    const scale = poolUsd / referralTotal;
    referralRewards = referralRewards
      .map((r) => ({ ...r, rewardUsd: r.rewardUsd * scale }))
      .filter((r) => r.rewardUsd > 0);
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
  /** Set from the admin panel; when null the PLATFORM_TREASURY_WALLET_ADDRESS env value is used. */
  treasuryWalletAddress: string | null;
  referralLevels: ReferralLevelInput[];
  // Final Opportunity Score (Section 7) weights — see opportunityScore.ts.
  safetyWeightBps: number;
  momentumWeightBps: number;
  walletWeightBps: number;
  socialWeightBps: number;
  aiWeightBps: number;
  // 2026-07-29, DEX-agnostic adapter refactor — see opportunityScore.ts's
  // bandLiquidityDepthScore.
  liquidityDepthWeightBps: number;
}

const DEFAULT_PERFORMANCE_FEE_BPS = 2000; // 20%
const DEFAULT_REFERRAL_LEVELS: Omit<ReferralLevelInput, 'level'>[] = [
  { percentBps: 1000, enabled: true }, // level 1: 10% of net profit
  { percentBps: 500, enabled: true }, // level 2: 5% of net profit
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
