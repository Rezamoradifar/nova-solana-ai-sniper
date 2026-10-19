import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Glyph, Modal, Panel, Pill, Skeleton, productLinks, useML, useMLFeed, useMLToast } from './core.js';
import { EmptyState, FormField, LinkedTool, ModeTag, Notice, Sparkline, Stat, ToolHeading } from './WorkspaceCommon.js';
import { TradingViewWidget } from '../components/TradingViewWidget.js';
import { PUBLIC_API_BASE, money, pct } from '../lib/publicMarket.js';
import { indicativeSwapOutput } from './math.js';
import { useWalletConnection } from '../lib/WalletContext.js';

const CHAINS = ['Solana', 'Ethereum', 'BNB Chain', 'Arbitrum', 'Base'] as const;
const TOKEN_CHOICES = ['SOL', 'USDC', 'JUP', 'RAY', 'BONK'] as const;
const finite = (input: string) => {
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? value : 0;
};
const usd = (value: number) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  : '—';

export function OverviewScreen() {
  const { t, lang } = useML();
  const { tokens, loading, error, updatedAt, refresh } = useMLFeed();
  const { state } = useWalletConnection();
  const volume = tokens.reduce((sum, token) => sum + token.volume, 0);
  const liquidity = tokens.reduce((sum, token) => sum + token.liquidity, 0);
  return <>
    <ToolHeading eyebrow="WORKSPACE / OVERVIEW" title={lang === 'fa' ? 'داشبورد معاملاتی' : 'Your trading command center'}
      description={lang === 'fa' ? 'نمای فوری بازار سولانا و دسترسی به تمام ابزارها؛ بدون داده ساختگی برای حساب.' : 'One destination for market intelligence, connected trading tools and your portfolio.'}
      badge={<ModeTag mode={error ? 'offline' : tokens.length ? 'connected' : 'preview'}/>}
      action={<button className="ml2-outline-button" type="button" disabled={loading} onClick={refresh}><Glyph name="refresh" size={16}/>{t('refresh')}</button>}/>
    <div className="ml2-stat-grid">
      <Stat label="24H OBSERVED POOL VOLUME" value={tokens.length ? money(volume, true) : '—'} note="Selected Solana pools" />
      <Stat label="OBSERVED LIQUIDITY" value={tokens.length ? money(liquidity, true) : '—'} note="Not total value locked" />
      <Stat label="TRACKED TOKENS" value={tokens.length || '—'} note={tokens.length ? 'Live source coverage' : 'Source pending'} />
      <Stat label="YOUR ACCOUNT VALUE" value="—" note={state.account ? 'Account valuation not connected' : 'Connect wallet to begin'} />
    </div>
    <div className="ml2-dashboard-columns">
      <Panel className="ml2-chart-panel" title={lang === 'fa' ? 'نمودار زنده سولانا' : 'Live SOL/USD chart'} action={<Pill color="cyan">TRADINGVIEW / EXTERNAL</Pill>}>
        <TradingViewWidget symbol="COINBASE:SOLUSD" height={382}/>
        <div className="ml2-panel-pad"><small className="ml2-muted-small">{lang === 'fa' ? 'نمودار از TradingView دریافت می‌شود؛ مالک داده یا اجرای سفارش نیستیم.' : 'External TradingView chart. Charts and quotes are not evidence of filled orders.'}</small></div>
      </Panel>
      <Panel className="ml2-watchlist-panel" title={lang === 'fa' ? 'دارایی‌های منتخب' : 'Top watchlist'} action={<LinkedTool to="/markets" label={t('seeAll')}/>}>
        {loading && !tokens.length ? <div className="ml2-panel-pad"><Skeleton lines={4}/></div> :
          tokens.length ? <div className="ml2-list-asset">
            {tokens.slice(0, 6).map((token) => <Link to="/markets" className="ml2-list-row" key={token.mint}>
              <span className="ml2-token-avatar">{token.symbol.charAt(0)}</span>
              <span className="ml2-asset-name"><strong>{token.symbol}</strong><small>{token.name}</small></span>
              <span className="ml2-asset-spark"><Sparkline trend={token.change != null && token.change < 0 ? 'down' : 'up'}/></span>
              <span className="ml2-list-price"><strong dir="ltr">{money(token.price)}</strong>
                <small dir="ltr" className={token.change != null && token.change < 0 ? 'ml2-negative' : 'ml2-positive'}>{pct(token.change)}</small></span>
            </Link>)}</div> : <EmptyState title={t('offline')} text={error || 'No live market data received'}/>}
        <div className="ml2-table-foot">{updatedAt ? 'Observed at ' + new Date(updatedAt).toLocaleTimeString() : t('notAvailable')}</div>
      </Panel>
    </div>
    <div className="ml2-subsection-title"><div><span className="ml2-eyebrow"><span/> ACCESS / TOOLS</span><h2>{lang === 'fa' ? 'دسترسی سریع' : 'Jump into a workspace'}</h2></div></div>
    <div className="ml2-overview-shortcuts">
      {productLinks.filter((p) => p.key !== 'overview' && p.key !== 'portfolio').map((p) => <Link key={p.key} to={p.route}>
        <span><Glyph name={p.icon} size={22}/></span><strong>{t(p.key)}</strong><small>{p.hint}</small><Glyph name="arrow" size={16}/>
      </Link>)}
    </div>
    <Notice tone="info" title={lang === 'fa' ? 'تفکیک داده و اجرا' : 'Observation ≠ execution'}>
      {t('limited')} {t('riskNote')}
    </Notice>
  </>;
}

