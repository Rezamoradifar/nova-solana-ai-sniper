// Read-only diagnostics inside the existing API container. No mode/flag writes,
// wallet access, worker startup, signing, transaction submission or raw errors.
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';

const { fetch, AbortSignal } = globalThis;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export function classifyError(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'TIMEOUT';
  const code = error?.cause?.code ?? error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS_LOOKUP_FAILED';
  if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'NETWORK_UNREACHABLE';
  return 'CONNECTION_OR_RESPONSE_ERROR';
}

export function probeWsUrl(endpoint) {
  if (endpoint.wsUrl) return endpoint.wsUrl;
  // Match web3.js makeWebsocketUrl, including its explicit HTTP-port +1 rule.
  const m = endpoint.url.match(/^https?:\/\/([^:[\]]+|\[[^\]]+\])(:\d+)?(.*)$/i);
  if (!m) throw new Error('INVALID_RPC_URL');
  return (
    (endpoint.url.startsWith('https:') ? 'wss://' : 'ws://') +
    m[1] +
    (m[2] ? ':' + (Number(m[2].slice(1)) + 1) : '') +
    m[3]
  );
}

export async function checkRpc(url, method, fetchImpl = fetch, timeoutMs = 8000) {
  const report = { method };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: method === 'getGenesisHash' ? [] : [{ commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    report.http = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      report.status = [401, 403].includes(response.status)
        ? 'ACCESS_DENIED'
        : response.status === 429
          ? 'RATE_LIMITED'
          : 'HTTP_ERROR';
      return report;
    }
    const body = await response.json();
    if (body?.error) {
      report.status = 'RPC_ERROR';
      if (Number.isInteger(body.error.code)) report.rpcCode = body.error.code;
      return report;
    }
    const result = body?.result;
    const valid =
      method === 'getGenesisHash'
        ? result === MAINNET_GENESIS
        : method === 'getSlot'
          ? Number.isSafeInteger(result) && result >= 0
          : method === 'getLatestBlockhash' &&
            typeof result?.value?.blockhash === 'string' &&
            result.value.blockhash.length > 0 &&
            Number.isSafeInteger(result.value.lastValidBlockHeight);
    report.status = valid
      ? 'OK'
      : method === 'getGenesisHash'
        ? 'MAINNET_NOT_VERIFIED'
        : 'INVALID_RESULT';
  } catch (error) {
    report.status = classifyError(error);
  }
  return report;
}

export function checkWs(url, Socket, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let socket,
      subscribed = false,
      subscription,
      done = false;
    const finish = (status, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Closing the connection also releases its provider-side subscription.
      try {
        socket?.terminate();
      } catch {
        /* no raw library errors */
      }
      resolve({ status, subscribed, ...extra });
    };
    const timer = setTimeout(
      () => finish(subscribed ? 'SUBSCRIBED_NO_LOGS' : 'WS_TIMEOUT'),
      timeoutMs,
    );
    try {
      socket = new Socket(url, {
        handshakeTimeout: timeoutMs,
        maxPayload: 128 * 1024,
        followRedirects: false,
      });
      socket.on('error', (error) => finish(classifyError(error)));
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        finish(
          [401, 403].includes(response.statusCode)
            ? 'ACCESS_DENIED'
            : response.statusCode === 429
              ? 'RATE_LIMITED'
              : 'WS_UPGRADE_REJECTED',
          { http: response.statusCode },
        );
      });
      socket.on('close', () =>
        finish(subscribed ? 'CLOSED_AFTER_SUBSCRIBE' : 'CLOSED_BEFORE_SUBSCRIBE'),
      );
      socket.on('open', () => {
        try {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'logsSubscribe',
              params: [{ mentions: [PUMPFUN_PROGRAM] }, { commitment: 'processed' }],
            }),
          );
        } catch (error) {
          finish(classifyError(error));
        }
      });
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.id === 1) {
            if (message.error) {
              const extra = Number.isInteger(message.error.code)
                ? { rpcCode: message.error.code }
                : {};
              finish('WS_RPC_ERROR', extra);
            } else if (Number.isSafeInteger(message.result) && message.result >= 0) {
              subscription = message.result;
              subscribed = true;
            } else finish('INVALID_SUBSCRIBE_RESPONSE');
          } else if (
            subscribed &&
            message.method === 'logsNotification' &&
            message.params?.subscription === subscription &&
            Array.isArray(message.params.result?.value?.logs) &&
            typeof message.params.result?.value?.signature === 'string'
          ) {
            finish('LOGS_RECEIVED');
          }
        } catch {
          finish('INVALID_WS_RESPONSE');
        }
      });
    } catch (error) {
      finish(classifyError(error));
    }
  });
}

