// Read-only probe, run from /repo in an API image with its actual environment:
// docker compose run --rm --no-deps -T api node --input-type=module - < scripts/check-solana-rpc.mjs
// Print labels and status codes only: provider URLs and errors can contain secrets.
import { resolveAllRpcEndpoints } from './apps/api/dist/solana/connection.js';
import process from 'node:process';
import console from 'node:console';

const { fetch, AbortSignal } = globalThis;

const endpoints = resolveAllRpcEndpoints({
  rpcUrl: process.env.SOLANA_RPC_URL,
  wsUrl: process.env.SOLANA_WS_URL,
  heliusApiKey: process.env.HELIUS_API_KEY,
  quicknodeRpcUrl: process.env.QUICKNODE_RPC_URL,
  quicknodeWsUrl: process.env.QUICKNODE_WS_URL,
  chainstackRpcUrl: process.env.CHAINSTACK_RPC_URL,
  additionalRpcUrls: process.env.ADDITIONAL_RPC_URLS,
});

let healthy = 0;
let healthyPrimary = 0;
for (const endpoint of endpoints) {
  const report = { provider: endpoint.label, tier: endpoint.tier };
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    report.http = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      report.status =
        response.status === 401 || response.status === 403
          ? 'ACCESS_DENIED'
          : response.status === 429
            ? 'RATE_LIMITED'
            : 'HTTP_ERROR';
    } else {
      const body = await response.json();
      if (!body.error && Number.isSafeInteger(body.result) && body.result >= 0) {
        report.status = 'OK';
        healthy += 1;
        if (endpoint.tier === 'primary') healthyPrimary += 1;
      } else {
        report.status = 'RPC_ERROR';
        if (Number.isInteger(body.error?.code)) report.rpcCode = body.error.code;
      }
    }
  } catch (error) {
    report.status = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_OR_RESPONSE_ERROR';
  }
  console.log(JSON.stringify(report));
}

if (!healthy) {
  console.error(
    'RPC_CHECK_FAILED: no provider answered getSlot. Fix RPC access before activation.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `RPC_CHECK_OK: healthy=${healthy}, healthyPrimary=${healthyPrimary}. HTTP read check only; WebSocket and trading readiness are not verified.`,
  );
  if (!healthyPrimary)
    console.warn(
      'NO_HEALTHY_PRIMARY_RPC: only public fallback is available; dedicated RPC access still needs repair.',
    );
}
