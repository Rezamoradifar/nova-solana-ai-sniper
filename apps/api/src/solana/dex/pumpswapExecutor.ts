import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PUMPSWAP_PROGRAM_ID, getPumpSwapPoolState } from './pumpswap.js';
import type { NativeDexExecutor, NativeSwapParams } from './types.js';

/**
 * Fallback-only native PumpSwap swap builder — Jupiter (which already routes
 * through PumpSwap) is the primary execution path; this only fires when Jupiter
 * can't find a route. Every account, PDA seed, and instruction discriminator here
 * is sourced directly from pump-fun's own published IDL
 * (github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json), not
 * reverse-engineered or guessed. Never sends a transaction itself — callers must
 * simulate first (same discipline the existing Jupiter path already follows in
 * JupiterClient.prepareSwap) before ever treating the result as sendable.
 *
 * Verification status: the `global_config` PDA seed was confirmed live against a
 * real mainnet pool, and a full signed `simulateTransaction` dry-run (real wallet,
 * real signature, no broadcast) was run with the user's explicit authorization.
 * That dry-run caught a real bug: PumpSwap consumes SOL as an SPL token balance
 * (WSOL), not natively, so a buy failed with `AccountNotInitialized` on
 * `user_quote_token_account` — nothing had wrapped the SOL into a WSOL account
 * first. Fixed by wrapping (idempotent ATA + transfer + sync-native) before a buy
 * and unwrapping (close account) after a sell, matching the
 * `wrapAndUnwrapSol: true` behavior Jupiter's own path already relies on. A re-run
 * confirmed that specific error is gone.
 *
 * A follow-up dry-run then failed on-chain with `InvalidProtocolFeeRecipient`
 * (error 6013): the pool used to test (4bBe7N8WTABTr4AQFkKiM9ST54g8Z9Kb8qy2HTrWGzhn)
 * has its `is_mayhem_mode` byte set to 1, and mayhem-mode pools only accept a
 * recipient from `GlobalConfig.reserved_fee_recipient`/`reserved_fee_recipients`,
 * not the normal `protocol_fee_recipients` array this code was unconditionally
 * reading from. Fixed by decoding the pool's `is_mayhem_mode` flag (see
 * `pumpswap.ts`) and selecting from the matching recipient set. A re-run against
 * the same real pool confirmed `InvalidProtocolFeeRecipient` no longer occurs.
 *
 * That same re-run then failed on-chain with `Overflow` (error 6023,
 * `programs/pump-amm/src/instructions/swap/buy.rs:438`). Diagnosed via pump-fun's
 * own `pump-public-docs` GitHub repo (issue #29 and `docs/BREAKING_FEE_RECIPIENT.md`):
 * an April 28 program upgrade added a `pool_v2` PDA (seeds `["pool-v2", base_mint]`)
 * plus 2 more accounts — one of 8 new fee-recipient pubkeys (readonly) and that
 * recipient's quote-mint ATA (mutable) — that must be appended to the *end* of both
 * `buy` and `sell`'s account list, required for every pool regardless of
 * cashback/mayhem status. The published IDL this executor was built from predates
 * that upgrade, so the account list was 3 accounts short; the program reports that
 * as a generic arithmetic `Overflow` rather than a missing-account error. Fixed by
 * appending `pool_v2` + a fee recipient + its ATA (see `poolV2Pda` and
 * `NEW_FEE_RECIPIENTS` below).
 *
 * KNOWN OPEN ISSUE: this fix is sourced from pump-fun's own docs/issue tracker, not
 * yet confirmed against a fresh signed `simulateTransaction` dry-run (the prior
 * dry-run predates this account-list change). `PositionManager` always calls
 * `simulateTransaction` and refuses to send on any simulation error before this
 * executor's output is ever used for a real trade (see positionManager.test.ts), so
 * this still fails closed. Do not treat this executor as verified end-to-end until a
 * clean dry-run (zero simulation error) is confirmed.
 */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// fee_config's second PDA seed, a fixed constant per the IDL (not derived from any
