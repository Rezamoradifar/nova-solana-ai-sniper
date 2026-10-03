import type { Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsChangeProperties,
  StandardEventsFeature,
} from '@wallet-standard/features';

export type ConnectionWallet = Wallet & {
  features: StandardConnectFeature & StandardEventsFeature & Partial<StandardDisconnectFeature>;
};


interface LegacyInjectedPublicKey {
  toBase58?: () => string;
  toBytes?: () => Uint8Array;
  toString: () => string;
}

interface LegacyInjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: LegacyInjectedPublicKey | null;
  connect: () => Promise<{ publicKey?: LegacyInjectedPublicKey } | void>;
  disconnect?: () => Promise<void>;
  on?: (event: string, listener: (value?: unknown) => void) => void;
  off?: (event: string, listener: (value?: unknown) => void) => void;
}

interface LegacyInjectedWindow {
  phantom?: { solana?: LegacyInjectedProvider };
  solflare?: LegacyInjectedProvider;
}

function legacyPublicKey(value: unknown): LegacyInjectedPublicKey | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LegacyInjectedPublicKey>;
  if (typeof candidate.toString !== 'function') return null;
  return candidate as LegacyInjectedPublicKey;
}

function legacyAccount(publicKey: LegacyInjectedPublicKey | null | undefined): WalletAccount | null {
  if (!publicKey) return null;
  const address =
    typeof publicKey.toBase58 === 'function' ? publicKey.toBase58() : publicKey.toString();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  const bytes = typeof publicKey.toBytes === 'function' ? publicKey.toBytes() : null;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
  return {
    address,
    publicKey: bytes,
    chains: ['solana:mainnet'],
    features: [],
  };
}

function legacyWallet(
  name: string,
  icon: Wallet['icon'],
  provider: LegacyInjectedProvider,
): ConnectionWallet {
  const listeners = new Set<(properties: StandardEventsChangeProperties) => void>();
  let current = legacyAccount(provider.publicKey);

  const notifyAccount = (value?: unknown) => {
    const key = legacyPublicKey(value) ?? provider.publicKey ?? null;
    current = legacyAccount(key);
    const accounts = current ? [current] : [];
    listeners.forEach((listener) => listener({ accounts }));
  };
  const notifyDisconnect = () => {
    current = null;
    listeners.forEach((listener) => listener({ accounts: [] }));
  };

  return {
    version: '1.0.0',
    name,
    icon,
    chains: ['solana:mainnet'],
    get accounts() {
      return current ? [current] : [];
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          const result = await provider.connect();
          const resultKey =
            result && typeof result === 'object' && 'publicKey' in result
              ? legacyPublicKey(result.publicKey)
              : null;
          current = legacyAccount(resultKey ?? provider.publicKey);
          return { accounts: current ? [current] : [] };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          await provider.disconnect?.();
          notifyDisconnect();
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (_event, listener) => {
          listeners.add(listener);
          provider.on?.('accountChanged', notifyAccount);
          provider.on?.('disconnect', notifyDisconnect);
          return () => {
            listeners.delete(listener);
            provider.off?.('accountChanged', notifyAccount);
            provider.off?.('disconnect', notifyDisconnect);
          };
        },
      },
    },
  };
}

const PHANTOM_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiM3YzY1ZmYiLz48cGF0aCBkPSJNMTYgNDJjNC0xOCAxNi0yOCAzMC0yOCA4IDAgMTIgNSAxMiAxMSAwIDEyLTEzIDI1LTMwIDI1LTUgMC0xNC0xLTEyLTgtNSA0LTggMi04LTQgMCAwLTQgNi04IDYiLTQiIGZpbGw9IiNmZmYiLz48L3N2Zz4=' as Wallet['icon'];
const SOLFLARE_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiNmNThhMWYiLz48cGF0aCBkPSJNMzIgMTJsNiAxNCAxNCA2LTE0IDYtNiAxNC02LTE0LTE0LTYgMTQtNiA2LTE0eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==' as Wallet['icon'];

/**
 * Some injected wallets expose their legacy browser provider before (or without)
 * registering Wallet Standard. Register a read-only connection adapter so the
 * public-address connect flow still works in those environments.
 */
