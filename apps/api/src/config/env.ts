import { envSchema, loadEnv } from '@nova/shared';

export const apiEnvSchema = envSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  API_PORT: true,
  API_HOST: true,
  CORS_ORIGIN: true,
  JWT_SECRET: true,
  ENCRYPTION_KEY: true,
  SOLANA_RPC_URL: true,
  SOLANA_WS_URL: true,
  HELIUS_API_KEY: true,
  JITO_BLOCK_ENGINE_URL: true,
  JITO_AUTH_KEYPAIR: true,
  ANTHROPIC_API_KEY: true,
  OPENAI_API_KEY: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  DEXSCREENER_API_BASE: true,
  JUPITER_API_BASE: true,
});

export function loadApiEnv() {
  return loadEnv(apiEnvSchema);
}

export type ApiEnv = ReturnType<typeof loadApiEnv>;
