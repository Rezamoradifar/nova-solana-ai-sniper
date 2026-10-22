import { useState } from 'react';
import { copyToClipboard } from '../lib/clipboard.js';
import { getMobileWalletLinks } from '../lib/mobileWalletLinks.js';
import './MobileWalletActions.css';

/**
 * Normal mobile Chrome/Safari does not expose wallet providers installed in
 * separate apps. Open the site inside Phantom/Solflare or copy its public URL
 * for SafePal's in-app DApp browser. This component never asks for signatures.
 */
export function MobileWalletActions({ lang }: { lang: 'en' | 'fa' }) {
  const [copied, setCopied] = useState<'idle' | 'success' | 'error'>('idle');
  const links =
    typeof window === 'undefined' ? null : getMobileWalletLinks(window.location.origin);
  if (!links) return null;
  const fa = lang === 'fa';
  return (
    <section className="nova-mobile-wallet-actions" aria-label={fa ? 'اتصال با کیف پول موبایل' : 'Mobile wallet connection'}>
      <strong>{fa ? 'اتصال با گوشی' : 'Connect from a phone'}</strong>
      <p>
        {fa
          ? 'اگر مرورگر معمولی کیف پول را پیدا نمی‌کند، سایت را در مرورگر خود کیف پول باز کنید.'
          : 'If your phone browser cannot detect the wallet, open the site in your wallet app browser.'}
      </p>
      <div className="nova-mobile-wallet-links">
        <a href={links.phantom} rel="noreferrer" className="nova-mobile-wallet-link">
          {fa ? 'بازکردن Phantom' : 'Open Phantom'}
        </a>
        <a href={links.solflare} rel="noreferrer" className="nova-mobile-wallet-link">
          {fa ? 'بازکردن Solflare' : 'Open Solflare'}
        </a>
      </div>
      <p>
        <strong>SafePal:</strong>{' '}
        {fa
          ? 'در اپ SafePal وارد DApps / Explore شوید و آدرس سایت را باز کنید.'
          : 'In the SafePal app, open DApps / Explore and enter the website address.'}
      </p>
      <button
        type="button"
        className="nova-mobile-wallet-copy"
        onClick={() => {
          void copyToClipboard(links.page).then((ok) => setCopied(ok ? 'success' : 'error'));
        }}
      >
        {copied === 'success'
          ? fa ? 'آدرس سایت کپی شد' : 'Website address copied'
          : copied === 'error'
            ? fa ? 'کپی نشد؛ آدرس را دستی وارد کنید' : 'Could not copy; enter the address manually'
            : fa ? 'کپی آدرس سایت' : 'Copy website address'}
      </button>
      <small>{links.page}</small>
    </section>
  );
}
