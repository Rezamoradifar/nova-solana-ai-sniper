import { useEffect, useRef } from 'react';

interface TradingViewWidgetProps {
  symbol?: string;
  height?: number;
}

/**
 * Embeds TradingView's free "Advanced Real-Time Chart" widget via their
 * public embed script. Re-mounts the script whenever `symbol` changes since
 * the widget doesn't expose an imperative update API for the embed version.
 */
export function TradingViewWidget({
  symbol = 'COINBASE:SOLUSD',
  height = 480,
}: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      enable_publishing: false,
      allow_symbol_change: true,
      support_host: 'https://www.tradingview.com',
    });

    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container__widget';
    container.appendChild(widgetDiv);
    container.appendChild(script);
  }, [symbol]);

  return (
    <div className="card overflow-hidden p-0">
      <div ref={containerRef} className="tradingview-widget-container" style={{ height }} />
    </div>
  );
}
