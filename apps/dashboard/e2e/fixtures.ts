import type { Page } from '@playwright/test';
export const address = '11111111111111111111111111111111';
export const secondAddress = 'So11111111111111111111111111111111111111112';
export const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export async function mockServices(page: Page) {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (pathname === '/api/public/solana/overview') json = mainnetFixture();
    else if (pathname === '/api/public/markets') json = [{ chainId: 'solana', dexId: 'raydium', pairAddress: 'pool-1', baseToken: {address: secondAddress, name: 'Solana',symbol: 'SOL'},quoteToken:{address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC'},priceUsd:'102.63',liquidity:{usd:1000000},volume:{h24:500000},priceChange:{h24:-0.58} }];
    else if (pathname === '/api/public/network/status')
      json = {
        status: 'ready',
        workersReady: true,
        tradingMode: 'PAPER',
        slot: 100,
        scanner: { state: 'HEALTHY', wsHealthy: true, fallbackHealthy: false },
      };
    else if (pathname === '/api/public/copy-trading')
      json = {
        executionMode: 'disabled',
        copyWatcherReady: false,
        liveExecutionEnabled: false,
        buyReadiness: {
          ready: false,
          blockers: ['COPY_EXECUTION_DISABLED'],
          checkedAt: Date.now(),
        },
        recommendations: [],
        localWallets: [],
        gmgn: { status: 'not_configured', wallets: [], trades: [] },
        limits: { maxBuySol: 0.1, maxDailyBuys: 10, maxOpenPositions: 3, slippageBps: 150 },
      };
    else if (pathname.startsWith('/api/public/wallet/'))
      json = {
        address: pathname.split('/').pop(),
        chain: 'solana', cluster:'mainnet-beta', mainnetVerified:true, genesisHash:genesis,
        sol: pathname.endsWith(secondAddress) ? 2 : 1,
        lamports: '1000000000',
        slot: 100,
        signatures: [],
        checkedAt: Date.now(),
      };
    else if (pathname === '/api/auth/login' || pathname === '/api/auth/register')
      json = { token: 'test-account-token' };
    else if (pathname === '/api/auth/me')
      json = { id: 'test-account', email: 'user@example.com', role: 'USER' };
    else if (pathname === '/api/wallets')
      json = [
        {
          id: 'wallet-1',
          label: 'Home',
          publicKey: address,
          isActive: true,
          createdAt: '2026-10-24T00:00:00Z',
        },
      ];
    else if (pathname === '/api/public/gmgn/markets')
      json = { status: 'not_configured', tokens: [] };
    await route.fulfill({ json });
  });
}

export async function injectWallet(page: Page, reject = false) {
  await page.addInitScript(
    ({ address, reject }) => {
      const events = new Map<string, Set<(value?: unknown) => void>>();
      const publicKey = (value: string) => ({ toBase58: () => value, toString: () => value });
      const provider = {
        isPhantom: true,
        publicKey: publicKey(address),
        connect: async () => {
          if (reject) throw Object.assign(new Error('User rejected connection'), { code: 4001 });
          return { publicKey: provider.publicKey };
        },
        disconnect: async () => {
          events.get('disconnect')?.forEach((fn) => fn());
        },
        on: (event: string, fn: (value?: unknown) => void) => {
          const listeners = events.get(event) ?? new Set();
          listeners.add(fn);
          events.set(event, listeners);
        },
        off: (event: string, fn: (value?: unknown) => void) => {
          events.get(event)?.delete(fn);
        },
        signTransaction: () => {
          throw new Error('UNEXPECTED_SIGNING_REQUEST');
        },
        signMessage: () => {
          throw new Error('UNEXPECTED_SIGNING_REQUEST');
        },
      };
      Object.assign(window, {
        phantom: { solana: provider },
        __novaWalletChange: (next: string) => {
          provider.publicKey = publicKey(next);
          events.get('accountChanged')?.forEach((fn) => fn(provider.publicKey));
        },
      });
    },
    { address, reject },
  );
}


export function mainnetFixture() {
  return {schemaVersion:1, chain:'solana', cluster:'mainnet-beta', status:'ready', mainnetVerified:true,
    genesisHash:genesis, slot:460627712,nonVoteTps:1250,samplePeriodSecs:60,checkedAt:Date.now(),
    source:'dedicated', configurationIssue:null, tradingMode:'PAPER',workersReady:true,
    programs:[{name:'System Program',address,purpose:'SOL accounts',status:'executable',owner:'NativeLoader1111111111111111111111111111111'},
      {name:'SPL Token',address:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',purpose:'Token accounts',status:'executable',owner:'BPFLoader2111111111111111111111111111111111'}]};
}
