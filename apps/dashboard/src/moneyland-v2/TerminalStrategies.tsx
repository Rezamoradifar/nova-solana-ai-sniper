import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Glyph, Modal, Panel, Pill, Skeleton, useML, useMLToast } from './core.js';
import { EmptyState, FormField, LinkedTool, ModeTag, Notice, Stat, ToolHeading } from './WorkspaceCommon.js';
import { ARB_TOKENS, scanLiveRoutes, isRouteFresh, type LiveRoute, type ScanProgress } from '../lib/liveArbitrage.js';
import { PUBLIC_API_BASE, money, pct } from '../lib/publicMarket.js';
import { evaluateFlashCosts } from './math.js';

interface CopyCandidate {
  address: string;
  label: string | null;
  signalScore: number;
  sampleSize: number;
  medianRoiPercent: number | null;
  avgRoiPercent: number | null;
  recommendation: {
    eligible: boolean;
    score: number;
    closedTrades: number;
    winRatePct: number;
    realizedPnlSol: number;
    warnings: string[];
    reasons: string[];
  };
}
interface CopyFeed {
  recommendations: CopyCandidate[];
  localWallets: CopyCandidate[];
  watcher: { running: boolean; healthy: boolean } | null;
  executionMode: 'disabled' | 'paper' | 'live';
  liveExecutionEnabled: boolean;
  updatedAt: number;
}
interface MemecoinFeed {
  status: 'not_configured' | 'connected' | 'unavailable';
  updatedAt: number | null;
  tokens: Array<{
    address: string; symbol: string; name: string; priceUsd: number;
    volumeUsd: number | null; liquidityUsd: number | null;
    smartMoneyHolders: number | null;
  }>;
}
const short = (s: string) => s.slice(0, 6) + '…' + s.slice(-5);
const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = (v: number | null | undefined, suffix = '') => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }) + suffix;
const DATA_TIMEOUT = 12_000;

