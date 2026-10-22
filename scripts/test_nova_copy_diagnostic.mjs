import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  checkRpc,
  checkWs,
  classifyError,
  probeWsUrl,
  stopSummary,
} from './diagnose-nova-copy.mjs';

const { queueMicrotask } = globalThis;

const SECRET = 'private-provider-token';
const URL = 'https://provider.invalid/' + SECRET;
const response = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });

test('RPC checks verify actual mainnet identity and shapes without returning provider data', async () => {
  for (const [method, result, status] of [
    ['getGenesisHash', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'OK'],
    ['getGenesisHash', 'different-network-' + SECRET, 'MAINNET_NOT_VERIFIED'],
    ['getSlot', 123, 'OK'],
    ['getSlot', SECRET, 'INVALID_RESULT'],
    ['getLatestBlockhash', { value: { blockhash: SECRET, lastValidBlockHeight: 123 } }, 'OK'],
    ['getLatestBlockhash', { value: { blockhash: SECRET } }, 'INVALID_RESULT'],
  ]) {
    const report = await checkRpc(URL, method, async (_url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(JSON.parse(init.body).method, method);
      return response(result);
    });
    assert.equal(report.status, status);
    assert(!JSON.stringify(report).includes(SECRET));
  }
});

test('HTTP and RPC diagnostics preserve status and numeric codes while discarding secrets', async () => {
  for (const [status, expected] of [
    [403, 'ACCESS_DENIED'],
    [429, 'RATE_LIMITED'],
    [502, 'HTTP_ERROR'],
  ]) {
    let cancelled = false;
    const report = await checkRpc(URL, 'getSlot', async () => ({
      ok: false,
      status,
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    }));
    assert.equal(report.status, expected);
    assert(cancelled);
  }
  const report = await checkRpc(URL, 'getSlot', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: { code: -32005, message: URL, data: SECRET } }),
  }));
  assert.deepEqual(report, { method: 'getSlot', http: 200, status: 'RPC_ERROR', rpcCode: -32005 });
  assert(!JSON.stringify(report).includes(SECRET));
});

test('transport failures classify bounded codes and never expose URLs or provider messages', async () => {
  for (const [extra, expected] of [
    [{ name: 'TimeoutError' }, 'TIMEOUT'],
    [{ cause: { code: 'EAI_AGAIN' } }, 'DNS_LOOKUP_FAILED'],
    [{ code: 'ENETUNREACH' }, 'NETWORK_UNREACHABLE'],
    [{}, 'CONNECTION_OR_RESPONSE_ERROR'],
  ]) {
    const error = Object.assign(new Error(URL), extra);
    assert.equal(classifyError(error), expected);
    const report = await checkRpc(URL, 'getSlot', async () => {
      throw error;
    });
    assert.equal(report.status, expected);
    assert(!JSON.stringify(report).includes(SECRET));
  }
});

test('WS URL follows explicit settings and web3 HTTPS, port and IPv6 conventions', () => {
  assert.equal(
    probeWsUrl({ url: URL, wsUrl: 'wss://different.invalid/explicit' }),
    'wss://different.invalid/explicit',
  );
  assert.equal(probeWsUrl({ url: URL }), URL.replace('https:', 'wss:'));
  assert.equal(
    probeWsUrl({ url: 'http://127.0.0.1:8899/path?key=hidden' }),
    'ws://127.0.0.1:8900/path?key=hidden',
  );
  assert.equal(probeWsUrl({ url: 'https://[::1]:9000/token' }), 'wss://[::1]:9001/token');
  assert.throws(() => probeWsUrl({ url: 'not-a-url' }));
});

function socketFor(onSend, onOpen) {
  return class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => (onOpen ? onOpen(this) : this.emit('open')));
    }
    send(data) {
      const request = JSON.parse(data);
      assert.equal(request.method, 'logsSubscribe');
      assert.deepEqual(request.params[0], {
        mentions: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      });
      onSend(this, request);
    }
    terminate() {
      this.emit('close');
    }
  };
}
const frame = (socket, message) => socket.emit('message', JSON.stringify(message));

test('WS requires a matching real log notification and distinguishes an idle subscription', async () => {
  const live = socketFor((socket) => {
    frame(socket, { id: 1, result: 0 });
    frame(socket, {
      method: 'logsNotification',
      params: {
        subscription: 0,
        result: { value: { logs: ['private log ' + SECRET], signature: SECRET } },
      },
    });
  });
  assert.deepEqual(await checkWs(URL, live, 50), { status: 'LOGS_RECEIVED', subscribed: true });
  const wrongSubscription = socketFor((socket) => {
    frame(socket, { id: 1, result: 12 });
    frame(socket, {
      method: 'logsNotification',
      params: { subscription: 13, result: { value: { logs: [], signature: SECRET } } },
    });
  });
  assert.deepEqual(await checkWs(URL, wrongSubscription, 5), {
    status: 'SUBSCRIBED_NO_LOGS',
    subscribed: true,
  });
});

test('WS rejection and transport failures redact provider-controlled text', async () => {
  const cases = [
    [
      socketFor((socket) => frame(socket, { id: 1, error: { code: -32001, message: URL } })),
      'WS_RPC_ERROR',
    ],
    [socketFor((socket) => frame(socket, { id: 1, result: SECRET })), 'INVALID_SUBSCRIBE_RESPONSE'],
    [
      socketFor(
        () => {},
        (socket) => socket.emit('error', new Error(URL)),
      ),
      'CONNECTION_OR_RESPONSE_ERROR',
    ],
    [
      socketFor(
        () => {},
        (socket) => socket.emit('unexpected-response', {}, { statusCode: 401, resume() {} }),
      ),
      'ACCESS_DENIED',
    ],
  ];
  for (const [Socket, expected] of cases) {
    const report = await checkWs(URL, Socket, 50);
    assert.equal(report.status, expected);
    assert(!JSON.stringify(report).includes(SECRET));
  }
});

test('stop diagnostics separate env, Redis and automatic pauses without printing manual reasons', () => {
  const config = { KILL_SWITCH: true, SCANNER_AUTO_BUY_AUTO_RESUME_ENABLED: true };
  assert.equal(
    stopSummary(config, ['0', '1', 'all launch-detection sources unhealthy']).scannerPauseSource,
    'AUTOMATIC_OUTAGE',
  );
  const manual = stopSummary(config, ['1', '1', SECRET]);
  assert.equal(manual.envKillSwitch, true);
  assert.equal(manual.redisKillSwitch, true);
  assert.equal(manual.scannerPauseSource, 'OTHER_OR_MANUAL');
  assert(!JSON.stringify(manual).includes(SECRET));
  assert.equal(stopSummary(config).redisKillSwitch, null);
  assert.equal(stopSummary(config, ['unrecognized', '1', null]).redisKillSwitch, null);
});
