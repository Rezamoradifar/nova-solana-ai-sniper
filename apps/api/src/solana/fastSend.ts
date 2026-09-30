import type { Logger } from '@nova/shared';

/**
 * Sends one already-signed transaction (raw bytes) somewhere. Resolves once that
 * endpoint accepted it; rejects if it refused. It never waits for confirmation.
 */
export type RawSender = { label: string; send: (raw: Uint8Array) => Promise<void> };

export interface FastSendConfig {
  /** Every endpoint a signed swap is sprayed to, all at once. */
  senders: RawSender[];
  /** How often the same signed bytes are re-sent until they confirm or expire. */
  rebroadcastMs: number;
}

let config: FastSendConfig | undefined;

/** Set once at worker startup. Unset (the default) keeps the single-RPC send path. */
export function configureFastSend(next: FastSendConfig | undefined): void {
  config = next;
}

export function getFastSendConfig(): FastSendConfig | undefined {
  return config;
}

/** A plain JSON-RPC sendTransaction to one RPC URL, preflight skipped. */
export function rpcSender(label: string, url: string, timeoutMs = 3_000): RawSender {
  return {
    label,
    async send(raw) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            Buffer.from(raw).toString('base64'),
            { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error) throw new Error(`${label}: ${body.error.message ?? 'rpc error'}`);
    },
  };
}

/**
 * Jito's single-transaction endpoint. It forwards straight to the current leader
 * over Jito's own network, which usually lands faster than a public RPC hop.
 */
export function jitoTransactionSender(blockEngineUrl: string, timeoutMs = 3_000): RawSender {
  return rpcSender(
    'jito-tx',
    `${blockEngineUrl.replace(/\/$/, '')}/api/v1/transactions`,
    timeoutMs,
  );
}

/**
 * Sprays the signed bytes to every sender in parallel. Returns the labels that
 * accepted it; throws only if every single one refused (nothing was sent).
 */
export async function sprayTransaction(
  raw: Uint8Array,
  senders: RawSender[],
  logger?: Logger,
): Promise<string[]> {
  const results = await Promise.allSettled(senders.map((s) => s.send(raw)));
  const accepted: string[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') accepted.push(senders[i]!.label);
    else errors.push(String((r.reason as Error)?.message ?? r.reason));
  });
  if (accepted.length === 0) {
    throw new Error(`fast send: every endpoint refused the transaction (${errors.join('; ')})`);
  }
  if (errors.length > 0) logger?.debug?.({ accepted, errors }, 'fast send: some endpoints refused');
  return accepted;
}

/**
 * Re-sends the same bytes every `intervalMs` until stopped. Same signature every
 * time, so the network executes it at most once no matter how many copies land.
 */
export function startRebroadcast(
  raw: Uint8Array,
  senders: RawSender[],
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    void Promise.allSettled(senders.map((s) => s.send(raw)));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