export function CopyScreen() {
  const { lang, t } = useML();
  const toast = useMLToast();
  const [feed, setFeed] = useState<CopyFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<'30D' | '90D'>('30D');
  const [chosen, setChosen] = useState<CopyCandidate | null>(null);
  const [allocation, setAllocation] = useState('0.10');
  const [maxDaily, setMaxDaily] = useState('0.5');
  const [ack, setAck] = useState(false);
  const [demoPlans, setDemoPlans] = useState<Record<string, { perTradeSol: number; dailySol: number }>>({});
  useEffect(() => {
    const c = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(PUBLIC_API_BASE + '/public/copy-trading', {
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(DATA_TIMEOUT)]), cache: 'no-store',
        });
        if (!res.ok) throw new Error('Public copy-trading service unavailable');
        const value = await res.json() as CopyFeed;
        if (!c.signal.aborted) setFeed(value);
      } catch (cause) {
        if (!c.signal.aborted) setError(cause instanceof Error ? cause.message : 'Copy data unavailable');
      } finally { if (!c.signal.aborted) setLoading(false); }
    };
    void load();
    return () => c.abort();
  }, []);
  const list = (feed?.recommendations?.length ? feed.recommendations : feed?.localWallets || [])
    .filter((w) => typeof w.address === 'string' && !!w.recommendation)
    .sort((a, b) => b.signalScore - a.signalScore);
  return <>
    <ToolHeading eyebrow="INTELLIGENCE / COPY TRADING" title={t('copy')}
      description={lang === 'fa' ? 'پروفایل کیف پول‌ها بر اساس داده سرویس فعلی، همراه با درصد برد و نمونه معاملات؛ دنبال‌کننده یا افت سرمایه نامعلوم پنهان نمی‌شود.' : 'Explore candidate smart wallets using the connected public feed. Return, drawdown and follower metrics are never fabricated.'}
      badge={<ModeTag mode={feed ? 'connected' : 'offline'}/>} action={<LinkedTool to="/copy-trading" label={t('viewLive')}/>}/>
    <div className="ml2-stat-grid">
      <Stat label="ANALYZED WALLETS" value={feed ? list.length : '—'} note="Returned candidate coverage"/>
      <Stat label="RANKING FEED" value={feed?.watcher?.running && feed.watcher.healthy ? 'Running' : '—'} note="Source-reported watcher status"/>
      <Stat label="COPY EXECUTION" value={feed?.executionMode?.toUpperCase() || '—'} note="Backend-reported execution mode"/>
      <Stat label="FOLLOWER COUNT" value="—" note="Not supplied by the public API"/>
    </div>
    <Notice tone="warn" title={lang === 'fa' ? 'ارزیابی عملکرد' : 'Interpret performance carefully'}>
      {lang === 'fa' ? 'برآورد نرخ برد بر مبنای نمونه معاملات سرویس است و ضمانت بازده نیست. این صفحه کپی واقعی را فعال نمی‌کند.' : 'Sample sizes, reported wallet results and data quality vary. This screen cannot execute copying; use the connected tool to verify current safeguards.'}
    </Notice>
    <Panel className="ml2-copy-table-panel">
      <div className="ml2-panel-heading"><h2>{lang === 'fa' ? 'کیف پول‌های مشاهده‌شده' : 'Smart-wallet leaderboard'}</h2>
        <div className="ml2-segments">
          <button type="button" className={period === '30D' ? 'active' : ''} onClick={() => setPeriod('30D')}>30D</button>
          <button type="button" className={period === '90D' ? 'active' : ''} onClick={() => setPeriod('90D')}>90D</button>
        </div>
      </div>
      <div className="ml2-data-qualification">
        <Pill color="purple">PERIOD VIEW IS VISUAL ONLY</Pill>
        <span>API does not currently provide a verified 30/90-day equity series.</span>
      </div>
      {loading ? <div className="ml2-panel-pad"><Skeleton lines={6}/></div> :
        error || !list.length ? <EmptyState title="No verified traders available"
          text={error || 'No ranked wallets are available from the connected service.'} action={<LinkedTool to="/copy-trading"/>}/> :
        <div className="ml2-table-wrap"><table className="ml2-table">
          <thead><tr><th>#</th><th>WALLET</th><th>30/90D CHART</th><th>MEDIAN ROI</th><th>WIN RATE</th><th>DRAWDOWN</th><th>FOLLOWERS</th><th>RISK</th><th></th></tr></thead>
          <tbody>{list.slice(0, 20).map((wallet, index) => <tr key={wallet.address}>
            <td className="ml2-mono">{String(index + 1).padStart(2, '0')}</td>
            <td><div className="ml2-wallet-inline"><span className="ml2-trader-avatar">{wallet.label?.slice(0, 1) || '◈'}</span>
              <span><strong>{wallet.label || short(wallet.address)}</strong>
                <small>{wallet.recommendation.closedTrades} closed trades · {wallet.sampleSize} samples</small></span></div></td>
            <td><span className="ml2-unavailable">No verified chart</span></td>
            <td className={'ml2-mono ' + (wallet.medianRoiPercent != null && wallet.medianRoiPercent < 0 ? 'ml2-negative' : 'ml2-positive')}>
              {num(wallet.medianRoiPercent, '%')}</td>
            <td className="ml2-mono">{num(wallet.recommendation.winRatePct, '%')}</td>
            <td>—</td><td>—</td>
            <td><Pill color={wallet.recommendation.eligible ? 'green' : 'red'}>{wallet.recommendation.eligible ? 'Eligible' : 'Caution'}</Pill></td>
            <td><button className="ml2-table-action" type="button" onClick={() => { setChosen(wallet); setAck(false); }}>{demoPlans[wallet.address] ? (lang === 'fa' ? 'ویرایش دمو' : 'Edit demo') : (lang === 'fa' ? 'بررسی' : 'Inspect')} ↗</button></td>
          </tr>)}</tbody></table></div>}
      <div className="ml2-table-foot"><span>{feed ? 'Updated ' + new Date(feed.updatedAt).toLocaleString() : t('notAvailable')}</span>
        <span>Drawdown and follower counts not returned by API.</span></div>
    </Panel>
    {Object.keys(demoPlans).length > 0 && <Notice tone="safe" title="Local demo allocations saved">
      {Object.keys(demoPlans).length} wallet profiles configured for UI demonstration only. No live copy engine is enabled.
    </Notice>}
    <div className="ml2-lower-grid">
      <Panel title="Leader profile / risk signals">
        <div className="ml2-panel-pad"><div className="ml2-profile-placeholder"><Glyph name="users" size={30}/><strong>{lang === 'fa' ? 'ابتدا یک کیف پول را انتخاب کنید' : 'Select a wallet to inspect'}</strong>
          <p>Review available samples, eligibility and reported warnings before configuring an actual copy strategy.</p></div>
          <LinkedTool to="/copy-trading" label="Open advanced copy configuration"/></div>
      </Panel>
      <Panel title="Wallet signal coverage"><div className="ml2-panel-pad"><div className="ml2-strategy-metric">
        <span>Historical win rate</span><strong>{list.length ? num(list[0]?.recommendation.winRatePct, '%') : '—'}</strong></div>
        <div className="ml2-strategy-metric"><span>Realized sample PnL</span><strong>{list.length ? num(list[0]?.recommendation.realizedPnlSol, ' SOL') : '—'}</strong></div>
        <div className="ml2-strategy-metric"><span>Equity curve / 30–90d</span><strong>Not available</strong></div>
        <p className="ml2-muted-small">Only backend-reported metrics are shown. No historical equity curve is reconstructed from incomplete data.</p></div>
      </Panel>
    </div>
    <Modal title={chosen ? 'Copy allocation · ' + short(chosen.address) : 'Copy allocation'} open={!!chosen} onClose={() => setChosen(null)}>
      <form className="ml2-modal-body" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!ack) return;
        if (chosen) setDemoPlans((prev) => ({ ...prev, [chosen.address]: { perTradeSol: Number(allocation), dailySol: Number(maxDaily) } }));
    toast(lang === 'fa' ? 'تنظیم نمایشی ثبت شد؛ کپی واقعی فعال نیست.' : 'Demo allocation saved; no live copying enabled.');
        setChosen(null);
      }}>
        <Notice tone="warn">A copy profile here is a local UI demonstration; no account, strategy or trade is activated.</Notice>
        <div className="ml2-estimate-list">
          <div><span>Target</span><strong>{chosen && short(chosen.address)}</strong></div>
          <div><span>Reported win rate</span><strong>{num(chosen?.recommendation.winRatePct, '%')}</strong></div>
          <div><span>Drawdown</span><strong>Unverified</strong></div>
        </div>
        <FormField label="Maximum per-trade allocation (SOL)">
          <input required type="number" min="0.01" max="10" step="0.01" value={allocation} onChange={(e) => setAllocation(e.target.value)}/>
        </FormField>
        <FormField label="Daily exposure cap (SOL)">
          <input required type="number" min="0.01" max="100" step="0.01" value={maxDaily} onChange={(e) => setMaxDaily(e.target.value)}/>
        </FormField>
        <label className="ml2-checkbox"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}/>
          I understand this saves only a demonstration allocation and will not copy a wallet.</label>
        <button disabled={!ack || Number(allocation) <= 0 || Number(maxDaily) <= 0} type="submit" className="ml2-primary-button ml2-full-width">Save demo allocation</button>
        <LinkedTool to="/copy-trading" label="Configure in the connected tool"/>
      </form>
    </Modal>
  </>;
}

