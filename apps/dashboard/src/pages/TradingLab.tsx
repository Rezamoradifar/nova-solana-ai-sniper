import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Snipe = {
  id: string;
  isActive: boolean;
  buyAmountSol: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  minAiScore: number;
  takeProfitPercent: number | null;
  stopLossPercent: number | null;
  trailingStopPercent: number | null;
  autoBuyOnLaunch: boolean;
  entryFilterEnabled?: boolean;
  institutionalModeEnabled?: boolean;
  useOpportunityScoreGate?: boolean;
  exitStrategy?: string | null;
};

type Winner = {
  id: string;
  mint: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  dex: string | null;
  walletAddress: string;
  walletConfidenceScore: number | null;
  entryAt: string;
  exitAt: string;
  entrySignature: string;
  exitSignature: string | null;
  entryAmountSol: number | null;
  exitAmountSol: number | null;
  realizedRoiPercent: number;
  realizedPnlSol: number | null;
  realizedPnlUsd: number;
};

type Arbitrage = {
  enabled: boolean;
  mode?: 'paper';
  note?: string;
  scans?: number;
  opportunities?: number;
  paperNetSol?: number;
  bestNetSol?: number;
  lastScanAt?: number;
  recent?: Array<{
    mint: string;
    buyDex: string;
    sellDex: string;
    inSol: number;
    grossSol: number;
    netSol: number;
    at: number;
  }>;
};

const PRESETS = [
  {
    key: 'defensive',
    name: 'Defensive',
    note: 'Tighter risk, stronger quality filter',
    patch: {
      minAiScore: 75,
      minLiquidityUsd: 10_000,
      takeProfitPercent: 35,
      stopLossPercent: 10,
      trailingStopPercent: 8,
      entryFilterEnabled: true,
    },
  },
  {
    key: 'balanced',
    name: 'Balanced',
    note: 'Middle-ground target and protection',
    patch: {
      minAiScore: 65,
      minLiquidityUsd: 5_000,
      takeProfitPercent: 50,
      stopLossPercent: 15,
      trailingStopPercent: 12,
    },
  },
  {
    key: 'momentum',
    name: 'Momentum',
    note: 'Wider target; hard stop-loss still capped at 20%',
    patch: {
      minAiScore: 70,
      minLiquidityUsd: 3_000,
      takeProfitPercent: 80,
      stopLossPercent: 20,
      trailingStopPercent: 15,
      useOpportunityScoreGate: true,
    },
  },
] as const;

function short(v: string) {
  return v.length > 16 ? v.slice(0, 8) + '…' + v.slice(-5) : v;
}

