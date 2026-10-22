import { describe, expect, it, vi } from 'vitest';
import type { Wallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';
import { registerLegacyInjectedWallets, WalletConnectionStore } from './walletConnection.js';

const SOLANA_ADDRESS = '11111111111111111111111111111111';

function walletRegistry() {
  const wallets: Wallet[] = [];
  const register = vi.fn((wallet: Wallet) => {
    wallets.push(wallet);
    return () => {
      const index = wallets.indexOf(wallet);
      if (index !== -1) wallets.splice(index, 1);
    };
  });
  const registry = {
    get: () => wallets,
    register,
    on: () => () => {},
  } as unknown as Wallets;
  return { registry, wallets, register };
}

describe('SafePal Solana legacy wallet connection', () => {
  it('registers only the Solana provider and reads its approved public address', async () => {
    const { registry, wallets } = walletRegistry();
    const connect = vi.fn(async () => undefined);
    const getAccount = vi.fn(async () => SOLANA_ADDRESS);
    const seen = new Set<object>();
    const cleanups = registerLegacyInjectedWallets(registry, {
      safepal: { connect, getAccount },
    }, seen);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.name).toBe('SafePal');
    expect(registerLegacyInjectedWallets(registry, { safepal: { connect, getAccount } }, seen)).toHaveLength(0);

    const store = new WalletConnectionStore();
    store.start(registry);
    await store.connect(store.getSnapshot().available[0]!);
    expect(connect).toHaveBeenCalledOnce();
    expect(getAccount).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('connected');
    expect(store.getSnapshot().account?.address).toBe(SOLANA_ADDRESS);
    expect(store.getSnapshot().account?.publicKey).toHaveLength(32);

    await store.disconnect();
    expect(store.getSnapshot().status).toBe('disconnected');
    store.stop();
    cleanups.forEach((off) => off());
  });

  it('never exposes an EVM-only SafePal provider as a Solana wallet', () => {
    const { registry, wallets } = walletRegistry();
    registerLegacyInjectedWallets(registry, { safepal: { connect: async () => undefined } });
    expect(wallets).toHaveLength(0);
  });

  it('rejects invalid public-account responses without creating a connection', async () => {
    const { registry } = walletRegistry();
    registerLegacyInjectedWallets(registry, {
      safepal: { connect: async () => undefined, getAccount: async () => '0x1234' },
    });
    const store = new WalletConnectionStore();
    store.start(registry);
    await store.connect(store.getSnapshot().available[0]!);
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(store.getSnapshot().account).toBeNull();
    expect(store.getSnapshot().error).toMatch(/No compatible Solana account/);
    store.stop();
  });

  it('preserves Phantom injected-provider connections', async () => {
    const { registry } = walletRegistry();
    const key = {
      toBase58: () => SOLANA_ADDRESS,
      toString: () => SOLANA_ADDRESS,
      toBytes: () => new Uint8Array(32),
    };
    registerLegacyInjectedWallets(registry, {
      phantom: { solana: { isPhantom: true, publicKey: key, connect: async () => ({ publicKey: key }) } },
    });
    const store = new WalletConnectionStore();
    store.start(registry);
    await store.connect(store.getSnapshot().available[0]!);
    expect(store.getSnapshot().status).toBe('connected');
    store.stop();
  });
});