export function ArbitrageScreen() {
  const { lang, t } = useML();
  const [token, setToken] = useState<(typeof ARB_TOKENS)[number]>(ARB_TOKENS[0]);
  const [amount, setAmount] = useState('0.5');
  const [cost, setCost] = useState('0.000205');
  const [buffer, setBuffer] = useState('10');
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [positiveOnly, setPositiveOnly] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setStamp((old) => old + 1);
    }, 120_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);
  useEffect(() => {
    // Manual and optional timed scans are read-only. Never submit trades.
    if (!stamp) return;
    const c = new AbortController();
    const value = Number(amount);
    const budget = Number(cost);
    const bps = Number(buffer);
    if (!Number.isFinite(value) || value < 0.01 || value > 10 ||
      !Number.isFinite(budget) || budget < 0 || budget > 0.1 ||
      !Number.isInteger(bps) || bps < 0 || bps > 500) {
      setError('Amount must be 0.01–10 SOL, fee 0–0.1 SOL and buffer 0–500 bps.');
      setRoutes([]);
      setScanning(false);
      return;
    }
    setError(null);
    setRoutes([]);
    setScanning(true);
    setProgress({ phase: 'Connecting to quote sources', total: 9, completed: 0, failed: 0 });
    scanLiveRoutes({ token, amountSol: value, costSol: budget, bufferBps: bps }, c.signal,
      (p) => { if (!c.signal.aborted) setProgress(p); },
      (r) => { if (!c.signal.aborted) setRoutes((prev) => [...prev.filter((x) => x.id !== r.id), r]); })
      .then((next) => {
        if (c.signal.aborted) return;
        setRoutes(next);
        setLastScan(Date.now());
      })
      .catch((cause) => {
        if (!c.signal.aborted) setError(cause instanceof Error ? cause.message : 'Quote scanner unavailable');
      })
      .finally(() => { if (!c.signal.aborted) setScanning(false); });
    return () => c.abort();
    // Configuration changes intentionally require a new Scan click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
  const visible = routes.filter((r) => !positiveOnly || r.estimatedNetSol > 0)
    .sort((a, b) => b.estimatedNetSol - a.estimatedNetSol);
  const fresh = visible.filter((r) => isRouteFresh(r));
  return <>
    <ToolHeading eyebrow="SCANNER / ARBITRAGE" title={t('arbitrage')}
      description={lang === 'fa' ? 'اسکن واقعی قیمت‌های مستقیم صرافی‌های سولانا، با نمایش هزینه، اختلاف و تازگی قیمت؛ بدون اجرای خودکار معامله.' : 'Read-only cross-DEX route scanner powered by live Jupiter quote requests. Results are observations, not executable atomic opportunities.'}
      badge={<ModeTag mode={scanning || routes.length ? 'connected' : 'preview'}/>}
      action={<LinkedTool to="/arbitrage" label="Full live terminal"/>}/>
    <Notice tone="warn" title="No one-click execution">Sequential quotes do not reserve liquidity. Live execution and atomic settlement are not implemented in this UI.</Notice>
    <Panel className="ml2-scanner-controls">
      <div className="ml2-scanner-fields">
        <FormField label="QUOTE ASSET"><select value={token.symbol} onChange={(e) => setToken(ARB_TOKENS.find((t) => t.symbol === e.target.value) || ARB_TOKENS[0])}>
          {ARB_TOKENS.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}</select></FormField>
        <FormField label="AMOUNT (SOL)"><input type="number" min=".01" max="10" step=".01" value={amount} onChange={(e) => setAmount(e.target.value)}/></FormField>
        <FormField label="COST BUDGET (SOL)"><input type="number" min="0" max=".1" step=".000001" value={cost} onChange={(e) => setCost(e.target.value)}/></FormField>
        <FormField label="BUFFER (BPS)"><input type="number" min="0" max="500" step="1" value={buffer} onChange={(e) => setBuffer(e.target.value)}/></FormField>
        <button type="button" disabled={scanning} className="ml2-primary-button" onClick={() => setStamp((old) => old + 1)}>
          <Glyph name={scanning ? 'refresh' : 'scan'} size={17}/>{scanning ? 'Scanning routes…' : 'Scan quotes'}</button>
      </div>
      <div className="ml2-scanner-switches"><label className="ml2-checkbox">
        <input type="checkbox" checked={positiveOnly} onChange={(e) => setPositiveOnly(e.target.checked)}/>Positive estimates only</label>
        <label className="ml2-checkbox"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)}/>
          Auto-refresh read-only quotes every 2 min</label>
        <span className="ml2-muted-small">Auto-execute: unavailable • Execution time: unknown</span>
      </div>
      {scanning && progress && <div className="ml2-scan-progress" role="status">
        <div><span>{progress.phase}</span><strong>{progress.completed}/{progress.total}</strong></div>
        <progress value={progress.completed} max={progress.total}/></div>}
      {error && <p className="ml2-form-error" role="alert">{error}</p>}
    </Panel>
    <div className="ml2-stat-grid">
      <Stat label="RETURNED ROUTES" value={routes.length} note={lastScan ? new Date(lastScan).toLocaleTimeString() : 'Run scanner to check'}/>
      <Stat label="CURRENTLY FRESH" value={fresh.length} note="Quote age threshold: 45 seconds"/>
      <Stat label="BEST ESTIMATED NET" value={visible.length ? num(visible[0]?.estimatedNetSol, ' SOL') : '—'} note="Net estimate after assumed costs"/>
      <Stat label="ATOMIC EXECUTION" value="OFF" note="No executable swap bundle"/>
    </div>
    <Panel className="ml2-opportunity-panel">
      <div className="ml2-panel-heading"><h2>Cross-DEX opportunities</h2><Pill color="cyan">LIVE QUOTE OBSERVATIONS</Pill></div>
      <div className="ml2-table-wrap"><table className="ml2-table">
        <thead><tr><th>PAIR</th><th>DEX A / BUY</th><th>DEX B / SELL</th><th>NET SPREAD</th><th>NET EST. (SOL)</th><th>GAS BUDGET</th><th>AGE</th><th>ACTION</th></tr></thead>
        <tbody>{visible.map((route) => <tr key={route.id}>
          <td>SOL / {route.token}</td><td>{route.buyDex}</td><td>{route.sellDex}</td>
          <td className={'ml2-mono ' + (route.estimatedNetPercent < 0 ? 'ml2-negative' : 'ml2-positive')}>{pct(route.estimatedNetPercent)}</td>
          <td className={'ml2-mono ' + (route.estimatedNetSol < 0 ? 'ml2-negative' : 'ml2-positive')}>{num(route.estimatedNetSol, ' SOL')}</td>
          <td className="ml2-mono">{num(route.costSol, ' SOL')}</td>
          <td><Pill color={isRouteFresh(route) ? 'green' : 'red'}>{isRouteFresh(route) ? 'Fresh' : 'Stale'}</Pill></td>
          <td><button type="button" disabled title="Live execution is not implemented" className="ml2-disabled-action">Execute locked</button></td>
        </tr>)}</tbody></table></div>
      {!visible.length && <EmptyState title={scanning ? 'Fetching direct quotes' : lastScan ? 'No routes met these criteria' : 'Ready to scan'}
        text={scanning ? 'Each venue is queried sequentially with rate limits.' : 'Start a read-only scan. Empty results do not imply arbitrage is safe or available.'}/>}
      <div className="ml2-table-foot"><span>Every estimate excludes unpredictable execution failures.</span><Link to="/arbitrage">Advanced quote detail ↗</Link></div>
    </Panel>
  </>;
}

