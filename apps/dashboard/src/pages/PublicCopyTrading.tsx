import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';
import { WalletButton } from '../components/WalletUI.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.js';
import { useLanguage } from '../lib/LanguageContext.js';
import { useWalletConnection } from '../lib/WalletContext.js';
import { useMainnet } from '../lib/MainnetContext.js';
import { useCopyTraders } from '../lib/useCopyTraders.js';
import {
  pnlTone,
  signedValue,
  traderDataLive,
  validTarget,
  type TraderPeriod,
} from '../lib/copyTraders.js';
import { liveCopyBuysReady, type PublicCopyReadiness } from '../neon/realReadiness.js';
import type { Wallet } from '../lib/types.js';
import './CopyTrading.css';

interface CopyConfig {
  id: string;
  targetAddress: string;
  isActive: boolean;
  copyPercentSize: number;
  maxAmountSol: number | null;
}
interface LocalWallet {
  address: string;
  label: string | null;
  signalScore: number;
  recommendation: {
    eligible: boolean;
    closedTrades: number;
    realizedPnlSol: number;
    winRatePct: number;
    reasons: string[];
    warnings: string[];
  };
}
interface Runtime extends PublicCopyReadiness {
  localWallets?: LocalWallet[];
  gmgn?: {
    status: string;
    trades: Array<{
      transactionHash: string;
      maker: string;
      side: string;
      tokenAddress: string;
      tokenSymbol: string;
      amountUsd?: number;
      timestamp?: number;
    }>;
  };
}
interface AccountState {
  ownerId: string;
  configs: CopyConfig[];
  wallets: Wallet[];
  loading: boolean;
  failed: boolean;
}
const short = (address: string) => `${address.slice(0, 5)}…${address.slice(-5)}`;
const colors = ['#d8bc80', '#8ec4b0', '#b4a5d5', '#80b1d0', '#d2a88c'];
const toneColor = (address: string) =>
  colors[[...address].reduce((sum, c) => sum + c.charCodeAt(0), 0) % colors.length];
const money = (value?: number | null) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value);
const percent = (value?: number | null) =>
  value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;

