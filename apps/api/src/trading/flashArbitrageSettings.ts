import { z } from 'zod';
import type { FlashArbitrageRiskConfig } from './flashArbitrage.js';

const literalBoolean = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  FLASH_ARBITRAGE_ENABLED: literalBoolean,
  FLASH_ARBITRAGE_LIVE_EXECUTION_ENABLED: literalBoolean,
  FLASH_ARBITRAGE_MAX_BORROW_USDC: z
    .string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .default('10000'),
  FLASH_ARBITRAGE_MIN_NET_BPS: z.coerce.number().int().min(1).max(2_000).default(30),
  FLASH_ARBITRAGE_MAX_PRICE_IMPACT_BPS: z.coerce.number().int().min(1).max(2_000).default(25),
  FLASH_ARBITRAGE_MAX_QUOTE_AGE_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
});

function usdcUiToBaseUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

export interface FlashArbitrageSettings {
  enabled: boolean;
  risk: FlashArbitrageRiskConfig;
}

export function loadFlashArbitrageSettings(
  env: Record<string, string | undefined> = process.env,
): FlashArbitrageSettings {
  const parsed = schema.parse(env);
  return {
    enabled: parsed.FLASH_ARBITRAGE_ENABLED,
    risk: {
      maxBorrowBaseUnits: usdcUiToBaseUnits(parsed.FLASH_ARBITRAGE_MAX_BORROW_USDC),
      minNetBps: parsed.FLASH_ARBITRAGE_MIN_NET_BPS,
      maxPriceImpactBps: parsed.FLASH_ARBITRAGE_MAX_PRICE_IMPACT_BPS,
      maxQuoteAgeMs: parsed.FLASH_ARBITRAGE_MAX_QUOTE_AGE_MS,
      liveExecutionEnabled: parsed.FLASH_ARBITRAGE_LIVE_EXECUTION_ENABLED,
    },
  };
}
