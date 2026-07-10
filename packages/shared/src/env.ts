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

  // Auth / secrets
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(32),

  // Solana / RPC
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  JITO_BLOCK_ENGINE_URL: z.string().url().optional(),
  JITO_AUTH_KEYPAIR: z.string().optional(),

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

  // Third-party market data
  DEXSCREENER_API_BASE: z.string().url().default('https://api.dexscreener.com'),
  JUPITER_API_BASE: z.string().url().default('https://lite-api.jup.ag'),

  // Marketing / links
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  COMMUNITY_URL: z.string().url().optional(),
  REFERRAL_BASE_URL: z.string().url().optional(),
});

export type FullEnv = z.infer<typeof envSchema>;

export function loadEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
