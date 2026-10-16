import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.js';
import { ApiError } from '../lib/api.js';

export function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = search.get('next');
  const destination = next && /^\/dashboard(?:\/|\?|$)/.test(next) ? next : '/dashboard';
  const [referralCode, setReferralCode] = useState(search.get('ref') ?? '');
  const [mode, setMode] = useState<'login' | 'register'>(search.has('ref') ? 'register' : 'login');
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
        await register(email, password, referralCode.trim() || undefined);
      }
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="card w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-bold text-white">GSP TRADING</div>
          <div className="mt-1 text-sm text-slate-500">
            {mode === 'login' ? 'Sign in to your account' : 'Create an account'}
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="email">
              Email
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
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={mode === 'register' ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              placeholder="••••••••••"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="label" htmlFor="referral">
                Referral code (optional)
              </label>
              <input
                id="referral"
                className="input-field"
                value={referralCode}
                minLength={4}
                maxLength={32}
                onChange={(e) => setReferralCode(e.target.value)}
              />
            </div>
          )}
          {error && <div className="text-sm text-loss">{error}</div>}

          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <Link to="/" className="mt-4 block text-center text-xs text-slate-400">
          Back to website
        </Link>
        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300"
        >
          {mode === 'login'
            ? "Don't have an account? Register"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
