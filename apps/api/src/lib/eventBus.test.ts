import { describe, expect, it, vi } from 'vitest';
import { eventBus } from './eventBus.js';

describe('eventBus', () => {
  it('delivers published events to subscribers', () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.subscribe(handler);

    eventBus.publish('token.created', { mint: 'abc' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'token.created', payload: { mint: 'abc' } }),
    );
    unsubscribe();
  });

  it('stops delivering events after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = eventBus.subscribe(handler);
    unsubscribe();

    eventBus.publish('trade.created', { tradeId: '1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple independent subscribers', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = eventBus.subscribe(handlerA);
    const unsubB = eventBus.subscribe(handlerB);

    eventBus.publish('position.updated', { positionId: '1' });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});