export function registerLegacyInjectedWallets(
  registry: Wallets,
  scope: LegacyInjectedWindow = globalThis as unknown as LegacyInjectedWindow,
  seen: Set<object> = new Set(),
): Array<() => void> {
  const existingNames = new Set(registry.get().map((wallet) => wallet.name.toLowerCase()));
  const candidates: Array<{
    name: string;
    icon: Wallet['icon'];
    provider: LegacyInjectedProvider | undefined;
    valid: (provider: LegacyInjectedProvider) => boolean;
  }> = [
    {
      name: 'Phantom',
      icon: PHANTOM_ICON,
      provider: scope.phantom?.solana,
      valid: (provider) => provider.isPhantom === true,
    },
    {
      name: 'Solflare',
      icon: SOLFLARE_ICON,
      provider: scope.solflare,
      valid: (provider) => provider.isSolflare === true,
    },
  ];

  const off: Array<() => void> = [];
  for (const candidate of candidates) {
    const provider = candidate.provider;
    if (
      !provider ||
      typeof provider !== 'object' ||
      seen.has(provider as object) ||
      existingNames.has(candidate.name.toLowerCase()) ||
      typeof provider.connect !== 'function' ||
      !candidate.valid(provider)
    ) {
      continue;
    }
    seen.add(provider as object);
    off.push(registry.register(legacyWallet(candidate.name, candidate.icon, provider)));
    existingNames.add(candidate.name.toLowerCase());
  }
  return off;
}

export interface WalletConnectionState {
  available: readonly ConnectionWallet[];
  status: 'disconnected' | 'connecting' | 'connected' | 'disconnecting';
  wallet: ConnectionWallet | null;
  accounts: readonly WalletAccount[];
  account: WalletAccount | null;
  error: string | null;
  notice: string | null;
}

function method(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === 'function'
  );
}

export function supportsSolanaConnection(wallet: Wallet): wallet is ConnectionWallet {
  return (
    wallet.chains.includes('solana:mainnet') &&
    method(wallet.features['standard:connect'], 'connect') &&
    method(wallet.features['standard:events'], 'on')
  );
}

function approvedSolanaAccounts(accounts: readonly WalletAccount[]): WalletAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    if (
      !account.chains.includes('solana:mainnet') ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account.address) ||
      account.publicKey.length !== 32 ||
      seen.has(account.address)
    )
      return false;
    seen.add(account.address);
    return true;
  });
}

function connectError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const message = error instanceof Error ? error.message : '';
  if (code === 4001 || /reject|declin|cancel/i.test(message))
    return 'Connection was declined. Choose your wallet to try again when you are ready.';
  return 'The wallet could not connect. Unlock it, check its connection request, and try again.';
}

const initialState = (): WalletConnectionState => ({
  available: [],
  status: 'disconnected',
  wallet: null,
  accounts: [],
  account: null,
  error: null,
  notice: null,
});

/** Address-only connection state. No signing, authentication, RPC or trading methods. */
export class WalletConnectionStore {
  private state = initialState();
  private listeners = new Set<() => void>();
  private registry: Wallets | null = null;
  private registryOff: Array<() => void> = [];
  private walletOff: (() => void) | null = null;
  private attempt = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private pendingAccountChange: readonly WalletAccount[] | null = null;
  private pendingOperations = new Set<ConnectionWallet>();

