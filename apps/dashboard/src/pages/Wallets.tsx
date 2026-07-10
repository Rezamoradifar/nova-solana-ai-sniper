import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import type { Wallet } from '../lib/types.js';

export function Wallets() {
  const { data: wallets, error: pollError } = usePolling(
    () => api.get<Wallet[]>('/wallets'),
    10000,
  );
  const [label, setLabel] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (mode === 'create') {
        await api.post('/wallets', { label });
        setNotice('Wallet created. Its private key is encrypted at rest and never shown here.');
      } else {
        await api.post('/wallets/import', { label, secretKeyBase58: secretKey });
        setNotice('Wallet imported and encrypted at rest.');
      }
      setLabel('');
      setSecretKey('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(id: string) {
    await api.del(`/wallets/${id}`);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Wallets</h1>

      <div className="card max-w-lg">
        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setMode('create')}
            className={mode === 'create' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          >
            Generate new
          </button>
          <button
            onClick={() => setMode('import')}
            className={mode === 'import' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          >
            Import existing
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label">Label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              className="input-field"
              placeholder="Main trading wallet"
            />
          </div>
          {mode === 'import' && (
            <div>
              <label className="label">Private key (base58)</label>
              <input
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                required
                type="password"
                className="input-field"
                placeholder="Never shared or logged — encrypted at rest immediately"
              />
            </div>
          )}
          {error && <div className="text-sm text-loss">{error}</div>}
          {notice && <div className="text-sm text-profit">{notice}</div>}
          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {mode === 'create' ? 'Generate wallet' : 'Import wallet'}
          </button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Label</th>
              <th>Public Key</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(wallets ?? []).map((wallet) => (
              <tr key={wallet.id}>
                <td>{wallet.label}</td>
                <td className="font-mono text-xs">{wallet.publicKey}</td>
                <td>{wallet.isActive ? 'Active' : 'Disabled'}</td>
                <td>{new Date(wallet.createdAt).toLocaleDateString()}</td>
                <td>
                  <button
                    onClick={() => onRemove(wallet.id)}
                    className="text-xs text-loss hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {wallets?.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-500">
                  No wallets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pollError && <div className="mt-2 text-xs text-loss">{pollError.message}</div>}
      </div>
    </div>
  );
}
