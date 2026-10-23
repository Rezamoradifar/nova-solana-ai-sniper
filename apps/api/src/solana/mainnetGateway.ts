import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { RAYDIUM_CPMM_PROGRAM_ID } from './dex/raydium.js';
import { ORCA_WHIRLPOOL_PROGRAM_ID } from './dex/orca.js';
import type { RpcEndpoint } from './connection.js';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const MAINNET_PROGRAMS = [
  { name: 'System Program', address: SystemProgram.programId.toBase58(), purpose: 'SOL accounts' },
  { name: 'SPL Token', address: TOKEN_PROGRAM_ID.toBase58(), purpose: 'Token accounts' },
  { name: 'Associated Token', address: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), purpose: 'Wallet token addresses' },
  { name: 'Raydium CPMM', address: RAYDIUM_CPMM_PROGRAM_ID.toBase58(), purpose: 'Existing swap venue' },
  { name: 'Orca Whirlpool', address: ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(), purpose: 'Existing swap venue' },
] as const;

type Method = { method: string; params: unknown[] };
type RpcReply = { id: number; result?: unknown; error?: unknown };
type Json = Record<string, unknown>;
export interface MainnetOverview {
  schemaVersion: 1;
  chain: 'solana';
  cluster: 'mainnet-beta' | null;
  status: 'ready' | 'degraded' | 'wrong_network';
  mainnetVerified: boolean;
  genesisHash: string | null;
  slot: number | null;
  nonVoteTps: number | null;
  samplePeriodSecs: number | null;
  source: 'dedicated' | 'public-fallback' | null;
  provider: string | null;
  configurationIssue: 'wrong_network' | null;
  checkedAt: number;
  programs: Array<{ name: string; address: string; purpose: string;
    status: 'executable' | 'missing' | 'not_executable' | 'unavailable'; owner: string | null }>;
}

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function unavailable(status: 'degraded' | 'wrong_network', checkedAt: number): MainnetOverview {
  return { schemaVersion: 1, chain: 'solana', cluster: null, status, mainnetVerified: false,
    genesisHash: null, slot: null, nonVoteTps: null, samplePeriodSecs: null, source: null,
    provider: null, configurationIssue: status === 'wrong_network' ? 'wrong_network' : null,
    checkedAt, programs: MAINNET_PROGRAMS.map(p => ({ ...p, status: 'unavailable', owner: null })) };
}

/** Each response verifies genesis and reads data from the same explicit HTTP endpoint.
 * No signer, transaction endpoint, or private provider URL is exposed to the website. */
