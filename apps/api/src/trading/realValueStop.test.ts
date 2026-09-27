import { describe, expect, it } from 'vitest';
import { evaluateRealValueStop } from './realValueStop.js';

const base = {
  investedSol: 0.1,
  originalAmountToken: 1000,
  remainingAmountToken: 1000,
  stopLossPercent: 20,
  takeProfitStageReached: false,
};

describe('evaluateRealValueStop', () => {
  it('triggers when the sellable value is below the stop-loss', () => {
    const r = evaluateRealValueStop({ ...base, exitValueSol: 0.075 });
    expect(r.breached).toBe(true);
    expect(r.pnlPercent).toBeCloseTo(-25);
  });
  it('does not trigger above the stop-loss', () => {
    expect(evaluateRealValueStop({ ...base, exitValueSol: 0.085 }).breached).toBe(false);
  });
  it('uses the cost basis of only the remaining tokens after a partial sell', () => {
    const r = evaluateRealValueStop({ ...base, remainingAmountToken: 500, exitValueSol: 0.045 });
    expect(r.pnlPercent).toBeCloseTo(-10);
    expect(r.breached).toBe(false);
  });
  it('leaves exits to the trailing stop once take-profit has triggered', () => {
    expect(
      evaluateRealValueStop({ ...base, takeProfitStageReached: true, exitValueSol: 0.01 }).breached,
    ).toBe(false);
  });
  it('does nothing without a stop-loss or with bad inputs', () => {
    expect(
      evaluateRealValueStop({ ...base, stopLossPercent: null, exitValueSol: 0.01 }).breached,
    ).toBe(false);
    expect(evaluateRealValueStop({ ...base, investedSol: 0, exitValueSol: 0.01 }).breached).toBe(
      false,
    );
  });
});
