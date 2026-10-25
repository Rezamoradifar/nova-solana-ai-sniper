import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../lib/clipboard.js';
import { useLanguage } from '../lib/LanguageContext.js';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t: localize } = useLanguage();
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const manual = useRef<HTMLInputElement>(null);
  const copied = result?.text === text && result.ok;
  const failed = result?.text === text && !result.ok;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [copied, result]);

  useEffect(() => {
    if (!failed) return;
    manual.current?.focus({ preventScroll: true });
    manual.current?.select();
  }, [failed, result]);

  async function onClick() {
    let ok = false;
    try {
      ok = await copyToClipboard(text);
    } catch {
      /* Offer manual copying below. */
    }
    setResult({ text, ok });
  }

  return (
    <span className="copy-address-control">
      <button
        type="button"
        onClick={onClick}
        className="text-xs text-accent hover:underline"
        title={localize('Copy to clipboard')}
        aria-live="polite"
      >
        {copied ? localize('Copied!') : (label ?? localize('Copy'))}
      </button>
      {failed && (
        <span className="copy-address-fallback">
          <span role="alert">
            {localize(
              'Automatic copying failed. Select and copy the address below.',
              'کپی خودکار انجام نشد؛ آدرس زیر را انتخاب و کپی کن.',
            )}
          </span>
          <input
            ref={manual}
            readOnly
            dir="ltr"
            value={text}
            aria-label={localize('Address to copy manually', 'آدرس برای کپی دستی')}
            onFocus={(event) => event.currentTarget.select()}
          />
        </span>
      )}
    </span>
  );
}
