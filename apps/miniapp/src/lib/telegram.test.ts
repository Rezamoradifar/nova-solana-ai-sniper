import { describe, expect, it } from 'vitest';
import { initTelegram, getInitDataRaw, haptics } from './telegram.js';

describe('initTelegram (outside Telegram — plain Node/browser environment)', () => {
  it('detects it is not running inside Telegram and never throws', () => {
    expect(() => initTelegram()).not.toThrow();
    expect(initTelegram().isInsideTelegram).toBe(false);
  });

  it('getInitDataRaw() is safely undefined outside Telegram', () => {
    expect(getInitDataRaw()).toBeUndefined();
  });

  it('every haptics method is a safe no-op outside Telegram', () => {
    expect(() => haptics.tap()).not.toThrow();
    expect(() => haptics.success()).not.toThrow();
    expect(() => haptics.error()).not.toThrow();
    expect(() => haptics.impact()).not.toThrow();
  });
});
