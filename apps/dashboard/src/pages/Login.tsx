import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';
import { ApiError } from '../lib/api.js';
import { LanguageSwitch, useLanguage } from '../lib/LanguageContext.js';
import { WalletButton } from '../components/WalletUI.js';
import { SiteBrand } from '../components/SiteBrand.js';
import { safeReturnPath } from '../lib/returnPath.js';

export function Login() {
  const { t: localize } = useLanguage();
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
      const from: unknown = location.state?.returnTo;
      navigate(safeReturnPath(from), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="card w-full max-w-sm">
        <div className="nova-account-actions">
          <LanguageSwitch />
          <WalletButton />
        </div>
        <div className="mb-6 text-center">
          <Link to="/">
            <SiteBrand />
          </Link>
          <div className="mt-1 text-sm text-slate-500">
            {mode === 'login' ? localize('Sign in to your account') : localize('Create an account')}
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="email">
              {localize('Email')}
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              {localize('Password')}
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              placeholder="••••••••••"
            />
          </div>

          {error && <div className="text-sm text-loss">{localize(error)}</div>}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting
              ? localize('Please wait…')
              : mode === 'login'
                ? localize('Sign in')
                : localize('Create account')}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300"
        >
          {mode === 'login'
            ? localize("Don't have an account? Register")
            : localize('Already have an account? Sign in')}
        </button>
      </div>
    </div>
  );
}
