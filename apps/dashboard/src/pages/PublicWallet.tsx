import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { useWalletConnection } from '../lib/WalletContext.js';
import { PUBLIC_API_BASE } from '../lib/publicMarket.js';
import { WalletButton } from '../components/WalletUI.js';
import { MobileWalletActions } from '../components/MobileWalletActions.js';
import { useLanguage } from '../lib/LanguageContext.js';
import { SOLANA_MAINNET_GENESIS } from '../lib/mainnet.js';

interface WalletNetworkSnapshot {
  mainnetVerified: boolean;
  genesisHash: string;
  chain: 'solana';
  cluster: 'mainnet-beta';
  address: string;
  lamports: string;
  sol: number;
  slot: number;
  checkedAt: number;
  signatures: Array<{
    signature: string;
    slot: number;
    err: unknown;
    blockTime: number | null;
    confirmationStatus: string | null;
  }>;
}

export default function PublicWallet() {
  const { t: localize } = useLanguage();
  const { state, selectAccount } = useWalletConnection();
  const { lang } = useLanguage();
  const [snapshot, setNetwork] = useState<WalletNetworkSnapshot | null>(null);
  const network = snapshot?.address === state.account?.address ? snapshot : null;
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyGuard = useRef<{ address?: string; active: boolean; attempt: number }>({
    active: false,
    attempt: 0,
  });
  useLayoutEffect(() => {
    const guard = { address: state.account?.address, active: true, attempt: 0 };
    copyGuard.current = guard;
    setCopyState('idle');
    return () => {
      guard.active = false;
    };
  }, [state.account?.address]);
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    const address = state.account?.address;
    if (!address) {
      setNetwork(null);
      setNetworkError(null);
      return;
    }

    setNetwork(null);
    setNetworkError(null);
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(
          `${PUBLIC_API_BASE}/public/wallet/${encodeURIComponent(address)}`,
          {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (!response.ok) throw new Error('Solana RPC data is currently unavailable.');
        const next = (await response.json()) as WalletNetworkSnapshot;
        if (next.address !== address || next.mainnetVerified !== true || next.genesisHash !== SOLANA_MAINNET_GENESIS ||
          next.chain !== 'solana' || next.cluster !== 'mainnet-beta')
          throw new Error('Solana RPC data is currently unavailable.');
        if (!controller.signal.aborted) {
          setNetwork(next);
          setNetworkError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setNetworkError(
            error instanceof Error ? error.message : 'Solana RPC data is currently unavailable.',
          );
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [state.account?.address]);
  const copyAddress = async () => {
    const guard = copyGuard.current;
    if (!guard.address || !guard.active) return;
    const attempt = ++guard.attempt;
    const copied = await copyToClipboard(guard.address);
    if (guard.active && guard.attempt === attempt) setCopyState(copied ? 'copied' : 'failed');
  };

  return (
    <div className="site-container interior-page wallet-page">
      <PageHeading
        eyebrow={localize('WEBSITE WALLET')}
        title={localize('Your wallet. Your connection.')}
        text={localize(
          'Choose a Solana wallet and approve access to your public address. Manage the connection here.',
        )}
      />
      <div className="wallet-workspace">
        <section className="wallet-connect-panel panel" aria-labelledby="wallet-connect-title">
          <div className="wallet-panel-heading">
            <span className="wallet-step">01</span>
            <div>
              <h2 id="wallet-connect-title">
                {state.account ? localize('Wallet connected') : localize('Connect a wallet')}
              </h2>
              <p>{localize('One wallet connection across your Moneyland workspace.')}</p>
            </div>
            <Icon name="wallet" size={27} />
          </div>
          <div className="wallet-approved">
            <p>
              {localize(
                'Use a browser wallet or connect a compatible Solana wallet with WalletConnect.',
              )}
            </p>
            <WalletButton />
            <p className="muted">Phantom · Solflare · SafePal · WalletConnect</p>
          </div>
          <div className="wallet-connect-foot">
            <Icon name="shield" size={16} />
            <span>
              {localize(
                'Connecting shares your public address. Transactions need separate approval.',
              )}
            </span>
          </div>
        </section>

        <aside className="wallet-details panel" aria-labelledby="wallet-details-title">
          <div className="wallet-panel-heading">
            <span className="wallet-step">02</span>
            <div>
              <h2 id="wallet-details-title">{localize('Connection details')}</h2>
              <p>
                {state.account
                  ? localize('Your selected public account.')
                  : localize('Your approved address will appear here.')}
              </p>
            </div>
          </div>
          <div className="wallet-details-body">
            <div className="wallet-chain-row">
              <span className="token-mark">≋</span>
              <div>
                <strong>Solana</strong>
                <small>{localize('Website market data · Mainnet')}</small>
              </div>
              <span className={`wallet-state-pill ${state.account ? 'is-connected' : ''}`}>
                {state.account
                  ? localize('Connected')
                  : state.status === 'connecting'
                    ? localize('Awaiting approval')
                    : localize('Not connected')}
              </span>
            </div>
            {state.accounts.length > 1 && (
              <label className="wallet-account-select">
                {localize('Approved account')}
                <select
                  value={state.account?.address ?? ''}
                  onChange={(event) => selectAccount(event.target.value)}
                >
                  {state.accounts.map((account) => (
                    <option key={account.address} value={account.address}>
                      {account.label ??
                        `${account.address.slice(0, 6)}…${account.address.slice(-6)}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="wallet-field-label">{localize('PUBLIC ADDRESS')}</span>
            <div className={`wallet-address ${state.account ? 'has-address' : ''}`}>
              <code>
                {state.account?.address ?? localize('Connect your wallet to view its address')}
              </code>
            </div>
            {state.account && (
              <div className="wallet-address-actions">
                <button className="nova-button button-outline" onClick={() => void copyAddress()}>
                  <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={17} />
                  {copyState === 'copied' ? localize('Copied') : localize('Copy address')}
                </button>
                <a
                  className="text-link"
                  href={`https://solscan.io/account/${encodeURIComponent(state.account.address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {localize('View on Solscan') + ' '}
                  <Icon name="external" size={15} />
                </a>
              </div>
            )}
            {copyState === 'failed' && (
              <p className="wallet-message" role="status">
                {localize('Select the address above to copy it manually.')}
              </p>
            )}
            <div className="wallet-access-details">
              <div>
                <span>{localize('Account access')}</span>
                <strong>
                  {state.account ? localize('Public address') : localize('Not requested')}
                </strong>
              </div>
              <div>
                <span>{localize('Mainnet balance')}</span>
                <strong>
                  {network
                    ? `${network.sol.toFixed(6)} SOL`
                    : networkError
                      ? localize('Unavailable')
                      : state.account
                        ? localize('Loading…')
                        : '—'}
                </strong>
              </div>
              <div>
                <span>{localize('RPC slot')}</span>
                <strong>{network ? network.slot.toLocaleString() : '—'}</strong>
              </div>
              <div>
                <span>{localize('Transaction requests')}</span>
                <strong>{localize('None')}</strong>
              </div>
              <div>
                <span>{localize('Telegram account')}</span>
                <Link to="/telegram">{localize('Managed in bot')}</Link>
              </div>
            </div>
            {networkError && (
              <p className="wallet-message wallet-error" role="status">
                {localize(networkError ?? '')}
              </p>
            )}
            {network && network.signatures.length > 0 && (
              <div className="mt-4">
                <span className="wallet-field-label">{localize('RECENT MAINNET ACTIVITY')}</span>
                <div className="mt-2 space-y-2">
                  {network.signatures.slice(0, 5).map((row) => (
                    <a
                      key={row.signature}
                      href={`https://solscan.io/tx/${row.signature}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-3 rounded-lg border border-surface-border p-3 text-xs hover:border-accent/50"
                    >
                      <span className="font-mono text-slate-300">
                        {row.signature.slice(0, 8)}…{row.signature.slice(-8)}
                      </span>
                      <span className={row.err ? 'text-loss' : 'text-profit'}>
                        {row.err ? localize('Failed') : (row.confirmationStatus ?? 'confirmed')}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <MobileWalletActions lang={lang} />
      <div className="wallet-next-links">
        <Link to="/tools" className="text-link">
          {localize('Explore website tools')}
        </Link>
        <Link to="/telegram" className="text-link">
          <Icon name="telegram" size={18} />
          {localize('Telegram bot account')}
        </Link>
      </div>
    </div>
  );
}
