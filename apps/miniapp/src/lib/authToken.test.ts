import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, setToken } from './authToken.js';

/** Node has no global localStorage — a tiny Map-backed polyfill satisfying
 * just the getItem/setItem/removeItem surface this module actually uses. */
function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authToken', () => {
  it('returns null when no token has been set', () => {
    expect(getToken()).toBeNull();
  });

  it('round-trips a token through set/get', () => {
    setToken('jwt-abc-123');
    expect(getToken()).toBe('jwt-abc-123');
  });

  it('clearToken removes a previously stored token', () => {
    setToken('jwt-abc-123');
    clearToken();
    expect(getToken()).toBeNull();
  });
});
