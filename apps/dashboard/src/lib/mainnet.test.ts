import { describe, expect, it } from 'vitest';
import { parseMainnet, verifiedMainnet, SOLANA_MAINNET_GENESIS, solanaExplorer, type MainnetObservation } from './mainnet.js';
const good = { schemaVersion: 1, chain: 'solana', cluster: 'mainnet-beta', status: 'ready', mainnetVerified: true,
  genesisHash: SOLANA_MAINNET_GENESIS, slot: 100, checkedAt: 100_000, tradingMode: 'PAPER', programs: [] } as unknown as MainnetObservation;
describe('mainnet proof at the interface boundary', () => {
  it('requires current genesis evidence, not a ready label or wallet connection', () => {
    expect(verifiedMainnet(good, 110_000)).toBe(true);
    for (const change of [{ genesisHash: 'devnet' }, { mainnetVerified: false }, { cluster: 'devnet' },
      { slot: 0 }, { status: 'degraded' }, { checkedAt: 10 }, { checkedAt: 200_000 }]) {
      expect(verifiedMainnet({ ...good, ...change } as MainnetObservation, 110_000)).toBe(false);
    }
    expect(parseMainnet({ status: 'ready', slot: 100 })).toBeNull();
    expect(verifiedMainnet(null)).toBe(false);
  });
  it('only builds mainnet explorer links for valid addresses and signatures', () => {
    expect(solanaExplorer('address', '11111111111111111111111111111111')).toContain('?cluster=mainnet-beta');
    expect(solanaExplorer('tx', '2'.repeat(88))).toContain('/tx/');
    expect(solanaExplorer('address', 'https://secret.example')).toBeUndefined();
    expect(solanaExplorer('tx', 'javascript:alert(1)')).toBeUndefined();
  });
});
