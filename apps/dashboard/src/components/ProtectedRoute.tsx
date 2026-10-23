import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';
import { useLanguage } from '../lib/LanguageContext.js';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { t: localize } = useLanguage();
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        {localize('Loading…')}
      </div>
    );
  }
  if (!user) {
    return (
      <Navigate
        to="/login"
        state={{ returnTo: location.pathname + location.search + location.hash }}
        replace
      />
    );
  }
  return <>{children}</>;
}
