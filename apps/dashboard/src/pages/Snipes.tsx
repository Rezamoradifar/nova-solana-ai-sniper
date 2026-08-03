import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import type { SnipeConfig } from '../lib/types.js';

const DEFAULTS = {
  buyAmountSol: '0.1',
  maxSlippageBps: '300',
  minLiquidityUsd: '1000',
  minAiScore: '60',
  takeProfitPercent: '50',
  stopLossPercent: '20',
  trailingStopPercent: '15',
};

export function Snipes() {
  const { data: configs } = usePolling(() => api.get<SnipeConfig[]>('/snipes'), 8000);
  const [form, setForm] = useState(DEFAULTS);
  const [autoBuyOnLaunch, setAutoBuyOnLaunch] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // Stop-loss is the one field with a real safety ceiling enforced server-side
  // (PositionManager clamps to DEFAULT_MAX_LOSS_PERCENT regardless of what's
  // stored here) — editable in place since a config was previously create-only.
  const [editingStopLossId, setEditingStopLossId] = useState<string | null>(null);
  const [stopLossEditValue, setStopLossEditValue] = useState('');
  const [stopLossError, setStopLossError] = useState<string | undefined>();

  function update(field: keyof typeof DEFAULTS, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await api.post('/snipes', {
        buyAmountSol: Number(form.buyAmountSol),
        maxSlippageBps: Number(form.maxSlippageBps),
        minLiquidityUsd: Number(form.minLiquidityUsd),
        minAiScore: Number(form.minAiScore),
        takeProfitPercent: Number(form.takeProfitPercent),
        stopLossPercent: Number(form.stopLossPercent),
        trailingStopPercent: Number(form.trailingStopPercent),
        autoBuyOnLaunch,
      });
      setForm(DEFAULTS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(id: string) {
    await api.del(`/snipes/${id}`);
  }

  function startEditStopLoss(config: SnipeConfig) {
    setEditingStopLossId(config.id);
    setStopLossEditValue(String(config.stopLossPercent ?? ''));
    setStopLossError(undefined);
  }

  async function onSaveStopLoss(id: string) {
    setStopLossError(undefined);
    try {
      await api.patch(`/snipes/${id}`, { stopLossPercent: Number(stopLossEditValue) });
      setEditingStopLossId(null);
    } catch (err) {
      setStopLossError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Snipe Settings</h1>

      <form onSubmit={onSubmit} className="card grid max-w-2xl grid-cols-2 gap-4">
        <div>
          <label className="label">Buy amount (SOL)</label>
          <input
            className="input-field"
            type="number"
            step="0.01"
            value={form.buyAmountSol}
            onChange={(e) => update('buyAmountSol', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Max slippage (bps)</label>
          <input
            className="input-field"
            type="number"
            value={form.maxSlippageBps}
            onChange={(e) => update('maxSlippageBps', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Min liquidity (USD)</label>
          <input
            className="input-field"
            type="number"
            value={form.minLiquidityUsd}
            onChange={(e) => update('minLiquidityUsd', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Min AI score</label>
          <input
            className="input-field"
            type="number"
            value={form.minAiScore}
            onChange={(e) => update('minAiScore', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Take profit %</label>
          <input
            className="input-field"
            type="number"
            value={form.takeProfitPercent}
            onChange={(e) => update('takeProfitPercent', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Stop loss %</label>
          <input
            className="input-field"
            type="number"
            value={form.stopLossPercent}
            onChange={(e) => update('stopLossPercent', e.target.value)}
          />
        </div>
        <div>
          <label className="label">Trailing stop %</label>
          <input
            className="input-field"
            type="number"
            value={form.trailingStopPercent}
            onChange={(e) => update('trailingStopPercent', e.target.value)}
          />
        </div>
        <div className="flex items-end gap-2">
          <input
            id="autoBuy"
            type="checkbox"
            checked={autoBuyOnLaunch}
            onChange={(e) => setAutoBuyOnLaunch(e.target.checked)}
          />
          <label htmlFor="autoBuy" className="text-sm text-slate-300">
            Auto-buy on launch
          </label>
        </div>

        {error && <div className="col-span-2 text-sm text-loss">{error}</div>}

        <div className="col-span-2">
          <button type="submit" disabled={submitting} className="btn-primary">
            Create snipe config
          </button>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Buy (SOL)</th>
              <th>Min Liquidity</th>
              <th>Min AI Score</th>
              <th>TP / SL / Trail</th>
              <th>Auto-buy</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(configs ?? []).map((config) => (
              <tr key={config.id}>
                <td>{config.buyAmountSol}</td>
                <td>${config.minLiquidityUsd.toLocaleString()}</td>
                <td>{config.minAiScore}</td>
                <td className="text-xs text-slate-400">
                  {config.takeProfitPercent ?? '—'}% /{' '}
                  {editingStopLossId === config.id ? (
                    <span className="inline-flex items-center gap-1">
                      <input
                        className="input-field w-16 px-1 py-0"
                        type="number"
                        value={stopLossEditValue}
                        onChange={(e) => setStopLossEditValue(e.target.value)}
                      />
                      <button
                        onClick={() => onSaveStopLoss(config.id)}
                        className="text-primary hover:underline"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingStopLossId(null)}
                        className="hover:underline"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => startEditStopLoss(config)}
                      className="hover:underline"
                      title="Never honored looser than the platform's default max-loss ceiling, regardless of what's set here"
                    >
                      {config.stopLossPercent ?? '—'}%
                    </button>
                  )}{' '}
                  / {config.trailingStopPercent ?? '—'}%
                  {stopLossError && editingStopLossId === null && (
                    <div className="text-loss">{stopLossError}</div>
                  )}
                </td>
                <td>{config.autoBuyOnLaunch ? 'Yes' : 'No'}</td>
                <td>{config.isActive ? 'Active' : 'Paused'}</td>
                <td>
                  <button
                    onClick={() => onDelete(config.id)}
                    className="text-xs text-loss hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {configs?.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  No snipe configs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
