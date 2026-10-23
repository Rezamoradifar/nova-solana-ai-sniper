export type CopyBuyBlocker =
  | 'COPY_EXECUTION_DISABLED'
  | 'PAPER_MODE'
  | 'WORKERS_NOT_READY'
  | 'COPY_WATCHER_UNHEALTHY'
  | 'SCANNER_UNHEALTHY'
  | 'BUYING_PAUSED'
  | 'SAFETY_STATE_UNKNOWN';

interface RuntimeState {
  enabled: boolean;
  mode: 'LIVE' | 'PAPER' | undefined;
  workersReady: boolean;
  watcher: { running: boolean; healthy: boolean } | undefined;
  scanner: { state: string; wsHealthy: boolean; fallbackHealthy: boolean } | undefined;
  envKillSwitch: boolean;
  stops: Array<string | null> | null;
}

/** Server-wide readiness for new buys, independent of user funds and trade checks. */
export function copyBuyReadiness(state: RuntimeState) {
  const blockers: CopyBuyBlocker[] = [];
  if (!state.enabled || !state.watcher?.running) blockers.push('COPY_EXECUTION_DISABLED');
  if (state.mode === 'PAPER') blockers.push('PAPER_MODE');
  if (!state.workersReady || state.mode === undefined) blockers.push('WORKERS_NOT_READY');
  if (state.watcher?.running && !state.watcher.healthy) blockers.push('COPY_WATCHER_UNHEALTHY');
  if (
    state.scanner?.state !== 'HEALTHY' ||
    !(state.scanner.wsHealthy || state.scanner.fallbackHealthy)
  )
    blockers.push('SCANNER_UNHEALTHY');
  if (state.envKillSwitch || state.stops?.some((value) => value === '1'))
    blockers.push('BUYING_PAUSED');
  if (
    !state.stops ||
    state.stops.length !== 2 ||
    state.stops.some((value) => value !== null && value !== '0' && value !== '1')
  ) {
    blockers.push('SAFETY_STATE_UNKNOWN');
  }
  return { ready: blockers.length === 0, blockers };
}
