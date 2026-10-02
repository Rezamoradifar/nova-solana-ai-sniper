import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardEventsChangeProperties } from '@wallet-standard/features';
import { WalletConnectionStore, type ConnectionWallet } from './walletConnection.js';

const accountA: WalletAccount = {
  address: '11111111111111111111111111111111',
  publicKey: new Uint8Array(32),
  chains: ['solana:mainnet'],
  features: [],
};
const accountB: WalletAccount = {
  ...accountA,
  address: 'So11111111111111111111111111111111111111112',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makeWallet(name = 'Test Solana wallet') {
  let accounts: readonly WalletAccount[] = [accountA];
  let chains: Wallet['chains'] = ['solana:mainnet'];
  const events = new Set<(properties: StandardEventsChangeProperties) => void>();
  const connect = vi.fn(async () => ({ accounts }));
  const disconnect = vi.fn(async () => {});
  const signTransaction = vi.fn();
  const wallet: ConnectionWallet = {
    version: '1.0.0',
    name,
    icon: 'data:image/png;base64,',
    get chains() {
      return chains;
    },
    get accounts() {
      return accounts;
    },
    features: {
      'standard:connect': { version: '1.0.0', connect },
      'standard:disconnect': { version: '1.0.0', disconnect },
      'standard:events': {
        version: '1.0.0',
        on: (_event, listener) => {
          events.add(listener);
          return () => {
            events.delete(listener);
          };
        },
      },
      'solana:signTransaction': { version: '1.0.0', signTransaction },
    },
  };
  const emit = (properties: StandardEventsChangeProperties) => {
    if (properties.accounts) accounts = properties.accounts;
    if (properties.chains) chains = properties.chains;
    [...events].forEach((listener) => listener(properties));
  };
  return { wallet, connect, disconnect, signTransaction, emit, events };
}

function makeRegistry(...initial: Wallet[]) {
  const wallets = new Set(initial);
  const events = {
    register: new Set<(...wallets: Wallet[]) => void>(),
    unregister: new Set<(...wallets: Wallet[]) => void>(),
  };
  const registry: Wallets = {
    get: () => [...wallets],
    on: (event, listener) => {
      events[event].add(listener);
      return () => {
        events[event].delete(listener);
      };
    },
    register: (...items) => {
      items.forEach((wallet) => wallets.add(wallet));
      events.register.forEach((listener) => listener(...items));
      return () => {
        items.forEach((wallet) => wallets.delete(wallet));
        events.unregister.forEach((listener) => listener(...items));
      };
    },
  };
  return registry;
}

const stores: WalletConnectionStore[] = [];
function start(registry: Wallets) {
  const store = new WalletConnectionStore();
  store.start(registry);
  stores.push(store);
  return store;
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.stop());
  vi.useRealTimers();
});

