import { UniversalProvider } from '@walletconnect/universal-provider';
import { createAppKit } from '@reown/appkit/core';
import { solana } from '@reown/appkit/networks';
import {
  SOLANA_WC_CHAIN,
  walletConnectAccounts,
  type WalletConnectTransport,
} from './walletConnect.js';

/** Imported only after a user chooses WalletConnect; never on ordinary page load. */
export async function loadWalletConnect(projectId: string): Promise<WalletConnectTransport> {
  const provider = await UniversalProvider.init({
    projectId,
    logger: 'silent',
    metadata: {
      name: 'Moneyland · GSP Trading',
      description: 'Solana wallet connection',
      url: window.location.origin,
      icons: [new URL('/favicon.svg', window.location.origin).href],
    },
  });
  const modal = createAppKit({
    projectId,
    networks: [solana],
    universalProvider: provider,
    manualWCControl: true,
    themeMode: 'dark',
    themeVariables: { '--w3m-accent': '#00e5ff', '--w3m-border-radius-master': '3px' },
    enableReconnect: false,
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  });
  let pending = false;
  let cancel: (() => void) | undefined;
  const listeners = new Set<Parameters<WalletConnectTransport['onChange']>[0]>();
  const accounts = () => walletConnectAccounts(provider.session);
  const changed = () => listeners.forEach((listener) => listener(accounts()));
  provider.on('session_update', changed);
  provider.on('accountsChanged', changed);
  provider.on('session_delete', () => listeners.forEach((listener) => listener([])));
  provider.on('disconnect', () => listeners.forEach((listener) => listener([])));

  return {
    accounts,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: () => cancel?.(),
    disconnect: async () => {
      if (provider.session) await provider.disconnect();
    },
    connect: async () => {
      if (pending) throw new Error('A previous connection request is still pending');
      // Reuse only a session whose mainnet account was explicitly approved by the wallet.
      if (accounts().length) return accounts();
      if (provider.session) await provider.disconnect();
      pending = true;
      let cancelled = false;
      let seenOpen = false;
      let approved = false;
      let started = false;
      let rejectCancel: (error: Error) => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancel = reject;
      });
      cancel = () => {
        if (approved || cancelled) return;
        cancelled = true;
        provider.abortPairingAttempt();
        rejectCancel(new Error('Connection cancelled'));
      };
      const unsubscribe = modal.subscribeState((state) => {
        if (state.open) seenOpen = true;
        else if (seenOpen && !approved && !accounts().length) cancel?.();
      });
      try {
        await modal.open();
        if (cancelled) throw new Error('Connection cancelled');
        started = true;
        const connecting = provider
          .connect({
            namespaces: {
              solana: {
                chains: [SOLANA_WC_CHAIN],
                methods: [],
                events: ['accountsChanged', 'chainChanged'],
              },
            },
          })
          .then(async (session) => {
            if (cancelled) {
              if (session && provider.session?.topic === session.topic) await provider.disconnect();
              throw new Error('Connection cancelled');
            }
            const next = walletConnectAccounts(session);
            if (!next.length) {
              if (provider.session) await provider.disconnect();
              throw new Error('No Solana mainnet account was approved');
            }
            approved = true;
            return next;
          })
          .finally(() => {
            pending = false;
          });
        return await Promise.race([connecting, cancellation]);
      } catch (error) {
        // A failed modal open never starts a pairing request.
        if (!started) pending = false;
        throw error;
      } finally {
        unsubscribe();
        cancel = undefined;
        await modal.close();
      }
    },
  };
}
