import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, useExperience } from './ui.js';
import {
  classifyCopyReadiness, type CopyReadiness,
  type PublicCopyReadiness, type PublicNetworkReadiness,
} from './realReadiness.js';
import './live-execution.css';

type State = {
  network: PublicNetworkReadiness | null;
  copy: PublicCopyReadiness | null;
  error: string | null;
  loaded: boolean;
};

const initial: State = { network: null, copy: null, error: null, loaded: false };

export function LiveExecutionHub() {
  const { t, lang } = useExperience();
  const [state, setState] = useState<State>(initial);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((x) => x + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const fetchJson = async <T,>(path: string): Promise<T> => {
        const timeout = AbortSignal.timeout(9_000);
        const response = await fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, timeout]),
        });
        if (!response.ok) throw new Error('Service currently unavailable');
        return response.json() as Promise<T>;
      };
      try {
        const [network, copy] = await Promise.all([
          fetchJson<PublicNetworkReadiness>('/api/public/network/status'),
          fetchJson<PublicCopyReadiness>('/api/public/copy-trading'),
        ]);
        if (!controller.signal.aborted) setState({ network, copy, error: null, loaded: true });
      } catch {
        if (!controller.signal.aborted) {
          setState({
            ...initial,
            loaded: true,
            error: t(
              'Live backend could not be verified. No demo values were substituted.',
              'وضعیت موتور واقعی تأیید نشد؛ داده نمایشی جایگزین نشده است.',
            ),
          });
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 20_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [reload, lang, t]);

  const status: CopyReadiness = classifyCopyReadiness(state.network, state.copy);
  const descriptions: Record<CopyReadiness, [string, string]> = {
    'unavailable': ['Not verified', 'تأیید نشده'],
    'network-degraded': ['RPC / worker unavailable', 'اختلال RPC یا پردازشگر'],
    'watcher-stopped': ['Watcher stopped', 'اسکنر کپی متوقف'],
    'watcher-degraded': ['Watcher degraded', 'اختلال در اسکنر کپی'],
    'paper': ['PAPER: no live spending', 'آزمایشی: بدون خرج واقعی'],
    'scanner-degraded': ['Scanner readiness not confirmed', 'سلامت اسکنر تأیید نشده'],
    'buy-paused': ['New copy buys are paused', 'خریدهای جدید کپی‌ترید متوقف‌اند'],
    'readiness-unavailable': ['Buy readiness not verified', 'آمادگی خرید تأیید نشده'],
    'live-backend-ready': ['LIVE backend: user enrollment required', 'موتور LIVE: نیازمند فعال‌سازی حساب کاربر'],
  };

  const items = [
    {
      key: 'copy', title: t('Copy Trading', 'کپی‌ترید واقعی'),
      to: '/copy-trading',
      note: t('Review tracked wallets, configure capped copies, pause/resume. Requires an active trading account.', 'انتخاب کیف‌پول مرجع، تنظیم سقف خرید و توقف/ادامه. به حساب معاملاتی فعال نیاز دارد.'),
    },
    {
      key: 'bots', title: t('Sniper & automated strategies', 'اسنایپر و ربات‌های معاملاتی'),
      to: '/dashboard/snipes',
      note: t('Existing account-controlled snipe configurations and risk limits; live only when your backend allows it.', 'تنظیمات ربات و محدودیت ریسک حساب؛ اجرای واقعی فقط با مجوز موتور سرور.'),
    },
    {
      key: 'positions', title: t('Positions & trade history', 'پوزیشن‌ها و سابقه معاملات'),
      to: '/executions',
      note: t('Your authenticated confirmed transactions and separately labeled PAPER records.', 'تراکنش‌های تأییدشده حساب و سوابق آزمایشی به‌صورت مجزا.'),
    },
    {
      key: 'arbitrage', title: t('Real quotes & arbitrage research', 'قیمت واقعی و تحلیل آربیتراژ'),
      to: '/arbitrage',
      note: t('Observed quotes only. This page does not submit swaps or guarantee a net profit.', 'صرفاً قیمت و اختلاف بازار؛ در این صفحه تراکنش اجرا نمی‌شود و سود تضمینی نیست.'),
    },
  ] as const;

  return (
    <div className="n-live-hub">
      <header className="n-live-hub-header">
        <span className="n-live-hub-eyebrow">NOVA · SOLANA MAINNET</span>
        <h1>{t('Real trading services, honest execution status.', 'امکانات معاملاتی واقعی، با وضعیت اجرایی شفاف.')}</h1>
        <p>{t(
          'Open existing connected account tools. Prices and analysis are not permission to spend funds. Copy trading is authorized per account and per target.',
          'به ابزارهای متصل حساب وارد شوید. مشاهده قیمت مجوز خرج‌کردن دارایی نیست. کپی‌ترید باید برای هر حساب و کیف‌پول مرجع جداگانه فعال شود.',
        )}</p>
      </header>
      <section className="n-live-hub-status" aria-live="polite" aria-label={t('Execution readiness', 'وضعیت آماده‌بودن اجرا')}>
        <div>
          <span>{t('Copy trading server', 'سرور کپی‌ترید')}</span>
          <strong>{!state.loaded ? t('Checking…', 'در حال بررسی…') : t(...descriptions[status])}</strong>
          <small>{t(
            'Even a healthy LIVE backend does not confirm your wallet funding or any completed trade.',
            'حتی وضعیت LIVE سالم هم موجودی کیف پول شما یا انجام معامله را تأیید نمی‌کند.',
          )}</small>
        </div>
        <button type="button" onClick={refresh} className="n-live-hub-refresh">
          <Icon name="refresh" size={16}/>{t('Recheck', 'بررسی مجدد')}
        </button>
      </section>
      {state.error && <p className="n-live-hub-error" role="alert">{state.error}</p>}
      {state.copy?.limits && <div className="n-live-hub-limits">
        <span>{t('Server copy limits', 'محدودیت‌های سرور')}</span>
        <strong>{state.copy.limits.maxBuySol} SOL {t('max/buy', 'حداکثر هر خرید')}</strong>
        <strong>{state.copy.limits.maxDailyBuys} {t('attempts/day', 'تلاش روزانه')}</strong>
        <strong>{state.copy.limits.maxOpenPositions} {t('open positions', 'پوزیشن باز')}</strong>
      </div>}
      <div className="n-live-hub-grid">
        {items.map(item => (
          <Link className="n-live-hub-card" key={item.key} to={item.to}>
            <strong>{item.title}<Icon name="arrow" size={17}/></strong>
            <p>{item.note}</p>
            <span>{t('Open connected tool', 'ورود به ابزار متصل')} <Icon name="arrow" size={14}/></span>
          </Link>
        ))}
      </div>
      <aside className="n-live-hub-note">
        <strong>{t('Not live yet', 'هنوز اجرای واقعی ندارد')}</strong>
        <p>{t(
          'Standalone website DEX signing, CEX spot/futures execution, flash-loan borrowing and atomic arbitrage execution require separate audited integrations. They are not enabled by this page.',
          'امضای سواپ مستقیم DEX روی سایت، معامله صرافی متمرکز/فیوچرز، وام آنی و اجرای اتمیک آربیتراژ هنوز به اتصال و بررسی امنیتی مستقل نیاز دارند. این صفحه آن‌ها را فعال نمی‌کند.',
        )}</p>
      </aside>
    </div>
  );
}
