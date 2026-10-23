import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { initialLanguage, languageFrom, LANGUAGE_KEY, type Language } from './language.js';
import { persian } from './translations.fa.js';

interface LanguageState {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (en: string, fa?: string) => string;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, update] = useState<Language>(() => {
    try {
      return initialLanguage(window.localStorage, window.location.search);
    } catch {
      return initialLanguage(undefined, window.location.search);
    }
  });
  const setLang = useCallback((next: Language) => {
    update(next);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      /* Storage is optional. */
    }
    // Do not let a one-time deep-link preference override a later explicit choice.
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', next);
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);
  const t = useCallback(
    (en: string, fa?: string) => (lang === 'fa' ? (fa ?? persian[en] ?? en) : en),
    [lang],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    try {
      window.localStorage.setItem(LANGUAGE_KEY, lang);
    } catch {
      /* Storage is optional. */
    }
  }, [lang]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LANGUAGE_KEY) {
        const next = languageFrom(event.newValue);
        if (next) update(next);
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('LanguageProvider is required.');
  return value;
}

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useLanguage();
  return (
    <button
      type="button"
      className={`nova-language-switch ${className}`}
      onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
      aria-label={lang === 'fa' ? 'Switch to English' : 'تغییر زبان به فارسی'}
      lang={lang === 'fa' ? 'en' : 'fa'}
    >
      <span aria-hidden="true">◎</span> {lang === 'fa' ? 'EN' : 'فارسی'}
    </button>
  );
}
