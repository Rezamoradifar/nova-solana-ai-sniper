import { describe, expect, it, vi } from 'vitest';
import { createMainnetGateway, MAINNET_GENESIS, MAINNET_PROGRAMS } from './mainnetGateway.js';

const primary = { label: 'private', url: 'https://provider.example/secret-key', tier: 'primary' as const };
const fallback = { label: 'public', url: 'https://public.example', tier: 'fallback' as const };
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
function response(values: unknown[]) {
  return new Response(JSON.stringify(values.map((result, id) => ({ jsonrpc: '2.0', id, result })).reverse()));
}
function snapshot(genesis = MAINNET_GENESIS, slot: unknown = 100) {
  return [genesis, slot, [{ numNonVoteTransactions: 6000, samplePeriodSecs: 60 }],
    { value: MAINNET_PROGRAMS.map(() => ({ executable: true, owner: loader })) }];
}
function gateway(fetcher: ReturnType<typeof vi.fn>, extra = {}) {
  return createMainnetGateway({ endpoints: () => [primary, fallback], fetch: fetcher as typeof fetch, ...extra });
}

describe('same-endpoint Solana mainnet gateway', () => {
  it('verifies chain identity and program executable flags before returning a mainnet snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(snapshot()));
    const result = await gateway(fetcher).overview();
    expect(result).toMatchObject({ mainnetVerified: true, cluster: 'mainnet-beta', slot: 100,
      genesisHash: MAINNET_GENESIS, source: 'dedicated', nonVoteTps: 100, samplePeriodSecs: 60 });
    expect(result.programs.every(p => p.status === 'executable' && p.owner === loader)).toBe(true);
    const methods = JSON.parse(fetcher.mock.calls[0]![1].body).map((r: {method: string}) => r.method);
    expect(methods).toEqual(['getGenesisHash', 'getSlot', 'getRecentPerformanceSamples', 'getMultipleAccounts']);
    expect(JSON.stringify(result)).not.toContain(primary.url);
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('rejects a wrong-chain primary and records the issue while using verified public mainnet data', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot('devnet', 999)))
      .mockResolvedValueOnce(response(snapshot(MAINNET_GENESIS, 123)));
    expect(await gateway(fetcher).overview()).toMatchObject({ mainnetVerified: true, slot: 123,
      source: 'public-fallback', configurationIssue: 'wrong_network' });
  });
  it('never publishes wrong-network balances, slots or program availability', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response(snapshot('devnet', 999)));
    const g = gateway(fetcher);
    const r = await g.overview();
    expect(r).toMatchObject({ status: 'wrong_network', cluster: null, mainnetVerified: false, slot: null, nonVoteTps: null });
    expect(r.programs.every(p => p.status === 'unavailable')).toBe(true);
    await expect(g.wallet('11111111111111111111111111111111')).rejects.toThrow('MAINNET_WALLET_UNAVAILABLE');
  });
  it.each([0, -1, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid confirmed slot %s', async slot => {
    const fetcher = vi.fn().mockImplementation(async () => response(snapshot(MAINNET_GENESIS, slot)));
    expect(await gateway(fetcher).overview()).toMatchObject({ status: 'degraded', slot: null, mainnetVerified: false });
  });
  it('does not fabricate TPS when the optional non-vote sample is unavailable', async () => {
    const values = snapshot(); values[2] = [{ numTransactions: 6000, samplePeriodSecs: 60 }];
    const fetcher = vi.fn().mockResolvedValue(response(values));
    expect(await gateway(fetcher).overview()).toMatchObject({ mainnetVerified: true, nonVoteTps: null, samplePeriodSecs: null });
  });
  it('distinguishes missing and non-executable program accounts from verified programs', async () => {
    const values = snapshot(); values[3] = { value: [null, { executable: false, owner: loader },
      { executable: true, owner: loader }, { executable: 'true' }, { executable: true, owner: 'https://secret' }] };
    const fetcher = vi.fn().mockResolvedValue(response(values));
    const r = await gateway(fetcher).overview();
    expect(r.programs.map(p => p.status)).toEqual(['missing','not_executable','executable','unavailable','unavailable']);
    expect(r.programs[4]?.owner).toBeNull();
  });
  it('coalesces viewers and expires the actual observation without renewing its timestamp', async () => {
    let now = 100_000; let resolve!: (r: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }))
      .mockImplementation(async () => response(snapshot()));
    const g = gateway(fetcher, { now: () => now });
    const first = g.overview(); const second = g.overview();
    expect(fetcher).toHaveBeenCalledTimes(1); resolve(response(snapshot()));
    expect((await Promise.all([first,second])).map(r => r.checkedAt)).toEqual([100_000,100_000]);
    now += 10_000; expect((await g.overview()).checkedAt).toBe(100_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 5_001; expect((await g.overview()).checkedAt).toBe(now);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reports unavailable on malformed/failed providers and never leaks provider errors', async () => {
    for (const fail of [() => Promise.reject(new Error('https://private/secret')),
      async () => new Response('private-secret', { status: 429 }),
      async () => new Response('[{"id":0,"result":"private-secret"},{"id":0,"result":1}]')]) {
      const r = await gateway(vi.fn().mockImplementation(fail)).overview();
      expect(r.mainnetVerified).toBe(false);
      expect(JSON.stringify(r)).not.toContain('secret');
    }
  });
  it('verifies each wallet read and reports balance-context slot, not an unrelated later slot', async () => {
    const sig = '2'.repeat(88);
    const fetcher = vi.fn().mockResolvedValue(response([MAINNET_GENESIS, { context: { slot: 321 }, value: 1500000000 },
      [{ signature: sig, slot: 320, err: null, blockTime: 100, confirmationStatus: 'confirmed' },
        { signature: 'javascript:bad', slot: 310 }]]));
    const r = await gateway(fetcher).wallet('11111111111111111111111111111111');
    expect(r).toMatchObject({ mainnetVerified: true, lamports: '1500000000', sol: 1.5, slot: 321 });
    expect(r.signatures).toHaveLength(1);
    expect(r.signatures[0]?.signature).toBe(sig);
  });
});
