import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { PUBLIC_API_BASE } from '../lib/publicMarket.js';

interface LocalWallet {
  address: string;
  label: string | null;
  signalScore: number;
  recommendation: {
    eligible: boolean;
    reasons: string[];
    warnings: string[];
    score: number;
    closedTrades: number;
    distinctTokens: number;
    realizedPnlSol: number;
    profitFactor: number | null;
    winRatePct: number;
  };
  confidenceScore: number | null;
  sampleSize: number;
  medianRoiPercent: number | null;
  avgRoiPercent: number | null;
  earlyEntryRatePct: number | null;
  rugExposureRatePct: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  lastActivityAt: string | null;
  sybilConfidencePct: number | null;
}

interface GmgnWallet {
  address: string;
  trades: number;
  volumeUsd: number;
  buys: number;
  sells: number;
  tags: string[];
}

interface GmgnTrade {
  transactionHash: string;
  maker: string;
  side: 'buy' | 'sell' | 'unknown';
  tokenAddress: string;
  tokenSymbol: string;
  amountUsd?: number;
  priceUsd?: number;
  timestamp?: number;
  tags: string[];
}

interface PublicCopyData {
  chain: 'solana';
  mode: 'buy_mirror_independent_exits';
  recommendations: LocalWallet[];
  limits: {
    maxBuySol: number;
    maxDailyBuys: number;
    maxOpenPositions: number;
    slippageBps: number;
  };
  watcher: { running: boolean; healthy: boolean; lastSuccessAt: number | null } | null;
  copyConfigEnabled: boolean;
  copyWatcherReady: boolean;
  executionMode: 'disabled' | 'paper' | 'live';
  liveExecutionEnabled: boolean;
  updatedAt: number;
  localWallets: LocalWallet[];
  gmgn:
    | { status: 'not_configured'; trades: GmgnTrade[]; wallets: GmgnWallet[] }
    | { status: 'connected'; trades: GmgnTrade[]; wallets: GmgnWallet[] }
    | { status: 'unavailable'; trades: GmgnTrade[]; wallets: GmgnWallet[]; reason: string };
}

