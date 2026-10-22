// Executed only inside the existing API image. No keys are read/decrypted, no
// signer is constructed, and no trade is submitted by this operator helper.
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';

const { fetch, AbortSignal } = globalThis;

export const FEATURE_KEYS = ['COPY_TRADING_EXECUTION_ENABLED', 'LIVE_TRADING'];
const ACTION = 'operator.copy_live_enabled';
// https://namespaces.chainagnostic.org/solana/caip2
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export function blockers(s, live = false) {
  const errors = [];
  if (s.health !== 200 || s.readiness !== 200) errors.push('API_NOT_READY');
  if (s.copyHttp !== 200 || s.copy?.mode !== 'buy_and_proportional_sell_mirror_independent_exits')
    errors.push('COPY_BACKEND_NOT_COMPATIBLE');
  if (s.network?.status !== 'ready' || s.network?.workersReady !== true)
    errors.push('NETWORK_NOT_READY');
  const scanner = s.network?.scanner;
  if (scanner?.state !== 'HEALTHY' || !(scanner.wsHealthy || scanner.fallbackHealthy))
    errors.push('SCANNER_UNHEALTHY_REPAIR_RPC_OR_WS');
  if (s.killSwitch !== false) errors.push('KILL_SWITCH_ACTIVE_OR_UNKNOWN');
  if (s.scannerPause !== false) errors.push('SCANNER_BUYS_PAUSED');
  if (!Number.isInteger(s.otherAutoBuys) || s.otherAutoBuys !== 0)
    errors.push('UNRELATED_AUTO_BUYS_REQUIRE_REVIEW');
  if (s.safetyReady !== true) errors.push('SAFETY_LIMITS_INVALID');
  if (s.skipSimulation !== false) errors.push('BUY_SIMULATION_IS_DISABLED');
  for (const [key, cap] of Object.entries({
    maxBuySol: 0.1,
    maxDailyBuys: 10,
    maxOpenPositions: 3,
    slippageBps: 150,
  })) {
    const value = s.limits?.[key];
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > cap ||
      (key !== 'maxBuySol' && !Number.isInteger(value))
    )
      errors.push('COPY_LIMIT_' + key);
  }
  if (live) {
    const c = s.copy;
    if (
      s.network?.tradingMode !== 'LIVE' ||
      c?.executionMode !== 'live' ||
      c?.liveExecutionEnabled !== true
    )
      errors.push('LIVE_MODE_NOT_ACTIVE');
    if (
      c?.copyWatcherReady !== true ||
      c?.watcher?.running !== true ||
      c?.watcher?.healthy !== true
    )
      errors.push('COPY_WATCHER_NOT_READY');
  } else if (s.dedicatedMainnetRpc !== true) errors.push('DEDICATED_MAINNET_RPC_NOT_READY');
  return errors;
}

export function featureSnapshot(rows) {
  return FEATURE_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return row
      ? {
          key,
          enabled: row.enabled,
          updatedByUserId: row.updatedByUserId ?? null,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        }
      : null;
  });
}

