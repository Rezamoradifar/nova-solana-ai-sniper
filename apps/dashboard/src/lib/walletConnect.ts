import type { WalletAccount } from '@wallet-standard/base';
import type { StandardEventsChangeProperties } from '@wallet-standard/features';
import { addressBytes, type ConnectionWallet } from './walletConnection.js';

export const SOLANA_WC_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const WALLETCONNECT_NAME = 'WalletConnect';
const ICON: `data:image/svg+xml;base64,${string}` = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#3b99fc"/><path d="M14 28q18-18 36 0l-5 5q-13-13-26 0zm5 7 8 8 5-5 5 5 8-8-5-5-3 3-5-5-5 5-3-3z" fill="white"/></svg>')}`;

export function validWalletConnectProjectId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim()) && value.trim() !== '0'.repeat(32)
    ? value.trim() : null;
}

interface Session {
  topic: string;
  namespaces: Record<string, { accounts: string[] }>;
}

export function walletConnectAccounts(session: Session | undefined): WalletAccount[] {
  const accounts = Object.values(session?.namespaces ?? {}).flatMap((ns) => ns.accounts);
  const approved = new Set<string>();
  return accounts.flatMap((account) => {
    const prefix = SOLANA_WC_CHAIN + ':';
    if (!account.startsWith(prefix)) return [];
    const address = account.slice(prefix.length);
    const publicKey = addressBytes(address);
    if (!publicKey || approved.has(address)) return [];
    approved.add(address);
    return [{ address, publicKey, chains: ['solana:mainnet'], features: [] }];
  });
}

export interface WalletConnectTransport {
  accounts(): WalletAccount[];
  connect(): Promise<WalletAccount[]>;
  disconnect(): Promise<void>;
  cancel(): void;
  onChange(listener: (accounts: WalletAccount[]) => void): () => void;
}

/** Wallet Standard bridge exposes public account access only, with no signer methods. */
export function createWalletConnectWallet(
  load: () => Promise<WalletConnectTransport>,
): ConnectionWallet {
  let transport: WalletConnectTransport | undefined;
  let current: readonly WalletAccount[] = [];
  let cancelled = false;
  const listeners = new Set<(properties: StandardEventsChangeProperties) => void>();
  let init: Promise<WalletConnectTransport> | undefined;
  const initialize = () =>
    (init ??= load()
      .then((next) => {
        transport = next;
        next.onChange((accounts) => {
          current = accounts;
          listeners.forEach((listener) => listener({ accounts }));
        });
        return next;
      })
      .catch((error) => {
        init = undefined;
        throw error;
      }));
  return {
    version: '1.0.0',
    name: WALLETCONNECT_NAME,
    icon: ICON,
    chains: ['solana:mainnet'],
    get accounts() {
      return current;
    },
    connectionTimeoutMs: 180_000,
    cancelConnect: () => {
      cancelled = true;
      transport?.cancel();
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          cancelled = false;
          const next = await initialize();
          if (cancelled) throw new Error('Connection cancelled');
          current = await next.connect();
          if (cancelled) {
            current = [];
            throw new Error('Connection cancelled');
          }
          return { accounts: current };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          await transport?.disconnect();
          current = [];
          listeners.forEach((listener) => listener({ accounts: [] }));
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (_event, listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  };
}
