import { Contract, JsonRpcProvider } from 'ethers';

/** ArbiSmart USDT staking contract on Polygon PoS mainnet (chainId 137). */
export const ARBISMART_ADDRESS = '0xdE8859444957B327F18f75E2C600d6Cc275Ea662';
export const ARBISMART_EXPLORER_URL = `https://polygonscan.com/address/${ARBISMART_ADDRESS}`;
export const POLYGON_RPC_URL = 'https://polygon-bor-rpc.publicnode.com';
/** USDT (and every on-chain amount in this contract) uses 6 decimals. */
export const USDT_DECIMALS = 6;
export const PLAN_LABELS = ['Starter', 'Growth', 'Pro', 'Elite'] as const;

export const ARBISMART_ABI = [
  'function OWNER() view returns (address)',
  'function FEE_WALLET_1() view returns (address)',
  'function FEE_WALLET_2() view returns (address)',
  'function USDT() view returns (address)',
  'function FREE_PERIOD() view returns (uint256)',
  'function MAX_PARTNERS() view returns (uint256)',
  'function REQUIRED_VOTES() view returns (uint256)',
  'function deployTime() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function totalPaidOut() view returns (uint256)',
  'function paused() view returns (bool)',
  'function emergencyMode() view returns (bool)',
  'function emergencyVoteCount() view returns (uint256)',
  'function partnerCount() view returns (uint256)',
  'function partners(uint256) view returns (address)',
  'function dailyRates(uint256) view returns (uint256)',
  'function planDurations(uint256) view returns (uint256)',
  'function minStakes(uint256) view returns (uint256)',
  'function referralRates(uint256) view returns (uint256)',
  'function f3Rates(uint256) view returns (uint256)',
  'function blacklisted(address) view returns (bool)',
  'function isFreePeriod() view returns (bool)',
  'function getTimeLeft() view returns (uint256)',
  'function getBalance() view returns (uint256)',
  'function getPartners() view returns (address[4], uint256)',
  'function getGlobalStats() view returns (uint256, uint256, uint256, uint256)',
  'function getReward(address u) view returns (uint256)',
  'function getRefReward(address u) view returns (uint256)',
  'function getUserStats(address u) view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getUserStatsExtended(address u) view returns (uint256, uint256, bool, uint256, uint256, uint256, uint256, uint256)',
  'function getStakeBasic(address u) view returns (uint256, uint256, uint256, uint256, bool, bool, uint256, uint256)',
  'function getReferralInfo(address u) view returns (address, uint256, uint256, uint256, uint256)',
  'function getTeamVolume(address u) view returns (uint256, uint256, uint256)',
  'function getF1Count(address u) view returns (uint256)',
  'function getF1List(address u) view returns (address[], uint256[], uint256[])',
  'function getClaimCount(address u) view returns (uint256)',
  'function stakes(address) view returns (uint256 amount, uint256 plan, uint256 rate, uint256 startTime, uint256 lastClaimTime, uint256 totalClaimed, bool active, bool earlyExited, bool freeStake)',
  'function referrals(address) view returns (address referrer, uint256 totalEarned, uint256 pendingReward, uint256 activeReferrals, uint256 level)',
] as const;

let _provider: JsonRpcProvider | undefined;
export function getProvider(): JsonRpcProvider {
  _provider ??= new JsonRpcProvider(POLYGON_RPC_URL, 137, { staticNetwork: true });
  return _provider;
}

let _contract: Contract | undefined;
export function getArbiSmartContract(): Contract {
  _contract ??= new Contract(ARBISMART_ADDRESS, ARBISMART_ABI, getProvider());
  return _contract;
}

/** ethers' Contract exposes ABI methods via a Proxy, so TS can't statically
 * type them — getFunction() is the typed, always-defined escape hatch. */
export function callArbiSmart<T>(method: string, ...args: unknown[]): Promise<T> {
  return getArbiSmartContract().getFunction(method)(...args) as Promise<T>;
}
