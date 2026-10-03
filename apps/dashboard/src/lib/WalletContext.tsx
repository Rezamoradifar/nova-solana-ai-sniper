import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getWallets } from '@wallet-standard/app';
import { registerLegacyInjectedWallets, WalletConnectionStore } from './walletConnection.js';

const WalletContext = createContext<WalletConnectionStore | null>(null);

export function WalletConnectionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WalletConnectionStore());
  useEffect(() => {
    const registry = getWallets();
    const seen = new Set<object>();
    const cleanups: Array<() => void> = [];
    const registerInjected = () => {
      cleanups.push(...registerLegacyInjectedWallets(registry, window, seen));
      store.refresh();
    };

    store.start(registry);
    registerInjected();
    const retry250 = window.setTimeout(registerInjected, 250);
    const retry1000 = window.setTimeout(registerInjected, 1000);
    const retry2500 = window.setTimeout(registerInjected, 2500);

    return () => {
      window.clearTimeout(retry250);
      window.clearTimeout(retry1000);
      window.clearTimeout(retry2500);
      cleanups.splice(0).forEach((off) => off());
      store.stop();
    };
  }, [store]);
  return <WalletContext.Provider value={store}>{children}</WalletContext.Provider>;
}

export function useWalletConnection() {
  const store = useContext(WalletContext);
  if (!store) throw new Error('Wallet connection must be used within its provider.');
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    state,
    connect: store.connect,
    disconnect: store.disconnect,
    cancel: store.cancel,
    selectAccount: store.selectAccount,
    refresh: store.refresh,
  };
}