// account — it's the same for every pool).
const FEE_CONFIG_SEED_2 = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213,
  113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
]);

// Published by pump-fun in docs/BREAKING_FEE_RECIPIENT.md for the April 28 program
// upgrade: any one of these 8 is a valid "new" fee recipient (same load-distribution
// pattern as GlobalConfig.protocol_fee_recipients), so the first is used.
const NEW_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map((s) => new PublicKey(s));

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const globalConfigPda = () => pda([Buffer.from('global_config')], PUMPSWAP_PROGRAM_ID);
const eventAuthorityPda = () => pda([Buffer.from('__event_authority')], PUMPSWAP_PROGRAM_ID);
const globalVolumeAccumulatorPda = () =>
  pda([Buffer.from('global_volume_accumulator')], PUMPSWAP_PROGRAM_ID);
const userVolumeAccumulatorPda = (user: PublicKey) =>
  pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMPSWAP_PROGRAM_ID);
const coinCreatorVaultAuthorityPda = (coinCreator: PublicKey) =>
  pda([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMPSWAP_PROGRAM_ID);
const feeConfigPda = () => pda([Buffer.from('fee_config'), FEE_CONFIG_SEED_2], FEE_PROGRAM_ID);
// Added by the same April 28 upgrade as NEW_FEE_RECIPIENTS above (seeds per
// pump-fun's pump-public-docs issue #29: ["pool-v2", base_mint]).
const poolV2Pda = (baseMint: PublicKey) =>
  pda([Buffer.from('pool-v2'), baseMint.toBuffer()], PUMPSWAP_PROGRAM_ID);

async function getTokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  if (mint.equals(WSOL_MINT)) return TOKEN_PROGRAM_ID;
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on-chain`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

interface GlobalConfigState {
  protocolFeeRecipients: PublicKey[];
  reservedFeeRecipients: PublicKey[];
}

/**
 * GlobalConfig layout per the IDL: 8-byte discriminator, admin (32), lp_fee_bp (8),
 * protocol_fee_bp (8), disable_flags (1), protocol_fee_recipients ([Pubkey; 8]),
 * coin_creator_fee_bp (8), admin_set_coin_creator_authority (32), whitelist_pda
 * (32), reserved_fee_recipient (32), mayhem_mode_enabled (1),
 * reserved_fee_recipients ([Pubkey; 7]).
 *
 * The program validates the passed recipient is a member of one of two disjoint
 * sets depending on the *pool's own* `is_mayhem_mode` flag (see pumpswap.ts):
 * non-mayhem pools require a `protocol_fee_recipients` entry, mayhem-mode pools
 * require `reserved_fee_recipient` or a `reserved_fee_recipients` entry. Verified
 * live: a real pool with `is_mayhem_mode = true` failed a signed
 * simulateTransaction dry-run with `InvalidProtocolFeeRecipient` (6013) when given
 * a normal-set recipient, which is what motivated reading both sets here instead of
 * hardcoding the normal set.
 */
function decodeGlobalConfig(data: Buffer): GlobalConfigState {
  let offset = 8 + 32 + 8 + 8 + 1;
  const protocolFeeRecipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) {
    protocolFeeRecipients.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  offset += 8 + 32 + 32; // coin_creator_fee_bp, admin_set_coin_creator_authority, whitelist_pda
  const reservedFeeRecipients: PublicKey[] = [
    new PublicKey(data.subarray(offset, offset + 32)), // reserved_fee_recipient
  ];
  offset += 32 + 1; // reserved_fee_recipient, mayhem_mode_enabled
  for (let i = 0; i < 7; i++) {
    reservedFeeRecipients.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }
  return { protocolFeeRecipients, reservedFeeRecipients };
}

/**
 * Constant-product quote from raw (non-decimal-adjusted) reserves, matching the
 * same x*y=k model used for liquidity estimation elsewhere in this codebase.
 * Ignores the pool's actual fee basis points (read from GlobalConfig, not applied
 * here) — acceptable for a rarely-used fallback path since the result is only ever
 * a floor/ceiling bound, protected by simulation before any send.
 */
export function quoteConstantProduct(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  return (reserveOut * amountIn) / (reserveIn + amountIn);
}

/** Applies a downward slippage discount (in bps) to a raw amount — never negative. */
export function applySlippageFloor(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

export class PumpSwapExecutor implements NativeDexExecutor {
  readonly dex = 'PUMPSWAP';

  async buildSwap(params: NativeSwapParams): Promise<VersionedTransaction> {
    const { connection, signer, inputMint, outputMint, amountLamports, slippageBps, poolAddress } =
      params;
    if (!poolAddress) {
      throw new Error('PumpSwap executor requires a known poolAddress (from Token.poolAddress)');
    }

    const pool = await getPumpSwapPoolState(connection, poolAddress);
    if (!pool) {
      throw new Error(
        `PumpSwap pool ${poolAddress} not found or not owned by the PumpSwap program`,
      );
    }

    const isBuy = inputMint === pool.quoteMint && outputMint === pool.baseMint;
    const isSell = inputMint === pool.baseMint && outputMint === pool.quoteMint;
    if (!isBuy && !isSell) {
      throw new Error(
        `Mint pair ${inputMint}/${outputMint} does not match pool ${poolAddress}'s base/quote (${pool.baseMint}/${pool.quoteMint})`,
      );
    }

    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const poolPubkey = new PublicKey(poolAddress);
    const coinCreator = new PublicKey(pool.coinCreator);

    const [baseTokenProgram, quoteTokenProgram, baseBal, quoteBal, globalConfigInfo] =
      await Promise.all([
        getTokenProgramForMint(connection, baseMint),
        getTokenProgramForMint(connection, quoteMint),
        connection.getTokenAccountBalance(new PublicKey(pool.poolBaseTokenAccount)),
        connection.getTokenAccountBalance(new PublicKey(pool.poolQuoteTokenAccount)),
        connection.getAccountInfo(globalConfigPda()),
      ]);
    if (!globalConfigInfo) throw new Error('PumpSwap GlobalConfig account not found');
    const globalConfig = decodeGlobalConfig(globalConfigInfo.data);
    // Mayhem-mode pools only accept a reserved-set recipient; everyone else only
    // accepts a normal-set recipient (see decodeGlobalConfig's docstring).
    const protocolFeeRecipient = pool.isMayhemMode
      ? globalConfig.reservedFeeRecipients[0]!
      : globalConfig.protocolFeeRecipients[0]!;

    const baseReserve = BigInt(baseBal.value.amount);
    const quoteReserve = BigInt(quoteBal.value.amount);

    const userBaseAta = getAssociatedTokenAddressSync(
      baseMint,
      signer.publicKey,
      false,
      baseTokenProgram,
    );
    const userQuoteAta = getAssociatedTokenAddressSync(
      quoteMint,
      signer.publicKey,
      false,
      quoteTokenProgram,
    );
    const protocolFeeRecipientAta = getAssociatedTokenAddressSync(
      quoteMint,
      protocolFeeRecipient,
      true,
      quoteTokenProgram,
    );
    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);
    const coinCreatorVaultAta = getAssociatedTokenAddressSync(
      quoteMint,
      coinCreatorVaultAuthority,
      true,
      quoteTokenProgram,
    );

    const keys = [
      { pubkey: poolPubkey, isSigner: false, isWritable: true },
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: globalConfigPda(), isSigner: false, isWritable: false },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.poolBaseTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(pool.poolQuoteTokenAccount), isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },
      { pubkey: protocolFeeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram, isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey('11111111111111111111111111111111'),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },
    ];

    let data: Buffer;
    if (isBuy) {
      const estimatedBaseOut = quoteConstantProduct(quoteReserve, baseReserve, amountLamports);
      const baseAmountOut = applySlippageFloor(estimatedBaseOut, slippageBps);
      if (baseAmountOut <= 0n) throw new Error('Computed buy quote is zero — pool has no depth');

      keys.push(
        { pubkey: globalVolumeAccumulatorPda(), isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulatorPda(signer.publicKey), isSigner: false, isWritable: true },
        { pubkey: feeConfigPda(), isSigner: false, isWritable: false },
        { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      );

      data = Buffer.concat([
        BUY_DISCRIMINATOR,
        u64le(baseAmountOut),
        u64le(amountLamports), // max_quote_amount_in: the hard SOL spend cap
        Buffer.from([0]), // track_volume: false
      ]);
    } else {
      const estimatedQuoteOut = quoteConstantProduct(baseReserve, quoteReserve, amountLamports);
      const minQuoteOut = applySlippageFloor(estimatedQuoteOut, slippageBps);

      keys.push(
        { pubkey: feeConfigPda(), isSigner: false, isWritable: false },
        { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      );

      data = Buffer.concat([
        SELL_DISCRIMINATOR,
        u64le(amountLamports), // base_amount_in: exact tokens being sold
        u64le(minQuoteOut),
      ]);
    }

    // Required by the April 28 program upgrade for both buy and sell, for every
    // pool (see file header and NEW_FEE_RECIPIENTS/poolV2Pda above). Omitting these
    // is what produced the Overflow (6023) error this fix addresses.
    const newFeeRecipient = NEW_FEE_RECIPIENTS[0]!;
    const newFeeRecipientAta = getAssociatedTokenAddressSync(
      quoteMint,
      newFeeRecipient,
      true,
      quoteTokenProgram,
    );
    keys.push(
      { pubkey: poolV2Pda(baseMint), isSigner: false, isWritable: false },
      { pubkey: newFeeRecipient, isSigner: false, isWritable: false },
      { pubkey: newFeeRecipientAta, isSigner: false, isWritable: true },
    );

    const ix = new TransactionInstruction({ programId: PUMPSWAP_PROGRAM_ID, keys, data });

    // Idempotent: never fails if the ATA already exists, matching the existing
    // Jupiter-swap path's assumption that ATA setup is the caller's problem to not
    // block on — this makes the native path self-sufficient instead.
    const receivingAta = isBuy ? userBaseAta : userQuoteAta;
    const receivingMint = isBuy ? baseMint : quoteMint;
    const receivingTokenProgram = isBuy ? baseTokenProgram : quoteTokenProgram;
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey,
      receivingAta,
      signer.publicKey,
      receivingMint,
      receivingTokenProgram,
    );

    const instructions: TransactionInstruction[] = [ataIx];

    if (isBuy) {
      // PumpSwap consumes SOL as an SPL token balance (WSOL), not natively — the
      // quote side has to actually be wrapped before the Buy instruction can spend
      // it. Verified live: omitting this fails with AccountNotInitialized on
      // user_quote_token_account.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          userQuoteAta,
          signer.publicKey,
          quoteMint,
          quoteTokenProgram,
        ),
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: userQuoteAta,
          lamports: amountLamports,
        }),
        createSyncNativeInstruction(userQuoteAta, quoteTokenProgram),
      );
    }

    instructions.push(ix);

    if (isSell) {
      // Mirror image of the buy-side wrap: unwrap the WSOL received back to native
      // SOL and reclaim the account's rent, matching the same
      // wrapAndUnwrapSol: true behavior Jupiter's own swaps already rely on (so a
      // sell through this fallback lands real SOL, not a stranded WSOL balance).
      instructions.push(
        createCloseAccountInstruction(
          userQuoteAta,
          signer.publicKey,
          signer.publicKey,
          [],
          quoteTokenProgram,
        ),
      );
    }

    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([signer]);
    return tx;
  }
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}
