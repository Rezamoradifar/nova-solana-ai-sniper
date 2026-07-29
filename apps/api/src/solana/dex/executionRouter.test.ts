import { describe, expect, it } from 'vitest';
import { selectExecutionRoute } from './executionRouter.js';

describe('selectExecutionRoute', () => {
  it('picks native when it quotes strictly more output than Jupiter', () => {
    const decision = selectExecutionRoute(1000n, 1100n);
    expect(decision.selected).toBe('native');
  });

  it('picks jupiter when it quotes strictly more output than native', () => {
    const decision = selectExecutionRoute(1100n, 1000n);
    expect(decision.selected).toBe('jupiter');
  });

  it('picks jupiter on an exact tie (never prefers native without a real advantage)', () => {
    const decision = selectExecutionRoute(1000n, 1000n);
    expect(decision.selected).toBe('jupiter');
  });

  it("always picks jupiter when no native quote is available — matches today's unconditional Jupiter-first behavior", () => {
    const decision = selectExecutionRoute(1000n, undefined);
    expect(decision.selected).toBe('jupiter');
    expect(decision.nativeOutputAmount).toBeUndefined();
  });

  it('always picks jupiter when the native quote is zero or negative (no real depth)', () => {
    expect(selectExecutionRoute(1000n, 0n).selected).toBe('jupiter');
    expect(selectExecutionRoute(1000n, -5n).selected).toBe('jupiter');
  });

  it('preserves both quoted amounts in the decision for logging/observability', () => {
    const decision = selectExecutionRoute(1000n, 1200n);
    expect(decision.jupiterOutputAmount).toBe(1000n);
    expect(decision.nativeOutputAmount).toBe(1200n);
  });
});
