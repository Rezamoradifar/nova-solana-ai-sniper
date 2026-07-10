import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearToken, getToken, setToken } from './api.js';
import type { CurrentUser } from './types.js';

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadCurrentUser() {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      setUser(me);
    } catch {
      clearToken();
      setUser(null);
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
    await loadCurrentUser();
  }

  async function register(email: string, password: string) {
    const { token } = await api.post<{ token: string }>('/auth/register', { email, password });
    setToken(token);
    await loadCurrentUser();
  }

  function logout() {
    clearToken();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
