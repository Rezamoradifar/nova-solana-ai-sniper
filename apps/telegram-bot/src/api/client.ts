import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';

export interface ApiConfig {
  /** e.g. http://127.0.0.1:4000 — same host apps/api's own HTTP server listens
   * on (see index.ts's metricsUrl for the existing precedent of this bot
   * talking to apps/api over loopback). */
  baseUrl: string;
  /** Same secret apps/api's @fastify/jwt plugin verifies against — this bot
   * process already holds ENCRYPTION_KEY (strictly more powerful: it can
   * decrypt any user's wallet key), so minting a short-lived JWT for a
   * telegramId it already resolved to a User row adds no new trust boundary. */
  jwtSecret: string;
}

/** Minted fresh per request rather than cached — these are infrequent,
 * user-initiated actions (view/close positions), not a hot path. */
function tokenFor(user: Pick<User, 'id' | 'role'>, secret: string): string {
  return jwt.sign({ userId: user.id, role: user.role }, secret, { expiresIn: '2m' });
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly category?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(
  api: ApiConfig,
  user: Pick<User, 'id' | 'role'>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${api.baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenFor(user, api.jwtSecret)}`,
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => undefined)) as
    { error?: string; category?: string } | undefined;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      body?.error ?? `Request failed with status ${res.status}`,
      body?.category,
    );
  }
  return body as T;
}

/** Mirrors GET /positions's response shape (apps/api/src/routes/positions.ts) —
 * only the fields this bot's UI actually reads. currentPriceUsd/unrealizedPnlUsd
 * are populated for OPEN positions only (null when no live price is available),
 * same convention that route already documents. */
export interface ApiPosition {
  id: string;
  walletId: string;
  status: 'OPEN' | 'CLOSED';
  entryPriceUsd: number;
  amountToken: number;
  remainingAmountToken: number | null;
  amountSolInvested: number;
  createdAt: string;
  token: { mint: string; symbol: string | null; decimals: number };
  currentPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface ClosePositionResult {
  closed: boolean;
  position: { id: string; status: string; realizedPnlUsd: number | null };
  signature: string | null;
}

export interface CloseAllResult {
  closed: number;
  failed: number;
  skipped: number;
  failures: Array<{ positionId: string; symbol: string; reason: string }>;
}

export async function fetchPositions(
  api: ApiConfig,
  user: Pick<User, 'id' | 'role'>,
): Promise<ApiPosition[]> {
  return request<ApiPosition[]>(api, user, '/positions');
}

export async function closePositionApi(
  api: ApiConfig,
  user: Pick<User, 'id' | 'role'>,
  positionId: string,
): Promise<ClosePositionResult> {
  return request<ClosePositionResult>(api, user, `/positions/${positionId}/sell`, {
    method: 'POST',
  });
}

export async function closeAllPositionsApi(
  api: ApiConfig,
  user: Pick<User, 'id' | 'role'>,
): Promise<CloseAllResult> {
  return request<CloseAllResult>(api, user, '/positions/close-all', { method: 'POST' });
}