export function stopSummary(config, values) {
  const flag = (value) => (value === '1' ? true : value === '0' || value === null ? false : null);
  return {
    envKillSwitch: config.KILL_SWITCH,
    redisKillSwitch: values ? flag(values[0]) : null,
    scannerPaused: values ? flag(values[1]) : null,
    scannerPauseSource: !values
      ? 'UNKNOWN'
      : !values[2]
        ? 'NOT_RECORDED'
        : values[2] === 'all launch-detection sources unhealthy'
          ? 'AUTOMATIC_OUTAGE'
          : 'OTHER_OR_MANUAL',
    scannerAutoResumeEnabled: config.SCANNER_AUTO_BUY_AUTO_RESUME_ENABLED,
  };
}

async function main() {
  const { loadApiEnv } = await import('/repo/apps/api/dist/config/env.js');
  const { resolveAllRpcEndpoints } = await import('/repo/apps/api/dist/solana/connection.js');
  const { Redis } = await import('ioredis');
  const { default: Socket } = await import('ws');
  const config = loadApiEnv();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  redis.on('error', () => {});
  try {
    let stops;
    try {
      stops = await redis.mget(
        'nova:trading:kill_switch',
        'nova:trading:scanner_autobuy_paused',
        'nova:trading:scanner_autobuy_paused_reason',
      );
    } catch {
      /* explicit unknowns, never print Redis URLs or messages */
    }
    console.log('NOVA_COPY_DIAG_SAFETY=' + JSON.stringify(stopSummary(config, stops)));
    const keys = [
      'SOLANA_RPC_URL',
      'SOLANA_WS_URL',
      'HELIUS_API_KEY',
      'QUICKNODE_RPC_URL',
      'QUICKNODE_WS_URL',
      'CHAINSTACK_RPC_URL',
      'ADDITIONAL_RPC_URLS',
    ];
    console.log(
      'NOVA_COPY_DIAG_CONFIG=' +
        JSON.stringify({
          freshBootstrapMarkerPresent: Boolean(process.env.NOVA_FRESH_BOOTSTRAP),
          configured: Object.fromEntries(keys.map((key) => [key, Boolean(config[key]?.trim())])),
        }),
    );
    const all = resolveAllRpcEndpoints({
      rpcUrl: config.SOLANA_RPC_URL,
      wsUrl: config.SOLANA_WS_URL,
      heliusApiKey: config.HELIUS_API_KEY,
      quicknodeRpcUrl: config.QUICKNODE_RPC_URL,
      quicknodeWsUrl: config.QUICKNODE_WS_URL,
      chainstackRpcUrl: config.CHAINSTACK_RPC_URL,
      additionalRpcUrls: config.ADDITIONAL_RPC_URLS,
    });
    const primary = all.filter((e) => e.tier === 'primary');
    console.log(
      'NOVA_COPY_DIAG_PROVIDERS=' +
        JSON.stringify({
          dedicatedConfigured: primary.length,
          checked: Math.min(3, primary.length),
          publicFallbackConfigured: all.some((e) => e.tier === 'fallback'),
        }),
    );
    if (!primary.length)
      console.log('NOVA_COPY_DIAG_ACTION=CONFIGURE_DEDICATED_MAINNET_HTTP_AND_WS');
    await Promise.all(
      primary.slice(0, 3).map(async (endpoint) => {
        const checks = await Promise.all(
          ['getGenesisHash', 'getSlot', 'getLatestBlockhash'].map((method) =>
            checkRpc(endpoint.url, method),
          ),
        );
        let ws;
        try {
          ws = await checkWs(probeWsUrl(endpoint), Socket);
        } catch {
          ws = { status: 'INVALID_WS_CONFIGURATION', subscribed: false };
        }
        console.log(
          'NOVA_COPY_DIAG_PROVIDER=' +
            JSON.stringify({
              provider: endpoint.label,
              mainnetHttpReady: checks.every((c) => c.status === 'OK'),
              checks,
              websocketSource: endpoint.wsUrl ? 'EXPLICIT' : 'DERIVED_AS_WEB3',
              ws,
            }),
        );
      }),
    );
    console.log('NOVA_COPY_DIAGNOSTIC_ONLY_NO_CHANGES');
  } finally {
    redis.disconnect();
  }
}

if (
  (process.argv[1] === '-' && import.meta.url.endsWith('/[eval1]')) ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  const timer = setTimeout(() => {
    console.error('NOVA_COPY_DIAG_TIMEOUT_NO_CHANGES');
    process.exit(1);
  }, 55000);
  main()
    .catch(() => {
      console.error('NOVA_COPY_DIAG_FAILED_REDACTED_NO_CHANGES');
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timer));
}
