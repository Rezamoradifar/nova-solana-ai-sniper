import { describe, expect, it, vi } from 'vitest';
import type { WalletAccount } from '@wallet-standard/base';
import {
  createWalletConnectWallet,
  SOLANA_WC_CHAIN,
  validWalletConnectProjectId,
  walletConnectAccounts,
  type WalletConnectTransport,
} from './walletConnect.js';

const address = '11111111111111111111111111111111';
const session = (accounts: string[]) => ({
  topic: 'approved-session',
  namespaces: { solana: { accounts } },
});
const account: WalletAccount = {
  address,
  publicKey: new Uint8Array(32),
  chains: ['solana:mainnet'],
  features: [],
};

function transport() {
  let change: (accounts: WalletAccount[]) => void = () => {};
  const client: WalletConnectTransport = {
    accounts: () => [account],
    connect: vi.fn(async () => [account]),
    disconnect: vi.fn(async () => {}),
    cancel: vi.fn(),
    onChange: (listener) => {
      change = listener;
      return () => {};
    },
  };
  return { client, change: (accounts: WalletAccount[]) => change(accounts) };
}

describe('WalletConnect Solana address bridge', () => {
  it('accepts only approved mainnet accounts with an exact 32-byte Solana public key', () => {
    const result = walletConnectAccounts(
      session([
        `${SOLANA_WC_CHAIN}:${address}`,
        `${SOLANA_WC_CHAIN}:${address}`,
        `eip155:56:0x1234`,
        `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${address}`,
        `${SOLANA_WC_CHAIN}:not-a-public-key`,
        `${SOLANA_WC_CHAIN}:${'z'.repeat(44)}`,
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe(address);
    expect(result[0]?.publicKey).toHaveLength(32);
    expect(walletConnectAccounts(undefined)).toEqual([]);
  });

  it('does not initialize a relay until explicitly selected and never exposes a signing feature', async () => {
    const { client } = transport();
    const load = vi.fn(async () => client);
    const wallet = createWalletConnectWallet(load);
    expect(load).not.toHaveBeenCalled();
    expect(Object.keys(wallet.features).sort()).toEqual([
      'standard:connect',
      'standard:disconnect',
      'standard:events',
    ]);
    expect(await wallet.features['standard:connect'].connect()).toEqual({ accounts: [account] });
    expect(load).toHaveBeenCalledOnce();
    await wallet.features['standard:disconnect']!.disconnect();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(wallet.accounts).toEqual([]);
  });

  it('updates approved accounts and removes access when the remote session ends', async () => {
    const { client, change } = transport();
    const wallet = createWalletConnectWallet(async () => client);
    const listener = vi.fn();
    const off = wallet.features['standard:events'].on('change', listener);
    await wallet.features['standard:connect'].connect();
    change([]);
    expect(listener).toHaveBeenLastCalledWith({ accounts: [] });
    expect(wallet.accounts).toEqual([]);
    off();
    change([account]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not start a pairing if the user cancels while the SDK is loading', async () => {
    const { client } = transport();
    let loaded: (client: WalletConnectTransport) => void = () => {};
    const wallet = createWalletConnectWallet(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    const pending = wallet.features['standard:connect'].connect();
    const result = expect(pending).rejects.toThrow('cancelled');
    wallet.cancelConnect?.();
    loaded(client);
    await result;
    expect(client.connect).not.toHaveBeenCalled();
    expect(wallet.accounts).toEqual([]);
  });

  it('rejects placeholders and accepts a public Reown project identifier', () => {
    expect(validWalletConnectProjectId('YOUR_PROJECT_ID')).toBeNull();
    expect(validWalletConnectProjectId('0'.repeat(32))).toBeNull();
    expect(validWalletConnectProjectId('https://example.com')).toBeNull();
    expect(validWalletConnectProjectId('  ' + 'a'.repeat(32) + ' ')).toBe('a'.repeat(32));
  });
});
