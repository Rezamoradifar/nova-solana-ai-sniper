import { envSchema, loadEnv } from '@nova/shared';

export const botEnvSchema = envSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  TELEGRAM_ADMIN_IDS: true,
  TELEGRAM_PRIVATE_MODE: true,
  MINIAPP_URL: true,
  ENCRYPTION_KEY: true,
  // Used only to mint short-lived service JWTs so the bot can call apps/api's
  // own authenticated position-close routes on behalf of the Telegram user it
  // already resolved (see api/client.ts) — reusing the exact same
  // PositionManager/Jupiter swap pipeline apps/api's Mini App and dashboard
  // already call, instead of a second sell engine living in this process.
  // No new trust boundary: this process already holds ENCRYPTION_KEY, which
  // can decrypt any user's wallet private key — a strictly more powerful
  // secret than a JWT signer.
  JWT_SECRET: true,
  API_PORT: true,
  INTERNAL_API_URL: true,
  TELEGRAM_TREND_SOURCE_ENABLED: true,
  TELEGRAM_TREND_CHANNELS: true,
  TELEGRAM_TREND_MIN_AI_SCORE: true,
  TELEGRAM_TREND_POLL_INTERVAL_MS: true,
  SOLANA_RPC_URL: true,
  HELIUS_API_KEY: true,
});

export function loadBotEnv() {
  return loadEnv(botEnvSchema);
}

export type BotEnv = ReturnType<typeof loadBotEnv>;

export function parseAdminIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
