import type { ApiEnv } from '../config/env.js';
import { resolveAllRpcEndpoints } from '../solana/connection.js';

export type ConnectionState =
  'healthy' | 'access_denied' | 'rate_limited' | 'unavailable' | 'not_configured' | 'unchecked';
export interface IntegrationHealth {
  key: string;
  label: string;
  status: ConnectionState;
  detail: string;
  checkedAt: string | null;
}

// Never serialize provider URLs, headers, tokens, response bodies or raw errors.
async function probe(
  key: string,
  label: string,
  url: string,
  options: RequestInit,
  valid: (body: Record<string, unknown>) => boolean,
): Promise<IntegrationHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const r = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    const status: ConnectionState =
      r.status === 401 || r.status === 403
        ? 'access_denied'
        : r.status === 429
          ? 'rate_limited'
          : r.ok
            ? 'healthy'
            : 'unavailable';
    const body = r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    const rpcError = body?.error as { code?: number } | undefined;
    const result: ConnectionState =
      rpcError?.code === 429
        ? 'rate_limited'
        : rpcError?.code === 401 || rpcError?.code === 403
          ? 'access_denied'
          : r.ok && (!body || typeof body !== 'object' || !valid(body))
            ? 'unavailable'
            : status;
    return {
      key,
      label,
      status: result,
      checkedAt,
      detail:
        result === 'healthy'
          ? 'Read-only connection check passed.'
          : result === 'access_denied'
            ? 'Check the API key, endpoint permissions and provider IP restrictions.'
            : result === 'rate_limited'
              ? 'Provider rate limit reached. Reduce load or review its quota.'
              : 'Connection check did not pass.',
    };
  } catch {
    return {
      key,
      label,
      status: 'unavailable',
      detail: 'Connection timed out or returned an invalid response.',
      checkedAt,
    };
  }
}

export function createIntegrationHealth(config: ApiEnv) {
  let cached: { at: number; value: IntegrationHealth[] } | undefined;
  let pending: Promise<IntegrationHealth[]> | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const endpoints = resolveAllRpcEndpoints({
        rpcUrl: config.SOLANA_RPC_URL,
        wsUrl: config.SOLANA_WS_URL,
        heliusApiKey: config.HELIUS_API_KEY,
        quicknodeRpcUrl: config.QUICKNODE_RPC_URL,
        chainstackRpcUrl: config.CHAINSTACK_RPC_URL,
        additionalRpcUrls: config.ADDITIONAL_RPC_URLS,
      });
      const jobs: Promise<IntegrationHealth>[] = endpoints.map((endpoint) =>
        probe(
          endpoint.label,
          `Solana RPC · ${endpoint.label}`,
          endpoint.url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getSlot',
              params: [{ commitment: 'confirmed' }],
            }),
          },
          (body) => Number.isSafeInteger(body.result) && Number(body.result) >= 0,
        ),
      );
      if (config.TELEGRAM_BOT_TOKEN)
        jobs.push(
          probe(
            'telegram',
            'Telegram Bot',
            `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getMe`,
            {},
            (body) => body.ok === true && typeof body.result === 'object' && body.result !== null,
          ),
        );
      if (config.OLLAMA_HOST)
        jobs.push(
          probe(
            'ollama',
            'Ollama',
            `${config.OLLAMA_HOST.replace(/\/$/, '')}/api/tags`,
            {},
            (body) => Array.isArray(body.models),
          ),
        );
      const rows = await Promise.all(jobs);
      const optional: Array<[string, string, string | undefined]> = [
        ['telegram', 'Telegram Bot', config.TELEGRAM_BOT_TOKEN],
        ['ollama', 'Ollama', config.OLLAMA_HOST],
        ['helius', 'Helius RPC', config.HELIUS_API_KEY],
        ['quicknode', 'QuickNode RPC', config.QUICKNODE_RPC_URL],
        ['chainstack', 'Chainstack RPC', config.CHAINSTACK_RPC_URL],
        ['jito', 'Jito', config.JITO_BLOCK_ENGINE_URL],
        ['openrouter', 'OpenRouter AI', config.OPENROUTER_API_KEY],
        ['anthropic', 'Anthropic AI', config.ANTHROPIC_API_KEY],
        ['openai', 'OpenAI', config.OPENAI_API_KEY],
        ['twitter', 'X / Twitter', config.TWITTER_BEARER_TOKEN],
        ['gmgn', 'GMGN', config.GMGN_API_KEY],
        ['jupiter', 'Jupiter quotes', config.JUPITER_API_BASE],
      ];
      for (const [key, label, value] of optional) {
        if (rows.some((row) => row.key === key)) continue;
        rows.push({
          key,
          label,
          status: value?.trim() ? 'unchecked' : 'not_configured',
          checkedAt: null,
          detail: value?.trim()
            ? 'Configured; successful service use has not been verified by this check.'
            : 'Server configuration is missing.',
        });
      }
      cached = { at: Date.now(), value: rows };
      return rows;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