export function MemesScreen() {
  const { lang, t } = useML();
  const [data, setData] = useState<MemecoinFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'volume' | 'liquidity'>('volume');
  useEffect(() => {
    const c = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(PUBLIC_API_BASE + '/public/gmgn/markets', {
          cache: 'no-store', signal: AbortSignal.any([c.signal, AbortSignal.timeout(DATA_TIMEOUT)]),
        });
        if (!res.ok) throw new Error('GMGN market feed unavailable');
        if (!c.signal.aborted) setData(await res.json() as MemecoinFeed);
      } catch (cause) {
        if (!c.signal.aborted) setError(cause instanceof Error ? cause.message : 'Meme market data unavailable');
      } finally { if (!c.signal.aborted) setLoading(false); }
    };
    void load(); return () => c.abort();
  }, []);
  const tokens = (data?.tokens || []).filter((token) =>
    (token.symbol + ' ' + token.name).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (sort === 'volume' ? (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0)
      : (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)));
  return <>
    <ToolHeading eyebrow="DISCOVERY / MEME COINS" title={t('memes')}
      description={lang === 'fa' ? 'جست‌وجوی توکن‌های جدید و ترند از منبع GMGN در صورت اتصال؛ معیارهای امنیتی ناموجود با عنوان «بررسی‌نشده» نمایش داده می‌شوند.' : 'Monitor tracked token signals, volume and liquidity from the public GMGN adapter when connected. Safety checks require independent validation.'}
      badge={<ModeTag mode={data?.status === 'connected' ? 'connected' : 'offline'}/>}
      action={<LinkedTool to="/research" label="Advanced token research"/>}/>
    <Notice tone="warn" title="Meme coin risks are unusually high">Honeypot status, rug-pull probability, LP locks, and developer-wallet concentration are not verified by this feed. Never treat an unverified token as safe.</Notice>
    <div className="ml2-stat-grid">
      <Stat label="TRACKED TOKENS" value={data ? tokens.length : '—'} note="GMGN returned assets"/>
      <Stat label="SMART-MONEY COVERAGE" value={data?.status === 'connected' ? 'Connected' : '—'} note="Adapter status"/>
      <Stat label="VERIFIED SAFE SCORES" value="—" note="No honeypot audit endpoint"/>
      <Stat label="QUICK BUY STATUS" value="OFF" note="Transaction signing not connected"/>
    </div>
    <Panel className="ml2-meme-table">
      <div className="ml2-panel-heading"><h2>Trending / monitored tokens</h2>
        <div className="ml2-table-actions"><label className="ml2-search"><Glyph name="search" size={16}/><input aria-label="Search meme tokens" placeholder="Search token..." value={query} onChange={(e) => setQuery(e.target.value)}/></label>
          <select aria-label="Sort tokens" value={sort} onChange={(e) => setSort(e.target.value as 'volume' | 'liquidity')}><option value="volume">Volume</option><option value="liquidity">Liquidity</option></select></div></div>
      {loading ? <div className="ml2-panel-pad"><Skeleton lines={5}/></div> : tokens.length ?
        <div className="ml2-table-wrap"><table className="ml2-table"><thead><tr>
          <th>TOKEN</th><th>PRICE</th><th>24H VOLUME</th><th>LIQUIDITY</th><th>SMART HOLDERS</th><th>SAFETY SCORE</th><th>LP LOCK / DEV %</th><th>ACTION</th></tr></thead>
          <tbody>{tokens.slice(0, 30).map((token) => <tr key={token.address}>
            <td><div className="ml2-wallet-inline"><span className="ml2-token-avatar">{token.symbol?.slice(0, 1) || '?'}</span>
              <span><strong>{token.symbol || 'Unknown'}</strong><small>{token.name}</small></span></div></td>
            <td className="ml2-mono">{money(token.priceUsd)}</td><td className="ml2-mono">{num(token.volumeUsd == null ? null : token.volumeUsd, ' USD')}</td>
            <td className="ml2-mono">{num(token.liquidityUsd == null ? null : token.liquidityUsd, ' USD')}</td>
            <td className="ml2-mono">{num(token.smartMoneyHolders)}</td>
            <td><Pill color="red">UNVERIFIED</Pill></td><td>— / —</td>
            <td><Link className="ml2-table-action" to="/research">Research ↗</Link></td>
          </tr>)}</tbody></table></div> :
        <EmptyState title={error || 'No monitored launches returned'} text="The connected GMGN source did not return token data. No fake launch, market cap or safety badge is shown." action={<LinkedTool to="/research"/>}/>}
      <div className="ml2-table-foot"><span>New launches and market caps require verified providers.</span><span>{data?.updatedAt ? new Date(data.updatedAt).toLocaleString() : 'No source update'}</span></div>
    </Panel>
    <div className="ml2-lower-grid">
      <Panel title="Token safety checklist"><div className="ml2-panel-pad">
        {['Honeypot / sell simulation', 'Rug-pull risk signal', 'Liquidity pool lock', 'Developer wallet concentration'].map((item) => <div className="ml2-strategy-metric" key={item}><span>{item}</span><Pill color="red">NOT VERIFIED</Pill></div>)}
        <Link className="ml2-outline-button ml2-full-width" to="/research">Open research toolbox <Glyph name="arrow" size={16}/></Link>
      </div></Panel>
      <Panel title="Quick buy / Sniper"><div className="ml2-panel-pad ml2-meme-actions">
        <Glyph name="rocket" size={28}/><strong>Execution is deliberately locked</strong>
        <p>Buying a newly launched token requires verified contract checks, funded account permissions, and supported transaction execution.</p>
        <button type="button" disabled title="Token safety and executable route have not been verified" className="ml2-primary-button ml2-full-width">Quick buy · locked</button>
        <LinkedTool to="/dashboard/snipes" label="Open connected sniper settings"/>
      </div></Panel>
    </div>
  </>;
}

