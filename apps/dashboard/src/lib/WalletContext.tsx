import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getWallets } from '@wallet-standard/app';
import { WalletConnectionStore } from './walletConnection.js';

const WalletContext = createContext<WalletConnectionStore | null>(null);

export function WalletConnectionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WalletConnectionStore());
  useEffect(() => {
    store.start(getWallets());
    return () => store.stop();
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
