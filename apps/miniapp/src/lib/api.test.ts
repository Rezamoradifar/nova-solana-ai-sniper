import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.js';
import { setToken } from './authToken.js';

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

function stubFetch(response: { status: number; body?: unknown }) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    void _input;
    void _init;
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api client', () => {
  it('sends no Authorization header when no token is stored', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true } });
    await api.get('/health');
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends a Bearer Authorization header once a token is stored', async () => {
    setToken('jwt-xyz');
    const fetchMock = stubFetch({ status: 200, body: { ok: true } });
    await api.get('/portfolio');
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-xyz');
  });

  it('returns the parsed JSON body on success', async () => {
    stubFetch({ status: 200, body: { id: 'user-1', role: 'TRADER' } });
    const result = await api.get<{ id: string; role: string }>('/auth/me');
    expect(result).toEqual({ id: 'user-1', role: 'TRADER' });
  });

  it('returns undefined for a 204 response without attempting to parse a body', async () => {
    stubFetch({ status: 204 });
    await expect(api.del('/wallets/x')).resolves.toBeUndefined();
  });

  it('throws ApiError with the server-provided message on a non-ok response', async () => {
    stubFetch({ status: 401, body: { error: 'Invalid or expired Telegram authentication data' } });
    await expect(api.get('/auth/me')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or expired Telegram authentication data',
    });
  });

  it('falls back to a generic message when the error response has no body', async () => {
    stubFetch({ status: 500 });
    const err: unknown = await api.get('/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('500');
  });

  it('post() sends a JSON-serialized body with the POST method', async () => {
    const fetchMock = stubFetch({ status: 200, body: { token: 'jwt' } });
    await api.post('/auth/telegram', { initData: 'raw-init-data' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('POST');
    expect(init!.body).toBe(JSON.stringify({ initData: 'raw-init-data' }));
  });
});
