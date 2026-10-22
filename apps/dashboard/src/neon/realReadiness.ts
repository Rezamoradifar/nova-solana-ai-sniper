/** Honest public execution readiness. This does not inspect a user's trading wallet. */
export interface PublicNetworkReadiness {
  status: 'ready' | 'degraded' | 'not_ready';
  tradingMode: 'LIVE' | 'PAPER';
  workersReady: boolean;
}

export interface PublicCopyReadiness {
  executionMode: 'live' | 'paper' | 'disabled';
  liveExecutionEnabled: boolean;
  copyWatcherReady: boolean;
  watcher: { running: boolean; healthy: boolean } | null;
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
  | 'live-backend-ready';

export function classifyCopyReadiness(
  network: PublicNetworkReadiness | null,
  copy: PublicCopyReadiness | null,
): CopyReadiness {
  if (!network || !copy) return 'unavailable';
  if (network.status !== 'ready' || !network.workersReady) return 'network-degraded';
  if (!copy.watcher?.running || copy.executionMode === 'disabled')
    return 'watcher-stopped';
  if (!copy.watcher.healthy || !copy.copyWatcherReady) return 'watcher-degraded';
  if (
    network.tradingMode !== 'LIVE' ||
    copy.executionMode !== 'live' ||
    !copy.liveExecutionEnabled
  ) return 'paper';
  return 'live-backend-ready';
}