describe('address-only wallet connection', () => {
  it('discovers Solana wallets without using an already approved account or connecting', () => {
    const wallet = makeWallet();
    const ethereum = { ...wallet.wallet, name: 'Other chain', chains: ['eip155:1'] as const };
    const incomplete = {
      ...wallet.wallet,
      name: 'No events',
      features: { 'standard:connect': { version: '1.0.0', connect: wallet.connect } },
    };
    const store = start(makeRegistry(wallet.wallet, ethereum, incomplete));
    expect(store.getSnapshot().available).toEqual([wallet.wallet]);
    expect(store.getSnapshot().account).toBeNull();
    expect(wallet.connect).not.toHaveBeenCalled();
  });

  it('discovers late registration and clears an account when its wallet is removed', async () => {
    const registry = makeRegistry();
    const store = start(registry);
    const wallet = makeWallet();
    const remove = registry.register(wallet.wallet);
    expect(store.getSnapshot().available).toHaveLength(1);
    await store.connect(wallet.wallet);
    remove();
    expect(store.getSnapshot().available).toHaveLength(0);
    expect(store.getSnapshot().account).toBeNull();
    expect(wallet.events.size).toBe(0);
  });

  it('only requests a connection and exposes the approved public account', async () => {
    const wallet = makeWallet();
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    expect(wallet.connect).toHaveBeenCalledTimes(1);
    expect(wallet.connect).toHaveBeenCalledWith();
    expect(store.getSnapshot().account).toEqual(accountA);
    expect(store.getSnapshot().status).toBe('connected');
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('handles declined approval and allows a subsequent explicit retry', async () => {
    const wallet = makeWallet();
    wallet.connect.mockRejectedValueOnce({ code: 4001 });
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    expect(store.getSnapshot().error).toContain('declined');
    expect(store.getSnapshot().account).toBeNull();
    await store.connect(wallet.wallet);
    expect(store.getSnapshot().status).toBe('connected');
  });

  it('does not clear accounts on a chains-only event and clears explicit empty accounts', async () => {
    const wallet = makeWallet();
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    wallet.emit({ chains: ['solana:mainnet', 'solana:devnet'] });
    expect(store.getSnapshot().account).toEqual(accountA);
    wallet.emit({ accounts: [] });
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(store.getSnapshot().account).toBeNull();
  });

  it('updates changed accounts and only selects accounts the wallet approved', async () => {
    const wallet = makeWallet();
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    wallet.emit({ accounts: [accountA, accountB] });
    store.selectAccount(accountB.address);
    expect(store.getSnapshot().account).toEqual(accountB);
    store.selectAccount('unapproved');
    expect(store.getSnapshot().account).toEqual(accountB);
    wallet.emit({ accounts: [accountA] });
    expect(store.getSnapshot().account).toEqual(accountA);
  });

  it('invalidates an unsupported chain or missing feature', async () => {
    const wallet = makeWallet();
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    wallet.emit({ features: {} });
    expect(store.getSnapshot().account).toBeNull();
    expect(store.getSnapshot().available).toHaveLength(0);
  });

  it('rejects malformed and non-Solana approved account data', async () => {
    const wallet = makeWallet();
    wallet.connect.mockResolvedValueOnce({
      accounts: [
        { ...accountA, publicKey: new Uint8Array(31) },
        { ...accountB, chains: ['eip155:1'] },
      ],
    });
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(store.getSnapshot().error).toContain('No compatible Solana account');
  });

  it('prevents double clicks from creating parallel approval requests', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const wallet = makeWallet();
    wallet.connect.mockReturnValue(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const first = store.connect(wallet.wallet);
    await store.connect(wallet.wallet);
    expect(wallet.connect).toHaveBeenCalledTimes(1);
    pending.resolve({ accounts: [accountA] });
    await first;
  });

  it('ignores a delayed approval after the connection was cancelled', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const wallet = makeWallet();
    wallet.connect.mockReturnValue(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const connection = store.connect(wallet.wallet);
    store.cancel();
    pending.resolve({ accounts: [accountA] });
    await connection;
    expect(store.getSnapshot().account).toBeNull();
    expect(store.getSnapshot().status).toBe('disconnected');
  });

  it('clears the account immediately and ignores approval after disconnect', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const wallet = makeWallet();
    wallet.connect.mockReturnValue(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const connection = store.connect(wallet.wallet);
    await store.disconnect();
    pending.resolve({ accounts: [accountA] });
    await connection;
    expect(store.getSnapshot().account).toBeNull();
    expect(wallet.disconnect).not.toHaveBeenCalled();
  });

  it('uses the latest account change during approval instead of a stale connect response', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const wallet = makeWallet();
    wallet.connect.mockReturnValue(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const connection = store.connect(wallet.wallet);
    wallet.emit({ accounts: [accountB] });
    pending.resolve({ accounts: [accountA] });
    await connection;
    expect(store.getSnapshot().account).toEqual(accountB);
  });

  it('blocks a second request to the same wallet until a cancelled provider request settles', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const wallet = makeWallet();
    wallet.connect.mockReturnValueOnce(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const first = store.connect(wallet.wallet);
    store.cancel();
    await store.connect(wallet.wallet);
    expect(wallet.connect).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toContain('previous request');
    wallet.emit({ accounts: [accountA] });
    pending.resolve({ accounts: [accountA] });
    await first;
    wallet.connect.mockResolvedValueOnce({ accounts: [accountB] });
    await store.connect(wallet.wallet);
    expect(store.getSnapshot().account).toEqual(accountB);
  });

  it('allows a different wallet while the first provider request is pending', async () => {
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    const firstWallet = makeWallet('First');
    const other = makeWallet('Other');
    firstWallet.connect.mockReturnValueOnce(pending.promise);
    other.connect.mockResolvedValueOnce({ accounts: [accountB] });
    const store = start(makeRegistry(firstWallet.wallet, other.wallet));
    const first = store.connect(firstWallet.wallet);
    store.cancel();
    await store.connect(other.wallet);
    pending.resolve({ accounts: [accountA] });
    await first;
    expect(store.getSnapshot().account).toEqual(accountB);
    expect(store.getSnapshot().wallet).toBe(other.wallet);
  });

  it('waits for provider disconnect to settle before reconnecting the same wallet', async () => {
    vi.useFakeTimers();
    const wallet = makeWallet();
    const pending = deferred<void>();
    wallet.disconnect.mockReturnValueOnce(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    const cleanup = store.disconnect();
    expect(store.getSnapshot().account).toBeNull();
    await vi.advanceTimersByTimeAsync(8_000);
    await store.connect(wallet.wallet);
    expect(wallet.connect).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toContain('previous request');
    pending.resolve();
    await cleanup;
    await store.connect(wallet.wallet);
    expect(store.getSnapshot().status).toBe('connected');
  });

  it('keeps the website disconnected even if provider cleanup fails', async () => {
    const wallet = makeWallet();
    wallet.disconnect.mockRejectedValueOnce(new Error('Wallet unavailable'));
    const store = start(makeRegistry(wallet.wallet));
    await store.connect(wallet.wallet);
    await store.disconnect();
    expect(store.getSnapshot().account).toBeNull();
    expect(store.getSnapshot().status).toBe('disconnected');
    expect(store.getSnapshot().notice).toContain('saved site permission');
  });

  it('times out a wallet request and rejects its eventual late approval', async () => {
    vi.useFakeTimers();
    const wallet = makeWallet();
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    wallet.connect.mockReturnValue(pending.promise);
    const store = start(makeRegistry(wallet.wallet));
    const connection = store.connect(wallet.wallet);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().error).toContain('timed out');
    pending.resolve({ accounts: [accountA] });
    await connection;
    expect(store.getSnapshot().account).toBeNull();
  });

  it('unsubscribes and ignores late events or approvals after unmount', async () => {
    const wallet = makeWallet();
    const pending = deferred<{ accounts: readonly WalletAccount[] }>();
    wallet.connect.mockReturnValue(pending.promise);
    const registry = makeRegistry(wallet.wallet);
    const store = start(registry);
    const connection = store.connect(wallet.wallet);
    store.stop();
    pending.resolve({ accounts: [accountA] });
    await connection;
    registry.register(makeWallet('Late wallet').wallet);
    wallet.emit({ accounts: [accountB] });
    expect(store.getSnapshot().account).toBeNull();
    expect(store.getSnapshot().available).toHaveLength(0);
    expect(wallet.events.size).toBe(0);
  });
});
