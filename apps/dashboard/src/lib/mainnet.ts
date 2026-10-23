export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const MAINNET_MAX_AGE_MS = 45_000;
export interface ProgramObservation {
  name: string; address: string; purpose: string;
  status: 'executable' | 'missing' | 'not_executable' | 'unavailable'; owner: string | null;
}
export interface MainnetObservation {
  schemaVersion: 1; chain: 'solana'; cluster: 'mainnet-beta' | null;
  status: 'ready' | 'degraded' | 'wrong_network'; mainnetVerified: boolean;
  genesisHash: string | null; slot: number | null; checkedAt: number;
  nonVoteTps: number | null; samplePeriodSecs: number | null;
  source: 'dedicated' | 'public-fallback' | null;
  configurationIssue: 'wrong_network' | null;
  tradingMode: 'LIVE' | 'PAPER'; workersReady: boolean; programs: ProgramObservation[];
}
export function verifiedMainnet(value: MainnetObservation | null, now = Date.now()): boolean {
  return value?.schemaVersion === 1 && value.chain === 'solana' && value.cluster === 'mainnet-beta' &&
    value.mainnetVerified === true && value.status === 'ready' && value.genesisHash === SOLANA_MAINNET_GENESIS &&
    typeof value.slot === 'number' && Number.isSafeInteger(value.slot) && value.slot > 0 &&
    Number.isFinite(value.checkedAt) && now - value.checkedAt <= MAINNET_MAX_AGE_MS && value.checkedAt - now <= 5_000;
}
export function parseMainnet(value: unknown): MainnetObservation | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as MainnetObservation;
  if (v.schemaVersion !== 1 || v.chain !== 'solana' || !['ready','degraded','wrong_network'].includes(v.status) ||
    !['LIVE','PAPER'].includes(v.tradingMode) || !Array.isArray(v.programs) || !Number.isFinite(v.checkedAt)) return null;
  return { ...v, programs: v.programs.filter(p => p && typeof p.name === 'string' &&
    typeof p.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address) &&
    ['executable','missing','not_executable','unavailable'].includes(p.status)) };
}
export function solanaExplorer(kind: 'address' | 'tx', value: string): string | undefined {
  if (!new RegExp(kind === 'address' ? '^[1-9A-HJ-NP-Za-km-z]{32,44}$' : '^[1-9A-HJ-NP-Za-km-z]{64,88}$').test(value)) return undefined;
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=mainnet-beta`;
}
