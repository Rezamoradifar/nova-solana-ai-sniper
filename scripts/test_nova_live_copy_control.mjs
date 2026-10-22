import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockers,
  enableFeatures,
  restoreFeatures,
  featureSnapshot,
  FEATURE_KEYS,
  bootstrapStopReleaseAllowed,
  redisStopState,
} from './nova-live-copy-control.mjs';

const { structuredClone } = globalThis;

function healthy() {
  return {
    health: 200,
    readiness: 200,
    copyHttp: 200,
    network: {
      status: 'ready',
      workersReady: true,
      tradingMode: 'PAPER',
      scanner: { state: 'HEALTHY', wsHealthy: true, fallbackHealthy: false },
    },
    copy: { mode: 'buy_and_proportional_sell_mirror_independent_exits' },
    killSwitch: false,
    scannerPause: false,
    otherAutoBuys: 0,
    safetyReady: true,
    skipSimulation: false,
    dedicatedMainnetRpc: true,
    limits: { maxBuySol: 0.1, maxDailyBuys: 10, maxOpenPositions: 3, slippageBps: 150 },
  };
}

test('preflight permits PAPER before activation but requires independent readiness', () => {
  assert.deepEqual(blockers(healthy()), []);
  for (const [key, value, expected] of [
    ['health', 503, 'API_NOT_READY'],
    ['readiness', 503, 'API_NOT_READY'],
    ['copyHttp', 404, 'COPY_BACKEND_NOT_COMPATIBLE'],
    ['dedicatedMainnetRpc', false, 'DEDICATED_MAINNET_RPC_NOT_READY'],
    ['killSwitch', true, 'KILL_SWITCH_ACTIVE_OR_UNKNOWN'],
    ['killSwitch', undefined, 'KILL_SWITCH_ACTIVE_OR_UNKNOWN'],
    ['scannerPause', true, 'SCANNER_BUYS_PAUSED'],
    ['safetyReady', false, 'SAFETY_LIMITS_INVALID'],
    ['skipSimulation', true, 'BUY_SIMULATION_IS_DISABLED'],
    ['otherAutoBuys', 1, 'UNRELATED_AUTO_BUYS_REQUIRE_REVIEW'],
  ]) {
    const s = healthy();
    s[key] = value;
    assert(blockers(s).includes(expected), key);
  }
});

test('a responding RPC alone cannot qualify an unhealthy or unknown scanner', () => {
  for (const scanner of [
    null,
    { state: 'UNHEALTHY' },
    { state: 'HEALTHY', wsHealthy: false, fallbackHealthy: false },
  ]) {
    const s = healthy();
    s.network.scanner = scanner;
    assert(blockers(s).includes('SCANNER_UNHEALTHY_REPAIR_RPC_OR_WS'));
  }
  const s = healthy();
  s.network.workersReady = false;
  assert(blockers(s).includes('NETWORK_NOT_READY'));
});

test('only the existing conservative copy limits, including lower values, qualify', () => {
  for (const [key, cap] of Object.entries(healthy().limits)) {
    for (const value of [0, -1, NaN, Infinity, cap * 2]) {
      const s = healthy();
      s.limits[key] = value;
      assert(blockers(s).includes('COPY_LIMIT_' + key), key + ':' + value);
    }
  }
  const s = healthy();
  s.limits.maxDailyBuys = 1.5;
  assert(blockers(s).includes('COPY_LIMIT_maxDailyBuys'));
  s.limits = { maxBuySol: 0.01, maxDailyBuys: 1, maxOpenPositions: 1, slippageBps: 50 };
  assert.deepEqual(blockers(s), []);
});

test('postcheck demands LIVE and an actually running, healthy watcher', () => {
  const s = healthy();
  assert(blockers(s, true).includes('LIVE_MODE_NOT_ACTIVE'));
  assert(blockers(s, true).includes('COPY_WATCHER_NOT_READY'));
  s.network.tradingMode = 'LIVE';
  Object.assign(s.copy, {
    executionMode: 'live',
    liveExecutionEnabled: true,
    copyWatcherReady: true,
    watcher: { running: true, healthy: true },
  });
  assert.deepEqual(blockers(s, true), []);
  for (const key of ['running', 'healthy']) {
    s.copy.watcher[key] = false;
    assert(blockers(s, true).includes('COPY_WATCHER_NOT_READY'));
    s.copy.watcher[key] = true;
  }
});

test('bootstrap release is explicit and limited to the stopped fresh installation', () => {
  const s = healthy();
  s.activeCopyConfigs = 0;
  s.killSwitch = true;
  s.bootstrap = {
    marker: '2026-10-17',
    envKillSwitch: true,
    redisKillSwitch: false,
    envLiveTrading: false,
    envPaperTrading: true,
    envCopyExecution: false,
  };
  assert(bootstrapStopReleaseAllowed(s, [null, null]));
  assert(blockers(s).includes('KILL_SWITCH_ACTIVE_OR_UNKNOWN'));
  assert.deepEqual(blockers({ ...s, killSwitch: false }), []);
  for (const [key, value] of [
    ['marker', null],
    ['envKillSwitch', false],
    ['redisKillSwitch', true],
    ['redisKillSwitch', null],
    ['envLiveTrading', true],
    ['envPaperTrading', false],
    ['envCopyExecution', true],
  ]) {
    const changed = structuredClone(s);
    changed.bootstrap[key] = value;
    assert.equal(bootstrapStopReleaseAllowed(changed, [null, null]), false, key);
  }
  for (const [key, value] of [
    ['activeCopyConfigs', 1],
    ['activeCopyConfigs', undefined],
  ]) {
    assert.equal(bootstrapStopReleaseAllowed({ ...s, [key]: value }, [null, null]), false);
  }
  assert.equal(bootstrapStopReleaseAllowed(s, [{ enabled: true }, null]), false);
  const unhealthy = structuredClone(s);
  unhealthy.network.scanner.state = 'UNHEALTHY';
  assert(
    blockers({ ...unhealthy, killSwitch: false }).includes('SCANNER_UNHEALTHY_REPAIR_RPC_OR_WS'),
  );
});

