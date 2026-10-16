import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

interface Result {
  integrations: {
    key: string;
    label: string;
    status: string;
    detail: string;
    checkedAt: string | null;
  }[];
  note: string;
}
const labels: Record<string, string> = {
  healthy: 'Check passed',
  access_denied: 'Access denied',
  rate_limited: 'Rate limited',
  unavailable: 'Unavailable',
  not_configured: 'Not configured',
  unchecked: 'Configured · not checked',
};
export function IntegrationStatus() {
  const state = usePolling(() => api.get<Result>('/admin/integrations'), 60_000);
  return (
    <section className="card">
      <h2 className="font-semibold text-white">Connection diagnostics</h2>
      {state.loading && <p className="mt-3 text-sm text-slate-400">Checking connections…</p>}
      {state.error && (
        <p className="mt-3 text-sm text-loss" role="alert">
          Connection results could not be refreshed: {state.error.message}
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {state.data?.integrations.map((item) => (
          <div key={item.key} className="rounded-lg border border-surface-border p-3">
            <div className="text-sm font-semibold text-white">{item.label}</div>
            <div
              className={`mt-1 text-xs ${item.status === 'healthy' ? 'text-profit' : item.status === 'unchecked' || item.status === 'not_configured' ? 'text-slate-400' : 'text-loss'}`}
            >
              {labels[item.status] ?? item.status}
            </div>
            <p className="mt-2 text-xs text-slate-400">{item.detail}</p>
            {item.checkedAt && (
              <p className="mt-1 text-xs text-slate-500">
                Checked {new Date(item.checkedAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">
        {state.data?.note} Checks are cached for one minute.
      </p>
    </section>
  );
}
