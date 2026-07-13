import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { useAuth } from '../lib/AuthContext.js';
import { CopyButton } from '../components/CopyButton.js';
import { StatCard } from '../components/StatCard.js';
import { lamportsToSol, sol, usd, timeAgo } from '../lib/format.js';
import type { AuditLogEntry, LedgerEntry, Wallet } from '../lib/types.js';

/** Admin-only — records a withdrawal that was already executed manually,
 * out-of-band. Never signs or broadcasts a transaction: this is purely an
 * immutable ledger/audit record (see apps/api/src/routes/wallets.ts's
 * POST /wallets/:id/withdrawals doc comment). */
function RecordWithdrawalModal({
  wallet,
  onClose,
  onDone,
}: {
  wallet: Wallet;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amountSol, setAmountSol] = useState('');
  const [txSignature, setTxSignature] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const amountLamports = BigInt(Math.round(Number(amountSol) * 1e9)).toString();
      await api.post(`/wallets/${wallet.id}/withdrawals`, { amountLamports, txSignature, note });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="card w-full max-w-sm space-y-4">
        <h2 className="text-lg font-semibold text-white">Record withdrawal</h2>
        <p className="text-sm text-slate-400">
          Records that this withdrawal was already sent manually, out-of-band. This does not send
          any funds — it only creates an immutable ledger/audit entry.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label">Amount (SOL)</label>
            <input
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              required
              type="number"
              step="any"
              min="0"
              className="input-field"
              placeholder="0.5"
            />
          </div>
          <div>
            <label className="label">Transaction signature</label>
            <input
              value={txSignature}
              onChange={(e) => setTxSignature(e.target.value)}
              required
              className="input-field"
              placeholder="On-chain signature of the withdrawal"
            />
          </div>
          <div>
            <label className="label">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="input-field"
              placeholder="Reason / reference"
            />
          </div>
          {error && <div className="text-sm text-loss">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn-primary flex-1">
              Record withdrawal
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const sign = entry.direction === 'CREDIT' ? '+' : '-';
  const amount =
    entry.asset === 'SOL' ? sol(lamportsToSol(entry.amountLamports)) : usd(entry.amountUsd);
  return (
    <tr>
      <td className="whitespace-nowrap text-xs text-slate-500">
        {new Date(entry.createdAt).toLocaleString()}
      </td>
      <td>{entry.type}</td>
      <td className={entry.direction === 'CREDIT' ? 'text-profit' : 'text-loss'}>
        {sign}
        {amount}
      </td>
      <td className="text-xs text-slate-500">{entry.status}</td>
    </tr>
  );
}

export function WalletDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();
  const [showWithdrawalModal, setShowWithdrawalModal] = useState(false);

  const { data: wallet, error: walletError } = usePolling(
    () => api.get<Wallet>(`/wallets/${id}`),
    15000,
    refreshSignal,
  );
  const { data: transactions } = usePolling(
    () => api.get<LedgerEntry[]>(`/wallets/${id}/transactions?limit=50`),
    15000,
    refreshSignal,
  );
  const { data: history } = usePolling(
    () => api.get<AuditLogEntry[]>(`/wallets/${id}/audit-log?limit=50`),
    15000,
    refreshSignal,
  );

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    QRCode.toDataURL(wallet.publicKey, { width: 240, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on publicKey alone — regenerating the QR on every
    // balance-only poll refresh would be wasted work for an identical image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.publicKey]);

  async function onRefreshBalance() {
    if (!id) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await api.post(`/wallets/${id}/refresh-balance`);
      setRefreshSignal((n) => n + 1);
    } catch (err) {
      setRefreshError(err instanceof ApiError ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  if (walletError) {
    return (
      <div className="space-y-4">
        <Link to="/wallets" className="text-sm text-accent hover:underline">
          ← Back to Wallets
        </Link>
        <div className="text-sm text-loss">{walletError.message}</div>
      </div>
    );
  }

  if (!wallet) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  const balanceSol = lamportsToSol(wallet.lastKnownBalanceLamports);

  return (
    <div className="space-y-6">
      {showWithdrawalModal && (
        <RecordWithdrawalModal
          wallet={wallet}
          onClose={() => setShowWithdrawalModal(false)}
          onDone={() => {
            setShowWithdrawalModal(false);
            setRefreshSignal((n) => n + 1);
          }}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/wallets" className="text-xs text-accent hover:underline">
            ← Back to Wallets
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-white">{wallet.label}</h1>
          <div className="mt-1 flex items-center gap-2 font-mono text-xs text-slate-400">
            <span className="break-all">{wallet.publicKey}</span>
            <CopyButton text={wallet.publicKey} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-1 text-xs ${wallet.isActive ? 'bg-profit/20 text-profit' : 'bg-surface-hover text-slate-400'}`}
          >
            {wallet.isActive ? 'Active' : 'Disabled'}
          </span>
          <button
            onClick={onRefreshBalance}
            disabled={refreshing}
            className="btn-secondary text-xs"
          >
            {refreshing ? 'Refreshing…' : '🔄 Refresh Balance'}
          </button>
          {user?.role === 'ADMIN' && (
            <button onClick={() => setShowWithdrawalModal(true)} className="btn-secondary text-xs">
              Record Withdrawal
            </button>
          )}
        </div>
      </div>
      {refreshError && <div className="text-sm text-loss">{refreshError}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Current Balance" value={sol(balanceSol)} />
          <StatCard label="Last Updated" value={timeAgo(wallet.balanceUpdatedAt)} />
        </div>

        <div className="card space-y-3">
          <div className="label">Deposit — Solana Mainnet</div>
          <div className="flex items-center gap-4">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Deposit address QR code"
                className="h-32 w-32 rounded-lg bg-white p-1"
              />
            ) : (
              <div className="h-32 w-32 animate-pulse rounded-lg bg-surface-hover" />
            )}
            <div className="min-w-0 space-y-2">
              <div className="break-all font-mono text-xs text-slate-300">{wallet.publicKey}</div>
              <CopyButton text={wallet.publicKey} label="Copy Address" />
              <p className="text-xs text-slate-500">
                Send only SOL or SPL tokens on Solana to this address.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-white">Recent Transactions</h2>
          <table className="table-base">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(transactions ?? []).map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
              {transactions?.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    No transactions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-white">Wallet History</h2>
          <table className="table-base">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(history ?? []).map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td>{entry.action}</td>
                  <td className="text-xs text-slate-500">{entry.status}</td>
                </tr>
              ))}
              {history?.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-slate-500">
                    No history yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
