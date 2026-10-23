/** Honest public execution readiness. This does not inspect a user's trading wallet. */
export interface PublicNetworkReadiness {
  status: 'ready' | 'degraded' | 'not_ready';
  tradingMode: 'LIVE' | 'PAPER';
  workersReady: boolean;
  scanner?: { state: string; wsHealthy: boolean; fallbackHealthy: boolean } | null;
}

export interface PublicCopyReadiness {
  executionMode: 'live' | 'paper' | 'disabled';
  liveExecutionEnabled: boolean;
  copyWatcherReady: boolean;
  watcher: { running: boolean; healthy: boolean } | null;
  buyReadiness?: { ready: boolean; blockers: string[]; checkedAt: number };
  limits?: {
    maxBuySol: number;
    maxDailyBuys: number;
    maxOpenPositions: number;
    slippageBps: number;
  };
}

export type CopyReadiness =
  | 'unavailable'
  | 'network-degraded'
  | 'watcher-stopped'
  | 'watcher-degraded'
  | 'paper'
  | 'scanner-degraded'
  | 'buy-paused'
  | 'readiness-unavailable'
  | 'live-backend-ready';

export function liveCopyBuysReady(copy: PublicCopyReadiness | null): boolean {
  return (
    copy?.executionMode === 'live' &&
    copy.liveExecutionEnabled === true &&
    copy.copyWatcherReady === true &&
    copy.watcher?.running === true &&
    copy.watcher.healthy === true &&
    copy.buyReadiness?.ready === true &&
    Array.isArray(copy.buyReadiness.blockers) &&
    copy.buyReadiness.blockers.length === 0
  );
}

export function classifyCopyReadiness(
  network: PublicNetworkReadiness | null,
  copy: PublicCopyReadiness | null,
): CopyReadiness {
  if (!network || !copy) return 'unavailable';
  if (network.status !== 'ready' || !network.workersReady) return 'network-degraded';
  if (!copy.watcher?.running || copy.executionMode === 'disabled') return 'watcher-stopped';
  if (!copy.watcher.healthy || !copy.copyWatcherReady) return 'watcher-degraded';
  if (network.tradingMode !== 'LIVE' || copy.executionMode !== 'live' || !copy.liveExecutionEnabled)
    return 'paper';
  if (
    network.scanner?.state !== 'HEALTHY' ||
    !(network.scanner.wsHealthy || network.scanner.fallbackHealthy)
  )
    return 'scanner-degraded';
  if (!copy.buyReadiness) return 'readiness-unavailable';
  return liveCopyBuysReady(copy) ? 'live-backend-ready' : 'buy-paused';
}
