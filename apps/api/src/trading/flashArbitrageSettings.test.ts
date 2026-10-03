import { describe, expect, it } from 'vitest';
import { loadFlashArbitrageSettings } from './flashArbitrageSettings.js';

describe('loadFlashArbitrageSettings', () => {
  it('defaults to simulation feature off and live execution independently off', () => {
    const settings = loadFlashArbitrageSettings({});
    expect(settings).toEqual({
      enabled: false,
      risk: {
        maxBorrowBaseUnits: 10_000_000_000n,
        minNetBps: 30,
        maxPriceImpactBps: 25,
        maxQuoteAgeMs: 5_000,
        liveExecutionEnabled: false,
      },
    });
  });

  it('parses USDC to exact six-decimal base units without floating point', () => {
    const settings = loadFlashArbitrageSettings({
      FLASH_ARBITRAGE_ENABLED: 'true',
      FLASH_ARBITRAGE_LIVE_EXECUTION_ENABLED: 'false',
      FLASH_ARBITRAGE_MAX_BORROW_USDC: '1234.567891',
      FLASH_ARBITRAGE_MIN_NET_BPS: '40',
      FLASH_ARBITRAGE_MAX_PRICE_IMPACT_BPS: '20',
      FLASH_ARBITRAGE_MAX_QUOTE_AGE_MS: '2500',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.risk.maxBorrowBaseUnits).toBe(1_234_567_891n);
    expect(settings.risk.liveExecutionEnabled).toBe(false);
  });

  it('rejects ambiguous booleans, excessive precision and unsafe limits', () => {
    expect(() => loadFlashArbitrageSettings({ FLASH_ARBITRAGE_ENABLED: '1' })).toThrow();
    expect(() =>
      loadFlashArbitrageSettings({ FLASH_ARBITRAGE_MAX_BORROW_USDC: '1.0000001' }),
    ).toThrow();
    expect(() => loadFlashArbitrageSettings({ FLASH_ARBITRAGE_MIN_NET_BPS: '0' })).toThrow();
  });
});
