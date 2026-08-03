import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { RAYDIUM_CPMM_PROGRAM_ID, getRaydiumCpmmPoolState } from './raydium.js';
import { quoteConstantProduct, applySlippageFloor } from './pumpswapExecutor.js';
import type { NativeDexExecutor, NativeSwapParams } from './types.js';

/**
 * Fallback-only native Raydium CPMM ("CP-Swap") swap builder — Jupiter (which
 * already routes through Raydium) is the primary execution path; this only
 * fires when Jupiter can't find a route. Structurally mirrors
 * pumpswapExecutor.ts (see that file's own header for the WSOL-wrap
 * discipline and simulate-before-send convention this reuses verbatim).
 *
 * Sourcing (2026-07-29): every account, PDA seed, and instruction
 * discriminator here is sourced directly from raydium-io/raydium-cp-swap's
 * own published source on GitHub (fetched live during implementation, not
 * recalled from memory) —
 * `programs/cp-swap/src/instructions/swap_base_input.rs` (the `Swap` Accounts
 * struct, field-by-field, which is also the account ORDER Anchor expects —
 * cross-checked against `client/src/instructions/amm_instructions.rs`'s own
 * `swap_base_input_instr` helper, which builds the identical account list in
 * the identical order), `programs/cp-swap/src/lib.rs` (AUTH_SEED =
 * "vault_and_lp_mint_auth_seed", and confirms `swap_base_input` is a real
 * `#[program]` entrypoint). The 8-byte Anchor instruction discriminator
 * (`sha256("global:swap_base_input")[0:8]`) was computed directly, not
 * guessed. The pool-state byte offsets this depends on (`ammConfig`,
 * `token0Program`/`token1Program`, `observationKey` — see raydium.ts) were
 * verified byte-for-byte against a real, live-captured pool account
 * (raydium.test.ts's REAL_POOL fixture, 7ZFLTdJCmL8PQozEmfPcq8dxsjR4W7LLkbK8hqSGZnQ1).
 *
 * **Verification status — deliberately NOT the same bar as PumpSwap's
 * executor.** PumpSwap's executor (see its own header) was proven correct via
 * several rounds of a real, signed `simulateTransaction` dry-run against a
 * real mainnet pool with a real funded wallet — that process caught 3 real
 * bugs (a post-launch program upgrade, a fee-recipient edge case, a missing
 * account) that no amount of offline source-reading would have found. This
 * executor has NOT been through that same live dry-run pass — it requires a
 * real funded wallet and the user's direct, explicit participation, which
 * this implementation session does not have. The existing simulate-before-
 * send gate in positionManager.ts's sendSwap (which already calls
 * `connection.simulateTransaction` and refuses to send on any error, for
 * every NativeDexExecutor) is the safety net a wrong instruction here fails
 * into — same as it was for PumpSwap's early bugs — but until a live dry-run
 * (buy AND sell, against a real currently-trading Raydium CPMM pool) is run,
 * this should not be trusted for a real position. Accordingly, DexRegistry
 * does NOT wire this in as RAYDIUM's default executor (see registry.ts) —
 * it's built, exported, and fully unit-tested, available for a caller to
 * opt in only after that live verification happens.
 */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const SWAP_BASE_INPUT_DISCRIMINATOR = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