export default function PublicCopyTrading() {
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const { state: walletState } = useWalletConnection();
  const { copy, refresh: refreshRuntime } = useMainnet();
  const runtime = copy as Runtime | null;
  const [period, setPeriod] = useState<TraderPeriod>('7d');
  const feed = useCopyTraders(period);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('profit');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const target = params.get('trader') ?? '';
  const [copyPercent, setCopyPercent] = useState('25');
  const [maxSol, setMaxSol] = useState('0.10');
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const [notice, setNotice] = useState<{ ownerId: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState<{ ownerId: string; address: string } | null>(null);
  const setup = useRef<HTMLElement>(null);
  const ownerId = user?.id ?? null;
  const current = account?.ownerId === ownerId ? account : null;
  const accountLoading = Boolean(user && (!current || current.loading));
  const activeWallet = current?.wallets.find((wallet) => wallet.isActive);
  const liveReady = liveCopyBuysReady(runtime);
  const feedLive = !feed.error && traderDataLive(feed.data, feed.now);
  const configs = current?.configs ?? [];
  const busyHere = busy?.ownerId === ownerId;
  const limit = runtime?.limits?.maxBuySol ?? 0.1;
  const amount = Number(maxSol);
  const size = Number(copyPercent);
  const reviewContext = JSON.stringify([
    ownerId,
    activeWallet?.id,
    target,
    size,
    amount,
    liveReady,
    limit,
    runtime?.limits?.maxDailyBuys,
    runtime?.limits?.maxOpenPositions,
    runtime?.limits?.slippageBps,
  ]);
  const confirmed = reviewed === reviewContext;
  const setConfirmed = (value: boolean) => setReviewed(value ? reviewContext : null);
  const validSize =
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= limit &&
    Number.isFinite(size) &&
    size > 0 &&
    size <= 100;
  const returnTo = location.pathname + location.search + '#copy-setup';
  const loginState = { returnTo };

  useEffect(() => {
    if (!ownerId) return;
    const controller = new AbortController();
    let active = true;
    setAccount({ ownerId, configs: [], wallets: [], loading: true, failed: false });
    void Promise.all([
      api.get<CopyConfig[]>('/copy-trades', { signal: controller.signal }),
      api.get<Wallet[]>('/wallets', { signal: controller.signal }),
    ])
      .then(([configs, wallets]) => {
        if (active) setAccount({ ownerId, configs, wallets, loading: false, failed: false });
      })
      .catch(() => {
        if (active) setAccount({ ownerId, configs: [], wallets: [], loading: false, failed: true });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [ownerId, accountRevision]);

  function choose(address: string, scroll = true) {
    const next = new URLSearchParams(params);
    if (address) next.set('trader', address);
    else next.delete('trader');
    setParams(next, { replace: true });
    setConfirmed(false);
    if (scroll)
      setup.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'start',
      });
  }
  function refresh() {
    feed.refresh();
    refreshRuntime();
  }
  function activity(stamp: number | null) {
    if (stamp === null || !Number.isFinite(stamp)) return '—';
    return new Date(stamp).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  async function saveCopy() {
    if (
      !ownerId ||
      !activeWallet ||
      !validTarget(target) ||
      !validSize ||
      !confirmed ||
      busyHere ||
      current?.failed
    )
      return;
    const address = target;
    setBusy({ ownerId, address });
    setNotice(null);
    try {
      const created = await api.post<CopyConfig>(
        liveReady ? '/copy-trades' : '/copy-trades/drafts',
        {
          targetAddress: address,
          copyPercentSize: size,
          maxAmountSol: amount,
        },
      );
      setAccount((value) =>
        value?.ownerId === ownerId ? { ...value, configs: [...value.configs, created] } : value,
      );
      setNotice({
        ownerId,
        text: created.isActive
          ? t('Copy configuration enabled within your limits.', 'تنظیم کپی با سقف انتخابی فعال شد.')
          : t(
              'Copy settings saved paused. Activate after the execution engine is ready.',
              'تنظیم کپی ذخیره شد و متوقف است؛ پس از آماده‌شدن موتور می‌توانی آن را فعال کنی.',
            ),
      });
      setConfirmed(false);
    } catch (error) {
      setNotice({
        ownerId,
        text:
          error instanceof ApiError
            ? t(error.message)
            : t(
                'Could not save copy settings. Try again.',
                'ذخیرهٔ تنظیم کپی انجام نشد؛ دوباره تلاش کن.',
              ),
      });
    } finally {
      setBusy((value) => (value?.ownerId === ownerId ? null : value));
    }
  }
  async function toggle(config: CopyConfig) {
    if (!ownerId || busyHere || (!config.isActive && (!liveReady || !activeWallet))) return;
    if (
      !config.isActive &&
      !window.confirm(
        t(
          'Enable real copy buys for this saved trader within the displayed limits?',
          'خرید واقعی کپی برای این تریدر با سقف ذخیره‌شده فعال شود؟',
        ),
      )
    )
      return;
    setBusy({ ownerId, address: config.targetAddress });
    setNotice(null);
    try {
      const updated = await api.put<CopyConfig>(`/copy-trades/${config.id}/status`, {
        enabled: !config.isActive,
      });
      setAccount((value) =>
        value?.ownerId === ownerId
          ? { ...value, configs: value.configs.map((c) => (c.id === updated.id ? updated : c)) }
          : value,
      );
      setNotice({
        ownerId,
        text: updated.isActive
          ? t('Copy enabled.', 'کپی فعال شد.')
          : t('New copy buys paused.', 'خریدهای جدید کپی متوقف شدند.'),
      });
    } catch (error) {
      setNotice({
        ownerId,
        text:
          error instanceof ApiError
            ? t(error.message)
            : t('Could not update copy settings.', 'به‌روزرسانی تنظیم کپی انجام نشد.'),
      });
    } finally {
      setBusy((value) => (value?.ownerId === ownerId ? null : value));
    }
  }
  const needle = search.trim().toLowerCase();
  const traders = [...(feed.data?.traders ?? [])].filter(
    (trader) =>
      !needle ||
      `${trader.address} ${trader.name ?? ''} ${trader.tags.join(' ')}`
        .toLowerCase()
        .includes(needle),
  );
  const metric = (trader: (typeof traders)[number]) =>
    sort === 'wins'
      ? trader.performance?.winRatePct
      : sort === 'activity'
        ? trader.lastActivityAt
        : trader.performance?.realizedPnlUsd;
  traders.sort(
    (a, b) =>
      Number(metric(b) != null) - Number(metric(a) != null) || (metric(b) ?? 0) - (metric(a) ?? 0),
  );
  const selectedConfig = configs.find((config) => config.targetAddress === target);
  const localWallets = (runtime?.localWallets ?? [])
    .filter((wallet) => wallet.recommendation?.closedTrades > 0)
    .sort((a, b) => b.recommendation.realizedPnlSol - a.recommendation.realizedPnlSol)
    .slice(0, 12);
  const profits =
    feed.data?.traders.filter((trader) => (trader.performance?.realizedPnlUsd ?? 0) > 0).length ??
    0;

  return (
    <div className="site-container interior-page copy-trading-page ct-page">
      <PageHeading
        eyebrow="COPY TRADING / SOLANA"
        title={t('Follow the edge.', 'همراهِ معامله‌گرهای برتر.')}
        text={t(
          'Explore active Smart Money wallets, compare realized performance and build a copy strategy with your own limits.',
          'کیف پول‌های فعال اسمارت‌مانی را ببین، سود محقق‌شده را مقایسه کن و کپی را با سقف انتخابی خودت تنظیم کن.',
        )}
      >
        <span
          className={`ct-feed-badge ${feedLive ? 'is-live' : ''}`}
          role="status"
          data-testid="copy-feed-state"
        >
          <i />
          {feedLive ? 'LIVE DATA' : t('DATA PENDING', 'در انتظار داده')}
        </span>
      </PageHeading>
      <div className="ct-overview">
        <div>
          <span>{t('ACTIVE WATCHLIST', 'فهرست فعال')}</span>
          <strong>{feed.data?.traders.length ?? '—'}</strong>
          <small>GMGN · SOLANA</small>
        </div>
        <div>
          <span>{t('PROFITABLE IN SAMPLE', 'سودده در این فهرست')}</span>
          <strong className="is-profit">{feed.data?.performanceUpdatedAt ? profits : '—'}</strong>
          <small>
            {period === '7d'
              ? t('7-day realized PnL', 'سود محقق‌شدهٔ ۷روزه')
              : t('30-day realized PnL', 'سود محقق‌شدهٔ ۳۰روزه')}
          </small>
        </div>
        <div>
          <span>{t('COPY EXECUTION', 'اجرای کپی')}</span>
          <strong
            className={liveReady ? 'is-profit' : 'ct-waiting'}
            data-testid="copy-engine-state"
          >
            {liveReady ? t('READY', 'آماده') : t('PAUSED', 'متوقف')}
          </strong>
          <small>
            {runtime?.executionMode === 'paper'
              ? 'PAPER'
              : t('Account limits apply', 'با سقف‌های حساب')}
          </small>
        </div>
        <div>
          <span>{t('PER-BUY CEILING', 'سقف هر خرید')}</span>
          <strong dir="ltr">
            {limit} <em>SOL</em>
          </strong>
          <small>{t('Your cap can be lower', 'سقف شخصی می‌تواند کمتر باشد')}</small>
        </div>
      </div>
      <div className="ct-status-note">
        <Icon name="activity" size={18} />
        <p>
          {feedLive
            ? t(
                'Live analytics are connected. Copy execution has its own readiness checks.',
                'دادهٔ زنده متصل است. اجرای کپی، وضعیت آمادگی جداگانه دارد.',
              )
            : t(
                'Waiting for fresh trader analytics. Last available figures keep their original observation time.',
                'در انتظار اطلاعات تازهٔ تریدرها؛ اعداد قبلی با زمان مشاهدهٔ خودشان نمایش داده می‌شوند.',
              )}
        </p>
        <button type="button" onClick={refresh} disabled={feed.loading}>
          <Icon name="refresh" size={15} />
          {t('Refresh', 'تازه‌سازی')}
        </button>
      </div>
      <section className="ct-discovery" aria-labelledby="trader-title">
        <div className="ct-section-heading">
          <div>
            <span className="ct-eyebrow">SMART MONEY / PERFORMANCE</span>
            <h2 id="trader-title">{t('Top active traders', 'برترین تریدرهای فعال')}</h2>
            <p>
              {t(
                'Ranked within the active GMGN sample by realized USD profit; not a market-wide ranking or a copy recommendation.',
                'رتبه‌بندی سود دلاری در نمونهٔ فعال GMGN؛ این فهرست رتبه‌بندی کل بازار یا توصیهٔ خودکار کپی نیست.',
              )}
            </p>
          </div>
          <div
            className="ct-period"
            role="group"
            aria-label={t('Performance period', 'بازهٔ عملکرد')}
          >
            {(['7d', '30d'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {value.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="ct-toolbar">
          <label className="ct-search">
            <Icon name="search" size={17} />
            <input
              aria-label={t('Search traders', 'جستجوی تریدر')}
              placeholder={t('Name, wallet or tag…', 'نام، آدرس یا برچسب…')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="ct-sort">
            <span>{t('Sort by', 'مرتب‌سازی')}</span>
            <select
              aria-label={t('Sort traders', 'مرتب‌سازی تریدرها')}
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="profit">{t('Realized profit', 'سود محقق‌شده')}</option>
              <option value="wins">{t('Win rate', 'نرخ برد')}</option>
              <option value="activity">{t('Latest activity', 'آخرین فعالیت')}</option>
            </select>
          </label>
        </div>
        <div className="ct-data-note" aria-live="polite">
          {feed.loading
            ? t('Updating trader data…', 'در حال به‌روزرسانی تریدرها…')
            : feed.error || feed.data?.status === 'unavailable'
              ? t(
                  'Data source temporarily unavailable. Retry to refresh.',
                  'منبع داده موقتاً در دسترس نیست؛ تازه‌سازی را بزن.',
                )
              : feed.data?.status === 'partial'
                ? t(
                    'Some wallets have no reported performance. Missing values remain blank.',
                    'اطلاعات عملکرد برخی کیف پول‌ها گزارش نشده و با — نمایش داده می‌شود.',
                  )
                : t('Observed', 'زمان مشاهده')}{' '}
          {feed.data?.performanceUpdatedAt ? activity(feed.data.performanceUpdatedAt) : ''}
        </div>
        <div className="ct-trader-grid">
          {traders.map((trader, index) => {
            const p = trader.performance;
            const saved = configs.find((config) => config.targetAddress === trader.address);
            return (
              <article
                className={`ct-trader-card ${target === trader.address ? 'is-selected' : ''}`}
                key={trader.address}
                style={{ '--trader-color': toneColor(trader.address) } as CSSProperties}
                data-testid="trader-card"
              >
                <div className="ct-trader-top">
                  <span className="ct-avatar" aria-hidden="true">
                    {trader.name
                      ? trader.name.slice(0, 2).toUpperCase()
                      : trader.address.slice(0, 2)}
                  </span>
                  <div>
                    <h3>{trader.name || short(trader.address)}</h3>
                    <a
                      href={`https://gmgn.ai/sol/address/${trader.address}`}
                      target="_blank"
                      rel="noreferrer"
                      dir="ltr"
                    >
                      {short(trader.address)} ↗
                    </a>
                  </div>
                  <span className="ct-rank">#{index + 1}</span>
                </div>
                <div className="ct-tags">
                  {trader.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag.replaceAll('_', ' ')}</span>
                  ))}
                </div>
                <div className="ct-profit">
                  <span>
                    {t('Realized PnL', 'سود و زیان محقق‌شده')} · {period.toUpperCase()}
                  </span>
                  <strong dir="ltr" className={pnlTone(p?.realizedPnlUsd)} data-testid="trader-pnl">
                    {signedValue(p?.realizedPnlUsd, 'USD')}
                  </strong>
                  <small className={pnlTone(p?.roiPct)} dir="ltr">
                    {signedValue(p?.roiPct, 'percent')} <span>ROI</span>
                  </small>
                </div>
                <div className="ct-trader-metrics">
                  <div>
                    <span>{t('Win rate', 'نرخ برد')}</span>
                    <strong>{percent(p?.winRatePct)}</strong>
                  </div>
                  <div>
                    <span>{t('Buys / sells', 'خرید / فروش')}</span>
                    <strong dir="ltr">
                      {p?.buys ?? '—'} / {p?.sells ?? '—'}
                    </strong>
                  </div>
                </div>
                <div className="ct-win-track" aria-hidden="true">
                  <i style={{ width: `${p?.winRatePct ?? 0}%` }} />
                </div>
                <div className="ct-last-activity">
                  <span>{t('Last activity', 'آخرین فعالیت')}</span>
                  <time>{activity(trader.lastActivityAt)}</time>
                </div>
                <button className="ct-select" type="button" onClick={() => choose(trader.address)}>
                  {saved ? t('Manage copy', 'مدیریت کپی') : t('Set up copy', 'تنظیم کپی')}
                  <Icon name="chevron" size={16} />
                </button>
              </article>
            );
          })}
        </div>
        {!traders.length && (
          <div className="ct-empty">
            <Icon name="scan" size={30} />
            <h3>
              {feed.loading
                ? t('Loading active traders', 'در حال دریافت تریدرهای فعال')
                : search
                  ? t('No matching trader', 'تریدر مطابق پیدا نشد')
                  : t(
                      'Trader performance is not available yet',
                      'عملکرد تریدرها هنوز در دسترس نیست',
                    )}
            </h3>
            <p>
              {t(
                'You can review a wallet directly in the copy setup below.',
                'می‌توانی آدرس کیف پول را مستقیماً در تنظیم کپی وارد کنی.',
              )}
            </p>
          </div>
        )}
      </section>
      <section className="ct-setup" id="copy-setup" ref={setup} aria-labelledby="copy-setup-title">
        <div className="ct-section-heading">
          <div>
            <span className="ct-eyebrow">YOUR WALLET. YOUR LIMITS.</span>
            <h2 id="copy-setup-title">
              {t('Connect. Review. Copy.', 'متصل شو. بررسی کن. کپی کن.')}
            </h2>
          </div>
          <span className={`ct-engine-pill ${liveReady ? 'is-live' : ''}`}>
            {liveReady
              ? t('Execution ready', 'اجرای کپی آماده است')
              : t('Execution paused', 'اجرای کپی متوقف است')}
          </span>
        </div>
        <div className="ct-connection-steps">
          <div>
            <span className="ct-step-no">01</span>
            <div>
              <strong>{t('Browser wallet', 'کیف پول مرورگر')}</strong>
              <p>
                {walletState.account
                  ? short(walletState.account.address)
                  : t(
                      'Connect or manage your external wallet.',
                      'کیف پول بیرونی را متصل یا مدیریت کن.',
                    )}
              </p>
            </div>
            <WalletButton />
          </div>
          <div>
            <span className="ct-step-no">02</span>
            <div>
              <strong>{t('Your trading account', 'حساب معاملات تو')}</strong>
              <p>
                {user
                  ? user.email
                  : t('Sign in to save your copy settings.', 'برای ذخیرهٔ تنظیم کپی وارد حساب شو.')}
              </p>
            </div>
            {!user && (
              <Link className="ct-small-button" to="/login" state={loginState}>
                {t('Sign in and continue', 'ورود و ادامه')}
              </Link>
            )}
          </div>
          <div>
            <span className="ct-step-no">03</span>
            <div>
              <strong>{t('Account trading wallet', 'کیف پول معاملات حساب')}</strong>
              <p>
                {accountLoading
                  ? t('Checking account…', 'در حال بررسی حساب…')
                  : activeWallet
                    ? short(activeWallet.publicKey)
                    : t(
                        'Automatic copy uses the trading wallet in your account.',
                        'کپی خودکار از کیف پول معاملات داخل حساب استفاده می‌کند.',
                      )}
              </p>
            </div>
            {user && (
              <Link className="ct-small-button" to="/dashboard/wallets" state={{ returnTo }}>
                {t('Manage wallets', 'مدیریت کیف پول‌ها')}
              </Link>
            )}
          </div>
        </div>
        <p className="ct-setup-explanation">
          {t(
            'Connecting a browser wallet shares its address. Automatic copying requires your signed-in account and an active account trading wallet.',
            'اتصال کیف پول مرورگر، آدرس آن را در سایت نمایش می‌دهد. کپی خودکار به حساب واردشده و کیف پول فعال معاملات آن نیاز دارد.',
          )}
        </p>
        {!liveReady && (
          <div className="ct-paused-notice">
            <Icon name="pause" size={19} />
            <div>
              <strong>{t('Copy execution is paused', 'اجرای کپی فعلاً متوقف است')}</strong>
              <p>
                {t(
                  'The server needs a healthy mainnet RPC and copy worker. You can save a paused setup now, then enable it when ready.',
                  'سرور به RPC سالم شبکهٔ اصلی و موتور کپی آماده نیاز دارد. اکنون می‌توانی تنظیم را متوقف ذخیره کنی و پس از آماده‌شدن، فعالش کنی.',
                )}
              </p>
              <Link to="/network">{t('Check network status ↗', 'بررسی وضعیت شبکه ↗')}</Link>
            </div>
          </div>
        )}
        {current?.failed && (
          <div className="ct-feedback" role="alert">
            {t('Your account could not be loaded.', 'اطلاعات حساب دریافت نشد.')}{' '}
            <button type="button" onClick={() => setAccountRevision((n) => n + 1)}>
              {t('Retry account', 'بررسی دوبارهٔ حساب')}
            </button>
          </div>
        )}
        <form
          className="ct-copy-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCopy();
          }}
        >
          <label className="ct-target">
            <span>{t('Trader wallet address', 'آدرس کیف پول تریدر')}</span>
            <input
              dir="ltr"
              aria-label={t('Trader wallet address', 'آدرس کیف پول تریدر')}
              value={target}
              maxLength={44}
              placeholder="Solana address"
              onChange={(event) => choose(event.target.value.trim(), false)}
              required
            />
            {target && !validTarget(target) && (
              <small>{t('Enter a valid Solana address.', 'آدرس معتبر سولانا وارد کن.')}</small>
            )}
          </label>
          <label>
            <span>{t('Copy size (%)', 'اندازهٔ کپی (%)')}</span>
            <input
              aria-label={t('Copy size (%)', 'اندازهٔ کپی (%)')}
              dir="ltr"
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={copyPercent}
              onChange={(event) => {
                setCopyPercent(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <span>{t('Maximum per buy (SOL)', 'سقف هر خرید (SOL)')}</span>
            <input
              aria-label={t('Maximum per buy (SOL)', 'سقف هر خرید (SOL)')}
              dir="ltr"
              type="number"
              min="0.000001"
              max={limit}
              step="0.000001"
              value={maxSol}
              onChange={(event) => {
                setMaxSol(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <p className="ct-server-limits">
            {t('Server limits', 'سقف‌های سرور')}: {limit} SOL ·{' '}
            {runtime?.limits?.maxDailyBuys ?? '—'} {t('daily buy attempts', 'تلاش خرید روزانه')} ·{' '}
            {runtime?.limits?.maxOpenPositions ?? '—'} {t('open positions', 'پوزیشن باز')} ·{' '}
            {(runtime?.limits?.slippageBps ?? 0) / 100}% {t('slippage', 'لغزش')}
          </p>
          <button
            className="ct-consent"
            type="button"
            role="checkbox"
            aria-checked={confirmed}
            onClick={() => setConfirmed(!confirmed)}
          >
            <span className="ct-consent-box" aria-hidden="true">
              {confirmed ? <Icon name="check" size={16} /> : null}
            </span>
            <span>
              {liveReady
                ? t(
                    'I reviewed this trader and authorize copy buys within these limits.',
                    'این تریدر را بررسی کرده‌ام و خرید کپی را با این سقف‌ها تأیید می‌کنم.',
                  )
                : t(
                    'I reviewed this trader and want to save these settings paused.',
                    'این تریدر را بررسی کرده‌ام و تنظیمات را در حالت متوقف ذخیره می‌کنم.',
                  )}
            </span>
          </button>
          {selectedConfig ? (
            <p className="ct-feedback">
              {t(
                'This trader is already saved. Manage it below.',
                'این تریدر قبلاً ذخیره شده؛ از بخش زیر مدیریتش کن.',
              )}
            </p>
          ) : user ? (
            <button
              className="ct-submit"
              type="submit"
              disabled={
                busyHere ||
                accountLoading ||
                current?.failed ||
                !activeWallet ||
                !validSize ||
                !validTarget(target) ||
                !confirmed
              }
            >
              {busyHere
                ? t('Saving…', 'در حال ذخیره…')
                : liveReady
                  ? t('Enable copy within limits', 'فعال‌سازی کپی با این سقف‌ها')
                  : t('Save paused copy settings', 'ذخیرهٔ تنظیم کپی متوقف')}
            </button>
          ) : (
            <Link className="ct-submit" to="/login" state={loginState}>
              {t('Sign in and continue', 'ورود و ادامه')}
            </Link>
          )}
        </form>
        {notice?.ownerId === ownerId && (
          <p className="ct-feedback" role="status">
            {notice.text}
          </p>
        )}
        {user && (
          <div className="ct-saved">
            <h3>{t('Your saved traders', 'تریدرهای ذخیره‌شدهٔ تو')}</h3>
            {configs.map((config) => (
              <div key={config.id}>
                <span>
                  <strong dir="ltr">{short(config.targetAddress)}</strong>
                  <small>
                    {config.copyPercentSize}% · {config.maxAmountSol ?? limit} SOL ·{' '}
                    {config.isActive ? t('Enabled', 'فعال') : t('Paused', 'متوقف')}
                  </small>
                </span>
                <button
                  type="button"
                  className="ct-small-button"
                  disabled={
                    busyHere ||
                    (!config.isActive && (!liveReady || !activeWallet || accountLoading))
                  }
                  onClick={() => void toggle(config)}
                >
                  {config.isActive ? t('Pause', 'توقف') : t('Enable', 'فعال‌سازی')}
                </button>
              </div>
            ))}
            {!configs.length && !accountLoading && (
              <p>
                {t(
                  'Your selected traders will appear here after saving.',
                  'پس از ذخیره، تریدرهای انتخاب‌شده در این قسمت نمایش داده می‌شوند.',
                )}
              </p>
            )}
          </div>
        )}
      </section>
      {localWallets.length > 0 && (
        <section className="ct-local">
          <div className="ct-section-heading">
            <div>
              <span className="ct-eyebrow">GSP / RECORDED ON-CHAIN SAMPLE</span>
              <h2>{t('Tracked wallet results', 'نتایج کیف پول‌های رصدشده')}</h2>
              <p>
                {t(
                  '30-day recorded SOL sample. This is separate from GMGN wallet-wide USD performance.',
                  'نمونهٔ ثبت‌شدهٔ ۳۰روزه به SOL؛ این اعداد از عملکرد دلاری کل کیف پول در GMGN جدا هستند.',
                )}
              </p>
            </div>
          </div>
          <div className="ct-local-grid">
            {localWallets.map((wallet) => (
              <article key={wallet.address}>
                <strong>{wallet.label || short(wallet.address)}</strong>
                <span className={pnlTone(wallet.recommendation.realizedPnlSol)} dir="ltr">
                  {signedValue(wallet.recommendation.realizedPnlSol, 'SOL')}
                </span>
                <small>
                  {wallet.recommendation.closedTrades} {t('verified closes', 'خروج تأییدشده')} ·{' '}
                  {percent(wallet.recommendation.winRatePct)}
                </small>
                <button type="button" onClick={() => choose(wallet.address)}>
                  {t('Review wallet', 'بررسی کیف پول')} ↗
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {!!runtime?.gmgn?.trades.length && (
        <section className="ct-activity">
          <div className="ct-section-heading">
            <div>
              <span className="ct-eyebrow">SMART MONEY / ACTIVITY</span>
              <h2>{t('Recent trader activity', 'آخرین فعالیت تریدرها')}</h2>
            </div>
          </div>
          <div className="ct-activity-list">
            {runtime.gmgn.trades.slice(0, 12).map((trade, index) => (
              <div key={`${trade.transactionHash}-${trade.tokenAddress}-${index}`}>
                <span
                  className={`ct-side ${trade.side === 'buy' ? 'is-profit' : trade.side === 'sell' ? 'is-loss' : ''}`}
                >
                  {trade.side === 'buy'
                    ? t('BUY', 'خرید')
                    : trade.side === 'sell'
                      ? t('SELL', 'فروش')
                      : '—'}
                </span>
                <span>
                  <strong>{trade.tokenSymbol}</strong>
                  <small dir="ltr">{short(trade.maker)}</small>
                </span>
                <strong dir="ltr">{money(trade.amountUsd)}</strong>
                <time>{activity(trade.timestamp ? trade.timestamp * 1000 : null)}</time>
                {trade.transactionHash && (
                  <a
                    href={`https://solscan.io/tx/${encodeURIComponent(trade.transactionHash)}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t('View transaction', 'مشاهدهٔ تراکنش')}
                  >
                    <Icon name="external" size={16} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="ct-risk-note">
        <Icon name="shield" size={17} />
        {t(
          'Historical profit is not a forecast. Review wallet activity and risk before enabling copying.',
          'سود گذشته پیش‌بینی آینده نیست؛ پیش از فعال‌سازی کپی، فعالیت و ریسک کیف پول را بررسی کن.',
        )}
      </p>
    </div>
  );
}
