import { envSchema, loadEnv } from '@nova/shared';

export const botEnvSchema = envSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_CHAT_ID: true,
  TELEGRAM_ADMIN_IDS: true,
  ENCRYPTION_KEY: true,
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
