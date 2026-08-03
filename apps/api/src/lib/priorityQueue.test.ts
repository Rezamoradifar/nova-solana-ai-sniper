import { describe, expect, it, vi } from 'vitest';
import { PriorityConcurrencyQueue } from './priorityQueue.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask queue — safer than counting `await Promise.resolve()`
 * hops, since the queue's internal dispatch has more than one microtask hop
 * per item (the sync/async-throw-safety wrapper, plus the handler itself). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PriorityConcurrencyQueue', () => {
  it('runs up to `concurrency` handlers at once and no more', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let call = 0;

    const queue = new PriorityConcurrencyQueue<number>(2, async () => {
      const gate = gates[call++]!;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate.promise;
      concurrent--;
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);

    // Let the queue settle so the first two handlers actually start.
    await flush();

    expect(maxConcurrent).toBe(2);
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(2);

    gates[0]!.resolve();
    gates[1]!.resolve();
    await flush();

    expect(maxConcurrent).toBe(2);
    gates[2]!.resolve();
    gates[3]!.resolve();
    await flush();

    expect(queue.pending()).toBe(0);
  });

  it('always drains FAST_PATH items before NORMAL items when both are waiting', async () => {
    const order: string[] = [];
    const gate = deferred();
    let started = 0;

    const queue = new PriorityConcurrencyQueue<string>(1, async (item) => {
      started++;
      if (started === 1) {
        // Hold the only worker slot open so both enqueues below land while busy.
        await gate.promise;
      }
      order.push(item);
    });

    queue.enqueue('first', 'NORMAL'); // occupies the single slot immediately
    queue.enqueue('normal-1', 'NORMAL');
    queue.enqueue('fast-1', 'FAST_PATH');
    queue.enqueue('normal-2', 'NORMAL');

    gate.resolve();
    await flush();

    expect(order).toEqual(['first', 'fast-1', 'normal-1', 'normal-2']);
  });

  it("a rejecting handler doesn't stop subsequent items and is reported via onError", async () => {
    const processed: number[] = [];
    const onError = vi.fn();
    const queue = new PriorityConcurrencyQueue<number>(
      1,
      async (item) => {
        if (item === 2) throw new Error('boom');
        processed.push(item);
      },
      onError,
    );

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await flush();

    expect(processed).toEqual([1, 3]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toBe(2);
  });

  it('enqueue never throws even when the handler throws synchronously', () => {
    const queue = new PriorityConcurrencyQueue<number>(1, () => {
      throw new Error('sync boom');
    });
    expect(() => queue.enqueue(1)).not.toThrow();
  });

  describe('setConcurrency (Massive Scanner Scalability, Phase 2, 2026-07-26)', () => {
    it('increasing concurrency at runtime immediately starts more queued work, without waiting for a new enqueue', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const gates = [deferred(), deferred(), deferred(), deferred()];
      let call = 0;

      const queue = new PriorityConcurrencyQueue<number>(1, async () => {
        const gate = gates[call++]!;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent--;
      });

      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);
      queue.enqueue(4);
      await flush();

      expect(queue.active()).toBe(1);
      expect(maxConcurrent).toBe(1);

      queue.setConcurrency(3);
      await flush();

      expect(queue.getConcurrency()).toBe(3);
      expect(queue.active()).toBe(3);
      expect(maxConcurrent).toBe(3);

      gates.forEach((g) => g.resolve());
      await flush();
    });

    it('decreasing concurrency stops new items from starting once the lower limit is reached, without cancelling in-flight work', async () => {
      const gates = [deferred(), deferred(), deferred(), deferred()];
      let call = 0;
      const queue = new PriorityConcurrencyQueue<number>(3, async () => {
        const gate = gates[call++]!;
        await gate.promise;
      });

      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);
      queue.enqueue(4); // 4th item waits — concurrency is 3
      await flush();
      expect(queue.active()).toBe(3);
      expect(queue.pending()).toBe(1);

      queue.setConcurrency(1);
      expect(queue.active()).toBe(3); // in-flight work is never cancelled

      gates[0]!.resolve();
      await flush();
      // A slot freed up, but active(2) is still above the new limit(1) — the
      // 4th item must stay queued rather than starting.
      expect(queue.active()).toBe(2);
      expect(queue.pending()).toBe(1);

      gates[1]!.resolve();
      await flush();
      // Now at the limit — still no room for the 4th item.
      expect(queue.active()).toBe(1);
      expect(queue.pending()).toBe(1);

      gates[2]!.resolve();
      await flush();
      // Below the limit again — the 4th item finally starts.
      expect(queue.active()).toBe(1);
      expect(queue.pending()).toBe(0);

      gates[3]!.resolve();
      await flush();
      expect(queue.active()).toBe(0);
    });

    it('clamps a non-positive concurrency to 1 instead of stalling the queue forever', async () => {
      const queue = new PriorityConcurrencyQueue<number>(1, async () => {});
      queue.setConcurrency(0);
      expect(queue.getConcurrency()).toBe(1);
      queue.setConcurrency(-5);
      expect(queue.getConcurrency()).toBe(1);
    });
  });

  describe('processed (Massive Scanner Scalability, Phase 2, 2026-07-26)', () => {
    it('counts every item drained, whether the handler resolved or rejected', async () => {
      const queue = new PriorityConcurrencyQueue<number>(
        2,
        async (item) => {
          if (item === 2) throw new Error('boom');
        },
        () => {},
      );

      expect(queue.processed()).toBe(0);
      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);
      await flush();

      expect(queue.processed()).toBe(3);
    });
  });
});
