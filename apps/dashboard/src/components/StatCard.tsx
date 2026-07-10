interface StatCardProps {
  label: string;
  value: string;
  tone?: 'default' | 'profit' | 'loss';
  sublabel?: string;
}

export function StatCard({ label, value, tone = 'default', sublabel }: StatCardProps) {
  const toneClass =
    tone === 'profit' ? 'text-profit' : tone === 'loss' ? 'text-loss' : 'text-slate-100';

  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sublabel && <div className="mt-1 text-xs text-slate-500">{sublabel}</div>}
    </div>
  );
}
