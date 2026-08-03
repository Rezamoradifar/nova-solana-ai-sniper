import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, createChart, type IChartApi, type Time } from 'lightweight-charts';

export interface PortfolioChartPoint {
  /** Unix seconds — lightweight-charts' Time unit, not JS's milliseconds. */
  time: number;
  value: number;
}

export interface PortfolioChartProps {
  data: readonly PortfolioChartPoint[];
  trend: 'up' | 'down' | 'flat';
  height?: number;
}

const TREND_COLOR: Record<PortfolioChartProps['trend'], string> = {
  up: '#00FFA3',
  down: '#FF4D6D',
  flat: '#A2A2B2',
};

/**
 * The app's real charting engine (lightweight-charts — TradingView's own
 * open-source library; see MISSING_APIS.md's charting note for why this
 * stands in for the full Advanced Charts license until that's available).
 * Used here for the portfolio value/PnL history line; the same component
 * shape will back per-token price charts once Discovery/Signals need one.
 */
export function PortfolioChart({ data, trend, height = 180 }: PortfolioChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(162, 162, 178, 0.8)',
        fontFamily: 'Inter, -apple-system, sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const color = TREND_COLOR[trend];
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: `${color}59`,
      bottomColor: `${color}00`,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
    // Re-create on every data/trend change rather than diffing — this chart
    // is small and re-renders infrequently (portfolio history), so the
    // simplicity is worth more than avoiding a teardown/rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, trend, height]);

  return <div ref={containerRef} style={{ height }} />;
}