  getSnapshot = (): WalletConnectionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WalletConnectionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private clearTimeout() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }
  private release() {
    this.attempt++;
    this.clearTimeout();
    this.walletOff?.();
    this.walletOff = null;
    this.pendingAccountChange = null;
  }
  start(registry: Wallets) {
    this.registry = registry;
    this.registryOff = [
      registry.on('register', this.refresh),
      registry.on('unregister', this.refresh),
    ];
    this.refresh();
  }
  stop() {
    this.release();
    this.registryOff.forEach((off) => off());
    this.registryOff = [];
    this.registry = null;
    this.update(initialState());
  }
  refresh = () => {
    if (!this.registry) return;
    const available = this.registry
      .get()
      .filter(supportsSolanaConnection)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (this.state.wallet && !available.includes(this.state.wallet)) {
      this.release();
      this.update({
        ...initialState(),
        available,
        notice: 'Your wallet is no longer available. Choose a wallet to reconnect.',
      });
    } else this.update({ available });
  };
  private change(wallet: ConnectionWallet, properties: StandardEventsChangeProperties) {
    if (this.state.wallet !== wallet || this.state.status === 'disconnecting') return;
    const chains = properties.chains ?? wallet.chains;
    const features = properties.features ?? wallet.features;
    if (
      !chains.includes('solana:mainnet') ||
      !method(features['standard:connect'], 'connect') ||
      !method(features['standard:events'], 'on')
    ) {
      this.release();
      this.update({
        ...initialState(),
        available: this.state.available.filter((item) => item !== wallet),
        error: 'This wallet no longer exposes a compatible Solana connection.',
      });
      return;
    }
    if (properties.accounts === undefined) return;
    const accounts = approvedSolanaAccounts(properties.accounts);
    if (!accounts.length) {
      this.release();
      this.update({
        ...initialState(),
        available: this.state.available,
        notice: 'Wallet access ended. Choose a wallet to reconnect.',
      });
      return;
    }
    if (this.state.status === 'connecting') {
      this.pendingAccountChange = accounts;
      return;
    }
    const account =
      accounts.find((item) => item.address === this.state.account?.address) ?? accounts[0]!;
    this.update({
      accounts,
      account,
      error: null,
      notice: 'Your approved accounts have been updated.',
    });
  }
  connect = async (wallet: ConnectionWallet): Promise<void> => {
    if (this.state.status !== 'disconnected') return;
    if (this.pendingOperations.has(wallet)) {
      this.update({
        error:
          'A previous request is still open in this wallet. Close that request in your wallet, then try again.',
      });
      return;
    }
    if (!this.state.available.includes(wallet) || !supportsSolanaConnection(wallet)) {
      this.update({
        error: 'This wallet is no longer available. Check again and choose a detected wallet.',
      });
      return;
    }
    this.release();
    const attempt = this.attempt;
    this.update({
      status: 'connecting',
      wallet,
      account: null,
      accounts: [],
      error: null,
      notice: null,
    });
    this.pendingOperations.add(wallet);
    try {
      this.walletOff = wallet.features['standard:events'].on('change', (properties) => {
        if (attempt === this.attempt) this.change(wallet, properties);
      });
      this.timeout = setTimeout(() => {
        if (attempt !== this.attempt) return;
        this.cancel();
        this.update({
          error:
            'The connection request timed out. Close any old request in your wallet, then try again.',
        });
      }, 60_000);
      const result = await wallet.features['standard:connect'].connect();
      if (attempt !== this.attempt) return;
      this.clearTimeout();
      const accounts = approvedSolanaAccounts(this.pendingAccountChange ?? result.accounts);
      if (!accounts.length) {
        this.release();
        this.update({
          ...initialState(),
          available: this.state.available,
          error:
            'No compatible Solana account was approved. Select a Solana account in your wallet and try again.',
        });
        return;
      }
      this.pendingAccountChange = null;
      this.update({
        status: 'connected',
        accounts,
        account: accounts[0]!,
        error: null,
        notice: null,
      });
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.release();
      this.update({
        ...initialState(),
        available: this.state.available,
        error: connectError(error),
      });
    } finally {
      this.pendingOperations.delete(wallet);
    }
  };
  cancel = () => {
    if (this.state.status !== 'connecting') return;
    this.release();
    this.update({
      ...initialState(),
      available: this.state.available,
      notice: 'Connection cancelled here. Dismiss any pending request in your wallet.',
    });
  };
  selectAccount = (address: string) => {
    if (this.state.status !== 'connected') return;
    const account = this.state.accounts.find((item) => item.address === address);
    if (account) this.update({ account, notice: null });
  };
  disconnect = async (): Promise<void> => {
    const wallet = this.state.wallet;
    if (!wallet || this.state.status === 'disconnecting') return;
    if (this.state.status === 'connecting') {
      this.cancel();
      return;
    }
    this.release();
    const attempt = this.attempt;
    this.update({
      status: 'disconnecting',
      wallet: null,
      accounts: [],
      account: null,
      error: null,
      notice: null,
    });
    const done = (notice: string) => {
      if (attempt !== this.attempt) return;
      this.clearTimeout();
      this.update({ status: 'disconnected', notice });
    };
    this.timeout = setTimeout(
      () => done('Disconnected from this website. Manage saved site permissions in your wallet.'),
      8_000,
    );
    this.pendingOperations.add(wallet);
    try {
      if (method(wallet.features['standard:disconnect'], 'disconnect'))
        await wallet.features['standard:disconnect']!.disconnect();
      done('Disconnected from this website. Saved site permissions can be removed in your wallet.');
    } catch {
      done(
        'Disconnected from this website. Check your wallet to remove any saved site permission.',
      );
    } finally {
      this.pendingOperations.delete(wallet);
    }
  };
}
