import { describe, expect, it } from 'vitest';
import { DEFAULT_PUMP_PROTECTION_CONFIG, isExtremePump } from './pumpProtection.js';

describe('isExtremePump', () => {
  it('flags an extreme 1h price move at or above the threshold', () => {
    expect(isExtremePump(500, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(true);
    expect(isExtremePump(1000, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(true);
  });

  it("regression: the USOH incident's +372,983% 24h move would clear the 1h extreme-pump threshold many times over", () => {
    expect(isExtremePump(372_983, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(true);
  });

  it('does not flag ordinary price movement below the threshold', () => {
    expect(isExtremePump(50, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(false);
    expect(isExtremePump(0, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(false);
    expect(isExtremePump(-30, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(false);
  });

  it('does not flag when priceChangeH1 is unresolved — never treated as extreme by default', () => {
    expect(isExtremePump(undefined, DEFAULT_PUMP_PROTECTION_CONFIG)).toBe(false);
  });

  it('respects a custom threshold', () => {
    const config = { extremePumpH1ThresholdPercent: 100 };
    expect(isExtremePump(99, config)).toBe(false);
    expect(isExtremePump(100, config)).toBe(true);
  });
});