export function DexScreen() {
  const { t, lang } = useML();
  const { tokens, error } = useMLFeed();
  const [chain, setChain] = useState<(typeof CHAINS)[number]>('Solana');
  const [inputToken, setInputToken] = useState('SOL');
  const [outputToken, setOutputToken] = useState('USDC');
  const [amount, setAmount] = useState('1.0');
  const [slippage, setSlippage] = useState('0.5');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const connected = chain === 'Solana' && !error;
  const tokenPrice = (symbol: string) => symbol === 'USDC' ? 1 : tokens.find((token) => token.symbol === symbol)?.price;
  const fromPx = tokenPrice(inputToken);
  const toPx = tokenPrice(outputToken);
  const estimate = connected && inputToken !== outputToken ? indicativeSwapOutput(finite(amount), fromPx, toPx) : null;
  return <>
    <ToolHeading eyebrow="TRADE / DEX" title={t('dex')}
      description={lang === 'fa' ? 'پیش‌نمایش سواپ چندشبکه‌ای با مشاهده داده بازار؛ اجرای معاملات واقعی اینجا فعال نیست.' : 'Multi-chain swap research with live Solana reference prices. An executable route requires a separate verified quote and wallet approval.'}
      badge={<ModeTag mode={chain !== 'Solana' ? 'preview' : error ? 'offline' : tokens.length ? 'connected' : 'preview'}/>} action={<LinkedTool to="/arbitrage"/>}/>
    <div className="ml2-chain-strip">
      <span>{lang === 'fa' ? 'انتخاب شبکه' : 'SELECT NETWORK'}</span>
      {CHAINS.map((name) => <button className={chain === name ? 'selected' : ''} key={name} type="button" onClick={() => setChain(name)}>
        <span className="ml2-chain-mark">{name.slice(0, 1)}</span>{name}{name !== 'Solana' && <small>PREVIEW</small>}
      </button>)}
    </div>
    {chain !== 'Solana' && <Notice title={lang === 'fa' ? 'اتصال این شبکه آماده نیست' : 'Network integration not connected'}>
      {lang === 'fa' ? 'انتخاب شبکه تنها نمایش رابط کاربری را تغییر می‌دهد. این نسخه قیمت و تراکنش واقعی برای این شبکه ندارد.' : 'This chain selector is a UI preview. No route data or transaction execution is available on this chain in the current Nova backend.'}
    </Notice>}
    <div className="ml2-trade-grid">
      <Panel className="ml2-chart-panel" title="SOL / USD" action={<Pill color="cyan">TRADINGVIEW</Pill>}>
        <TradingViewWidget symbol="COINBASE:SOLUSD" height={390}/>
        <div className="ml2-panel-pad"><p className="ml2-muted-small">Market chart from TradingView · Symbol SOL/USD · Not an order execution feed</p></div>
      </Panel>
      <Panel className="ml2-swap-panel">
        <div className="ml2-panel-heading"><h2>{lang === 'fa' ? 'مبدل توکن' : 'Swap tokens'}</h2>
          <button aria-label={t('settings')} type="button" className="ml2-icon-button" onClick={() => setSettingsOpen(true)}><Glyph name="settings" size={18}/></button></div>
        <div className="ml2-swap-body">
          <span className="ml2-swap-caption">YOU PAY</span>
          <div className="ml2-swap-token-box">
            <input aria-label="Input amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)}/>
            <select aria-label="Input token" value={inputToken} onChange={(e) => setInputToken(e.target.value)}>
              {TOKEN_CHOICES.map((symbol) => <option value={symbol} key={symbol}>{symbol}</option>)}
            </select>
            <small>{fromPx && amount !== '' ? usd(finite(amount) * fromPx) + ' reference value' : 'Price unavailable'}</small>
          </div>
          <div className="ml2-swap-divider"><button type="button" title="Swap input and output" aria-label="Swap token selection" onClick={() => {
            setInputToken(outputToken); setOutputToken(inputToken);
          }}><Glyph name="swap" size={20}/></button></div>
          <span className="ml2-swap-caption">YOU RECEIVE / INDICATIVE</span>
          <div className="ml2-swap-token-box">
            <strong dir="ltr">{estimate == null ? '—' : estimate.toLocaleString('en-US', { maximumFractionDigits: 6 })}</strong>
            <select aria-label="Output token" value={outputToken} onChange={(e) => setOutputToken(e.target.value)}>
              {TOKEN_CHOICES.map((symbol) => <option value={symbol} key={symbol}>{symbol}</option>)}
            </select>
            <small>{toPx && estimate != null ? usd(estimate * toPx) + ' reference value' : 'Price unavailable'}</small>
          </div>
          <div className="ml2-estimate-list">
            <div><span>Slippage setting</span><strong>{slippage}%</strong></div>
            <div><span>Executable route</span><strong>Not quoted</strong></div>
            <div><span>Price impact</span><strong>—</strong></div>
            <div><span>Gas / network fee</span><strong>—</strong></div>
            <div><span>Route provider</span><strong>Jupiter · research only</strong></div>
          </div>
          <button type="button" className="ml2-primary-button ml2-full-width" disabled={estimate == null || finite(amount) === 0}
            onClick={() => setPreviewOpen(true)}>{lang === 'fa' ? 'پیش‌نمایش مقدار' : 'Preview indicative rate'} <Glyph name="arrow" size={17}/></button>
          <p className="ml2-muted-small">{lang === 'fa' ? 'این محاسبه سواپ قابل‌امضا نیست و کارمزد/اثر قیمت را لحاظ نمی‌کند.' : 'Cross-rate estimate only: not a swap quote, not a signed transaction and excludes fees/price impact.'}</p>
          <LinkedTool to="/wallet" label={t('connectAction')}/>
        </div>
      </Panel>
    </div>
    <div className="ml2-lower-grid">
      <Panel title="Order book"><EmptyState title="Venue order book not connected"
        text="Swap liquidity is AMM-based. A centralized-style order book requires an order-feed integration."/></Panel>
      <Panel title="Recent trades"><EmptyState title="Trade tape not connected"
        text="No executed trades are invented for this view. Explore verified pool activity in Markets."
        action={<LinkedTool to="/markets"/>}/></Panel>
    </div>
    <Modal title="Swap settings" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
      <div className="ml2-modal-body"><FormField label="Slippage tolerance (%)">
        <input type="number" min="0.1" max="5" step=".1" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
      </FormField><p className="ml2-muted-small">Slippage is saved to this UI preview only. An eventual signed quote must independently enforce limits.</p>
        <button className="ml2-primary-button ml2-full-width" type="button" onClick={() => setSettingsOpen(false)}>Done</button>
      </div>
    </Modal>
    <Modal title="Indicative swap preview" open={previewOpen} onClose={() => setPreviewOpen(false)}>
      <div className="ml2-modal-body">
        <Notice tone="warn" title="Not an executable quote">No transaction, route or price-impact data was retrieved for this preview.</Notice>
        <div className="ml2-estimate-list"><div><span>Input</span><strong>{amount} {inputToken}</strong></div>
          <div><span>Reference output</span><strong dir="ltr">{estimate?.toFixed(5) ?? '—'} {outputToken}</strong></div>
          <div><span>Network</span><strong>{chain}</strong></div></div>
        <Link to="/arbitrage" className="ml2-primary-button ml2-full-width">Explore verified route quotes <Glyph name="arrow" size={16}/></Link>
      </div>
    </Modal>
  </>;
}

