import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';

export interface ChartPoint {
  timestamp: number;
  value: number;
}

export interface PnlChartProps {
  data: readonly ChartPoint[];
  /** Colors the line/fill success (green) or danger (red) based on net
   * direction — pass explicitly rather than inferring from data[0]/data[-1]
   * so the caller (which knows the real PnL sign from the API, not just this
   * slice of points) stays the single source of truth. */
  trend: 'up' | 'down' | 'flat';
  height?: number;
}

const TREND_COLOR: Record<PnlChartProps['trend'], string> = {
  up: '#22D97A',
  down: '#F5433C',
  flat: '#A2A2B2',
};

/** The one PnL/portfolio chart primitive every screen with a profit graph
 * composes — real Recharts component, ready to receive live data; no
 * fabricated sample series baked in here. */
export function PnlChart({ data, trend, height = 160 }: PnlChartProps) {
  const color = TREND_COLOR[trend];
  const gradientId = `pnl-gradient-${trend}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={[...data]} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Tooltip
          contentStyle={{
            background: 'rgba(10,10,15,0.9)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
            fontSize: 12,
          }}
          labelFormatter={(label) =>
            typeof label === 'number' ? new Date(label).toLocaleString() : String(label ?? '')
          }
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          isAnimationActive
          animationDuration={400}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
