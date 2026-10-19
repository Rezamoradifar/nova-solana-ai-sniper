import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createCopyLeaderboard, providerWallet, rankProviderWallets, walletAddress } from './copyLeaderboardFeed.js';
import { loadRankedCopyWallets } from './copyWalletRanking.js';
vi.mock('./copyWalletRanking.js', () => ({ loadRankedCopyWallets: vi.fn(), COPY_RECOMMENDATION_POLICY: { lookbackDays: 30 } }));
// Deterministic PUBLIC test addresses, never production discovery candidates or funded accounts.
const A = Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey.toBase58();
const B = Keypair.fromSeed(new Uint8Array(32).fill(72)).publicKey.toBase58();
const C = Keypair.fromSeed(new Uint8Array(32).fill(73)).publicKey.toBase58();
const now = Date.UTC(2026, 9, 19, 9);
const allowed = new Map([[A, now - 1000], [B, now - 2000]]);
const stats = (address = A) => ({ wallet_address: address, realized_profit: '250', total_cost: '1000', winrate: '.6', sell_count: 30, buy_count: 40, token_num: 10, common: { name: 'Source identity' } });
function activity(address: string, timestamp = Math.floor(now / 1000) - 1) {
  return { maker: address, transaction_hash: '5'.repeat(88), base_address: 'So11111111111111111111111111111111111111112', side: 'buy', timestamp };
}
beforeEach(() => { vi.mocked(loadRankedCopyWallets).mockReset(); vi.mocked(loadRankedCopyWallets).mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

describe('real provider statistics', () => {
  it('validates canonical on-curve wallet addresses', () => { expect(walletAddress(A)).toBe(true); for (const x of ['', '103.244.227.112', '0'.repeat(44), '<script>', null]) expect(walletAddress(x)).toBe(false); });
  it('converts ratio exactly once and distinguishes realized from unrealized', () => {
    const w = providerWallet({ ...stats(), unrealized_profit: 999999 }, allowed, now)!;
    expect(w.winRatePct).toBe(60); expect(w.realizedRoiPct).toBe(25); expect(w.realizedPnlUsd).toBe(250);
    expect(w.score).toBe(49); expect(w.qualifiedSample).toBe(true); expect(w.periodDays).toBe(30);
  });
  it('missing metrics remain null, not zero or invented profit', () => {
    const w = providerWallet({ wallet_address: A }, allowed, now)!;
    expect(w.realizedPnlUsd).toBeNull(); expect(w.realizedRoiPct).toBeNull(); expect(w.winRatePct).toBeNull(); expect(w.score).toBeNull(); expect(w.qualifiedSample).toBe(false);
    expect(w.label).toBeNull(); expect(w.followers).toBeNull(); expect(w.drawdownPct).toBeNull(); expect(w.riskAssessment).toBe('not_available');
  });
  it.each([Infinity, 'NaN', '', ' ', null, undefined, false])('rejects nonfinite realized metric %j', value => { expect(providerWallet({ ...stats(), realized_profit: value }, allowed, now)!.realizedPnlUsd).toBeNull(); });
  it.each([-1, 60, 1.1, Infinity, 'NaN'])('rejects invalid win-rate ratio %j', value => { expect(providerWallet({ ...stats(), winrate: value }, allowed, now)!.winRatePct).toBeNull(); });
  it('does not divide by zero or turn overflow into a rank', () => {
    expect(providerWallet({ ...stats(), total_cost: 0 }, allowed, now)!.score).toBeNull();
    expect(providerWallet({ ...stats(), total_cost: Number.MIN_VALUE, realized_profit: Number.MAX_VALUE }, allowed, now)!.realizedRoiPct).toBeNull();
  });
  it('requires the response address to match an actually discovered candidate', () => { expect(providerWallet(stats(C), allowed, now)).toBeNull(); expect(providerWallet({ ...stats(), wallet_address: undefined }, allowed, now)).toBeNull(); });
  it('does not promote a losing or tiny sample as sufficient', () => { for (const values of [{ realized_profit: -1 }, { sell_count: 3 }, { winrate: .2 }, { buy_count: 0 }]) expect(providerWallet({ ...stats(), ...values }, allowed, now)!.qualifiedSample).toBe(false); });
  it('scores are bounded and deterministic; absent scores have no rank', () => {
    const a = providerWallet(stats(A), allowed, now)!, b = providerWallet(stats(B), allowed, now)!;
    const blank = providerWallet({ wallet_address: A }, allowed, now)!;
    expect(rankProviderWallets([b,a]).map(w => w.address)).toEqual([A,B].sort());
    expect(rankProviderWallets([blank])[0]!.rank).toBeNull();
    const strong = providerWallet({ ...stats(), realized_profit: 1e15, winrate: 1, sell_count: 10000, token_num: 10000 }, allowed, now)!;
    expect(strong.score).toBe(100);
  });
});

describe('bounded read-only feed', () => {
  function make(run: ReturnType<typeof vi.fn>, internal: string[] = [], key = 'test-only-key') {
    const prisma = { wallet: { findMany: vi.fn().mockResolvedValue(internal.map(publicKey => ({ publicKey }))) } };
    return { feed: createCopyLeaderboard(prisma as never, () => key, run), prisma };
  }
  it('no configured key means no external request and no example traders', async () => {
    const run = vi.fn(), { feed } = make(run, [], '');
    const result = await feed.read(); expect(result.sampleData).toBe(false); expect(result.gmgn.status).toBe('not_configured'); expect(result.gmgn.wallets).toEqual([]); expect(run).not.toHaveBeenCalled(); feed.stop();
  });
  it('reuses GSP cache for a minute; read does not modify source rows', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const row = { address: A, recommendation: { score: 42 } };
    vi.mocked(loadRankedCopyWallets).mockResolvedValue([row] as never);
    const { feed } = make(vi.fn(), [], '');
    const first = await feed.read(); await feed.read(); expect(loadRankedCopyWallets).toHaveBeenCalledTimes(1);
    expect(first.local.wallets[0]!.rank).toBe(1); expect(row).not.toHaveProperty('rank');
    await vi.advanceTimersByTimeAsync(60001); await feed.read(); expect(loadRankedCopyWallets).toHaveBeenCalledTimes(2); feed.stop();
  });
  it('deduplicates in-flight local loads', async () => {
    let done!: (value: never[]) => void;
    vi.mocked(loadRankedCopyWallets).mockImplementation(() => new Promise(resolve => { done = resolve as typeof done; }));
    const { feed } = make(vi.fn(), [], ''); const a = feed.read(), b = feed.read(); done([]); await Promise.all([a,b]);
    expect(loadRankedCopyWallets).toHaveBeenCalledTimes(1); feed.stop();
  });
  it('excludes internal wallets before batching statistics and never invokes trading CLI', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const run = vi.fn().mockResolvedValueOnce({ list: [activity(A), activity(A), activity(B)] }).mockResolvedValueOnce([stats(A)]);
    const { feed, prisma } = make(run, [B]); await feed.read(); await vi.advanceTimersByTimeAsync(2200); const value = await feed.read();
    expect(prisma.wallet.findMany).toHaveBeenCalledTimes(1); expect(value.gmgn.wallets.map(w => w.address)).toEqual([A]);
    expect(run).toHaveBeenCalledTimes(2);
    const args = run.mock.calls[1]![0] as string[];
    expect(args).toEqual(['portfolio','stats','--chain','sol','--period','30d','--wallet',A,'--raw']);
    expect(args).not.toContain(B); expect(args.join(' ')).not.toMatch(/swap|execute|buy|private/i);
    expect(JSON.stringify(value)).not.toContain('test-only-key'); feed.stop();
  });
  it('rejects old, future, invalid-signature and malformed address candidates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const run = vi.fn().mockResolvedValue({ list: [activity(A, now/1000 + 100), activity(B, now/1000 - 300000), { ...activity(A), transaction_hash: '' }, activity('bad-wallet')] });
    const { feed } = make(run); await feed.read(); await vi.advanceTimersByTimeAsync(1); const result = await feed.read();
    expect(result.gmgn.wallets).toEqual([]); expect(result.gmgn.status).toBe('empty'); expect(run).toHaveBeenCalledTimes(1); feed.stop();
  });
  it('failure clears provider rows and respects a cooldown instead of polling aggressively', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const run = vi.fn().mockRejectedValue(new Error('provider-private-token'));
    const { feed } = make(run); await feed.read(); await vi.advanceTimersByTimeAsync(1); const failed = await feed.read();
    expect(failed.gmgn.status).toBe('unavailable'); expect(failed.gmgn.wallets).toEqual([]); expect(JSON.stringify(failed)).not.toContain('provider-private-token');
    await vi.advanceTimersByTimeAsync(299000); await feed.read(); expect(run).toHaveBeenCalledTimes(1); feed.stop();
  });
  it('local errors never expose an old ranking as fresh', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(loadRankedCopyWallets).mockResolvedValueOnce([{ address:A }] as never).mockRejectedValueOnce(new Error('db-host-private'));
    const { feed } = make(vi.fn(), [], ''); await feed.read(); await vi.advanceTimersByTimeAsync(60001);
    const result = await feed.read(); expect(result.local.status).toBe('unavailable'); expect(result.local.wallets).toEqual([]); expect(JSON.stringify(result)).not.toContain('db-host-private'); feed.stop();
  });
  it('malformed stats do not become a synthetic fallback', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const run = vi.fn().mockResolvedValueOnce({ list:[activity(A)] }).mockResolvedValueOnce({ unexpected: [] });
    const { feed } = make(run); await feed.read(); await vi.advanceTimersByTimeAsync(2200); const r = await feed.read();
    expect(r.gmgn.status).toBe('unavailable'); expect(r.gmgn.wallets).toEqual([]); feed.stop();
  });
});
