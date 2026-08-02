import { describe, expect, it } from 'vitest';
import { buildTokenButtonRows } from './tokenButtons.js';

const MINT = '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9';

describe('buildTokenButtonRows', () => {
  it('always includes Buy + Chart on the first row', () => {
    const rows = buildTokenButtonRows({ mint: MINT });
    expect(rows[0]).toEqual([
      { text: '⚡ Buy', url: `https://jup.ag/swap/SOL-${MINT}` },
      { text: '📊 Chart', url: `https://dexscreener.com/solana/${MINT}` },
    ]);
  });

  it('uses the pump.fun buy link for PUMPFUN/PUMPSWAP dex', () => {
    const rows = buildTokenButtonRows({ mint: MINT, dex: 'PUMPFUN' });
    expect(rows[0]?.[0]?.url).toBe(`https://pump.fun/coin/${MINT}`);
  });

  it('includes a Track deep link when a bot username is provided', () => {
    const rows = buildTokenButtonRows({ mint: MINT, botUsername: 'novasniperbot' });
    const midRow = rows[1];
    expect(midRow).toContainEqual({
      text: '🔎 Track',
      url: `https://t.me/novasniperbot?start=track_${MINT}`,
    });
  });

  it('omits the Track button when no bot username is resolved', () => {
    const rows = buildTokenButtonRows({ mint: MINT });
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.text === '🔎 Track')).toBe(false);
  });

  it('always includes a Scan button linking to Solscan', () => {
    const rows = buildTokenButtonRows({ mint: MINT });
    const allButtons = rows.flat();
    expect(allButtons).toContainEqual({ text: '🔍 Scan', url: `https://solscan.io/token/${MINT}` });
  });

  it('includes a Website row when a valid public https URL is given', () => {
    const rows = buildTokenButtonRows({ mint: MINT, websiteUrl: 'https://novasniper.ai' });
    expect(rows.at(-1)).toEqual([{ text: '🌐 Website', url: 'https://novasniper.ai' }]);
  });

  it('drops the Website button for a localhost URL rather than failing the whole post', () => {
    const rows = buildTokenButtonRows({ mint: MINT, websiteUrl: 'http://localhost:3000' });
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.text === '🌐 Website')).toBe(false);
  });

  it('drops the Website button when the URL is missing entirely', () => {
    const rows = buildTokenButtonRows({ mint: MINT });
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.text === '🌐 Website')).toBe(false);
  });
});
