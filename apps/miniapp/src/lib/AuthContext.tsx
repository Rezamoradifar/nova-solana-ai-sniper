import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.js';
import { clearToken, getToken, setToken } from './authToken.js';
import { getInitDataRaw, initTelegram } from './telegram.js';
import type { CurrentUser } from './types.js';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  /** Set only when status === 'error' — a message safe to show the user
   * (never a raw exception/stack). */
  errorMessage: string | null;
  /** True only when initTelegram() determined this isn't running inside a
   * real Telegram client at all — a distinct, non-retryable case from a
   * transient network/server error. */
  outsideTelegram: boolean;
  retry: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * End-to-end Telegram auth: initializes the SDK, exchanges initData for a
 * JWT via POST /auth/telegram (skipped if a still-valid token is already
 * stored — GET /auth/me is tried first so a returning user doesn't pay a
 * round trip + HMAC verification on every single launch), and exposes the
 * resulting user to the rest of the app. No screen should render behind this
 * until status is 'authenticated' — see AuthGate.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outsideTelegram, setOutsideTelegram] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const authenticate = useCallback(async () => {
    setStatus('loading');
    setErrorMessage(null);
    setOutsideTelegram(false);

    const { isInsideTelegram } = initTelegram();

    // A previously-issued token is tried first — avoids re-exchanging
    // initData (and the HMAC verification round trip that entails) on every
    // single app open for a user who authenticated recently.
    if (getToken()) {
      try {
        const me = await api.get<CurrentUser>('/auth/me');
        setUser(me);
        setStatus('authenticated');
        return;
      } catch {
        // Expired/invalid token — fall through to a fresh initData exchange
        // rather than getting the user stuck; clearToken() so a repeat
        // failure below doesn't keep retrying against a token already known bad.
        clearToken();
      }
    }

    if (!isInsideTelegram) {
      setOutsideTelegram(true);
      setStatus('unauthenticated');
      return;
    }

    const initData = getInitDataRaw();
    if (!initData) {
      // Real Telegram client, but the SDK hasn't received launch params yet
      // (e.g. opened via a path Telegram doesn't attach initData to) —
      // distinct from "not in Telegram at all," but equally unauthenticatable.
      setErrorMessage('Telegram did not provide sign-in data for this session.');
      setStatus('error');
      return;
    }

    try {
      const { token } = await api.post<{ token: string }>('/auth/telegram', { initData });
      setToken(token);
      const me = await api.get<CurrentUser>('/auth/me');
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      clearToken();
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'Could not sign in — check your connection and try again.',
      );
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void authenticate();
    // `attempt` is bumped by retry() to intentionally re-run this effect —
    // authenticate() itself is stable (useCallback with no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, errorMessage, outsideTelegram, retry, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
