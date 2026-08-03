import { api } from './api.js';

export interface SellResult {
  closed?: boolean;
  sold?: boolean;
  signature?: string;
}

/** Thin client wrappers over the real POST /positions/:id/sell,
 * /partial-sell, /emergency-sell routes (apps/api/src/routes/positions.ts) —
 * every call here moves real funds; there is no simulated/mock mode in this
 * client. */
export const positionActions = {
  sell: (positionId: string) => api.post<SellResult>(`/positions/${positionId}/sell`),
  emergencySell: (positionId: string) =>
    api.post<SellResult>(`/positions/${positionId}/emergency-sell`),
  partialSell: (positionId: string, percent: number) =>
    api.post<SellResult>(`/positions/${positionId}/partial-sell`, { percent }),
};