function signed(n: number, digits = 1, suffix = '') {
  return (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(n).toFixed(digits) + suffix;
}

function errText(e: unknown) {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed';
}

export function TradingLab() {
  const [refresh, setRefresh] = useState(0);
  const snipes = usePolling(() => api.get<Snipe[]>('/snipes'), 10_000, refresh);
  const winners = usePolling(
    () => api.get<Winner[]>('/market/network-winners?limit=12&days=7'),
    30_000,
  );
  const arbitrage = usePolling(() => api.get<Arbitrage>('/market/arbitrage'), 15_000);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = (snipes.data ?? []).find((s) => s.id === selectedId) ?? snipes.data?.[0];

  async function applyPreset(preset: (typeof PRESETS)[number]) {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.patch('/snipes/' + selected.id, preset.patch);
      setMessage(preset.name + ' settings applied to this Snipe Config.');
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const [positionSol, setPositionSol] = useState('0.5');
  const [takeProfit, setTakeProfit] = useState('50');
  const [stopLoss, setStopLoss] = useState('15');

  const calculator = useMemo(() => {
    const size = Math.max(0, Number(positionSol) || 0);
    const tp = Math.max(0, Number(takeProfit) || 0);
    const sl = Math.min(20, Math.max(0, Number(stopLoss) || 0));
    const target = size * (tp / 100);
    const risk = size * (sl / 100);
    return { size, tp, sl, target, risk, ratio: risk > 0 ? target / risk : 0 };
  }, [positionSol, takeProfit, stopLoss]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">
          Trading Intelligence
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-white">Trading Lab</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Strategy controls, verified external network winners and a paper arbitrage radar. Nothing
          here guarantees profit; the tools are for filtering, risk control and decision support.
        </p>
      </div>

      {message && (
        <div className="rounded-lg border border-profit/30 bg-profit/10 p-3 text-sm text-green-300">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <section className="card">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <h2 className="font-semibold text-white">Strategy presets</h2>
            <p className="mt-1 text-xs text-slate-500">
              Applies to one of your Snipe Configs. Existing open positions keep their frozen exit settings.
            </p>
          </div>
          <div className="min-w-64">
            <label className="label">Snipe Config</label>
            <select
              className="input-field"
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {(snipes.data ?? []).map((s, index) => (
                <option key={s.id} value={s.id}>
                  #{index + 1} · {s.buyAmountSol} SOL · AI {s.minAiScore} · {s.isActive ? 'Active' : 'Paused'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {selected ? (
          <>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  disabled={busy}
                  onClick={() => void applyPreset(preset)}
                  className="rounded-xl border border-surface-border bg-surface p-4 text-left transition hover:border-accent/50 hover:bg-surface-hover disabled:opacity-50"
                >
                  <div className="font-semibold text-white">{preset.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{preset.note}</div>
                  <div className="mt-3 text-xs text-violet-300">
                    AI ≥ {preset.patch.minAiScore} · Liquidity ≥ ${preset.patch.minLiquidityUsd.toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
              <Mini label="Buy" value={selected.buyAmountSol + ' SOL'} />
              <Mini label="AI" value={String(selected.minAiScore)} />
              <Mini label="Liquidity" value={'$' + selected.minLiquidityUsd.toLocaleString()} />
              <Mini label="TP" value={(selected.takeProfitPercent ?? 0) + '%'} />
              <Mini label="SL" value={(selected.stopLossPercent ?? 0) + '%'} />
              <Mini label="Trail" value={(selected.trailingStopPercent ?? 0) + '%'} />
            </div>
          </>
        ) : (
          <div className="mt-4 text-sm text-slate-500">
            Create a Snipe Config first, then strategy presets can be applied here.
          </div>
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold text-white">Risk / reward calculator</h2>
          <p className="mt-1 text-xs text-slate-500">
            Simple scenario math before fees, slippage and price impact. It is not a profit forecast.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <label className="label">Position SOL</label>
              <input className="input-field" type="number" min="0" step="0.01" value={positionSol} onChange={(e) => setPositionSol(e.target.value)} />
            </div>
            <div>
              <label className="label">TP %</label>
              <input className="input-field" type="number" min="0" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
            </div>
            <div>
              <label className="label">SL %</label>
              <input className="input-field" type="number" min="0" max="20" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Mini label="Target gain" value={calculator.target.toFixed(4) + ' SOL'} tone="text-profit" />
            <Mini label="Risk at SL" value={calculator.risk.toFixed(4) + ' SOL'} tone="text-loss" />
            <Mini label="Reward / risk" value={calculator.ratio.toFixed(2) + 'x'} />
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            The platform hard-loss ceiling is 20%; actual fills can differ because of liquidity, slippage and route conditions.
          </p>
        </div>

        <div className="card">
          <h2 className="font-semibold text-white">Arbitrage Radar</h2>
          <p className="mt-1 text-xs text-slate-500">
            This scanner is paper/theoretical. It compares quote routes but does not borrow or execute funds.
          </p>
          {!arbitrage.data ? (
            <div className="mt-4 text-sm text-slate-500">Loading…</div>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Mini label="Status" value={arbitrage.data.enabled ? 'ON' : 'OFF'} />
                <Mini label="Scans" value={String(arbitrage.data.scans ?? 0)} />
                <Mini label="Opportunities" value={String(arbitrage.data.opportunities ?? 0)} />
                <Mini label="Best net" value={arbitrage.data.bestNetSol == null ? '—' : arbitrage.data.bestNetSol.toFixed(5) + ' SOL'} tone="text-profit" />
              </div>
              <div className="mt-4 space-y-2">
                {(arbitrage.data.recent ?? []).slice(0, 5).map((row, index) => (
                  <div key={row.mint + row.at + index} className="rounded-lg border border-surface-border p-3 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-slate-300">{short(row.mint)}</span>
                      <span className={row.netSol >= 0 ? 'text-profit' : 'text-loss'}>{signed(row.netSol, 5, ' SOL')}</span>
                    </div>
                    <div className="mt-1 text-slate-500">{row.buyDex} → {row.sellDex} · input {row.inSol.toFixed(3)} SOL</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="flex flex-col justify-between gap-2 md:flex-row md:items-end">
          <div>
            <h2 className="font-semibold text-white">Verified Network Winners</h2>
            <p className="mt-1 text-xs text-slate-500">
              Completed profitable trades from external Solana wallets. These are not Nova/GSP bot performance.
            </p>
          </div>
          <span className="text-xs text-slate-500">Last 7 days · positive realized ROI + PnL only</span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(winners.data ?? []).map((w) => (
            <article key={w.id} className="rounded-xl border border-surface-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-white">{w.tokenSymbol ? '$' + w.tokenSymbol : w.tokenName ?? short(w.mint)}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{w.dex ?? 'Solana'} · external wallet</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-bold text-profit">{signed(w.realizedRoiPercent, 1, '%')}</div>
                  <div className="font-mono text-xs text-green-300">+${w.realizedPnlUsd.toFixed(2)}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <Mini label="Invested" value={w.entryAmountSol == null ? '—' : w.entryAmountSol.toFixed(4) + ' SOL'} />
                <Mini label="Returned" value={w.exitAmountSol == null ? '—' : w.exitAmountSol.toFixed(4) + ' SOL'} />
              </div>
              <div className="mt-3 text-xs text-slate-500">
                Wallet <a className="text-violet-300 hover:underline" target="_blank" rel="noreferrer" href={'https://solscan.io/account/' + w.walletAddress}>{short(w.walletAddress)}</a>
                {' · '}closed {new Date(w.exitAt).toLocaleString()}
              </div>
              <div className="mt-3 flex gap-3 text-xs">
                <a className="text-violet-300 hover:underline" target="_blank" rel="noreferrer" href={'https://solscan.io/tx/' + w.entrySignature}>Buy TX</a>
                {w.exitSignature && <a className="text-violet-300 hover:underline" target="_blank" rel="noreferrer" href={'https://solscan.io/tx/' + w.exitSignature}>Sell TX</a>}
                <a className="ml-auto text-slate-400 hover:text-white" target="_blank" rel="noreferrer" href={'https://dexscreener.com/solana/' + w.mint}>Chart</a>
              </div>
            </article>
          ))}
        </div>
        {winners.data?.length === 0 && <div className="mt-4 text-sm text-slate-500">No verified profitable external exits are available in the selected window yet.</div>}
      </section>
    </div>
  );
}

function Mini(props: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised/40 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{props.label}</div>
      <div className={'mt-1 font-mono text-sm font-semibold ' + (props.tone ?? 'text-slate-200')}>{props.value}</div>
    </div>
  );
}
