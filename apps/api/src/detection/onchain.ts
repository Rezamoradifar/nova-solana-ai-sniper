import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export interface MintAuthorityInfo {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  decimals: number;
  supply: bigint;
}

export async function getMintAuthorityInfo(
  connection: Connection,
  mint: string,
): Promise<MintAuthorityInfo> {
  const mintInfo = await getMint(connection, new PublicKey(mint));
  return {
    mintAuthorityRevoked: mintInfo.mintAuthority === null,
    freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
    decimals: mintInfo.decimals,
    supply: mintInfo.supply,
  };
}

export interface HolderConcentration {
  top10HolderPercent: number;
  holderCount: number;
}

/**
 * Approximates holder concentration using the largest-token-accounts RPC call
 * (capped at 20 by the RPC itself). Good enough as a rug-risk signal without
 * needing a full indexer.
 *
 * KNOWN LIMITATION (audited, not fixed here): this does not exclude the LP/pool
 * vault token account from the top-10 sum, which inflates concentration for any
 * token with real on-chain liquidity — the pool's own vault is usually one of the
 * largest holders by construction. A correct fix needs each DEX's actual vault
 * address (e.g. Raydium CPMM's token0Vault/token1Vault, decoded in
 * solana/dex/raydium.ts but not currently exposed past DexPoolInfo.poolAddress,
 * which is the pool *state* account, not the vault) threaded through per-DEX from
 * registry.ts — a real but DEX-layout-specific change, not a safe one to improvise
 * across 4+ different account layouts without dedicated verification per DEX.
 */
export async function getHolderConcentration(
  connection: Connection,
  mint: string,
): Promise<HolderConcentration> {
  const mintPubkey = new PublicKey(mint);
  const largest = await connection.getTokenLargestAccounts(mintPubkey);
  const supply = await connection.getTokenSupply(mintPubkey);

  const totalSupply = Number(supply.value.amount);
  if (totalSupply === 0) {
    return { top10HolderPercent: 0, holderCount: 0 };
  }

  const top10 = largest.value.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);

  return {
    top10HolderPercent: (top10 / totalSupply) * 100,
    holderCount: largest.value.filter((a) => Number(a.amount) > 0).length,
  };
}
