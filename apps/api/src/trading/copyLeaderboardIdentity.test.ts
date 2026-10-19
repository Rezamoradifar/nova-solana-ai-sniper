import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { bindSingleWalletStats, providerWallet } from './copyLeaderboardFeed.js';
const A = Keypair.fromSeed(new Uint8Array(32).fill(81)).publicKey.toBase58();
const B = Keypair.fromSeed(new Uint8Array(32).fill(82)).publicKey.toBase58();
const metrics = { realized_profit: 40, total_cost: 200, winrate: .55, sell_count: 21, buy_count: 22 };
describe('single request / single response identity', () => {
  it('uses the requested address when the single response does not echo it', () => { expect(bindSingleWalletStats(metrics, A)).toEqual({ ...metrics, wallet_address: A }); });
  it('accepts one explicit matching identity', () => { expect(bindSingleWalletStats([{ ...metrics, wallet_address: A }], A).wallet_address).toBe(A); });
  it('rejects another address instead of overwriting it', () => { expect(() => bindSingleWalletStats({ ...metrics, wallet_address: B }, A)).toThrow('SOURCE_IDENTITY'); });
  it.each([[], [metrics, metrics], { rows: [metrics] }, null, 'not-stats', {}])('rejects ambiguous or missing shape %j', value => { expect(() => bindSingleWalletStats(value, A)).toThrow('SOURCE_SCHEMA'); });
  it('preserves unknown metrics, without turning them into fabricated numeric zero', () => {
    const row = providerWallet(bindSingleWalletStats({ realized_profit: null }, A), new Map([[A, Date.now()]]), Date.now())!;
    expect(row.score).toBeNull(); expect(row.realizedPnlUsd).toBeNull(); expect(row.drawdownPct).toBeNull(); expect(row.followers).toBeNull();
  });
});
