import { Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';

/**
 * Standalone, read-only, rule-based risk score for the ecosystemFeed content
 * pipeline (2026-07-31) — a display-quality gate for outbound marketing
 * posts, NOT a trading safety gate. Deliberately NOT a shared import of
 * apps/api/src/detection/riskAnalyzer.ts's RiskAnalyzer (same "duplicate,
 * don't cross-import" isolation convention as the rest of this package — see
 * discovery/telegramTrend.ts's own doc comment; apps/api also isn't packaged
 * as an importable library). Deliberately simpler than RiskAnalyzer too: no
 * LP-lock/native-DEX/bonding-curve/honeypot-simulation checks — those need
 * apps/api's live trading infra (DexRegistry, Jupiter quote simulation) this
 * package intentionally has no path into. A token this scores low is simply
 * left out of a post; nothing here ever blocks or permits a trade.
 *
 * Uses its own read-only Connection, sharing the same RPC provider quota as
 * apps/api's live trading calls — callers must keep candidate volume bounded
 * (see ECOSYSTEM_FEED_MAX_CANDIDATES_PER_TICK) since this competes for the
 * same provider-side rate limit live trading execution needs to stay fast.
 */

export interface EcosystemRpcConfig {
  rpcUrl?: string;
  heliusApiKey?: string;
}

const DEFAULT_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/** Trimmed duplicate of apps/api/src/solana/connection.ts's resolveRpcUrl. */
export function resolveEcosystemRpcUrl(config: EcosystemRpcConfig): string {
  if (config.heliusApiKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  }
  return config.rpcUrl ?? DEFAULT_PUBLIC_RPC;
}

export function createEcosystemConnection(config: EcosystemRpcConfig): Connection {
  return new Connection(resolveEcosystemRpcUrl(config), 'confirmed');
}

interface MintAuthorityInfo {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  supply: bigint;
}

/**
 * Trimmed duplicate of apps/api/src/detection/onchain.ts's
 * getMintAuthorityInfo — tries the legacy Token program first, falls back to
 * Token-2022 on the specific owner-mismatch error (real production fix,
 * 2026-07-22: a Token-2022 mint read with the wrong program ID otherwise
 * fails closed as "authority not revoked" for every single one).
 */
async function readMintAuthorityInfo(
  connection: Connection,
  mint: string,
): Promise<MintAuthorityInfo> {
  const pubkey = new PublicKey(mint);
  const read = (programId: typeof TOKEN_PROGRAM_ID) =>
    getMint(connection, pubkey, undefined, programId);
  try {
    const info = await read(TOKEN_PROGRAM_ID);
    return {
      mintAuthorityRevoked: info.mintAuthority === null,
      freezeAuthorityRevoked: info.freezeAuthority === null,
      supply: info.supply,
    };
  } catch (err) {
    if (err instanceof TokenInvalidAccountOwnerError) {
      const info = await read(TOKEN_2022_PROGRAM_ID);
      return {
        mintAuthorityRevoked: info.mintAuthority === null,
        freezeAuthorityRevoked: info.freezeAuthority === null,
        supply: info.supply,
      };
    }
    throw err;
  }
}

/**
 * Trimmed duplicate of apps/api/src/detection/onchain.ts's
 * getHolderConcentration, minus the pool-vault-exclusion machinery (that
 * needs DexRegistry, live-trading infra this package has no path into) — a
 * known simplification: the AMM pool's own vault is usually the single
 * largest "holder" by construction, so top10HolderPercent here can run
 * higher than apps/api's equivalent for the same token. Acceptable for a
 * display-quality gate; not used for any trading decision.
 */
async function readTop10HolderPercent(
  connection: Connection,
  mint: string,
  totalSupplyRaw: bigint,
): Promise<number> {
  if (totalSupplyRaw === 0n) return 0;
  const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
  const totalSupply = Number(totalSupplyRaw);
  const top10 = largest.value.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);
  return (top10 / totalSupply) * 100;
}

export interface EcosystemRiskFlags {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  top10HolderPercent: number;
  liquidityUsd: number;
}

/** Same point-deduction style as RiskAnalyzer.ruleBasedScore, reweighted for
 * the smaller flag set here (no LP-lock/honeypot checks). Pure function, no
 * I/O — always safe to unit test directly. */
export function computeEcosystemRiskScore(flags: EcosystemRiskFlags): number {
  let score = 100;
  if (!flags.mintAuthorityRevoked) score -= 40;
  if (!flags.freezeAuthorityRevoked) score -= 20;
  if (flags.top10HolderPercent > 50) score -= 25;
  else if (flags.top10HolderPercent > 30) score -= 12;
  if (flags.liquidityUsd < 5000) score -= 15;
  return Math.max(0, Math.min(100, score));
}

/**
 * Orchestrates the RPC reads and returns the score, or `undefined` if any
 * read failed — fail-CLOSED (unlike the Telegram-delivery classifier's
 * fail-open convention elsewhere in this package): if this can't be
 * verified, the candidate is simply left out of a post rather than posted
 * with an unverified/guessed score. `liquidityUsd` is passed in, already
 * fetched by the caller's cheaper DexScreener check — this function never
 * makes its own HTTP call, only RPC.
 */
export async function scoreTokenRisk(
  connection: Connection,
  mint: string,
  liquidityUsd: number,
): Promise<{ score: number; flags: EcosystemRiskFlags } | undefined> {
  try {
    const mintInfo = await readMintAuthorityInfo(connection, mint);
    const top10HolderPercent = await readTop10HolderPercent(connection, mint, mintInfo.supply);
    const flags: EcosystemRiskFlags = {
      mintAuthorityRevoked: mintInfo.mintAuthorityRevoked,
      freezeAuthorityRevoked: mintInfo.freezeAuthorityRevoked,
      top10HolderPercent,
      liquidityUsd,
    };
    return { score: computeEcosystemRiskScore(flags), flags };
  } catch {
    return undefined;
  }
}
