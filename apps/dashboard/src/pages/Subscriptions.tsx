import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { usePolling } from '../lib/usePolling.js';
import type { Wallet } from '../lib/types.js';

function paymentReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Plan {
  key: string;
  name: string;
  priceSol: number;
  durationDays: number;
  feeBps: number | null;
  maxBuySol: number | null;
  maxOpenPositions: number | null;
  autoBuyEnabled: boolean;
  features: string[];
}
interface Receipt {
  id: string;
  planKey: string;
  amountSol: number;
  txSignature: string;
  expiresAt: string;
  createdAt: string;
}
interface AccountPlans {
  currentPlanKey: string;
  expiresAt: string | null;
  plans: Plan[];
}

export function Subscriptions() {
  const { user } = useAuth();
  const [refresh, setRefresh] = useState(0);
  const account = usePolling(() => api.get<AccountPlans>('/plans/me'), 30_000, refresh);
  const wallets = usePolling(() => api.get<Wallet[]>('/wallets'), 30_000);
  const history = usePolling(() => api.get<Receipt[]>('/plans/history'), 30_000, refresh);
  const [review, setReview] = useState<Plan | null>(null);
  const [walletId, setWalletId] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeWallets = wallets.data?.filter((wallet) => wallet.isActive) ?? [];

  async function pay() {
    if (!review || !walletId || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const storageKey = `nova.plan-payment.${user?.id}.${review.key}.${walletId}.${review.priceSol}`;
    try {
      // Keep the same request identity across reloads and uncertain responses.
      const requestId = localStorage.getItem(storageKey) ?? paymentReference();
      localStorage.setItem(storageKey, requestId);
      const result = await api.post<{ txSignature: string; expiresAt: string }>(
        '/plans/purchase-reviewed',
        {
          requestId,
          planKey: review.key,
          walletId,
          expectedPriceSol: review.priceSol,
        },
      );
      localStorage.removeItem(storageKey);
      setMessage(
        `Subscription confirmed until ${new Date(result.expiresAt).toLocaleDateString()}. Receipt: ${result.txSignature}`,
      );
      setReview(null);
      setRefresh((value) => value + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && !err.paymentUncertain)
        localStorage.removeItem(storageKey);
      setError(
        err instanceof Error
          ? err.message
          : 'Payment status is uncertain. Check your history before trying again.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Subscription</h1>
        <p className="mt-2 text-sm text-slate-400">
          Review your access, choose a package and see your payment history.
        </p>
      </div>
      {account.error && (
        <p className="card text-loss" role="alert">
          {account.error.message}
        </p>
      )}
      {account.loading && <p className="card text-slate-400">Loading plans…</p>}
      {account.data && (
        <div className="card">
          <div className="label">Current plan</div>
          <p className="text-xl text-white">{account.data.currentPlanKey}</p>
          <p className="mt-1 text-sm text-slate-400">
            {account.data.expiresAt
              ? `Expires ${new Date(account.data.expiresAt).toLocaleString()}`
              : 'No paid subscription expiry'}
          </p>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {account.data?.plans.map((plan) => (
          <section className="card flex flex-col" key={plan.key}>
            <h2 className="text-lg font-semibold text-white">{plan.name}</h2>
            <p className="mt-3 text-2xl text-white">
              {plan.priceSol} SOL{' '}
              <span className="text-sm text-slate-400">/ {plan.durationDays} days</span>
            </p>
            <p className="mt-3 text-sm text-slate-400">
              Performance fee: {plan.feeBps === null ? 'platform default' : `${plan.feeBps / 100}%`}
            </p>
            <p className="text-sm text-slate-400">
              Buy limit:{' '}
              {plan.maxBuySol === null ? 'platform limits apply' : `${plan.maxBuySol} SOL`}
            </p>
            <p className="text-sm text-slate-400">
              Open positions: {plan.maxOpenPositions ?? 'platform limits apply'}
            </p>
            <ul className="my-4 flex-1 space-y-2 text-sm text-slate-300">
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            {plan.priceSol > 0 ? (
              <button
                className="btn-primary"
                disabled={busy || Boolean(account.error)}
                onClick={() => {
                  setReview({ ...plan });
                  setError(null);
                  setMessage(null);
                }}
              >
                Review purchase
              </button>
            ) : (
              <span className="text-sm text-slate-400">No payment required</span>
            )}
          </section>
        ))}
      </div>
      {account.data?.plans.length === 0 && (
        <p className="card text-slate-400">No packages are currently available.</p>
      )}
      {review && (
        <section
          className="card space-y-4 border border-accent"
          aria-label="Review subscription payment"
        >
          <h2 className="text-lg font-semibold text-white">Confirm {review.name}</h2>
          <p className="text-sm text-slate-300">
            Pay <strong>{review.priceSol} SOL</strong> from your selected GSP wallet for{' '}
            {review.durationDays} days. This is a real on-chain payment, including when trading is
            in PAPER mode. Network fees are additional.
          </p>
          <label htmlFor="payment-wallet" className="label">
            Pay from wallet
          </label>
          <select
            id="payment-wallet"
            className="input-field"
            value={walletId}
            disabled={busy}
            onChange={(event) => setWalletId(event.target.value)}
          >
            <option value="">Select your wallet</option>
            {activeWallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.label} · {wallet.publicKey}
              </option>
            ))}
          </select>
          {wallets.error && (
            <p role="alert" className="text-sm text-loss">
              Wallets could not be loaded.
            </p>
          )}
          {!wallets.loading && !wallets.error && activeWallets.length === 0 && (
            <Link className="text-sm text-violet-300" to="/dashboard/wallets">
              Create or import a GSP wallet
            </Link>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className="btn-primary"
              disabled={busy || !activeWallets.some((wallet) => wallet.id === walletId)}
              onClick={() => void pay()}
            >
              {busy ? 'Waiting for confirmation…' : `Pay ${review.priceSol} SOL`}
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => setReview(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {message && (
        <p className="card break-all text-profit" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="card text-loss" role="alert">
          {error}
        </p>
      )}
      <section className="card">
        <h2 className="font-semibold text-white">Payment history</h2>
        {history.error ? (
          <p className="mt-3 text-sm text-loss">{history.error.message}</p>
        ) : history.loading ? (
          <p className="mt-3 text-sm text-slate-400">Loading receipts…</p>
        ) : history.data?.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No confirmed subscription payments.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {history.data?.map((receipt) => (
              <div
                key={receipt.id}
                className="flex flex-wrap justify-between gap-2 border-b border-surface-border pb-3 text-sm"
              >
                <span>
                  {receipt.planKey} · {receipt.amountSol} SOL ·{' '}
                  {new Date(receipt.createdAt).toLocaleDateString()}
                </span>
                <a
                  className="text-violet-300"
                  href={`https://solscan.io/tx/${encodeURIComponent(receipt.txSignature)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction ↗
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