interface CopyConfig {
  id: string;
  targetAddress: string;
  isActive: boolean;
  copyPercentSize: number;
  maxAmountSol: number | null;
}

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const num = (value: number | null | undefined, suffix = '') =>
  value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}${suffix}`;
const usd = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
      }).format(value);

export default function PublicCopyTrading() {
  const { user } = useAuth();
  const [data, setData] = useState<PublicCopyData | null>(null);
  const [configs, setConfigs] = useState<CopyConfig[]>([]);
  const [copyPercent, setCopyPercent] = useState('25');
  const [maxSol, setMaxSol] = useState('0.10');
  const [manualAddress, setManualAddress] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busyAddress, setBusyAddress] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${PUBLIC_API_BASE}/public/copy-trading`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error('Copy-trading feed unavailable.');
        setData((await response.json()) as PublicCopyData);
      } catch (error) {
        if (!controller.signal.aborted) {
          setData(null);
          setMessage(error instanceof Error ? error.message : 'Copy-trading feed unavailable.');
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setConfigs([]);
      return;
    }
    void api
      .get<CopyConfig[]>('/copy-trades')
      .then(setConfigs)
      .catch(() => setConfigs([]));
  }, [user]);

  const configured = useMemo(() => new Set(configs.map((item) => item.targetAddress)), [configs]);

  async function addCopy(address: string) {
    if (!user || busyAddress) return;
    const percent = Number(copyPercent);
    const amount = Number(maxSol);
    if (
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent > 100 ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setMessage('Copy size must be 0–100% and max SOL must be greater than zero.');
      return;
    }
    setBusyAddress(address);
    setMessage(null);
    try {
      const created = await api.post<CopyConfig>('/copy-trades', {
        targetAddress: address,
        copyPercentSize: percent,
        maxAmountSol: amount,
      });
      setConfigs((current) => [...current.filter((item) => item.id !== created.id), created]);
      setMessage(
        `Copy enabled for ${short(address)} · cap ${created.maxAmountSol} SOL. ${data?.executionMode === 'live' ? 'New verified buys may spend real SOL.' : data?.executionMode === 'paper' ? 'Paper mode only.' : 'Waiting for the server watcher.'}`,
      );
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : 'Could not create copy configuration.',
      );
    } finally {
      setBusyAddress(null);
    }
  }

  async function toggleCopy(config: CopyConfig) {
    if (busyAddress) return;
    setBusyAddress(config.targetAddress);
    try {
      const updated = await api.put<CopyConfig>(`/copy-trades/${config.id}/status`, {
        enabled: !config.isActive,
      });
      setConfigs((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setMessage(
        updated.isActive
          ? 'Copy buys resumed.'
          : 'New copy buys paused. Existing positions retain their exits.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update copy configuration.');
    } finally {
      setBusyAddress(null);
    }
  }

  return (
    <div className="site-container interior-page copy-trading-page">
      <PageHeading
        eyebrow="SOLANA COPY TRADING"
        title="Track conviction. Copy with limits."
        text="Rank tracked Solana wallets using GSP on-chain history, inspect GMGN Smart Money activity when the official API is connected, and create bounded copy configurations."
      >
        <span className="observation-badge">
          <Icon name="activity" size={17} />{' '}
          {data?.executionMode === 'live'
            ? 'LIVE COPY BUYS'
            : data?.executionMode === 'paper'
              ? 'PAPER COPY BUYS'
              : 'WATCHER NOT READY'}
        </span>
      </PageHeading>

      <div className="copy-hero-visual panel">
        <img
          src="/images/gsp-copy-network.svg"
          alt="Solana smart-wallet copy-trading network visualization"
        />
        <div className="copy-hero-overlay">
          <span className="eyebrow">GSP TRADING · SMART WALLET NETWORK</span>
          <h2>Follow the wallet, not the noise.</h2>
          <p>On-chain scoring + optional GMGN Smart Money feed + per-wallet position limits.</p>
        </div>
      </div>

      <section className="copy-control-strip">
        <label>
          <span>Copy size</span>
          <div className="input-unit">
            <input
              value={copyPercent}
              onChange={(e) => setCopyPercent(e.target.value)}
              type="number"
              min="1"
              max="100"
            />
            <span>%</span>
          </div>
        </label>
        <label>
          <span>Max per copied buy</span>
          <div className="input-unit">
            <input
              value={maxSol}
              onChange={(e) => setMaxSol(e.target.value)}
              type="number"
              min="0.01"
              step="0.01"
            />
            <span>SOL</span>
          </div>
        </label>
        <div className="copy-mode">
          <span>Execution</span>
          <strong>
            {data?.executionMode === 'live'
              ? 'LIVE'
              : data?.executionMode === 'paper'
                ? 'PAPER MIRROR'
                : 'EXECUTION LOCKED'}
          </strong>
          <small>
            {data?.copyWatcherReady
              ? 'Copies SOL-funded buys. Stop-loss and trailing exits act independently; target sells are not mirrored.'
              : data?.watcher?.running
                ? 'Watcher health is degraded. Buys can still execute for healthy targets.'
                : 'Watcher is stopped. Copy configurations are stored.'}
          </small>
        </div>
        <div className="copy-mode">
          <span>GMGN provider</span>
          <strong>{data?.gmgn.status === 'connected' ? 'CONNECTED' : 'OPTIONAL'}</strong>
          <small>
            {data?.gmgn.status === 'connected'
              ? 'Official OpenAPI'
              : 'Add GMGN_API_KEY on the server'}
          </small>
        </div>
      </section>

      {message && (
        <div className="inline-notice">
          <Icon name="shield" size={18} />
          <span>{message}</span>
        </div>
      )}

      <section className="panel copy-wallet-panel">
        <div className="table-toolbar">
          <div>
            <h2>Recommended from verified history</h2>
            <p>
              30-day recorded sample · 20+ closed trades · 5+ tokens · positive realized SOL · risk
              and freshness checks.
            </p>
          </div>
          <span className="outline-tag">UP TO 3 CANDIDATES</span>
        </div>
        {(data?.recommendations ?? []).map((wallet) => (
          <div className="table-toolbar" key={wallet.address}>
            <div>
              <strong>{wallet.label || short(wallet.address)}</strong>
              <p>
                {wallet.recommendation.closedTrades} verified closes ·{' '}
                {num(wallet.recommendation.realizedPnlSol, ' SOL')} realized ·{' '}
                {num(wallet.recommendation.winRatePct, '%')} wins
              </p>
              <p>{wallet.recommendation.warnings.join(' · ')}</p>
              <a
                className="text-link"
                href={`https://solscan.io/account/${wallet.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Inspect wallet ↗
              </a>
            </div>
            {configured.has(wallet.address) ? (
              <span className="copy-active-pill">Configured below</span>
            ) : user ? (
              <button
                className="nova-button button-sm"
                disabled={busyAddress !== null}
                onClick={() => void addCopy(wallet.address)}
              >
                Enable copy buys
              </button>
            ) : (
              <Link className="nova-button button-sm" to="/login">
                Sign in to copy
              </Link>
            )}
          </div>
        ))}
        {!data?.recommendations?.length && (
          <div className="empty-state">
            <h3>No qualified wallet yet</h3>
            <p>
              We wait for enough verified history. Recent volume or a Smart Money tag alone does not
              qualify a wallet.
            </p>
          </div>
        )}
        {data?.limits && (
          <p className="inline-notice">
            Server ceilings: {data.limits.maxBuySol} SOL per buy · {data.limits.maxDailyBuys}{' '}
            attempts per Tehran day · {data.limits.maxOpenPositions} open positions ·{' '}
            {data.limits.slippageBps / 100}% slippage. Your account and plan can impose tighter
            limits.
          </p>
        )}
      </section>

      {user && (
        <section className="panel copy-wallet-panel">
          <div className="table-toolbar">
            <div>
              <h2>Your copy wallets</h2>
              <p>
                Enabling a wallet allows new buys whenever server mode is LIVE. Failed submission
                attempts also count toward the daily limit.
              </p>
            </div>
          </div>
          <form
            className="copy-control-strip"
            onSubmit={(event) => {
              event.preventDefault();
              void addCopy(manualAddress.trim());
            }}
          >
            <label>
              <span>Reviewed Solana wallet address</span>
              <input
                className="input-field"
                required
                value={manualAddress}
                onChange={(event) => setManualAddress(event.target.value)}
                placeholder="Wallet address"
              />
            </label>
            <button className="nova-button button-sm" disabled={busyAddress !== null} type="submit">
              Enable copy buys
            </button>
          </form>
          {configs.map((config) => (
            <div className="table-toolbar" key={config.id}>
              <div>
                <strong>{short(config.targetAddress)}</strong>
                <p>
                  {config.copyPercentSize}% of source · cap{' '}
                  {config.maxAmountSol ?? data?.limits?.maxBuySol ?? 'server limit'} SOL ·{' '}
                  {config.isActive ? 'Enabled' : 'Paused'}
                </p>
              </div>
              <button
                className="nova-button button-sm button-outline"
                disabled={busyAddress !== null}
                onClick={() => void toggleCopy(config)}
              >
                {config.isActive ? 'Pause' : 'Resume'}
              </button>
            </div>
          ))}
          {!configs.length && (
            <p className="empty-state">No copy wallets configured for this account.</p>
          )}
        </section>
      )}

      <section className="panel copy-wallet-panel">
        <div className="table-toolbar">
          <div>
            <h2>GSP ranked Solana wallets</h2>
            <p>
              Candidate score uses verified closed trades. Expand your review using the reasons
              below each wallet.
            </p>
          </div>
          <span className="outline-tag">ON-CHAIN GSP DATA</span>
        </div>
        <div className="table-scroll">
          <table className="nova-table copy-wallet-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th>Signal</th>
                <th>Sample</th>
                <th>Median ROI</th>
                <th>Early entries</th>
                <th>Rug exposure</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.localWallets ?? []).map((wallet, index) => (
                <tr key={wallet.address}>
                  <td>{index + 1}</td>
                  <td>
                    <strong>{wallet.label || short(wallet.address)}</strong>
                    <small className="cell-subtext">{short(wallet.address)}</small>
                    <small className="cell-subtext">
                      {wallet.recommendation.eligible
                        ? ['Qualifies for review', ...wallet.recommendation.warnings].join(' · ')
                        : wallet.recommendation.reasons.join(' · ')}
                    </small>
                  </td>
                  <td className="number positive">{wallet.signalScore}/100</td>
                  <td className="number">{wallet.recommendation.closedTrades} verified closes</td>
                  <td
                    className={
                      wallet.medianRoiPercent != null && wallet.medianRoiPercent >= 0
                        ? 'positive number'
                        : 'number'
                    }
                  >
                    {num(wallet.medianRoiPercent, '%')}
                  </td>
                  <td className="number">{num(wallet.earlyEntryRatePct, '%')}</td>
                  <td className="number">{num(wallet.rugExposureRatePct, '%')}</td>
                  <td>
                    {configured.has(wallet.address) ? (
                      <span className="copy-active-pill">Configured</span>
                    ) : user ? (
                      <button
                        className="nova-button button-sm"
                        disabled={busyAddress !== null}
                        onClick={() => void addCopy(wallet.address)}
                      >
                        {busyAddress === wallet.address ? 'Adding…' : 'Enable copy buys'}
                      </button>
                    ) : (
                      <Link className="nova-button button-sm button-outline" to="/login">
                        Sign in to copy
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.localWallets.length && (
            <div className="empty-state">
              <Icon name="wallet" size={30} />
              <h3>Building wallet history</h3>
              <p>
                Enable Smart Money analysis and the network trade scanner to populate scored wallets
                from on-chain activity.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="panel gmgn-wallet-panel">
        <div className="table-toolbar">
          <div>
            <h2>GMGN Smart Money wallets</h2>
            <p>
              Wallets observed in the official GMGN Solana Smart Money feed, ranked by recent
              observed volume.
            </p>
          </div>
          <span className="outline-tag">
            {data?.gmgn.status === 'connected' ? 'OFFICIAL OPENAPI' : 'GMGN API KEY REQUIRED'}
          </span>
        </div>
        {data?.gmgn.status === 'connected' && data.gmgn.wallets.length ? (
          <div className="table-scroll">
            <table className="nova-table copy-wallet-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Wallet</th>
                  <th>Observed trades</th>
                  <th>Buys / sells</th>
                  <th>Observed volume</th>
                  <th>Tags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.gmgn.wallets.map((wallet, index) => (
                  <tr key={wallet.address}>
                    <td>{index + 1}</td>
                    <td className="number">{short(wallet.address)}</td>
                    <td className="number">{wallet.trades}</td>
                    <td className="number">
                      <span className="positive">{wallet.buys}</span> /{' '}
                      <span className="negative">{wallet.sells}</span>
                    </td>
                    <td className="number">{usd(wallet.volumeUsd)}</td>
                    <td>{wallet.tags.slice(0, 2).join(' · ') || '—'}</td>
                    <td>
                      {configured.has(wallet.address) ? (
                        <span className="copy-active-pill">Configured</span>
                      ) : user ? (
                        <button
                          className="nova-button button-sm"
                          disabled={busyAddress !== null}
                          onClick={() => void addCopy(wallet.address)}
                        >
                          {busyAddress === wallet.address ? 'Adding…' : 'Enable copy buys'}
                        </button>
                      ) : (
                        <Link className="nova-button button-sm button-outline" to="/login">
                          Sign in to copy
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="activity" size={30} />
            <h3>
              {data?.gmgn.status === 'not_configured'
                ? 'Connect the official GMGN OpenAPI'
                : 'No GMGN Smart Money wallets available'}
            </h3>
            <p>
              Add an approved GMGN_API_KEY directly to the server environment. GSP TRADING does not
              scrape private GMGN endpoints.
            </p>
          </div>
        )}
      </section>

      <section className="panel gmgn-feed-panel">
        <div className="table-toolbar">
          <div>
            <h2>GMGN Smart Money activity</h2>
            <p>Official GMGN OpenAPI data when your server API key is configured.</p>
          </div>
          <span className="outline-tag">
            {data?.gmgn.status === 'connected' ? 'GMGN CONNECTED' : 'GMGN API KEY REQUIRED'}
          </span>
        </div>
        {data?.gmgn.status === 'connected' && data.gmgn.trades.length ? (
          <div className="table-scroll">
            <table className="nova-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Side</th>
                  <th>Token</th>
                  <th>Trade value</th>
                  <th>Price</th>
                  <th>Tags</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {data.gmgn.trades.slice(0, 30).map((trade, index) => (
                  <tr key={trade.transactionHash || `${trade.maker}-${trade.timestamp}-${index}`}>
                    <td className="number">{short(trade.maker)}</td>
                    <td>
                      <span
                        className={
                          trade.side === 'buy'
                            ? 'positive'
                            : trade.side === 'sell'
                              ? 'negative'
                              : 'muted'
                        }
                      >
                        {trade.side.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <strong>{trade.tokenSymbol}</strong>
                      <small className="cell-subtext">{short(trade.tokenAddress)}</small>
                    </td>
                    <td className="number">{usd(trade.amountUsd)}</td>
                    <td className="number">{trade.priceUsd == null ? '—' : usd(trade.priceUsd)}</td>
                    <td>{trade.tags.slice(0, 2).join(' · ') || '—'}</td>
                    <td className="muted">
                      {trade.timestamp
                        ? new Date(trade.timestamp * 1000).toLocaleTimeString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="activity" size={30} />
            <h3>
              {data?.gmgn.status === 'not_configured'
                ? 'GMGN integration is ready for a key'
                : 'GMGN feed unavailable'}
            </h3>
            <p>
              GSP does not scrape private GMGN endpoints. Configure an approved GMGN OpenAPI key on
              the server to enable this feed.
            </p>
          </div>
        )}
      </section>

      <div className="flash-safety-banner">
        <Icon name="shield" size={24} />
        <div>
          <strong>Copy trading can copy losses as quickly as gains.</strong>
          <p>
            Wallet scores and Smart Money tags describe observed history, not future performance.
            Use a dedicated wallet, small per-trade caps, stop-loss rules, and verify the token
            before enabling real execution.
          </p>
        </div>
        <Link className="text-link" to="/security">
          Risk controls ↗
        </Link>
      </div>
    </div>
  );
}
