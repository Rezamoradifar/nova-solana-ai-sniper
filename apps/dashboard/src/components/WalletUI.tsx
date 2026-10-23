import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { useWalletConnection, walletConnectProjectId } from '../lib/WalletContext.js';
import { useLanguage } from '../lib/LanguageContext.js';
import { WALLETCONNECT_NAME } from '../lib/walletConnect.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { MobileWalletActions } from './MobileWalletActions.js';
import './WalletUI.css';

const WalletUIContext = createContext<(() => void) | null>(null);
export function useWalletUI() {
  const open = useContext(WalletUIContext);
  if (!open) throw new Error('WalletUIProvider is required.');
  return open;
}

export function WalletButton({ className = '' }: { className?: string }) {
  const open = useWalletUI();
  const { state } = useWalletConnection();
  const { t } = useLanguage();
  const address = state.account?.address;
  return (
    <button
      type="button"
      className={`nova-wallet-button ${className}`}
      onClick={open}
      aria-label={t('Connect or manage wallet', 'اتصال یا مدیریت کیف پول')}
    >
      <span aria-hidden="true">◈</span>
      <span dir={address ? 'ltr' : undefined}>
        {address ? `${address.slice(0, 4)}…${address.slice(-4)}` : t('Connect wallet')}
      </span>
    </button>
  );
}

/** One chooser shared by the landing, connected tools, account dashboard and V2. */
export function WalletUIProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const { state, connect, cancel, disconnect, selectAccount, refresh } = useWalletConnection();
  const { lang, t } = useLanguage();
  const show = useCallback(() => {
    setCopied(false);
    setOpen(true);
  }, []);
  const close = () => {
    if (state.status === 'connecting') cancel();
    setOpen(false);
  };
  const busy = state.status === 'connecting' || state.status === 'disconnecting';
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);
  useEffect(() => {
    setCopied(false);
  }, [state.account?.address]);

  const choose = async (wallet: (typeof state.available)[number]) => {
    // Release the native top-layer dialog before AppKit opens its own chooser.
    const remote = wallet.name === WALLETCONNECT_NAME;
    if (remote) setOpen(false);
    await connect(wallet);
    if (remote) setOpen(true);
  };

  return (
    <WalletUIContext.Provider value={show}>
      {children}
      <dialog
        ref={ref}
        className="nova-wallet-dialog"
        dir={lang === 'fa' ? 'rtl' : 'ltr'}
        aria-labelledby={title}
        aria-describedby={description}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === ref.current) close();
        }}
      >
        <div className="nova-wallet-sheet">
          <header className="nova-wallet-heading">
            <div>
              <small>MONEYLAND · SOLANA</small>
              <h2 id={title}>{state.account ? t('Wallet connected') : t('Connect wallet')}</h2>
            </div>
            <button
              type="button"
              className="nova-wallet-close"
              aria-label={t('Close', 'بستن')}
              onClick={close}
            >
              ×
            </button>
          </header>
          <p id={description} className="nova-wallet-description">
            {t(
              'Choose your wallet or connect from another device with WalletConnect.',
              'کیف پول خود را انتخاب کنید یا با WalletConnect از دستگاه دیگری متصل شوید.',
            )}
          </p>
          {state.account ? (
            <div className="nova-wallet-account">
              <span className="nova-wallet-network">
                <i />
                {t('Solana mainnet', 'شبکه اصلی سولانا')}
              </span>
              <strong>{state.wallet?.name}</strong>
              <p dir="ltr" className="nova-wallet-address">
                {state.account.address}
              </p>
              {state.accounts.length > 1 && (
                <label>
                  {t('Account', 'حساب')}
                  <select
                    value={state.account.address}
                    onChange={(event) => selectAccount(event.target.value)}
                  >
                    {state.accounts.map((account) => (
                      <option key={account.address} value={account.address}>
                        {account.address}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="nova-wallet-actions">
                <button
                  type="button"
                  onClick={() => {
                    const address = state.account?.address;
                    if (address) void copyToClipboard(address).then(setCopied);
                  }}
                >
                  {copied ? t('Copied', 'کپی شد') : t('Copy address', 'کپی آدرس')}
                </button>
                <button type="button" onClick={() => void disconnect()} disabled={busy}>
                  {t('Disconnect wallet')}
                </button>
              </div>
              <Link to="/wallet" onClick={() => setOpen(false)} className="nova-wallet-primary">
                {t('View wallet', 'مشاهده کیف پول')}
              </Link>
            </div>
          ) : (
            <>
              <div className="nova-wallet-options">
                {state.available.map((wallet, index) => (
                  <button
                    type="button"
                    key={wallet.name + index}
                    className="nova-wallet-choice"
                    disabled={busy}
                    onClick={() => void choose(wallet)}
                  >
                    <img src={wallet.icon} alt="" width="38" height="38" />
                    <span>
                      <strong>{wallet.name}</strong>
                      <small>
                        {wallet.name === WALLETCONNECT_NAME
                          ? t('QR code · mobile & desktop', 'کد QR · موبایل و رایانه')
                          : t('Detected in this browser', 'شناسایی‌شده در این مرورگر')}
                      </small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
              {!walletConnectProjectId && (
                <p className="nova-wallet-description">
                  {t(
                    'QR connection is currently unavailable. Use a detected wallet or its app browser.',
                    'اتصال QR فعلاً در دسترس نیست. از کیف پول شناسایی‌شده یا مرورگر داخل اپ آن استفاده کنید.',
                  )}
                </p>
              )}
              {!state.available.length && (
                <p>{t('No compatible wallet detected', 'کیف پول سازگار شناسایی نشد')}</p>
              )}
              {state.status === 'connecting' && (
                <div role="status" className="nova-wallet-description">
                  <p>
                    {t(
                      'Approve the connection in your wallet.',
                      'اتصال را داخل کیف پول تأیید کنید.',
                    )}
                  </p>
                  <button type="button" onClick={cancel}>
                    {t('Cancel request', 'لغو درخواست')}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="nova-wallet-refresh"
                disabled={busy}
                onClick={refresh}
              >
                {t('Check wallets again', 'بررسی دوباره کیف پول‌ها')}
              </button>
              <MobileWalletActions lang={lang} />
            </>
          )}
          {state.error && (
            <p role="alert" className="nova-wallet-error">
              {t(state.error)}
            </p>
          )}
          {state.notice && (
            <p role="status" className="nova-wallet-description">
              {t(state.notice)}
            </p>
          )}
          <footer className="nova-wallet-footer">
            {t(
              'Connection shares your public address. Your keys stay in your wallet. Trades require separate authorization.',
              'اتصال فقط آدرس عمومی را در اختیار سایت می‌گذارد. کلیدها در کیف پول می‌مانند. معامله به مجوز جداگانه نیاز دارد.',
            )}
          </footer>
        </div>
      </dialog>
    </WalletUIContext.Provider>
  );
}