const providers = ['Aave', 'Balancer', 'dYdX'] as const;
const strategyBlocks = [
  { label: '01 / BORROW', title: 'Flash liquidity', icon: 'flash' as const },
  { label: '02 / ROUTE', title: 'DEX venue A', icon: 'swap' as const },
  { label: '03 / ROUTE', title: 'DEX venue B', icon: 'scan' as const },
  { label: '04 / REPAY', title: 'Return principal + fee', icon: 'shield' as const },
];

export function FlashScreen() {
  const { lang, t } = useML();
  const [provider, setProvider] = useState<(typeof providers)[number]>('Aave');
  const [principal, setPrincipal] = useState('10000');
  const [edge, setEdge] = useState('0.4');
  const [fee, setFee] = useState('0.05');
  const [gas, setGas] = useState('15');
  const [slippage, setSlippage] = useState('0.15');
  const [simulation, setSimulation] = useState(false);
  const n = Number(principal), e = Number(edge), f = Number(fee), g = Number(gas), s = Number(slippage);
  const modeled = evaluateFlashCosts({
    principal: n, edgePercent: e, loanFeePercent: f,
    gasAllowanceUsd: g, slippagePercent: s,
  });
  const valid = modeled !== null;
  const spreadValue = modeled?.grossUsd ?? 0;
  const feeValue = modeled?.loanFeeUsd ?? 0;
  const slipValue = modeled?.slippageAllowanceUsd ?? 0;
  const net = modeled?.netUsd ?? 0;
  return <>
    <ToolHeading eyebrow="STRATEGY / FLASH LOANS" title={t('flash')}
      description={lang === 'fa' ? 'سازنده استراتژی بصری با محاسبه کارمزدهای فرضی، هزینه شبکه و اسلیپیج؛ هیچ وام واقعی گرفته نمی‌شود.' : 'Model an atomic borrow → route → repay flow and test assumptions before any smart-contract integration.'}
      badge={<ModeTag mode="simulation"/>} action={<LinkedTool to="/flash-arbitrage" label="Existing flash-loan lab"/>}/>
    <Notice tone="warn" title="Flash loans are high risk">
      This is a calculator, not a transaction simulation or a provider fee quote. Incorrect liquidity assumptions, reverted calls and contract bugs can cause losses.
    </Notice>
    <div className="ml2-flash-grid">
      <Panel title="Visual strategy builder" className="ml2-flash-builder">
        <div className="ml2-strategy-nodes">
          {strategyBlocks.map((node, index) => <div className="ml2-strategy-node-wrap" key={node.label}>
            <div className="ml2-strategy-node"><span className="ml2-strategy-node-icon"><Glyph name={node.icon} size={21}/></span>
              <small>{node.label}</small><strong>{node.title}</strong></div>
            {index !== strategyBlocks.length - 1 && <div className="ml2-strategy-connector"><Glyph name="arrow" size={19}/></div>}
          </div>)}
        </div>
        <div className="ml2-block-details"><span><Glyph name="lock" size={16}/> ATOMIC TX REQUIRED</span>
          <span><Glyph name="shield" size={16}/> EXECUTION NOT CONNECTED</span>
          <span><Glyph name="activity" size={16}/> ASSUMPTIONS ONLY</span></div>
        <div className="ml2-feature-rules">
          <div><span>Strategy execution</span><Pill color="red">LOCKED</Pill></div>
          <div><span>Provider availability</span><Pill color="purple">NOT CHECKED</Pill></div>
          <div><span>Smart-contract simulation</span><Pill color="purple">NOT RUN</Pill></div>
        </div>
      </Panel>
      <Panel title="Loan & cost assumptions" className="ml2-flash-form">
        <div className="ml2-form-stack">
          <FormField label="Provider (illustrative)">
            <select value={provider} onChange={(e) => {setProvider(e.target.value as (typeof providers)[number]);setSimulation(false);}}>
              {providers.map((p) => <option key={p}>{p}</option>)}</select></FormField>
          <div className="ml2-two-inputs">
            <FormField label="Loan amount (USDC)"><input type="number" value={principal} min="1" max="1000000" onChange={(e) => {setPrincipal(e.target.value);setSimulation(false);}}/></FormField>
            <FormField label="Assumed spread (%)"><input type="number" value={edge} min="0" max="30" step="0.01" onChange={(e) => {setEdge(e.target.value);setSimulation(false);}}/></FormField>
          </div>
          <div className="ml2-two-inputs">
            <FormField label="Assumed loan fee (%)"><input type="number" value={fee} min="0" max="10" step="0.01" onChange={(e) => {setFee(e.target.value);setSimulation(false);}}/></FormField>
            <FormField label="Gas/tip allowance (USD)"><input type="number" value={gas} min="0" step="1" onChange={(e) => {setGas(e.target.value);setSimulation(false);}}/></FormField>
          </div>
          <FormField label="Assumed slippage budget (%)"><input type="number" value={slippage} min="0" max="10" step="0.01" onChange={(e) => {setSlippage(e.target.value);setSimulation(false);}}/></FormField>
          <button type="button" className="ml2-primary-button ml2-full-width" disabled={!valid} onClick={() => setSimulation(true)}>
            <Glyph name="play" size={16}/> Run cost-model simulation</button>
        </div>
      </Panel>
    </div>
    <div className="ml2-stat-grid">
      <Stat label="ESTIMATED GROSS EDGE" value={simulation && valid ? usd(spreadValue) : '—'} note="Assumed spread × capital"/>
      <Stat label="LOAN FEE ALLOWANCE" value={simulation && valid ? usd(feeValue) : '—'} note="User-defined fee, not provider quote"/>
      <Stat label="COSTS + SLIPPAGE" value={simulation && valid ? usd(g + slipValue) : '—'} note="User-defined estimates"/>
      <Stat label="MODEL NET RESULT" value={simulation && valid ? usd(net) : '—'} note="Not a realized or executable PnL" trend={simulation ? net >= 0 ? 'up' : 'down' : undefined}/>
    </div>
    {simulation && valid && <Notice tone={net > 0 ? 'info' : 'warn'} title={net > 0 ? 'Model passes arithmetic only' : 'Model estimates negative net'}>
      This result does not validate loan-provider liquidity, smart-contract safety, actual quotes, atomic execution, network fee volatility or revert conditions.
    </Notice>}
  </>;
}

