import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, clearToken, getToken, setToken } from './api.js';
import type { CurrentUser } from './types.js';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, referralCode?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadCurrentUser(throwOnError = false) {
    setLoading(true);
    setError(null);
    if (!getToken()) {
      setLoading(false);
      return;
    }
    const token = getToken();
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      if (getToken() === token) setUser(me);
    } catch (err) {
      if (getToken() !== token) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearToken();
        setUser(null);
      } else {
        setError('Account service is temporarily unavailable. Please retry.');
      }
      if (throwOnError) throw err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCurrentUser();
  }, []);

  async function login(email: string, password: string) {
    const { token } = await api.post<{ token: string }>('/auth/login', { email, password });
    setToken(token);
    await loadCurrentUser(true);
  }

  async function register(email: string, password: string, referralCode?: string) {
    const { token } = await api.post<{ token: string }>('/auth/register', {
      email,
      password,
      ...(referralCode ? { referralCode } : {}),
    });
    setToken(token);
    await loadCurrentUser(true);
  }

  function logout() {
    clearToken();
    setUser(null);
    setError(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, error, retry: () => void loadCurrentUser(), login, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
