import { describe, expect, it } from 'vitest';
import {
  computeVolatilityAdaptiveTrailingPercent,
  evaluateTp1TrailingStrategy,
  type Tp1TrailingInput,
} from './tp1TrailingStrategy.js';

function baseInput(overrides: Partial<Tp1TrailingInput> = {}): Tp1TrailingInput {
  return {
    entryPriceUsd: 1,
    currentPriceUsd: 1,
    highWaterMarkUsd: 1,
    initialStopLossPercent: 20,
    breakevenStopLossPercent: 2,
    tp1RoiPercent: 50,
    tp1SellFraction: 0.5,
    baseTrailingPercent: 15,
    trailingMinPercent: 10,
    trailingMaxPercent: 25,
    volatilityReferenceStdDevPercent: 5,
    state: { trailingActivatedAt: null },
    ...overrides,
  };
}

describe('computeVolatilityAdaptiveTrailingPercent', () => {
  it('returns the base percent unadjusted when volatility is undefined', () => {
    expect(
      computeVolatilityAdaptiveTrailingPercent({
        baseTrailingPercent: 15,
        volatilityStdDevPercent: undefined,
        volatilityReferenceStdDevPercent: 5,
        trailingMinPercent: 10,
        trailingMaxPercent: 25,
      }),
    ).toBe(15);
  });

  it('widens the trail when volatility is above the reference', () => {
    const result = computeVolatilityAdaptiveTrailingPercent({
      baseTrailingPercent: 15,
      volatilityStdDevPercent: 10, // 2x reference
      volatilityReferenceStdDevPercent: 5,
      trailingMinPercent: 10,
      trailingMaxPercent: 25,
    });
    expect(result).toBe(25); // 15 * clamp(2, 0.5, 2) = 30, clamped to max 25
  });

  it('tightens the trail when volatility is below the reference', () => {
    const result = computeVolatilityAdaptiveTrailingPercent({
      baseTrailingPercent: 15,
      volatilityStdDevPercent: 1, // 0.2x reference, clamped to 0.5x ratio floor
      volatilityReferenceStdDevPercent: 5,
      trailingMinPercent: 10,
      trailingMaxPercent: 25,
    });
    expect(result).toBe(10); // 15 * clamp(0.2, 0.5, 2) = 7.5, clamped to min 10
  });

  it('never exceeds the configured min/max band', () => {
    const wide = computeVolatilityAdaptiveTrailingPercent({
      baseTrailingPercent: 15,
      volatilityStdDevPercent: 1000,
      volatilityReferenceStdDevPercent: 5,
      trailingMinPercent: 10,
      trailingMaxPercent: 25,
    });
    const tight = computeVolatilityAdaptiveTrailingPercent({
      baseTrailingPercent: 15,
      volatilityStdDevPercent: 0.001,
      volatilityReferenceStdDevPercent: 5,
      trailingMinPercent: 10,
      trailingMaxPercent: 25,
    });
    expect(wide).toBeLessThanOrEqual(25);
    expect(tight).toBeGreaterThanOrEqual(10);
  });
});

describe('evaluateTp1TrailingStrategy — pre-TP1 phase', () => {
  it('does nothing while price sits between the stop-loss and TP1 target', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.1, highWaterMarkUsd: 1.1 }),
    );
    expect(action.type).toBe('none');
  });

  it('closes on the initial stop-loss before TP1 ever fires', () => {
    const action = evaluateTp1TrailingStrategy(baseInput({ currentPriceUsd: 0.79 })); // -21%
    expect(action).toMatchObject({ type: 'close', reason: 'stop_loss' });
  });

  it('fires TP1 at exactly the configured ROI threshold, selling the configured fraction', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.5, highWaterMarkUsd: 1.5 }), // +50%
    );
    expect(action).toMatchObject({ type: 'tp1_partial_exit', sellFraction: 0.5 });
  });

  it('does not fire TP1 one cent below the threshold', () => {
    const action = evaluateTp1TrailingStrategy(baseInput({ currentPriceUsd: 1.499 }));
    expect(action.type).toBe('none');
  });

  it('respects a custom tp1SellFraction', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.5, highWaterMarkUsd: 1.5, tp1SellFraction: 0.6 }),
    );
    expect(action).toMatchObject({ type: 'tp1_partial_exit', sellFraction: 0.6 });
  });
});

describe('evaluateTp1TrailingStrategy — post-TP1 trailing phase', () => {
  const postTp1State = { trailingActivatedAt: Date.now() };

  it('never caps upside — no take-profit fires post-TP1 no matter how high the price runs', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 100, highWaterMarkUsd: 100, state: postTp1State }),
    );
    expect(action.type).toBe('none');
  });

  it('does nothing when price sits just above entry with no meaningful pullback from its own high', () => {
    // pnl = +1% (breakeven -2% floor not breached) and high-water-mark equals
    // current price (no drop at all), so neither the breakeven stop-loss nor
    // the trailing stop has anything to fire on.
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.01, highWaterMarkUsd: 1.01, state: postTp1State }),
    );
    expect(action.type).toBe('none');
  });

  it('closes on the breakeven stop-loss on an actual pullback below breakeven', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 0.97, highWaterMarkUsd: 1.5, state: postTp1State }), // -3% < -2%
    );
    expect(action).toMatchObject({ type: 'close', reason: 'stop_loss' });
  });

  it('closes on the trailing stop after a new high followed by a qualifying pullback', () => {
    // High-water mark 2.0, base trailing 15%, no volatility signal -> trailing = 15%.
    // A drop to 1.69 from 2.0 is a 15.5% pullback -> should trigger.
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.69, highWaterMarkUsd: 2.0, state: postTp1State }),
    );
    expect(action).toMatchObject({ type: 'close', reason: 'trailing_stop' });
  });

  it('does not trigger the trailing stop on a pullback smaller than the trailing distance', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 1.9, highWaterMarkUsd: 2.0, state: postTp1State }), // 5% pullback
    );
    expect(action.type).toBe('none');
  });

  it('widens the effective trailing distance under high volatility, avoiding a stop-out a flat 15% trail would have triggered', () => {
    // Same 15.5% pullback from the previous trailing-stop test, but now high
    // volatility (2x reference) widens the trail to 25%, so it should NOT fire.
    const action = evaluateTp1TrailingStrategy(
      baseInput({
        currentPriceUsd: 1.69,
        highWaterMarkUsd: 2.0,
        state: postTp1State,
        volatilityStdDevPercent: 10, // 2x the 5% reference -> ratio clamps to 2 -> 30% clamped to max 25%
      }),
    );
    expect(action.type).toBe('none');
  });

  it('reports the new high-water mark even when no exit fires', () => {
    const action = evaluateTp1TrailingStrategy(
      baseInput({ currentPriceUsd: 2.5, highWaterMarkUsd: 2.0, state: postTp1State }),
    );
    expect(action).toMatchObject({ type: 'none', newHighWaterMarkUsd: 2.5 });
  });
});
