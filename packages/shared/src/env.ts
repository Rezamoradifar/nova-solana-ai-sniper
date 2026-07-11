import { z } from 'zod';

/**
 * `z.coerce.boolean()` is a footgun for env vars: `Boolean("false")` is `true`,
 * so it would turn LIVE_TRADING=false into `true`. This only accepts the literal
 * strings "true"/"false".
 */
function booleanFlag(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');
}

/**
 * Full superset of env vars used anywhere in the platform. Individual apps
 * import `envSchema.pick({...})` to validate only the vars they actually need,
 * so a missing Twitter key doesn't stop the API from booting, for example.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // Core infra
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Trading mode — the one hard safety switch. Real swaps only ever execute
  // when LIVE_TRADING is the literal string "true"; every other value (unset,
  // "false", typos) keeps the position manager in paper-fill mode.
  PAPER_TRADING: booleanFlag(true),
  LIVE_TRADING: booleanFlag(false),

  // Live-trading safety rails — operator-controlled ceilings independent of any
  // per-user SnipeConfig, enforced on every open (paper or live) except the
  // on-chain balance check, which only makes sense for real swaps.
  MAX_TRADE_SOL: z.coerce.number().positive().default(1),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(50),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  MIN_WALLET_RESERVE_SOL: z.coerce.number().nonnegative().default(0.01),
  // Emergency stop. This env value is a hard, restart-required override; the
  // real "flip it right now without redeploying" switch lives in Redis (see
  // apps/api/src/trading/safety.ts) and is toggled via the /killswitch admin command.
  KILL_SWITCH: booleanFlag(false),

  // Master switches for the staged profitability improvements — each defaults
  // to false (today's behavior, unchanged) and is a second layer on top of the
  // per-SnipeConfig opt-in fields (entryFilterEnabled, dynamicSizingEnabled,
  // etc): both this flag AND the per-user config must opt in before any new
  // logic runs. Lets an operator dark-launch or kill a whole stage instantly,
  // without a redeploy, independent of what any individual user has configured.
  ENTRY_FILTER_ENABLED: booleanFlag(false),
  DYNAMIC_SIZING_ENABLED: booleanFlag(false),
  PARTIAL_EXITS_ENABLED: booleanFlag(false),
  BEST_ROUTE_EXECUTION_ENABLED: booleanFlag(false),

  // Auth / secrets
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(32),

  // Solana / RPC
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  // Additional RPC providers, all optional — when set, each becomes one more
  // provider in the load-balanced/failover pool (see solana/connection.ts and
  // solana/resilientConnection.ts). Same graceful-no-op pattern as every other
  // optional integration in this codebase: unset simply means one less provider
  // in the rotation, not a startup error.
  QUICKNODE_RPC_URL: z.string().url().optional(),
  // QuickNode's WSS endpoint (same host as QUICKNODE_RPC_URL) — only used for
  // subscriptions when QuickNode ends up as the primary (first) provider.
  QUICKNODE_WS_URL: z.string().url().optional(),
  CHAINSTACK_RPC_URL: z.string().url().optional(),
  // Comma-separated list of any further RPC endpoints an operator wants in the
  // rotation (e.g. a self-hosted node, Ankr, Triton) without a dedicated env var each.
  ADDITIONAL_RPC_URLS: z.string().optional(),
  JITO_BLOCK_ENGINE_URL: z.string().url().optional(),
  JITO_AUTH_KEYPAIR: z.string().optional(),
  // Ceiling passed to Jupiter's dynamic/tiered priority-fee estimation — an
  // operator-controlled cap, same pattern as MAX_TRADE_SOL, so a fee spike can't
  // silently burn an unbounded amount of SOL per swap.
  MAX_PRIORITY_FEE_LAMPORTS: z.coerce.number().positive().default(1_000_000),

  // AI providers
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_IDS: z.string().optional(),

  // Twitter / X
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_SECRET: z.string().optional(),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_SEARCH_QUERY: z
    .string()
    .default('(pump.fun OR "solana memecoin" OR $SOL) -is:retweet lang:en'),
  TWITTER_POLL_INTERVAL_MS: z.coerce.number().min(15000).default(60000),

  // Telegram trend channels (signal source only — see apps/api/src/social/
  // telegramTrend.ts). Reads each channel's public HTML preview
  // (https://t.me/s/<channel>), no bot membership or login required. Master
  // switch defaults to false, same double-opt-in convention as
  // ENTRY_FILTER_ENABLED: a mint surfaced here still goes through the exact
  // same risk/AI/safety pipeline as any on-chain detection before anything
  // can buy it, gated per-user by each SnipeConfig's own autoBuyOnLaunch.
  TELEGRAM_TREND_SOURCE_ENABLED: booleanFlag(false),
  TELEGRAM_TREND_CHANNELS: z.string().default('trendingssol,trending'),
  TELEGRAM_TREND_POLL_INTERVAL_MS: z.coerce.number().min(15000).default(20000),
  // "AI Score < configured minimum" gate for this source specifically —
  // deliberately separate from SnipeConfig.minAiScore (a buy-gate) since this
  // one exists purely to keep low-quality Telegram-sourced candidates out of
  // the Launch Feed/notifications before a user-level config is even consulted.
  TELEGRAM_TREND_MIN_AI_SCORE: z.coerce.number().min(0).max(100).default(50),

  // Third-party market data
  DEXSCREENER_API_BASE: z.string().url().default('https://api.dexscreener.com'),
  JUPITER_API_BASE: z.string().url().default('https://lite-api.jup.ag'),
  // How often open positions are re-priced to evaluate take-profit/stop-loss/trailing-stop.
  PRICE_CHECK_INTERVAL_MS: z.coerce.number().min(5000).default(15000),
  // How often recently-seen pump.fun tokens are polled for a bonding-curve migration —
  // rarer than a price tick, so a longer default interval than PRICE_CHECK_INTERVAL_MS.
  MIGRATION_CHECK_INTERVAL_MS: z.coerce.number().min(10000).default(30000),

  // Marketing / links
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  COMMUNITY_URL: z.string().url().optional(),
  REFERRAL_BASE_URL: z.string().url().optional(),
});

export type FullEnv = z.infer<typeof envSchema>;

/**
 * A key present in `.env` but left blank (`COMMUNITY_URL=`) is how operators
 * naturally spell "not configured yet" — but dotenv loads that as `""`, not
 * `undefined`, so it fails `.optional()` fields that also validate shape
 * (`.url()`, `.email()`, etc.): blank fails the shape check instead of being
 * treated as absent. Normalizing blank strings to `undefined` before parsing
 * makes "key missing" and "key present but blank" behave identically for
 * every optional field, without weakening required (non-optional) fields —
 * a blank required field still fails validation, just as "Required" instead
 * of a shape error, which is arguably clearer anyway.
 */
function withBlankStringsAsUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]));
}

export function loadEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(withBlankStringsAsUndefined(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
