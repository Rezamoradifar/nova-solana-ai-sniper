import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { useWalletConnection } from '../lib/WalletContext.js';

export default function PublicWallet() {
  const { state, connect, disconnect, cancel, selectAccount, refresh } = useWalletConnection();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyGuard = useRef<{ address?: string; active: boolean; attempt: number }>({
    active: false,
    attempt: 0,
  });
  const busy = state.status === 'connecting' || state.status === 'disconnecting';
  const mobileUrl =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? `${window.location.origin}/wallet`
      : null;
  const embedded = typeof window !== 'undefined' && window.self !== window.top;
  const mobileBrowser =
    typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    !/Phantom|Solflare/i.test(navigator.userAgent);

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
        eyebrow="WEBSITE WALLET"
        title="Your wallet. Your connection."
        text="Choose a Solana wallet and approve access to your public address. Manage the connection here."
      />
      <div className="wallet-workspace">
        <section className="wallet-connect-panel panel" aria-labelledby="wallet-connect-title">
          <div className="wallet-panel-heading">
            <span className="wallet-step">01</span>
            <div>
              <h2 id="wallet-connect-title">
                {state.account ? 'Wallet connected' : 'Connect a wallet'}
              </h2>
              <p>
                {state.account
                  ? 'Your approved account is available on this website.'
                  : 'Select a detected wallet to request a connection.'}
              </p>
            </div>
            <Icon name="wallet" size={27} />
          </div>

          {state.account && state.wallet ? (
            <div className="wallet-approved">
              <div className="wallet-approved-brand">
                <img src={state.wallet.icon} width="48" height="48" alt="" />
                <div>
                  <strong>{state.wallet.name}</strong>
                  <span>
                    <Icon name="check" size={15} /> Connected
                  </span>
                </div>
              </div>
              <div className="wallet-permission">
                <Icon name="shield" size={22} />
                <div>
                  <strong>Public address access</strong>
                  <p>
                    This connection lets the website display your approved account. Your keys stay
                    in your wallet.
                  </p>
                </div>
              </div>
              <button className="nova-button button-outline" onClick={() => void disconnect()}>
                <Icon name="disconnect" size={18} />
                Disconnect wallet
              </button>
            </div>
          ) : state.status === 'connecting' ? (
            <div className="wallet-waiting" role="status">
              <div className="wallet-pending-icon">
                <Icon name="wallet" size={35} />
              </div>
              <h3>Check {state.wallet?.name}</h3>
              <p>Unlock your wallet and review its connection request.</p>
              <button className="nova-button button-outline" onClick={cancel}>
                Cancel connection
              </button>
            </div>
          ) : state.status === 'disconnecting' ? (
            <div className="wallet-waiting" role="status">
              <Icon name="disconnect" size={32} />
              <h3>Disconnecting wallet…</h3>
              <p>Your address has been cleared from this website.</p>
            </div>
          ) : (
            <>
              {state.available.length ? (
                <div className="detected-wallets" aria-label="Detected wallets">
                  {state.available.map((wallet, index) => (
                    <button
                      className="wallet-choice"
                      key={`${wallet.name}-${index}`}
                      disabled={busy}
                      onClick={() => void connect(wallet)}
                    >
                      <img src={wallet.icon} width="42" height="42" alt="" />
                      <span>
                        <strong>{wallet.name}</strong>
                        <small>Detected in this browser</small>
                      </span>
                      <span className="wallet-choice-action">Connect</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="wallet-not-found">
                  <span className="wallet-empty-icon">
                    <Icon name="wallet" size={35} />
                  </span>
                  <h3>No compatible wallet detected</h3>
                  <p>
                    {mobileBrowser
                      ? 'Mobile Chrome/Safari cannot expose Phantom or Solflare to this page. Open GSP TRADING inside the wallet app browser, then connect again.'
                      : 'Use a browser with a Solana wallet extension, or open this page in a supported wallet’s in-app browser.'}
                  </p>
                  {embedded && (
                    <div className="wallet-embedded-note">
                      <p>Wallet extensions may be unavailable inside an embedded preview.</p>
                      <a href="/wallet" target="_blank" rel="noreferrer" className="text-link">
                        Open this page directly
                      </a>
                    </div>
                  )}
                  <div className="wallet-install-links">
                    <a href="https://phantom.com/download" target="_blank" rel="noreferrer">
                      Get Phantom <Icon name="external" size={14} />
                    </a>
                    <a href="https://solflare.com/download" target="_blank" rel="noreferrer">
                      Get Solflare <Icon name="external" size={14} />
                    </a>
                  </div>
                </div>
              )}
              {mobileBrowser && mobileUrl && (
                <div className="wallet-mobile-quickstart">
                  <strong>Mobile connection</strong>
                  <p>Open this exact GSP TRADING page inside your wallet app.</p>
                  <div className="wallet-mobile-links">
                    <a
                      href={`https://phantom.app/ul/browse/${encodeURIComponent(mobileUrl)}?ref=${encodeURIComponent(window.location.origin)}`}
                      className="nova-button"
                    >
                      Open in Phantom
                    </a>
                    <a
                      href={`https://solflare.com/ul/v1/browse/${encodeURIComponent(mobileUrl)}?ref=${encodeURIComponent(window.location.origin)}`}
                      className="nova-button button-outline"
                    >
                      Open in Solflare
                    </a>
                  </div>
                </div>
              )}
              <button className="wallet-recheck" onClick={refresh}>
                <Icon name="refresh" size={16} />
                Check for wallets again
              </button>
            </>
          )}
          {state.error && (
            <p className="wallet-message wallet-error" role="alert">
              {state.error}
            </p>
          )}
          {state.notice && (
            <p className="wallet-message" role="status">
              {state.notice}
            </p>
          )}
          <div className="wallet-connect-foot">
            <Icon name="shield" size={16} />
            <span>
              Connection requests public account access. It does not request a payment or
              transaction signature.
            </span>
          </div>
        </section>

        <aside className="wallet-details panel" aria-labelledby="wallet-details-title">
          <div className="wallet-panel-heading">
            <span className="wallet-step">02</span>
            <div>
              <h2 id="wallet-details-title">Connection details</h2>
              <p>
                {state.account
                  ? 'Your selected public account.'
                  : 'Your approved address will appear here.'}
              </p>
            </div>
          </div>
          <div className="wallet-details-body">
            <div className="wallet-chain-row">
              <span className="token-mark">≋</span>
              <div>
                <strong>Solana</strong>
                <small>Website market data · Mainnet</small>
              </div>
              <span className={`wallet-state-pill ${state.account ? 'is-connected' : ''}`}>
                {state.account
                  ? 'Connected'
                  : state.status === 'connecting'
                    ? 'Awaiting approval'
                    : 'Not connected'}
              </span>
            </div>
            {state.accounts.length > 1 && (
              <label className="wallet-account-select">
                Approved account
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
            <span className="wallet-field-label">PUBLIC ADDRESS</span>
            <div className={`wallet-address ${state.account ? 'has-address' : ''}`}>
              <code>{state.account?.address ?? 'Connect your wallet to view its address'}</code>
            </div>
            {state.account && (
              <div className="wallet-address-actions">
                <button className="nova-button button-outline" onClick={() => void copyAddress()}>
                  <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={17} />
                  {copyState === 'copied' ? 'Copied' : 'Copy address'}
                </button>
                <a
                  className="text-link"
                  href={`https://solscan.io/account/${encodeURIComponent(state.account.address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Solscan <Icon name="external" size={15} />
                </a>
              </div>
            )}
            {copyState === 'failed' && (
              <p className="wallet-message" role="status">
                Select the address above to copy it manually.
              </p>
            )}
            <div className="wallet-access-details">
              <div>
                <span>Account access</span>
                <strong>{state.account ? 'Public address' : 'Not requested'}</strong>
              </div>
              <div>
                <span>Transaction requests</span>
                <strong>None</strong>
              </div>
              <div>
                <span>Telegram account</span>
                <Link to="/telegram">Managed in bot</Link>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <section className="wallet-mobile-help">
        <div>
          <Icon name="globe" size={24} />
          <div>
            <h2>Connecting on your phone?</h2>
            <p>
              Open this website in your wallet’s browser, then choose the wallet above. A normal
              mobile browser may not expose your wallet.
            </p>
          </div>
        </div>
        {mobileUrl && (
          <div className="wallet-mobile-links">
            <a
              href={`https://phantom.app/ul/browse/${encodeURIComponent(mobileUrl)}?ref=${encodeURIComponent(window.location.origin)}`}
              className="nova-button button-outline"
              target="_blank"
              rel="noreferrer"
            >
              Open in Phantom
            </a>
            <a
              href={`https://solflare.com/ul/v1/browse/${encodeURIComponent(mobileUrl)}?ref=${encodeURIComponent(window.location.origin)}`}
              className="nova-button button-outline"
              target="_blank"
              rel="noreferrer"
            >
              Open in Solflare
            </a>
          </div>
        )}
      </section>
      <div className="wallet-next-links">
        <Link to="/tools" className="text-link">
          Explore website tools
        </Link>
        <Link to="/telegram" className="text-link">
          <Icon name="telegram" size={18} />
          Telegram bot account
        </Link>
      </div>
    </div>
  );
}
