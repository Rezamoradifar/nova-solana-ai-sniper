import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

/** A handful of known Jito tip accounts; one is chosen at random per bundle. */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGeJy2D',
];

export interface JitoConfig {
  blockEngineUrl: string;
}

export class JitoClient {
  constructor(private readonly config: JitoConfig) {}

  static randomTipAccount(): PublicKey {
    const acct = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
    return new PublicKey(acct);
  }

  /** Builds a small transfer transaction that pays the Jito validator tip. */
  static buildTipTransaction(
    payer: Keypair,
    tipLamports: number,
    recentBlockhash: string,
  ): Transaction {
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: JitoClient.randomTipAccount(),
        lamports: tipLamports,
      }),
    );
    tx.sign(payer);
    return tx;
  }

  /** Submits a bundle (array of base64-encoded signed transactions) to the Jito block engine. */
  async sendBundle(transactions: (Transaction | VersionedTransaction)[]): Promise<string> {
    const encoded = transactions.map((tx) => Buffer.from(tx.serialize()).toString('base64'));

    const res = await fetch(`${this.config.blockEngineUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [encoded, { encoding: 'base64' }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Jito bundle submission failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) {
      throw new Error(`Jito bundle error: ${body.error.message}`);
    }
    return body.result ?? '';
  }
}
