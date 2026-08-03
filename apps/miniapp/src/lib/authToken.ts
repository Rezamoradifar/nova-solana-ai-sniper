const TOKEN_STORAGE_KEY = 'nova.miniapp.token';

/**
 * localStorage, same choice apps/dashboard already makes successfully — not
 * Telegram's CloudStorage, since that scope needs a bot-API round trip and
 * isn't available on every client version, and this token is re-derivable
 * anyway (a fresh initData exchange gets a new one) so losing it just means
 * one extra sign-in, never lost data.
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}
