import { describe, expect, it } from 'vitest';
import { getMobileWalletLinks } from './mobileWalletLinks.js';

describe('mobile wallet connection links', () => {
  it('opens only the public connection page at the real site origin', () => {
    const links = getMobileWalletLinks('https://moneyland.tr');
    expect(links?.page).toBe('https://moneyland.tr/wallet');
    expect(links?.phantom).toContain(encodeURIComponent('https://moneyland.tr/wallet'));
    expect(links?.solflare).toContain(encodeURIComponent('https://moneyland.tr/wallet'));
    expect(links?.phantom).toContain('ref=https%3A%2F%2Fmoneyland.tr');
  });

  it('never offers external deep links on insecure or malformed origins', () => {
    expect(getMobileWalletLinks('http://moneyland.tr')).toBeNull();
    expect(getMobileWalletLinks('not a url')).toBeNull();
    expect(getMobileWalletLinks('javascript:alert(1)')).toBeNull();
  });

  it('does not include a page query string in the deeplink', () => {
    const links = getMobileWalletLinks('https://moneyland.tr/?secret=never-copy');
    expect(links?.page).toBe('https://moneyland.tr/wallet');
    expect(links?.phantom).not.toContain('secret');
  });
  it('carries only the chosen site language into the mobile wallet browser', () => {
    const links = getMobileWalletLinks('https://moneyland.tr/?secret=never-copy', 'fa');
    expect(links?.page).toBe('https://moneyland.tr/wallet?lang=fa');
    expect(links?.phantom).toContain(encodeURIComponent('https://moneyland.tr/wallet?lang=fa'));
    expect(links?.phantom).not.toContain('secret');
  });
});
