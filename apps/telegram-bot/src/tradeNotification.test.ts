import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dexscreenerChartUrl,
  fetchDexScreenerChartImage,
  formatTradePhotoCaption,
  resolveTradePhoto,
  sendTradeNotificationPhoto,
  solscanTokenUrl,
  solscanTxUrl,
  type TradeNotificationData,
} from './tradeNotification.js';
import * as priceChart from './priceChart.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trade(overrides: Partial<TradeNotificationData> = {}): TradeNotificationData {
  return {
    mint: 'MintAbc123',
    tokenName: 'Example Token',
    tokenSymbol: 'EXT',
    dex: 'RAYDIUM',
    buyAt: new Date('2026-07-27T10:00:00Z'),
    sellAt: new Date('2026-07-27T10:30:00Z'),
    roiPercent: 50,
    pnlUsd: 25,
    aiScore: 92,
    buySignature: 'buySig123',
    sellSignature: 'sellSig456',
    liquidityUsd: 12_000,
    marketCapUsd: 80_000,
    volume24hUsd: 45_000,
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.0015,
    ...overrides,
  };
}

describe('link builders', () => {
  it('build real, direct Solscan/DexScreener URLs', () => {
    expect(solscanTxUrl('abc')).toBe('https://solscan.io/tx/abc');
    expect(solscanTokenUrl('MintX')).toBe('https://solscan.io/token/MintX');
    expect(dexscreenerChartUrl('MintX')).toBe('https://dexscreener.com/solana/MintX');
  });
});

describe('formatTradePhotoCaption', () => {
  it('includes every required field from the 2026-07-28 spec', () => {
    const text = formatTradePhotoCaption(trade());
    expect(text).toContain('REAL BOT TRADE');
    expect(text).toContain('Name: Example Token');
    expect(text).toContain('MintAbc123');
    expect(text).toContain('DEX: RAYDIUM');
    expect(text).toContain('Buy: 2026-07-27 10:00');
    expect(text).toContain('Sell: 2026-07-27 10:30');
    expect(text).toContain('Hold: 30m');
    expect(text).toContain('+50.0%');
    expect(text).toContain('$25.00');
    expect(text).toContain('92/100');
    expect(text).toContain('Liquidity: $12000.00');
    expect(text).toContain('Market Cap: $80000.00');
    expect(text).toContain('24h Volume: $45000.00');
    expect(text).toContain('https://solscan.io/tx/buySig123');
    expect(text).toContain('https://solscan.io/tx/sellSig456');
    expect(text).toContain('https://dexscreener.com/solana/MintAbc123');
    expect(text).toContain('GSP Bank Sniper');
  });

  it('renders N/A rather than omitting a line when AI score/enrichment/tx signatures are unavailable', () => {
    const text = formatTradePhotoCaption(
      trade({
        aiScore: undefined,
        liquidityUsd: undefined,
        marketCapUsd: undefined,
        volume24hUsd: undefined,
        buySignature: undefined,
        sellSignature: undefined,
      }),
    );
    expect(text).toContain('AI Score: *N/A*');
    expect(text).toContain('Liquidity: N/A');
    expect(text).toContain('Market Cap: N/A');
    expect(text).toContain('24h Volume: N/A');
    expect(text).toContain('Buy TX: N/A');
    expect(text).toContain('Sell TX: N/A');
  });

  it('escapes Markdown special characters in a token name/symbol', () => {
    const text = formatTradePhotoCaption(
      trade({ tokenName: '[Fake_Link](http://evil.example)', tokenSymbol: 'A*B' }),
    );
    expect(text).toContain('A\\*B');
    expect(text).toContain('\\[Fake\\_Link\\]');
  });

  it("never exceeds Telegram's 1024-char photo caption limit, keeping the DexScreener link and footer intact", () => {
    const text = formatTradePhotoCaption(trade({ tokenName: 'X'.repeat(2000) }));
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text).toContain('https://dexscreener.com/solana/MintAbc123');
    expect(text).toContain('GSP Bank Sniper');
  });
});

describe('fetchDexScreenerChartImage', () => {
  it('extracts og:image from the page HTML and downloads it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '<html><head><meta property="og:image" content="https://cdn.example/chart.png"></head></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchDexScreenerChartImage('MintAbc');

    expect(result?.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://dexscreener.com/solana/MintAbc',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example/chart.png',
      expect.anything(),
    );
  });

  it('returns undefined when the page has no og:image tag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }),
    );
    expect(await fetchDexScreenerChartImage('MintAbc')).toBeUndefined();
  });

  it('returns undefined on a non-2xx page response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    expect(await fetchDexScreenerChartImage('MintAbc')).toBeUndefined();
  });

  it('returns undefined on a network error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await fetchDexScreenerChartImage('MintAbc')).toBeUndefined();
  });
});

describe('resolveTradePhoto', () => {
  it('falls back to a self-rendered real-data price chart when no official chart image is found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }), // no og:image
    );
    const chartSpy = vi
      .spyOn(priceChart, 'resolveRealPriceChartPhoto')
      .mockResolvedValue({ buffer: Buffer.from([9]) });

    const result = await resolveTradePhoto(trade());

    expect(result?.buffer).toEqual(Buffer.from([9]));
    expect(chartSpy).toHaveBeenCalledWith(trade());
  });

  it('never falls back to a token logo — returns undefined when neither real chart source is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }),
    );
    vi.spyOn(priceChart, 'resolveRealPriceChartPhoto').mockResolvedValue(undefined);

    expect(await resolveTradePhoto(trade())).toBeUndefined();
  });

  it('uses the official DexScreener chart image without touching the real-data chart when the scrape succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '<html><head><meta property="og:image" content="https://cdn.example/chart.png"></head></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    vi.stubGlobal('fetch', fetchMock);
    const chartSpy = vi.spyOn(priceChart, 'resolveRealPriceChartPhoto');

    const result = await resolveTradePhoto(trade());

    expect(result?.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(chartSpy).not.toHaveBeenCalled();
  });
});

describe('sendTradeNotificationPhoto', () => {
  it('calls sendPhoto with the resolved image and caption when a photo is available', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });
    const bot = { api: { sendPhoto, sendMessage: vi.fn() } } as never;

    await sendTradeNotificationPhoto(bot, 'chat1', 'caption text', { buffer: Buffer.from([1]) });

    expect(sendPhoto).toHaveBeenCalledWith(
      'chat1',
      expect.anything(),
      expect.objectContaining({ caption: 'caption text', parse_mode: 'Markdown' }),
    );
  });

  it('sends the raw file_id string directly (no InputFile wrap) when reusing a previously-uploaded photo', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 2 });
    const bot = { api: { sendPhoto, sendMessage: vi.fn() } } as never;

    await sendTradeNotificationPhoto(bot, 'chat1', 'caption text', { fileId: 'AgACAgFILEID' });

    expect(sendPhoto).toHaveBeenCalledWith(
      'chat1',
      'AgACAgFILEID',
      expect.objectContaining({ caption: 'caption text', parse_mode: 'Markdown' }),
    );
  });

  it('falls back to sendMessage with the same caption text when no photo is available', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const bot = { api: { sendPhoto: vi.fn(), sendMessage } } as never;

    await sendTradeNotificationPhoto(bot, 'chat1', 'caption text', undefined);

    expect(sendMessage).toHaveBeenCalledWith(
      'chat1',
      'caption text',
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });
});
