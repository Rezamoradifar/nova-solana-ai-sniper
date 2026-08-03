import { describe, expect, it, vi } from 'vitest';
import { FallbackLaunchDiscovery } from './fallbackLaunchDiscovery.js';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function fakePrisma(existingMints: string[] = []) {
  const existing = new Set(existingMints);
  return {
    token: {
      findUnique: vi.fn(({ where: { mint } }: { where: { mint: string } }) =>
        Promise.resolve(existing.has(mint) ? { id: mint } : null),
      ),
    },
  };
}

interface FakeSigInfo {
  signature: string;
  err: unknown;
  blockTime: number;
}

function sig(signature: string, blockTime = Math.floor(Date.now() / 1000)): FakeSigInfo {
  return { signature, err: null, blockTime };
}

function fakeCreateTx(mint: string, deployer = 'deployer1') {
  return {
    meta: {
      logMessages: ['Program log: Instruction: Create'],
      preTokenBalances: [],
      postTokenBalances: [{ mint }],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => deployer } }] } },
  };
}

function fakeNonCreateTx() {
  return {
    meta: {
      logMessages: ['Program log: Instruction: Buy'],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => 'x' } }] } },
  };
}

function fakeConnection(opts: {
  signaturePages: FakeSigInfo[][];
  txByMintSignature: Map<string, unknown>;
}) {
  let pageCall = 0;
  return {
    getSignaturesForAddress: vi.fn(async () => {
      const page = opts.signaturePages[pageCall] ?? [];
      pageCall += 1;
      return page;
    }),
    getParsedTransaction: vi.fn(
      async (signature: string) => opts.txByMintSignature.get(signature) ?? null,
    ),
  };
}