export function createMainnetGateway(options: {
  endpoints: () => RpcEndpoint[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
}) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let snapshot: MainnetOverview | undefined;
  let inFlight: Promise<MainnetOverview> | undefined;

  async function batch(endpoint: RpcEndpoint, methods: Method[], signal: AbortSignal) {
    const response = await request(endpoint.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2_500)]),
      body: JSON.stringify(methods.map((m, id) => ({ jsonrpc: '2.0', id, ...m }))),
    });
    if (!response.ok) throw new Error('RPC_UNAVAILABLE');
    const raw: unknown = await response.json();
    if (!Array.isArray(raw) || raw.length !== methods.length) throw new Error('INVALID_RPC_RESPONSE');
    const rows = new Map<number, RpcReply>();
    for (const value of raw) {
      const row = record(value);
      if (!row || !Number.isInteger(row.id) || rows.has(row.id as number) ||
        (row.id as number) < 0 || (row.id as number) >= methods.length) throw new Error('INVALID_RPC_RESPONSE');
      rows.set(row.id as number, row as unknown as RpcReply);
    }
    return (id: number, required = true): unknown => {
      const row = rows.get(id);
      if (!row || row.error !== undefined || row.result === undefined) {
        if (required) throw new Error('RPC_UNAVAILABLE');
        return undefined;
      }
      return row.result;
    };
  }

  async function readOverview(): Promise<MainnetOverview> {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 7_000);
    let wrongNetwork = false;
    for (const endpoint of options.endpoints()) {
      if (signal.aborted) break;
      try {
        const result = await batch(endpoint, [
          { method: 'getGenesisHash', params: [] },
          { method: 'getSlot', params: [{ commitment: 'confirmed' }] },
          { method: 'getRecentPerformanceSamples', params: [1] },
          { method: 'getMultipleAccounts', params: [MAINNET_PROGRAMS.map(p => p.address),
            { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] },
        ], signal);
        if (result(0) !== MAINNET_GENESIS) { wrongNetwork = true; continue; }
        const slot = result(1);
        if (!nonnegative(slot) || slot === 0) throw new Error('INVALID_RPC_RESPONSE');
        const samples = result(2, false);
        const sample = Array.isArray(samples) ? record(samples[0]) : undefined;
        const period = sample?.samplePeriodSecs;
        const count = sample?.numNonVoteTransactions;
        const validSample = nonnegative(period) && period > 0 && nonnegative(count);
        const accounts = record(result(3, false))?.value;
        const programAccounts = Array.isArray(accounts) && accounts.length === MAINNET_PROGRAMS.length ? accounts : undefined;
        return { schemaVersion: 1, chain: 'solana', cluster: 'mainnet-beta', status: 'ready',
          mainnetVerified: true, genesisHash: MAINNET_GENESIS, slot,
          nonVoteTps: validSample ? Math.round(count / period * 10) / 10 : null,
          samplePeriodSecs: validSample ? period : null,
          source: endpoint.tier === 'primary' ? 'dedicated' : 'public-fallback', provider: endpoint.label,
          configurationIssue: wrongNetwork ? 'wrong_network' : null, checkedAt: now(),
          programs: MAINNET_PROGRAMS.map((p, i) => {
            const row = record(programAccounts?.[i]);
            const owner = typeof row?.owner === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.owner) ? row.owner : null;
            return { ...p, status: !programAccounts ? 'unavailable' : programAccounts[i] === null ? 'missing' :
              !row || !owner || typeof row.executable !== 'boolean' ? 'unavailable' : row.executable ? 'executable' : 'not_executable', owner };
          }) };
      } catch { /* Fail over within one bounded, shared read. Never return upstream errors. */ }
    }
    return unavailable(wrongNetwork ? 'wrong_network' : 'degraded', now());
  }

  async function overview(): Promise<MainnetOverview> {
    const ttl = snapshot?.mainnetVerified ? options.cacheMs ?? 15_000 : 3_000;
    if (snapshot && now() - snapshot.checkedAt < ttl) return snapshot;
    if (inFlight) return inFlight;
    inFlight = readOverview().then(value => { snapshot = value; return value; }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  async function wallet(address: string) {
    new PublicKey(address); // Canonical Solana address validation before any upstream call.
    const signal = AbortSignal.timeout(options.timeoutMs ?? 7_000);
    for (const endpoint of options.endpoints()) {
      if (signal.aborted) break;
      try {
        const result = await batch(endpoint, [
          { method: 'getGenesisHash', params: [] },
          { method: 'getBalance', params: [address, { commitment: 'confirmed' }] },
          { method: 'getSignaturesForAddress', params: [address, { limit: 10, commitment: 'confirmed' }] },
        ], signal);
        if (result(0) !== MAINNET_GENESIS) continue;
        const balance = record(result(1));
        const slot = record(balance?.context)?.slot;
        if (!nonnegative(balance?.value) || !nonnegative(slot)) throw new Error('INVALID_RPC_RESPONSE');
        const raw = result(2);
        if (!Array.isArray(raw)) throw new Error('INVALID_RPC_RESPONSE');
        const signatures = raw.slice(0, 10).flatMap(value => {
          const row = record(value);
          if (!row || typeof row.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature) || !nonnegative(row.slot)) return [];
          return [{ signature: row.signature, slot: row.slot, err: row.err == null ? null : { failed: true },
            blockTime: nonnegative(row.blockTime) ? row.blockTime : null,
            confirmationStatus: ['processed', 'confirmed', 'finalized'].includes(String(row.confirmationStatus)) ? row.confirmationStatus : null }];
        });
        return { chain: 'solana' as const, cluster: 'mainnet-beta' as const, mainnetVerified: true,
          genesisHash: MAINNET_GENESIS, address, lamports: String(balance.value), sol: balance.value / 1e9,
          slot, signatures, checkedAt: now() };
      } catch { /* A wallet snapshot must carry its own same-endpoint mainnet proof. */ }
    }
    throw new Error('MAINNET_WALLET_UNAVAILABLE');
  }
  return { overview, wallet };
}
