import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';

/** Wrapped SOL mint — the same well-known address used elsewhere in this
 * codebase (e.g. sharedSolPriceOracle) to look up SOL's own USD price. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEXSCREENER_TOKENS_URL = `https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`;
const FETCH_TIMEOUT_MS = 8_000;

export interface MarketContext {
  /** SOL's 24h price change in percent, from the highest-liquidity SOL pair
   * DexScreener returns — undefined if the public API is unreachable/slow,
   * never a stale or guessed value. */
  solPriceChangePct24h?: number;
  /** Count of `Token` rows this platform's own detection pipeline created in
   * the last 24h — a real, first-party number, not a market data point. */
  tokensScreened24h?: number;
}

interface DexScreenerPair {
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
}
interface DexScreenerTokensResponse {
  pairs?: DexScreenerPair[];
}

/** Best-effort, always resolves (never throws) — a marketing post with no
 * live facts falls back to evergreen framing rather than blocking or
 * crashing the scheduled run. */
async function fetchSolPriceChange24h(logger: Logger): Promise<number | undefined> {
  try {
    const res = await fetch(DEXSCREENER_TOKENS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DexScreener responded ${res.status}`);
    const data = (await res.json()) as DexScreenerTokensResponse;
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return undefined;
    // Highest-liquidity pair is the most reliable price source, same
    // reasoning riskAnalyzer.ts already applies when picking among pairs.
    const best = pairs.reduce((a, b) =>
      (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
    );
    const change = best.priceChange?.h24;
    return typeof change === 'number' && Number.isFinite(change) ? change : undefined;
  } catch (err) {
    logger.warn(
      { err },
      'marketing-engine: could not fetch SOL 24h price change — omitting from prompt',
    );
    return undefined;
  }
}

async function fetchTokensScreened24h(
  prisma: PrismaClient,
  logger: Logger,
): Promise<number | undefined> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return await prisma.token.count({ where: { createdAt: { gte: since } } });
  } catch (err) {
    logger.warn(
      { err },
      'marketing-engine: could not read tokensScreened24h — omitting from prompt',
    );
    return undefined;
  }
}

export async function fetchMarketContext(
  prisma: PrismaClient,
  logger: Logger,
): Promise<MarketContext> {
  const [solPriceChangePct24h, tokensScreened24h] = await Promise.all([
    fetchSolPriceChange24h(logger),
    fetchTokensScreened24h(prisma, logger),
  ]);
  return { solPriceChangePct24h, tokensScreened24h };
}

/** Renders the context as an explicit "these numbers only" instruction block
 * for the prompt — undefined when neither figure was available, so the
 * prompt has nothing to inject and category briefs stay evergreen. */
export function formatMarketFacts(ctx: MarketContext): string | undefined {
  const lines: string[] = [];
  if (ctx.solPriceChangePct24h !== undefined) {
    const sign = ctx.solPriceChangePct24h >= 0 ? '+' : '';
    lines.push(`SOL price change (24h): ${sign}${ctx.solPriceChangePct24h.toFixed(1)}%`);
  }
  if (ctx.tokensScreened24h !== undefined) {
    lines.push(
      `Tokens screened by this platform's own detection pipeline (24h): ${ctx.tokensScreened24h}`,
    );
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}
