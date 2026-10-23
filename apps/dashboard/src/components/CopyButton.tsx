import { useState } from 'react';
import { copyToClipboard } from '../lib/clipboard.js';
import { useLanguage } from '../lib/LanguageContext.js';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { t: localize } = useLanguage();
  const [copied, setCopied] = useState(false);

  async function onClick() {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-accent hover:underline"
      title={localize('Copy to clipboard')}
    >
      {copied ? localize('Copied!') : label}
    </button>
  );
}
