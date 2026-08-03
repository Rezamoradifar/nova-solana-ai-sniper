import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchNetworkTradeLogo } from './fetchNetworkTradeLogo.js';

describe('fetchNetworkTradeLogo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns undefined when no URL is given', async () => {
    expect(await fetchNetworkTradeLogo(undefined)).toBeUndefined();
  });

  it('returns the image bytes on a successful image response', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => bytes.buffer,
      }),
    );

    const result = await fetchNetworkTradeLogo('https://example.com/logo.png');
    expect(result).toEqual(Buffer.from(bytes));
  });

  it('returns undefined on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));
    expect(await fetchNetworkTradeLogo('https://example.com/logo.png')).toBeUndefined();
  });

  it('returns undefined when the content-type is not an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
      }),
    );
    expect(await fetchNetworkTradeLogo('https://example.com/logo.png')).toBeUndefined();
  });

  it('returns undefined when content-length exceeds the size cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': '99999999' }),
      }),
    );
    expect(await fetchNetworkTradeLogo('https://example.com/logo.png')).toBeUndefined();
  });

  it('returns undefined instead of throwing when fetch itself rejects (timeout/network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(fetchNetworkTradeLogo('https://example.com/logo.png')).resolves.toBeUndefined();
  });
});