const botTemplates = [
  { type: 'Grid Bot', desc: 'Place planned levels in a defined price corridor.', icon: 'chart' as const, risk: 'MEDIUM', accent: 'cyan' },
  { type: 'DCA Bot', desc: 'Stage position entries over time under a fixed exposure ceiling.', icon: 'history' as const, risk: 'MEDIUM', accent: 'purple' },
  { type: 'Arbitrage Bot', desc: 'Observe price differences between venue routes.', icon: 'scan' as const, risk: 'HIGH', accent: 'green' },
  { type: 'Sniper Bot', desc: 'Monitor fresh liquidity and launch events.', icon: 'rocket' as const, risk: 'VERY HIGH', accent: 'purple' },
  { type: 'Market Maker', desc: 'Model passive liquidity and quote management.', icon: 'layers' as const, risk: 'HIGH', accent: 'cyan' },
];
interface DemoBot {
  id: number; type: string; allocation: number; dailyLoss: number; running: boolean;
}
export function BotsScreen() {
  const { lang, t } = useML();
  const toast = useMLToast();
  const [tab, setTab] = useState<'marketplace' | 'builder' | 'mybots'>('marketplace');
  const [kind, setKind] = useState(botTemplates[0]?.type || 'Grid Bot');
  const [allocation, setAllocation] = useState('0.25');
  const [dailyLoss, setDailyLoss] = useState('3');
  const [bots, setBots] = useState<DemoBot[]>([]);
  const [modal, setModal] = useState(false);
  const createDemo = (e: FormEvent) => {
    e.preventDefault();
    const sol = Number(allocation), loss = Number(dailyLoss);
    if (!Number.isFinite(sol) || sol < 0.01 || sol > 10 || !Number.isFinite(loss) || loss < 0.1 || loss > 30) return;
    setBots((prev) => [...prev, { id: prev.length + 1, type: kind, allocation: sol, dailyLoss: loss, running: false }]);
    setTab('mybots');setModal(false);toast(t('saveDemo'));
  };
  return <>
    <ToolHeading eyebrow="AUTOMATION / BOT STUDIO" title={t('bots')}
      description={lang === 'fa' ? 'بازارچه ربات‌ها و سازنده استراتژی با تنظیم سرمایه و حد ضرر نمایشی؛ هیچ معامله خودکاری فعال نمی‌شود.' : 'Explore strategy templates, configure sample controls and manage local demo states. No unattended real-money bot is launched here.'}
      badge={<ModeTag mode="preview"/>} action={<LinkedTool to="/dashboard/trading-lab" label="Connected trading lab"/>}/>
    <Notice tone="warn" title="Automation can compound losses quickly">Templates, backtests and PnL are previews until connected to a verified execution engine. Do not fund a strategy based on sample UI alone.</Notice>
    <div className="ml2-stat-grid">
      <Stat label="AVAILABLE TEMPLATES" value={botTemplates.length} note="Strategy designs"/>
      <Stat label="LOCAL DEMO BOTS" value={bots.length} note="Browser session only"/>
      <Stat label="REAL BOT UPTIME" value="—" note="No production telemetry connected"/>
      <Stat label="REAL BOT PNL" value="—" note="No verified fills reported"/>
    </div>
    <div className="ml2-segments ml2-bot-tabs">
      {(['marketplace','builder','mybots'] as const).map((value) => <button type="button" key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>
        {value === 'marketplace' ? 'BOT MARKETPLACE' : value === 'builder' ? 'STRATEGY BUILDER' : 'MY DEMO BOTS'}</button>)}
    </div>
    {tab === 'marketplace' && <div className="ml2-bot-grid">
      {botTemplates.map((bot) => <Panel className={'ml2-bot-card ml2-accent-' + bot.accent} key={bot.type}>
        <span className="ml2-bot-card-top"><span className="ml2-product-icon"><Glyph name={bot.icon} size={22}/></span><Pill color={bot.risk.includes('HIGH') ? 'red' : 'purple'}>{bot.risk} RISK</Pill></span>
        <h3>{bot.type}</h3><p>{bot.desc}</p>
        <div className="ml2-bot-card-stats"><span>VERIFIED PNL <strong>—</strong></span><span>BACKTEST <strong>—</strong></span></div>
        <button className="ml2-outline-button ml2-full-width" type="button" onClick={() => {setKind(bot.type);setTab('builder');}}>
          Configure preview <Glyph name="arrow" size={15}/></button>
      </Panel>)}
    </div>}
    {tab === 'builder' && <div className="ml2-flash-grid">
      <Panel title="Build a strategy"><form className="ml2-form-stack ml2-panel-pad" onSubmit={createDemo}>
        <FormField label="Strategy template"><select value={kind} onChange={(e) => setKind(e.target.value)}>
          {botTemplates.map((b) => <option key={b.type}>{b.type}</option>)}</select></FormField>
        <FormField label="Max notional allocation (SOL)"><input required type="number" min=".01" max="10" step=".01" value={allocation} onChange={(e) => setAllocation(e.target.value)}/></FormField>
        <FormField label="Sample daily loss halt (%)"><input required type="number" min=".1" max="30" step=".1" value={dailyLoss} onChange={(e) => setDailyLoss(e.target.value)}/></FormField>
        <button className="ml2-primary-button ml2-full-width" type="button" onClick={() => setModal(true)}>Review demo configuration <Glyph name="arrow" size={16}/></button>
        <p className="ml2-muted-small">No funds are allocated. Settings only create an in-memory demo bot.</p>
      </form></Panel>
      <Panel title="Strategy guardrails"><div className="ml2-panel-pad">
        {['Execution disabled', 'Maximum exposure specified', 'Stop-on-loss plan', 'Quote freshness required', 'Independent backtest missing'].map((v, i) => <div className="ml2-strategy-metric" key={v}>
          <span>{v}</span><Pill color={i < 3 ? 'green' : 'purple'}>{i < 3 ? 'UI CHECK' : 'REQUIRED'}</Pill></div>)}
        <Notice tone="warn">A UI-configured guard does not guarantee that the execution engine will enforce it.</Notice>
      </div></Panel>
    </div>}
    {tab === 'mybots' && <Panel title="Local demo bot dashboard">
      {bots.length ? <div className="ml2-table-wrap"><table className="ml2-table"><thead><tr>
        <th>BOT</th><th>STATUS</th><th>NOTIONAL CAP</th><th>LOSS HALT</th><th>UPTIME</th><th>PNL</th><th>CONTROLS</th></tr></thead>
        <tbody>{bots.map((bot) => <tr key={bot.id}><td>{bot.type} #{bot.id}</td>
          <td><Pill color={bot.running ? 'green' : 'muted'}>{bot.running ? 'DEMO RUNNING' : 'DEMO PAUSED'}</Pill></td>
          <td>{bot.allocation} SOL</td><td>{bot.dailyLoss}%</td><td>—</td><td>—</td>
          <td><button type="button" className="ml2-outline-button" onClick={() => {
            setBots((prev) => prev.map((item) => item.id === bot.id ? { ...item, running: !item.running } : item));
            toast('Updated local demo state. No trades or workers were started.');
          }}><Glyph name={bot.running ? 'pause' : 'play'} size={15}/>{bot.running ? 'Pause demo' : 'Run demo'}</button></td>
        </tr>)}</tbody></table></div> :
        <EmptyState title="No demo bots yet" text="Create a sample strategy. Your real account bots are accessible from the connected dashboard." action={
          <button type="button" className="ml2-primary-button" onClick={() => setTab('builder')}>Build demo bot <Glyph name="arrow" size={16}/></button>}/>}
      <div className="ml2-table-foot">No service workers or trading API calls are started from this screen.</div>
    </Panel>}
    <Modal title="Confirm demo bot configuration" open={modal} onClose={() => setModal(false)}>
      <form className="ml2-modal-body" onSubmit={createDemo}>
        <Notice tone="warn">This creates a local UI sample only. It does not create a live bot, a backtest, or a funded allocation.</Notice>
        <div className="ml2-estimate-list"><div><span>Strategy</span><strong>{kind}</strong></div>
          <div><span>Allocation cap</span><strong>{allocation} SOL</strong></div>
          <div><span>Sample loss halt</span><strong>{dailyLoss}%</strong></div></div>
        <button type="submit" className="ml2-primary-button ml2-full-width">Create local demo bot</button>
      </form>
    </Modal>
  </>;
}
