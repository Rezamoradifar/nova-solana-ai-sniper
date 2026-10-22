/**
 * Open this site's public-address connection page inside a mobile Solana wallet.
 * Build links only for secure HTTPS origins; never forward query strings or hashes.
 */
export function getMobileWalletLinks(origin: string): {
  page: string;
  phantom: string;
  solflare: string;
} | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const page = new URL('/wallet', url.origin).href;
    const target = encodeURIComponent(page);
    const ref = encodeURIComponent(url.origin);
    return {
      page,
      phantom: `https://phantom.app/ul/browse/${target}?ref=${ref}`,
      solflare: `https://solflare.com/ul/v1/browse/${target}?ref=${ref}`,
    };
  } catch {
    return null;
  }
}
