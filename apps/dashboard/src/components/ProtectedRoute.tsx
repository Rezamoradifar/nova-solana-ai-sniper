import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading, error, retry } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>
    );
  }
  if (!user && error)
    return (
      <div className="card m-6" role="alert">
        <p>{error}</p>
        <button className="btn-primary mt-3" onClick={retry}>
          Retry connection
        </button>
      </div>
    );
  if (!user) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }
  return <>{children}</>;
}