describe('FallbackLaunchDiscovery', () => {
  it('idleTick is cheap: one signature-list call, no per-signature parsing, and sets the watermark', async () => {
    const connection = fakeConnection({
      signaturePages: [[sig('head-sig')]],
      txByMintSignature: new Map(),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate,
    });

    discovery.start();
    await vi.waitFor(() => expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1));
    discovery.stop();

    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
    expect(discovery.getHealth().reachable).toBe(true);
    expect(discovery.getHealth().lastIdleTickAt).toBeDefined();
  });

  it('idleTick failure marks the path unreachable and counts consecutive failures', async () => {
    const connection = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('rpc down')),
      getParsedTransaction: vi.fn(),
    };
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate: vi.fn(),
    });

    discovery.start();
    await vi.waitFor(() => expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1));
    discovery.stop();

    expect(discovery.getHealth().reachable).toBe(false);
    expect(discovery.getHealth().consecutiveFailures).toBeGreaterThan(0);
  });

  it('activeScan finds a genuine Create, extracts the mint, and feeds it through onCandidate', async () => {
    const createTx = fakeCreateTx('MINT111');
    const connection = fakeConnection({
      signaturePages: [[sig('create-sig'), { ...sig('buy-sig') }]],
      txByMintSignature: new Map([
        ['create-sig', createTx],
        ['buy-sig', fakeNonCreateTx()],
      ]),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate,
    });

    const result = await discovery.activeScan('fallback');

    expect(onCandidate).toHaveBeenCalledTimes(1);
    expect(onCandidate).toHaveBeenCalledWith({ mint: 'MINT111', deployerAddress: 'deployer1' });
    expect(result.candidatesFound).toBe(1);
    expect(result.duplicatesRejected).toBe(0);
  });

  it('skips signatures with a non-null err (failed inner tx) without ever parsing them', async () => {
    const connection = fakeConnection({
      signaturePages: [
        [
          {
            signature: 'failed-sig',
            err: { InstructionError: [] },
            blockTime: Math.floor(Date.now() / 1000),
          },
        ],
      ],
      txByMintSignature: new Map(),
    });
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate: vi.fn(),
    });

    const result = await discovery.activeScan('fallback');

    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
    expect(result.signaturesScanned).toBe(1);
    expect(result.candidatesFound).toBe(0);
  });

  it('deduplicates by mint: rejects a candidate already tracked in the DB', async () => {
    const createTx = fakeCreateTx('MINT_EXISTING');
    const connection = fakeConnection({
      signaturePages: [[sig('create-sig')]],
      txByMintSignature: new Map([['create-sig', createTx]]),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma(['MINT_EXISTING']) as never,
      logger: fakeLogger(),
      onCandidate,
    });

    const result = await discovery.activeScan('fallback');

    expect(onCandidate).not.toHaveBeenCalled();
    expect(result.duplicatesRejected).toBe(1);
  });

  it('deduplicates by mint within the same scan pass (two signatures resolving the same mint)', async () => {
    const createTx = fakeCreateTx('MINT_TWICE');
    const connection = fakeConnection({
      signaturePages: [[sig('sig-a'), sig('sig-b')]],
      txByMintSignature: new Map([
        ['sig-a', createTx],
        ['sig-b', fakeCreateTx('MINT_TWICE')],
      ]),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate,
    });

    const result = await discovery.activeScan('fallback');

    expect(onCandidate).toHaveBeenCalledTimes(1);
    expect(result.duplicatesRejected).toBe(1);
  });

  it('bounds an active scan by maxLookbackMs even if more signatures are available', async () => {
    const oldBlockTime = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000); // 3h ago
    const connection = fakeConnection({
      signaturePages: [
        [sig('recent-sig', Math.floor(Date.now() / 1000)), sig('old-sig', oldBlockTime)],
        [sig('even-older-sig', oldBlockTime - 1000)],
      ],
      txByMintSignature: new Map([
        ['recent-sig', fakeCreateTx('RECENT_MINT')],
        ['old-sig', fakeCreateTx('OLD_MINT')],
      ]),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery(
      {
        connection: connection as never,
        prisma: fakePrisma() as never,
        logger: fakeLogger(),
        onCandidate,
      },
      { maxLookbackMs: 60 * 60 * 1000 }, // 1h — the 3h-old page should stop pagination
    );

    await discovery.activeScan('fallback');

    // Paged exactly once more after hitting the lookback floor, not into the
    // (never-fetched) even-older page.
    expect(connection.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('a failed activeScan never throws and reports unreachable', async () => {
    const connection = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('down')),
      getParsedTransaction: vi.fn(),
    };
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate: vi.fn(),
    });

    await expect(discovery.activeScan('fallback')).resolves.toEqual({
      signaturesScanned: 0,
      candidatesFound: 0,
      duplicatesRejected: 0,
    });
    expect(discovery.getHealth().reachable).toBe(false);
  });

  it('runReconciliation is a thin wrapper around activeScan("reconciliation")', async () => {
    const createTx = fakeCreateTx('RECONCILED_MINT');
    const connection = fakeConnection({
      signaturePages: [[sig('sig-a')]],
      txByMintSignature: new Map([['sig-a', createTx]]),
    });
    const onCandidate = vi.fn();
    const discovery = new FallbackLaunchDiscovery({
      connection: connection as never,
      prisma: fakePrisma() as never,
      logger: fakeLogger(),
      onCandidate,
    });

    const result = await discovery.runReconciliation();

    expect(result.candidatesFound).toBe(1);
    expect(onCandidate).toHaveBeenCalledWith({
      mint: 'RECONCILED_MINT',
      deployerAddress: 'deployer1',
    });
  });

  it('fallback mode start/stop toggles fallbackModeActive and runs activeScan on an interval', async () => {
    vi.useFakeTimers();
    try {
      const connection = fakeConnection({ signaturePages: [[]], txByMintSignature: new Map() });
      const discovery = new FallbackLaunchDiscovery(
        {
          connection: connection as never,
          prisma: fakePrisma() as never,
          logger: fakeLogger(),
          onCandidate: vi.fn(),
        },
        { activeIntervalMs: 1000 },
      );

      expect(discovery.fallbackModeActive).toBe(false);
      discovery.startFallbackMode();
      expect(discovery.fallbackModeActive).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(connection.getSignaturesForAddress).toHaveBeenCalled();

      discovery.stopFallbackMode();
      expect(discovery.fallbackModeActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
