import { describe, expect, it } from 'vitest';
import { normalizeGmgnSmartMoney } from './gmgn.js';

describe('normalizeGmgnSmartMoney', () => {
  it('keeps only documented public smart-money fields', () => {
    expect(
      normalizeGmgnSmartMoney({
        list: [
          {
            transaction_hash: 'sig',
            maker: 'wallet',
            side: 'buy',
            base_address: 'mint',
            base_token: { symbol: 'TEST', launchpad: 'pump' },
            amount_usd: '125.5',
            token_amount: '42',
            price_usd: '2.5',
            buy_cost_usd: '0',
            is_open_or_close: 0,
            timestamp: 123,
            maker_info: { twitter_username: 'alpha', tags: ['smart_degen'] },
          },
        ],
      }),
    ).toEqual([
      {
        transactionHash: 'sig',
        maker: 'wallet',
        side: 'buy',
        tokenAddress: 'mint',
        tokenSymbol: 'TEST',
        launchpad: 'pump',
        amountUsd: 125.5,
        tokenAmount: 42,
        priceUsd: 2.5,
        buyCostUsd: 0,
        isClose: false,
        timestamp: 123,
        twitterUsername: 'alpha',
        tags: ['smart_degen'],
      },
    ]);
  });

  it('drops rows without a maker or token address', () => {
    expect(normalizeGmgnSmartMoney({ list: [{ maker: '', base_address: 'mint' }] })).toEqual([]);
  });
});
