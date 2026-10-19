import { Link } from 'react-router-dom';
import { Glyph, Pill, useML } from './core.js';
import type { ReactNode } from 'react';

export function ToolHeading({ eyebrow, title, description, action, badge }: {
  eyebrow: string; title: string; description: string; action?: ReactNode; badge?: ReactNode;
}) {
  return <header className="ml2-tool-heading">
    <div><span className="ml2-eyebrow"><span/>{eyebrow}</span>
      <h1>{title}</h1><p>{description}</p></div>
    <div className="ml2-tool-heading-actions">{badge}{action}</div>
  </header>;
}

export function Notice({ title, children, tone = 'info' }: {
  title?: string; children: ReactNode; tone?: 'info' | 'warn' | 'safe';
}) {
  return <div className={'ml2-notice ml2-notice-' + tone} role={tone === 'warn' ? 'alert' : 'note'}>
    <Glyph name={tone === 'warn' ? 'warning' : tone === 'safe' ? 'shield' : 'info'} size={18}/>
    <div>{title && <strong>{title}</strong>}<p>{children}</p></div>
  </div>;
}

export function EmptyState({ title, text, action }: {
  title: string; text: string; action?: ReactNode;
}) {
  return <div className="ml2-empty-state"><div className="ml2-empty-icon"><Glyph name="activity" size={25}/></div>
    <strong>{title}</strong><p>{text}</p>{action}</div>;
}

export function Stat({ label, value, note, trend }: {
  label: string; value: ReactNode; note?: string; trend?: 'up' | 'down';
}) {
  return <div className="ml2-stat"><span>{label}</span>
    <strong className={'ml2-mono ' + (trend === 'up' ? 'ml2-positive' : trend === 'down' ? 'ml2-negative' : '')} dir="ltr">{value}</strong>
    {note && <small>{note}</small>}</div>;
}

export function FormField({ label, children, hint }: {
  label: string; children: ReactNode; hint?: string;
}) {
  return <label className="ml2-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Sparkline({ trend = 'up' }: { trend?: 'up' | 'down' | 'neutral' }) {
  return <svg className={'ml2-sparkline ml2-sparkline-' + trend} viewBox="0 0 110 38" fill="none"
    role="img" aria-label="Illustrative sparkline; not a verified performance history">
    <path d={trend === 'down'
      ? 'M0 8 14 12 26 8 35 18 47 13 57 22 68 20 80 28 92 26 109 36'
      : 'M0 31 12 24 23 27 35 19 46 23 60 10 70 13 83 8 94 12 110 3'}
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

export function ModeTag({ mode }: { mode: 'connected' | 'preview' | 'simulation' | 'offline' }) {
  const { t } = useML();
  return <Pill color={mode === 'connected' ? 'green' : mode === 'offline' ? 'red' : mode === 'simulation' ? 'purple' : 'cyan'}>
    {mode === 'connected' ? t('live') : mode === 'offline' ? t('offline') : mode === 'simulation' ? t('simulation') : t('demo')}
  </Pill>;
}

export function LinkedTool({ to, label }: { to: string; label?: string }) {
  const { t } = useML();
  return <Link className="ml2-text-link" to={to}>{label || t('viewLive')} <Glyph name="arrow" size={16}/></Link>;
}
