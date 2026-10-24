import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import publicNetworkRoutes from './publicNetwork.js';
import { MAINNET_GENESIS, MAINNET_PROGRAMS } from '../solana/mainnetGateway.js';

async function setup(network = false) {
  const app = Fastify();
  app.decorate('config', { DEXSCREENER_API_BASE: 'https://source.example/' } as never);
  if (network) {
    app.decorate('solanaConnection', {} as never);
    app.decorate('backgroundWorkersReady', true);
    app.decorate('tradingMode', 'PAPER');
  }
  await app.register(publicNetworkRoutes);
  return app;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verified public mainnet routes', () => {
  function rpc(genesis: string) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      const methods = JSON.parse(init.body) as Array<{id:number;method:string}>;
      return new Response(JSON.stringify(methods.map(({id,method})=>({id,jsonrpc:'2.0',result:
        method === 'getGenesisHash' ? genesis : method === 'getSlot' ? 123 :
        method === 'getMultipleAccounts' ? {value:MAINNET_PROGRAMS.map(()=>({executable:true,owner:'BPFLoader2111111111111111111111111111111111'}))} :
        method === 'getBalance' ? {context:{slot:122},value:1000000000} : []}))));
    }));
  }
  it('returns genesis evidence while keeping paper execution separate from network readiness', async () => {
    rpc(MAINNET_GENESIS);
    const app = await setup(true);
    try {
      const r=await app.inject('/public/solana/overview');
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json()).toMatchObject({mainnetVerified:true,genesisHash:MAINNET_GENESIS,slot:123,tradingMode:'PAPER'});
      expect((await app.inject('/public/network/status')).json()).toMatchObject({status:'ready',mainnetVerified:true,tradingMode:'PAPER'});
      expect((await app.inject('/public/wallet/11111111111111111111111111111111')).json()).toMatchObject({sol:1,slot:122,mainnetVerified:true});
    } finally { await app.close(); }
  });
  it('never reports a devnet provider or its wallet values as mainnet-ready', async () => {
    rpc('devnet');
    const app=await setup(true);
    try {
      const r=await app.inject('/public/network/status');
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({status:'degraded',mainnetVerified:false,slot:null,cluster:null});
      expect((await app.inject('/public/wallet/11111111111111111111111111111111')).statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
describe('public market feed', () => {
  it('shares slow upstream requests and expires snapshots without relabeling their age', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: Response) => void;
    const upstream = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(new Response('[{"priceUsd":"150"}]'));
    vi.stubGlobal('fetch', upstream);
    const app = await setup();
    try {
      const first = app.inject('/public/markets');
      const second = app.inject('/public/markets');
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
      resolve(new Response('[{"priceUsd":"149"}]'));
      const responses = await Promise.all([first, second]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(responses[0].headers['cache-control']).toBe('no-store');
      expect(responses[0].headers['x-market-updated-at']).toBe('100000');
      now += 1_000;
      expect((await app.inject('/public/markets')).headers['x-market-updated-at']).toBe('100000');
      expect(upstream).toHaveBeenCalledTimes(1);
      now += 1_001;
      expect((await app.inject('/public/markets')).json()).toEqual([{ priceUsd: '150' }]);
      expect(upstream).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it.each([
    [429, 'busy', 429],
    [500, 'error', 502],
    [200, '{}', 502],
    [200, '[]', 502],
  ])(
    'handles source %s / %s without a server error or request storm',
    async (status, body, expected) => {
      const upstream = vi.fn().mockResolvedValue(new Response(body, { status }));
      vi.stubGlobal('fetch', upstream);
      const app = await setup();
      try {
        const response = await app.inject('/public/markets');
        expect(response.statusCode).toBe(expected);
        expect(response.headers['x-market-updated-at']).toBeUndefined();
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect((await app.inject('/public/markets')).statusCode).toBe(expected);
        expect(upstream).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );
  it('turns network timeouts into an unavailable response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const app = await setup();
    try {
      expect((await app.inject('/public/markets')).statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });
});

it('exposes GMGN connection state without requiring a configured key', async () => {
  const app = await setup();
  try {
    const r = await app.inject('/public/gmgn/markets');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ source: 'GMGN', status: 'not_configured', tokens: [] });
  } finally {
    await app.close();
  }
});
