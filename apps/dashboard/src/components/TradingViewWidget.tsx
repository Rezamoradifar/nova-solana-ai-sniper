import { useLanguage } from '../lib/LanguageContext.js';
import { tradingViewDocument } from '../lib/tradingViewEmbed.js';

interface TradingViewWidgetProps {
  symbol?: string;
  height?: number;
}

/** The embed owns its document, so late vendor callbacks cannot target an unmounted React node. */
export function TradingViewWidget({
  symbol = 'COINBASE:SOLUSD',
  height = 480,
}: TradingViewWidgetProps) {
  const { t } = useLanguage();
  return (
    <div className="card overflow-hidden p-0">
      <iframe
        title={t('TradingView market chart', 'نمودار بازار TradingView')}
        srcDoc={tradingViewDocument(symbol)}
        referrerPolicy="no-referrer"
        style={{ height, width: '100%', display: 'block', border: 0 }}
      />
    </div>
  );
}