export function sameFeatures(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function enableFeatures(db, payload, before) {
  return db.$transaction(
    async (tx) => {
      // AutoTrader reads this table. Do not promote existing unrelated simulations
      // into live buys. Explicit new user requests after rollout remain user-owned.
      await tx.$executeRawUnsafe('LOCK TABLE snipe_configs IN SHARE MODE');
      await tx.$executeRawUnsafe('LOCK TABLE admin_feature_overrides IN EXCLUSIVE MODE');
      if (await tx.snipeConfig.count({ where: { isActive: true, autoBuyOnLaunch: true } }))
        throw new Error('UNRELATED_AUTO_BUYS_REQUIRE_REVIEW');
      const current = featureSnapshot(
        await tx.adminFeatureOverride.findMany({
          where: { key: { in: FEATURE_KEYS } },
        }),
      );
      if (!sameFeatures(current, before)) throw new Error('ADMIN_FLAGS_CHANGED_DURING_PREFLIGHT');
      for (const key of FEATURE_KEYS) {
        await tx.adminFeatureOverride.upsert({
          where: { key },
          create: { key, enabled: true },
          update: { enabled: true },
        });
      }
      const after = featureSnapshot(
        await tx.adminFeatureOverride.findMany({
          where: { key: { in: FEATURE_KEYS } },
        }),
      );
      // Journal before commit: a lost client response can still be reconciled.
      await tx.auditLog.create({
        data: {
          action: ACTION,
          metadata: { operationId: payload.operationId, before, after },
        },
      });
      return after;
    },
    { timeout: 15000 },
  );
}

export async function restoreFeatures(db, payload) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE admin_feature_overrides IN EXCLUSIVE MODE');
      const record = await tx.auditLog.findFirst({
        where: { action: ACTION, metadata: { path: ['operationId'], equals: payload.operationId } },
        orderBy: { createdAt: 'desc' },
      });
      const current = featureSnapshot(
        await tx.adminFeatureOverride.findMany({
          where: { key: { in: FEATURE_KEYS } },
        }),
      );
      if (!record) {
        if (!sameFeatures(current, payload.before)) throw new Error('UNRECONCILED_FEATURE_STATE');
        return 'unchanged';
      }
      const { before, after } = record.metadata;
      if (sameFeatures(current, before)) return 'already_restored';
      if (!sameFeatures(current, after))
        throw new Error('LATER_ADMIN_EDIT_WILL_NOT_BE_OVERWRITTEN');
      for (let i = 0; i < FEATURE_KEYS.length; i++) {
        const row = before[i];
        const key = FEATURE_KEYS[i];
        if (row === null) await tx.adminFeatureOverride.deleteMany({ where: { key } });
        else
          await tx.adminFeatureOverride.upsert({
            where: { key },
            create: row,
            update: {
              enabled: row.enabled,
              updatedByUserId: row.updatedByUserId,
              updatedAt: new Date(row.updatedAt),
            },
          });
      }
      await tx.auditLog.create({
        data: {
          action: 'operator.copy_live_restored',
          metadata: { operationId: payload.operationId },
        },
      });
      return 'restored';
    },
    { timeout: 15000 },
  );
}

