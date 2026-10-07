import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@nova/shared';
import type { ApiEnv } from '../config/env.js';

export const ADMIN_FEATURES = [
  { key: 'LIVE_TRADING', label: 'Live trading' },
  { key: 'ENTRY_FILTER_ENABLED', label: 'Smart entry filter' },
  { key: 'DYNAMIC_SIZING_ENABLED', label: 'Dynamic sizing' },
  { key: 'PARTIAL_EXITS_ENABLED', label: 'Partial exits' },
  { key: 'BEST_ROUTE_EXECUTION_ENABLED', label: 'Best route execution' },
  { key: 'OPPORTUNITY_SCORE_GATE_ENABLED', label: 'Opportunity score gate' },
  { key: 'SMART_MONEY_ANALYSIS_ENABLED', label: 'Smart money analysis' },
  { key: 'EARLY_MOMENTUM_DETECTION_ENABLED', label: 'Early momentum detection' },
  { key: 'EMERGENCY_EXIT_ENABLED', label: 'Emergency exit engine' },
  { key: 'EXIT_STRATEGY_V2_ENABLED', label: 'TP1 / breakeven / trailing' },
  { key: 'ARBITRAGE_SCANNER_ENABLED', label: 'Arbitrage radar' },
  { key: 'NETWORK_TRADE_SCANNER_ENABLED', label: 'External network trade scanner' },
  { key: 'TELEGRAM_TREND_SOURCE_ENABLED', label: 'Telegram trend source' },
  { key: 'DEPOSIT_MONITOR_ENABLED', label: 'Deposit monitor' },
  { key: 'SHADOW_MODE_ENABLED', label: 'Shadow-mode evaluation' },
] as const;

export type AdminFeatureKey = (typeof ADMIN_FEATURES)[number]['key'];

const KEYS = new Set<string>(ADMIN_FEATURES.map((f) => f.key));

export function isAdminFeatureKey(value: string): value is AdminFeatureKey {
  return KEYS.has(value);
}

/**
 * Applies persisted operator feature choices before background workers are
 * constructed. Numeric risk limits and secrets remain env-owned; only this
 * narrow allowlist of boolean feature gates can be overridden from Admin.
 */
export async function applyAdminFeatureOverrides(
  prisma: PrismaClient,
  config: ApiEnv,
  logger: Logger,
): Promise<void> {
  try {
    const rows = await prisma.adminFeatureOverride.findMany();
    const mutable = config as unknown as Record<string, unknown>;
    for (const row of rows) {
      if (!isAdminFeatureKey(row.key)) continue;
      mutable[row.key] = row.enabled;
    }
    if (rows.length > 0) {
      logger.info(
        { count: rows.length, keys: rows.map((r) => r.key) },
        'applied persisted admin feature overrides',
      );
    }
  } catch (err) {
    // Backward-safe during a rolling deploy before the new migration exists.
    logger.warn({ err }, 'admin feature overrides unavailable — using env feature flags');
  }
}