export function ExchangeScreen() {
  const { t, lang } = useML();
  const { tokens, loading } = useMLFeed();
  const [marketMode, setMarketMode] = useState<'spot' | 'futures'>('spot');
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'stop'>('limit');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [pair, setPair] = useState('SOL');
  const [amount, setAmount] = useState('1');
  const [limitPrice, setLimitPrice] = useState('150');
  const [stopPrice, setStopPrice] = useState('140');
  const [leverage, setLeverage] = useState(2);
  const [open, setOpen] = useState(false);
  const selectedToken = tokens.find((token) => token.symbol === pair);
  const price = orderType === 'market' ? selectedToken?.price : finite(orderType === 'stop' ? stopPrice : limitPrice);
  const notional = price == null ? null : price * finite(amount);
  return <>
    <ToolHeading eyebrow="TRADE / EXCHANGE" title={t('exchange')}
      description={lang === 'fa' ? 'رابط پیشرفته سفارش‌گذاری اسپات و فیوچرز با نمودار زنده بیرونی؛ ارسال سفارش واقعی متصل نیست.' : 'Exchange-style charting and order-entry design for spot and futures. Real brokerage/exchange execution is not connected.'}
      badge={<ModeTag mode="preview"/>} action={<LinkedTool to="/dashboard" label={t('dashboard')}/>}/>
    <div className="ml2-exchange-toolbar">
      <div className="ml2-segments"><button type="button" className={marketMode === 'spot' ? 'active' : ''} onClick={() => setMarketMode('spot')}>SPOT</button>
        <button type="button" className={marketMode === 'futures' ? 'active' : ''} onClick={() => setMarketMode('futures')}>FUTURES · PREVIEW</button></div>
      <span className="ml2-mono">SOLANA / USDC REFERENCE DATA</span>
    </div>
    <div className="ml2-exchange-grid">
      <Panel className="ml2-exchange-pairs" title="MARKETS">
        <div className="ml2-pair-list">
          {loading && !tokens.length && <Skeleton lines={5}/>}
          {tokens.slice(0, 9).map((token) => <button type="button" key={token.mint} className={pair === token.symbol ? 'selected' : ''} onClick={() => setPair(token.symbol)}>
            <span><span className="ml2-token-avatar">{token.symbol.slice(0, 1)}</span><strong>{token.symbol}<small>/USDC</small></strong></span>
            <span><b dir="ltr">{money(token.price)}</b><small dir="ltr" className={token.change != null && token.change < 0 ? 'ml2-negative' : 'ml2-positive'}>{pct(token.change)}</small></span>
          </button>)}
          {!tokens.length && !loading && <p className="ml2-panel-pad ml2-muted-small">Market feed unavailable. No price substituted.</p>}
        </div>
      </Panel>
      <div className="ml2-exchange-center">
        <Panel className="ml2-chart-panel" title={pair + ' / USDC'} action={<Pill color="cyan">EXTERNAL LIVE CHART / SOL REFERENCE</Pill>}>
          <TradingViewWidget symbol="COINBASE:SOLUSD" height={400}/>
          {pair !== 'SOL' && <div className="ml2-panel-pad ml2-muted-small">This widget currently shows SOL/USD. A chart feed for {pair}/USDC is not configured.</div>}
        </Panel>
        <Panel title="Open orders / Positions / Trade history">
          <div className="ml2-tab-row"><span className="active">OPEN ORDERS</span><span>POSITIONS</span><span>HISTORY</span></div>
          <EmptyState title={t('notConnected')} text={t('noOrders')} action={<LinkedTool to="/dashboard" label={t('dashboard')}/>}/>
        </Panel>
      </div>
      <div className="ml2-exchange-side">
        <Panel title="ORDER BOOK">
          <div className="ml2-book-labels"><span>PRICE</span><span>SIZE</span><span>TOTAL</span></div>
          <EmptyState title="No exchange book" text="A matching-engine or venue order-feed integration is required." />
        </Panel>
        <Panel title={t('orderPreview')} className="ml2-order-panel">
          <div className="ml2-trade-side">
            <button type="button" className={side === 'buy' ? 'buy' : ''} onClick={() => setSide('buy')}>BUY / LONG</button>
            <button type="button" className={side === 'sell' ? 'sell' : ''} onClick={() => setSide('sell')}>SELL / SHORT</button>
          </div>
          <div className="ml2-segments ml2-order-types">
            {(['market','limit','stop'] as const).map((kind) => <button key={kind} type="button" className={orderType === kind ? 'active' : ''} onClick={() => setOrderType(kind)}>{kind.toUpperCase()}</button>)}
          </div>
          <div className="ml2-form-stack">
            {orderType !== 'market' && <FormField label={orderType === 'stop' ? 'Stop trigger (USD)' : 'Limit price (USD)'}>
              <input type="number" min="0" step="any" value={orderType === 'stop' ? stopPrice : limitPrice}
                onChange={(e) => orderType === 'stop' ? setStopPrice(e.target.value) : setLimitPrice(e.target.value)}/>
            </FormField>}
            <FormField label={'Amount (' + pair + ')'}><input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)}/></FormField>
            {marketMode === 'futures' && <FormField label={'Leverage · ' + leverage + 'x'}>
              <input type="range" min="1" max="20" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))}/>
            </FormField>}
            <div className="ml2-estimate-list">
              <div><span>Reference notional</span><strong dir="ltr">{notional == null ? '—' : usd(notional)}</strong></div>
              <div><span>Account margin</span><strong>—</strong></div>
              <div><span>Execution status</span><strong>{t('executionLocked')}</strong></div>
            </div>
            <button type="button" className="ml2-primary-button ml2-full-width" disabled={finite(amount) === 0 || !Number.isFinite(notional ?? NaN)}
              onClick={() => setOpen(true)}>Preview {side === 'buy' ? 'buy' : 'sell'} {marketMode} order</button>
            <p className="ml2-muted-small">Demo calculation only. No exchange API, leverage account, order book or margin engine is connected.</p>
          </div>
        </Panel>
      </div>
    </div>
    <Modal title="Order preview · no live execution" open={open} onClose={() => setOpen(false)}>
      <div className="ml2-modal-body"><Notice tone="warn">No order will be submitted. This preview cannot reserve margin or fill positions.</Notice>
        <div className="ml2-estimate-list">
          <div><span>Market</span><strong>{pair}/USDC · {marketMode}</strong></div>
          <div><span>Side / type</span><strong>{side.toUpperCase()} · {orderType.toUpperCase()}</strong></div>
          <div><span>Reference notional</span><strong>{notional == null ? '—' : usd(notional)}</strong></div>
        </div><button type="button" className="ml2-primary-button ml2-full-width" onClick={() => setOpen(false)}>Close preview</button>
      </div>
    </Modal>
  </>;
}