async function main() {
  // All runtime imports are deferred so offline tests cannot accidentally open a
  // DB/RPC connection or start the API. Loading this helper never starts workers.
  const { PrismaClient } = await import('@prisma/client');
  const { Redis } = await import('ioredis');
  const { loadApiEnv } = await import('/repo/apps/api/dist/config/env.js');
  const { resolveAllRpcEndpoints } = await import('/repo/apps/api/dist/solana/connection.js');
  const { verifySafetySystemReady } = await import('/repo/apps/api/dist/trading/safety.js');
  const { getKillSwitchState, getScannerAutoBuyPauseState } = await import('@nova/shared');
  const db = new PrismaClient();
  let redis;
  const action = process.argv[2];
  const payload = JSON.parse(process.argv[3] || '{}');
  try {
    if (action === 'restore') {
      console.log(JSON.stringify({ restored: await restoreFeatures(db, payload) }));
      return;
    }
    const config = loadApiEnv();
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
    redis.on('error', () => {});
    async function get(path) {
      try {
        const r = await fetch('http://127.0.0.1:4000' + path, {
          cache: 'no-store',
          signal: AbortSignal.timeout(12000),
        });
        return { status: r.status, body: await r.json() };
      } catch {
        return { status: 0, body: null };
      }
    }
    const [
      health,
      readiness,
      network,
      copy,
      rows,
      otherAutoBuys,
      activeCopyConfigs,
      safety,
      killSwitch,
      scannerPause,
    ] = await Promise.all([
      get('/health'),
      get('/health/ready'),
      get('/public/network/status'),
      get('/public/copy-trading'),
      db.adminFeatureOverride.findMany({ where: { key: { in: FEATURE_KEYS } } }),
      db.snipeConfig.count({ where: { isActive: true, autoBuyOnLaunch: true } }),
      db.copyTradeConfig.count({
        where: {
          isActive: true,
          user: { isSuspended: false, deletedAt: null },
        },
      }),
      verifySafetySystemReady(
        {
          maxTradeSol: config.MAX_TRADE_SOL,
          maxDailyLossUsd: config.MAX_DAILY_LOSS_USD,
          maxOpenPositions: config.MAX_OPEN_POSITIONS,
          minWalletReserveSol: config.MIN_WALLET_RESERVE_SOL,
          killSwitchEnv: config.KILL_SWITCH,
        },
        redis,
      ),
      getKillSwitchState(redis),
      getScannerAutoBuyPauseState(redis),
    ]);
    const limits = {
      maxBuySol: config.COPY_TRADING_MAX_BUY_SOL,
      maxDailyBuys: config.COPY_TRADING_MAX_DAILY_BUYS,
      maxOpenPositions: config.COPY_TRADING_MAX_OPEN_POSITIONS,
      slippageBps: config.COPY_TRADING_SLIPPAGE_BPS,
    };
    const snapshot = {
      health: health.status,
      readiness: readiness.status,
      network: network.body,
      copy: copy.body,
      copyHttp: copy.status,
      otherAutoBuys,
      activeCopyConfigs,
      limits,
      safetyReady: safety.ready,
      killSwitch: config.KILL_SWITCH || killSwitch,
      scannerPause,
      skipSimulation: config.SKIP_BUY_SIMULATION,
      dedicatedMainnetRpc: false,
    };
    if (action !== 'status') {
      const endpoints = resolveAllRpcEndpoints({
        rpcUrl: config.SOLANA_RPC_URL,
        wsUrl: config.SOLANA_WS_URL,
        heliusApiKey: config.HELIUS_API_KEY,
        quicknodeRpcUrl: config.QUICKNODE_RPC_URL,
        quicknodeWsUrl: config.QUICKNODE_WS_URL,
        chainstackRpcUrl: config.CHAINSTACK_RPC_URL,
        additionalRpcUrls: config.ADDITIONAL_RPC_URLS,
      })
        .filter((e) => e.tier === 'primary')
        .slice(0, 3);
      for (const endpoint of endpoints) {
        try {
          const rpc = async (method, params = []) => {
            const r = await fetch(endpoint.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
              signal: AbortSignal.timeout(8000),
            });
            const j = await r.json();
            if (!r.ok || j.error) throw new Error('RPC_FAILED');
            return j.result;
          };
          const [genesis, slot, block] = await Promise.all([
            rpc('getGenesisHash'),
            rpc('getSlot', [{ commitment: 'confirmed' }]),
            rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
          ]);
          if (
            genesis !== MAINNET_GENESIS ||
            !Number.isSafeInteger(slot) ||
            !block?.value?.blockhash ||
            !Number.isSafeInteger(block?.value?.lastValidBlockHeight)
          )
            continue;
          const targets = await db.copyTradeConfig.findMany({
            where: { isActive: true, user: { isSuspended: false, deletedAt: null } },
            select: { targetAddress: true },
            distinct: ['targetAddress'],
            take: 3,
          });
          for (const target of targets) {
            const signatures = await rpc('getSignaturesForAddress', [
              target.targetAddress,
              { limit: 1, commitment: 'confirmed' },
            ]);
            if (!Array.isArray(signatures)) throw new Error('HISTORY_FAILED');
            if (signatures[0]?.signature) {
              const tx = await rpc('getTransaction', [
                signatures[0].signature,
                {
                  encoding: 'jsonParsed',
                  commitment: 'confirmed',
                  maxSupportedTransactionVersion: 0,
                },
              ]);
              if (!tx?.transaction || !tx.meta) throw new Error('PARSED_HISTORY_UNAVAILABLE');
            }
          }
          snapshot.dedicatedMainnetRpc = true;
          break;
        } catch {
          /* Provider errors may contain credentials; output labels only. */
        }
      }
    }
    const errors = blockers(snapshot, action === 'status');
    const before = featureSnapshot(rows);
    const report = {
      ok: errors.length === 0,
      blockers: errors,
      mode: network.body?.tradingMode ?? 'UNKNOWN',
      scanner: network.body?.scanner?.state ?? 'UNKNOWN',
      otherAutoBuys,
      activeCopyConfigs,
      limits,
      copyWatcherReady: copy.body?.copyWatcherReady === true,
    };
    if (action === 'prepare' || action === 'status') {
      console.log(JSON.stringify({ report, before }));
    } else if (action === 'enable') {
      if (errors.length) throw new Error('PREFLIGHT_FAILED');
      await enableFeatures(db, payload, payload.before);
      console.log(JSON.stringify({ enabled: true }));
    } else throw new Error('INVALID_OPERATOR_ACTION');
  } finally {
    redis?.disconnect();
    await db.$disconnect();
  }
}

// node --input-type=module - ACTION JSON (stdin execution); normal imports stay inert.
if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  // Terminate the in-container helper before the operator command's timeout.
  // A detached docker-exec client must not leave a late flag mutation running.
  const deadline = setTimeout(() => process.exit(2), 90_000);
  deadline.unref();
  main()
    .catch(() => {
      console.error('NOVA_COPY_CONTROL_FAILED_REDACTED');
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(deadline));
}