test('unknown Redis stop values stay unknown and block activation', () => {
  assert.equal(redisStopState('1'), true);
  assert.equal(redisStopState('0'), false);
  assert.equal(redisStopState(null), false);
  for (const value of [undefined, '', 'true', 'off', 'unexpected']) {
    assert.equal(redisStopState(value), null);
    assert(
      blockers({ ...healthy(), killSwitch: redisStopState(value) }).includes(
        'KILL_SWITCH_ACTIVE_OR_UNKNOWN',
      ),
    );
    assert(
      blockers({ ...healthy(), scannerPause: redisStopState(value) }).includes(
        'SCANNER_BUYS_PAUSED',
      ),
    );
  }
});

const date = '2026-10-23T00:00:00.000Z';
const changedDate = '2026-10-23T00:00:01.000Z';
const row = (key, enabled, at = date) => ({
  key,
  enabled,
  updatedByUserId: null,
  createdAt: date,
  updatedAt: at,
});

function database(initial = [], autoCount = 0) {
  const state = { rows: structuredClone(initial), audits: [], locks: [] };
  const db = { state };
  db.$transaction = async (callback) => {
    const saved = structuredClone(state);
    const tx = {
      $executeRawUnsafe: async (sql) => state.locks.push(sql),
      snipeConfig: { count: async () => autoCount },
      adminFeatureOverride: {
        findMany: async ({ where }) => state.rows.filter((r) => where.key.in.includes(r.key)),
        upsert: async ({ where, create, update }) => {
          const existing = state.rows.find((r) => r.key === where.key);
          if (existing)
            Object.assign(existing, update, {
              updatedAt: update.updatedAt ? new Date(update.updatedAt).toISOString() : changedDate,
            });
          else state.rows.push({ ...row(where.key, create.enabled, changedDate), ...create });
        },
        deleteMany: async ({ where }) => {
          state.rows = state.rows.filter((r) => r.key !== where.key);
        },
      },
      auditLog: {
        create: async ({ data }) => state.audits.push(structuredClone(data)),
        findFirst: async ({ where }) =>
          state.audits.find(
            (a) => a.action === where.action && a.metadata.operationId === where.metadata.equals,
          ) || null,
      },
    };
    try {
      return await callback(tx);
    } catch (e) {
      Object.assign(state, saved);
      throw e;
    }
  };
  return db;
}

test('enable touches only two flags and journals both sides for a lost response', async () => {
  const beforeRows = [row('LIVE_TRADING', false), row('ARBITRAGE_SCANNER_ENABLED', false)];
  const db = database(beforeRows);
  const before = featureSnapshot(beforeRows);
  await enableFeatures(db, { operationId: 'run1' }, before);
  assert(db.state.rows.filter((r) => FEATURE_KEYS.includes(r.key)).every((r) => r.enabled));
  assert.equal(db.state.rows.find((r) => r.key === 'ARBITRAGE_SCANNER_ENABLED').enabled, false);
  assert.equal(db.state.audits.length, 1);
  assert.deepEqual(db.state.audits[0].metadata.before, before);
  // Treat the successful enable response as lost; restore uses the durable journal.
  assert.equal(await restoreFeatures(db, { operationId: 'run1', before }), 'restored');
  assert.deepEqual(featureSnapshot(db.state.rows), before);
  assert.equal(await restoreFeatures(db, { operationId: 'run1', before }), 'already_restored');
});

test('activation rechecks unrelated buys and concurrent admin changes inside its transaction', async () => {
  const db = database([row('LIVE_TRADING', false)], 1);
  await assert.rejects(
    enableFeatures(db, { operationId: 'x' }, featureSnapshot(db.state.rows)),
    /UNRELATED_AUTO_BUYS/,
  );
  assert.equal(db.state.audits.length, 0);
  assert.equal(db.state.rows.length, 1);
  const current = database([row('LIVE_TRADING', true)]);
  await assert.rejects(
    enableFeatures(current, { operationId: 'x' }, featureSnapshot([row('LIVE_TRADING', false)])),
    /ADMIN_FLAGS_CHANGED/,
  );
  assert.equal(current.state.audits.length, 0);
});

test('rollback refuses a later admin edit, including a same-value edit with a new timestamp', async () => {
  const db = database([]),
    before = featureSnapshot([]);
  await enableFeatures(db, { operationId: 'run2' }, before);
  db.state.rows[0].updatedAt = '2026-10-23T01:00:00.000Z';
  await assert.rejects(restoreFeatures(db, { operationId: 'run2', before }), /LATER_ADMIN_EDIT/);
  assert.equal(db.state.rows.length, 2);
});

test('a failure before commit restores nothing unless current flags match the saved snapshot', async () => {
  const db = database([]),
    before = featureSnapshot([]);
  assert.equal(await restoreFeatures(db, { operationId: 'missing', before }), 'unchanged');
  db.state.rows.push(row('LIVE_TRADING', true));
  await assert.rejects(
    restoreFeatures(db, { operationId: 'missing', before }),
    /UNRECONCILED_FEATURE/,
  );
});