interface SolanaWalletSnapshot {
  chain: string;
  address: string;
  sol: number;
  slot: number;
  checkedAt: number;
  signatures: Array<{
    signature: string; slot: number; err: unknown;
    blockTime: number | null; confirmationStatus: string | null;
  }>;
}

export function PortfolioScreen() {
  const { t, lang } = useML();
  const { state } = useWalletConnection();
  const [snapshot, setSnapshot] = useState<SolanaWalletSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = state.account?.address;
  useEffect(() => {
    if (!address) { setSnapshot(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const get = async () => {
      try {
        const res = await fetch(PUBLIC_API_BASE + '/public/wallet/' + encodeURIComponent(address), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
        });
        if (!res.ok) throw new Error('Solana balance service unavailable');
        const data = await res.json() as SolanaWalletSnapshot;
        if (data.address !== address || !Number.isFinite(data.sol)) throw new Error('Unverified wallet response');
        if (!controller.signal.aborted) { setSnapshot(data); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setError(cause instanceof Error ? cause.message : 'Cannot load wallet');
        }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void get();
    return () => controller.abort();
  }, [address]);
  return <>
    <ToolHeading eyebrow="ACCOUNT / PORTFOLIO" title={t('portfolio')}
      description={lang === 'fa' ? 'نمای موجودی SOL و فعالیت عمومی کیف پول متصل؛ بدون نمایش ارزش کل یا سود ساختگی.' : 'Read-only Solana wallet overview with verified address access. A complete multi-asset valuation and PnL require more account data.'}
      badge={<ModeTag mode={address ? 'connected' : 'preview'}/>}
      action={<LinkedTool to="/wallet" label={t('connectAction')}/>}/>
    <div className="ml2-stat-grid">
      <Stat label="SOL BALANCE" value={snapshot ? snapshot.sol.toLocaleString('en-US', { maximumFractionDigits: 7 }) + ' SOL' : '—'} note={address ? 'Public Solana RPC balance' : 'Wallet not connected'} />
      <Stat label="PORTFOLIO USD VALUE" value="—" note="Multi-asset valuation unavailable"/>
      <Stat label="REALIZED PNL" value="—" note="Not inferred from wallet balance"/>
      <Stat label="TOTAL CONNECTED WALLETS" value={address ? 1 : 0} note="Public address approval"/>
    </div>
    {!address && <Notice tone="info">{t('walletNeeded')} <Link to="/wallet" className="ml2-text-link">{t('connect')} ↗</Link></Notice>}
    {error && <Notice tone="warn">{error}</Notice>}
    <div className="ml2-dashboard-columns ml2-portfolio-grid">
      <Panel title={lang === 'fa' ? 'ترکیب دارایی' : 'Asset allocation'}>
        <div className="ml2-donut-layout">
          <div className={snapshot ? 'ml2-donut ml2-donut-connected' : 'ml2-donut'}><span>{snapshot ? 'SOL' : '—'}<small>{snapshot ? 'SOL-ONLY VIEW' : 'NO DATA'}</small></span></div>
          <div className="ml2-donut-legend"><div><span className="ml2-dot-cyan"/>Solana (SOL)<b>{snapshot ? snapshot.sol.toFixed(5) : '—'}</b></div>
            <p>{lang === 'fa' ? 'نمودار تنها موجودی SOL دریافت‌شده را نمایش می‌دهد، نه تمام دارایی‌های کیف پول.' : 'This visualization includes only the returned SOL balance, not a verified allocation of all tokens.'}</p></div>
        </div>
      </Panel>
      <Panel title={lang === 'fa' ? 'کیف پول متصل' : 'Connected wallet'} action={<Pill color={address ? 'green' : 'muted'}>{address ? 'CONNECTED' : 'DISCONNECTED'}</Pill>}>
        {loading ? <div className="ml2-panel-pad"><Skeleton lines={4}/></div> : <div className="ml2-wallet-profile">
          <span className="ml2-wallet-emblem"><Glyph name="wallet" size={30}/></span>
          <span>{address ? address.slice(0, 7) + '…' + address.slice(-7) : 'No wallet selected'}</span>
          <small>{snapshot ? 'Slot ' + snapshot.slot + ' · ' + new Date(snapshot.checkedAt).toLocaleString() : 'Solana Mainnet'}</small>
          <Link to="/wallet" className="ml2-outline-button ml2-full-width">{t('connectAction')} <Glyph name="arrow" size={16}/></Link>
          <Link to="/dashboard" className="ml2-text-link">{t('dashboard')} ↗</Link>
        </div>}
      </Panel>
    </div>
    <Panel title={lang === 'fa' ? 'تراکنش‌های اخیر شبکه' : 'Recent on-chain signatures'} action={<Pill color="muted">PUBLIC RPC</Pill>}>
      {snapshot?.signatures?.length ? <div className="ml2-table-wrap"><table className="ml2-table">
        <thead><tr><th>TX SIGNATURE</th><th>SLOT</th><th>STATUS</th><th>LINK</th></tr></thead>
        <tbody>{snapshot.signatures.slice(0, 8).map((tx) => <tr key={tx.signature}>
          <td className="ml2-mono">{tx.signature.slice(0, 8)}…{tx.signature.slice(-8)}</td>
          <td className="ml2-mono">{tx.slot}</td><td><Pill color={tx.err ? 'red' : 'green'}>{tx.err ? 'Failed' : tx.confirmationStatus || 'Observed'}</Pill></td>
          <td><a href={'https://solscan.io/tx/' + encodeURIComponent(tx.signature)} target="_blank" rel="noreferrer">View ↗</a></td>
        </tr>)}</tbody></table></div>
        : <EmptyState title="No verified transactions to show" text={address ? 'No confirmed signatures were returned by the public endpoint.' : 'Connect a wallet to load its public on-chain activity.'}/>}
    </Panel>
    <Notice title={t('security')} tone="safe">This page never requests private keys, and balances are public-chain observations. It cannot prove complete portfolio value or profit history.</Notice>
  </>;
}