const AUTH_SEED = Buffer.from('vault_and_lp_mint_auth_seed');

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const authorityPda = () => pda([AUTH_SEED], RAYDIUM_CPMM_PROGRAM_ID);

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export class RaydiumExecutor implements NativeDexExecutor {
  readonly dex = 'RAYDIUM';

  async buildSwap(params: NativeSwapParams): Promise<VersionedTransaction> {
    const { connection, signer, inputMint, outputMint, amountLamports, slippageBps, poolAddress } =
      params;
    if (!poolAddress) {
      throw new Error('Raydium executor requires a known poolAddress (from Token.poolAddress)');
    }

    const pool = await getRaydiumCpmmPoolState(connection, poolAddress);
    if (!pool) {
      throw new Error(
        `Raydium CPMM pool ${poolAddress} not found or not owned by the Raydium CPMM program`,
      );
    }

    // Raydium CPMM's token_0/token_1 ordering doesn't guarantee which side is
    // input/output (unlike PumpSwap's explicit base/quote roles) — resolved
    // dynamically from which side matches the caller's requested mints, same
    // convention already established for liquidity math in raydium.ts's
    // calculateRaydiumCpmmLiquidityUsd.
    const isToken0Input = inputMint === pool.token0Mint && outputMint === pool.token1Mint;
    const isToken1Input = inputMint === pool.token1Mint && outputMint === pool.token0Mint;
    if (!isToken0Input && !isToken1Input) {
      throw new Error(
        `Mint pair ${inputMint}/${outputMint} does not match pool ${poolAddress}'s token_0/token_1 (${pool.token0Mint}/${pool.token1Mint})`,
      );
    }

    const inputVault = new PublicKey(isToken0Input ? pool.token0Vault : pool.token1Vault);
    const outputVault = new PublicKey(isToken0Input ? pool.token1Vault : pool.token0Vault);
    const inputTokenProgram = new PublicKey(
      isToken0Input ? pool.token0Program : pool.token1Program,
    );
    const outputTokenProgram = new PublicKey(
      isToken0Input ? pool.token1Program : pool.token0Program,
    );
    const inputMintKey = new PublicKey(inputMint);
    const outputMintKey = new PublicKey(outputMint);

    const isBuy = inputMint === WSOL_MINT.toBase58();
    const isSell = outputMint === WSOL_MINT.toBase58();

    const [inputBal, outputBal] = await Promise.all([
      connection.getTokenAccountBalance(inputVault),
      connection.getTokenAccountBalance(outputVault),
    ]);
    const estimatedOut = quoteConstantProduct(
      BigInt(inputBal.value.amount),
      BigInt(outputBal.value.amount),
      amountLamports,
    );
    const minimumAmountOut = applySlippageFloor(estimatedOut, slippageBps);
    if (minimumAmountOut <= 0n) {
      throw new Error('Computed Raydium swap quote is zero — pool has no depth');
    }

    const inputTokenAccount = getAssociatedTokenAddressSync(
      inputMintKey,
      signer.publicKey,
      false,
      inputTokenProgram,
    );
    const outputTokenAccount = getAssociatedTokenAddressSync(
      outputMintKey,
      signer.publicKey,
      false,
      outputTokenProgram,
    );

    // Account order matches the Swap Accounts struct in
    // swap_base_input.rs exactly (also cross-checked against
    // amm_instructions.rs's client-side helper) — see this file's header.
    const keys = [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false }, // payer
      { pubkey: authorityPda(), isSigner: false, isWritable: false }, // authority
      { pubkey: new PublicKey(pool.ammConfig), isSigner: false, isWritable: false }, // amm_config
      { pubkey: new PublicKey(poolAddress), isSigner: false, isWritable: true }, // pool_state
      { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: inputVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
      { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: inputMintKey, isSigner: false, isWritable: false },
      { pubkey: outputMintKey, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(pool.observationKey), isSigner: false, isWritable: true }, // observation_state
    ];

    const data = Buffer.concat([
      SWAP_BASE_INPUT_DISCRIMINATOR,
      u64le(amountLamports), // amount_in: exact amount being swapped in
      u64le(minimumAmountOut),
    ]);

    const ix = new TransactionInstruction({ programId: RAYDIUM_CPMM_PROGRAM_ID, keys, data });

    // Idempotent — the output ATA must exist to receive proceeds. Mirrors
    // pumpswapExecutor.ts's own "self-sufficient, doesn't rely on the caller
    // having already created it" convention.
    const instructions: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        outputTokenAccount,
        signer.publicKey,
        outputMintKey,
        outputTokenProgram,
      ),
    ];

    if (isBuy) {
      // Raydium CPMM consumes SOL as an SPL token balance (WSOL), not
      // natively — wrap before the swap can spend it. Same wrap discipline as
      // pumpswapExecutor.ts's buy path.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          inputTokenAccount,
          signer.publicKey,
          inputMintKey,
          inputTokenProgram,
        ),
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: inputTokenAccount,
          lamports: amountLamports,
        }),
        createSyncNativeInstruction(inputTokenAccount, inputTokenProgram),
      );
    }

    instructions.push(ix);

    if (isSell) {
      // Mirror image of the buy-side wrap: unwrap the WSOL just received back
      // to native SOL and reclaim the account's rent, matching
      // pumpswapExecutor.ts's sell path exactly.
      instructions.push(
        createCloseAccountInstruction(
          outputTokenAccount,
          signer.publicKey,
          signer.publicKey,
          [],
          outputTokenProgram,
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
