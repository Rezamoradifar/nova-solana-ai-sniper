import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOLANA_WC_CHAIN } from './walletConnect.js';

const mocks = vi.hoisted(() => {
  const stateListeners = new Set<(state: { open: boolean }) => void>();
  const events = new Map<string, (...args: unknown[]) => void>();
  const provider = {
    session: undefined as
      undefined | { topic: string; namespaces: Record<string, { accounts: string[] }> },
    connect: vi.fn(),
    disconnect: vi.fn(),
    abortPairingAttempt: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      events.set(event, listener);
    }),
    request: vi.fn(),
  };
  const modal = {
    open: vi.fn(async () => {
      stateListeners.forEach((fn) => fn({ open: true }));
    }),
    close: vi.fn(async () => {
      stateListeners.forEach((fn) => fn({ open: false }));
    }),
    subscribeState: vi.fn((fn: (state: { open: boolean }) => void) => {
      stateListeners.add(fn);
      return () => {
        stateListeners.delete(fn);
      };
    }),
  };
  return {
    provider,
    modal,
    events,
    stateListeners,
    init: vi.fn(async (_options: unknown) => provider),
    create: vi.fn(() => modal),
  };
});
vi.mock('@walletconnect/universal-provider', () => ({ UniversalProvider: { init: mocks.init } }));
vi.mock('@reown/appkit/core', () => ({ createAppKit: mocks.create }));
vi.mock('@reown/appkit/networks', () => ({
  solana: { caipNetworkId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
}));
import { loadWalletConnect } from './walletConnectSdk.js';

const address = '11111111111111111111111111111111';
const approved = {
  topic: 'approved',
  namespaces: { solana: { accounts: [`${SOLANA_WC_CHAIN}:${address}`] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.clear();
  mocks.stateListeners.clear();
  mocks.provider.session = undefined;
  mocks.provider.disconnect.mockImplementation(async () => {
    mocks.provider.session = undefined;
  });
  vi.stubGlobal('window', { location: { origin: 'https://moneyland.tr' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('real SDK boundary for WalletConnect', () => {
  it('opens the QR chooser and requests only Solana mainnet public account access', async () => {
    mocks.provider.connect.mockImplementation(async () => {
      mocks.provider.session = approved;
      return approved;
    });
    const transport = await loadWalletConnect('a'.repeat(32));
    expect(mocks.provider.connect).not.toHaveBeenCalled();
    const result = await transport.connect();
    expect(result[0]?.address).toBe(address);
    expect(mocks.provider.connect).toHaveBeenCalledWith({
      namespaces: {
        solana: {
          chains: [SOLANA_WC_CHAIN],
          methods: [],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
    });
    expect(mocks.provider.request).not.toHaveBeenCalled();
    expect(mocks.modal.open).toHaveBeenCalledOnce();
    expect(mocks.modal.close).toHaveBeenCalledOnce();
    expect(mocks.init.mock.calls[0]?.[0]).toMatchObject({
      metadata: { url: 'https://moneyland.tr', name: 'Moneyland · GSP Trading' },
    });
  });

  it('rejects an approved session for another chain', async () => {
    const wrong = { topic: 'wrong', namespaces: { eip155: { accounts: ['eip155:56:0x1234'] } } };
    mocks.provider.connect.mockImplementation(async () => {
      mocks.provider.session = wrong;
      return wrong;
    });
    const transport = await loadWalletConnect('a'.repeat(32));
    await expect(transport.connect()).rejects.toThrow('No Solana mainnet account');
    expect(mocks.provider.disconnect).toHaveBeenCalledOnce();
  });

  it('cancels when the chooser closes and discards a late approval without reopening access', async () => {
    let approve: (session: typeof approved) => void = () => {};
    mocks.provider.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const transport = await loadWalletConnect('a'.repeat(32));
    const pending = transport.connect();
    const result = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(mocks.provider.connect).toHaveBeenCalledOnce());
    mocks.stateListeners.forEach((fn) => fn({ open: false }));
    await result;
    expect(mocks.provider.abortPairingAttempt).toHaveBeenCalledOnce();
    await expect(transport.connect()).rejects.toThrow('previous connection request');
    mocks.provider.session = approved;
    approve(approved);
    await vi.waitFor(() => expect(mocks.provider.disconnect).toHaveBeenCalledOnce());
    expect(transport.accounts()).toEqual([]);
    expect(mocks.stateListeners.size).toBe(0);
  });

  it('handles remote session deletion and reuses an approved session only after an explicit connect', async () => {
    mocks.provider.session = approved;
    const transport = await loadWalletConnect('a'.repeat(32));
    const changed = vi.fn();
    transport.onChange(changed);
    expect(mocks.provider.connect).not.toHaveBeenCalled();
    expect((await transport.connect())[0]?.address).toBe(address);
    expect(mocks.modal.open).not.toHaveBeenCalled();
    mocks.events.get('session_delete')?.();
    expect(changed).toHaveBeenLastCalledWith([]);
  });
});
