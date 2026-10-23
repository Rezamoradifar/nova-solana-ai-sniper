/** Accept only same-site UI destinations; do not let login become an open redirect. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//'))
    return '/dashboard';
  try {
    const url = new URL(value, 'https://moneyland.tr');
    if (
      url.origin !== 'https://moneyland.tr' ||
      url.pathname === '/login' ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/app')
    )
      return '/dashboard';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/dashboard';
  }
}
