/** Keep the vendor's supported English locale; our frame title follows the site language. */
export function tradingViewDocument(symbol: string): string {
  const config = JSON.stringify({
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
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>
html,body,.tradingview-widget-container{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0d15}
.tradingview-widget-container__widget{height:calc(100% - 24px);width:100%}
.tradingview-widget-copyright{font:11px/24px Arial,sans-serif;text-align:center;color:#94a3b8}
a{color:inherit}
</style></head><body><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div>
<div class="tradingview-widget-copyright"><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></div>
<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>${config}</script>
</div></body></html>`;
}
