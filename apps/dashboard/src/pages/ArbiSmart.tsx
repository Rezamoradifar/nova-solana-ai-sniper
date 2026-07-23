import { useState, type FormEvent } from 'react';
import { formatUnits, isAddress, ZeroAddress } from 'ethers';
import { usePolling } from '../lib/usePolling.js';
import { StatCard } from '../components/StatCard.js';
import { CopyButton } from '../components/CopyButton.js';
import {
  ARBISMART_ADDRESS,
  ARBISMART_EXPLORER_URL,
  PLAN_LABELS,
  USDT_DECIMALS,
  callArbiSmart,
} from '../lib/arbismart.js';

function usdt(v: bigint | undefined, digits = 2): string {
  if (v === undefined) return '—';
  return `${Number(formatUnits(v, USDT_DECIMALS)).toLocaleString(undefined, {
    maximumFractionDigits: digits,
  })} USDT`;
}

/** Contract stores rates/fees in bps-like units where 10000 == 100%. */
function pct(v: bigint | undefined): string {
  return v === undefined ? '—' : `${(Number(v) / 100).toFixed(2)}%`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function secsToDuration(v: bigint | undefined): string {
  if (v === undefined) return '—';
  const total = Number(v);
  if (total <= 0) return 'ended';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

interface GlobalData {
  userCount: bigint;
  totalStaked: bigint;
  totalPaidOut: bigint;
  balance: bigint;
  freePeriod: boolean;
  timeLeft: bigint;
  paused: boolean;
  emergencyMode: boolean;
  partners: string[];
  dailyRates: bigint[];
  planDurations: bigint[];
  minStakes: bigint[];
  referralRates: bigint[];
  f3Rates: bigint[];
}

async function fetchGlobal(): Promise<GlobalData> {
  const [
    [userCount, totalStaked, totalPaidOut, balance],
    [partnersTuple],
    freePeriod,
    timeLeft,
    paused,
    emergencyMode,
    dailyRates,
    planDurations,
    minStakes,
    referralRates,
    f3Rates,
  ] = await Promise.all([
    callArbiSmart<[bigint, bigint, bigint, bigint]>('getGlobalStats'),
    callArbiSmart<[string[], bigint]>('getPartners'),
    callArbiSmart<boolean>('isFreePeriod'),
    callArbiSmart<bigint>('getTimeLeft'),
    callArbiSmart<boolean>('paused'),
    callArbiSmart<boolean>('emergencyMode'),
    Promise.all([0, 1, 2, 3].map((i) => callArbiSmart<bigint>('dailyRates', i))),
    Promise.all([0, 1, 2, 3].map((i) => callArbiSmart<bigint>('planDurations', i))),
    Promise.all([0, 1, 2, 3].map((i) => callArbiSmart<bigint>('minStakes', i))),
    Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => callArbiSmart<bigint>('referralRates', i))),
    Promise.all([0, 1, 2].map((i) => callArbiSmart<bigint>('f3Rates', i))),
  ]);
  return {
    userCount,
    totalStaked,
    totalPaidOut,
    balance,
    freePeriod,
    timeLeft,
    paused,
    emergencyMode,
    partners: (partnersTuple as string[]).filter((p) => p !== ZeroAddress),
    dailyRates,
    planDurations,
    minStakes,
    referralRates,
    f3Rates,
  };
}

interface UserData {
  amount: bigint;
  plan: bigint;
  rate: bigint;
  pendingReward: bigint;
  totalClaimed: bigint;
  claimCount: bigint;
  active: boolean;
  freeStake: bigint | boolean;
  referrer: string;
  referralTotalEarned: bigint;
  referralPending: bigint;
  activeReferrals: bigint;
  level: bigint;
  f1Volume: bigint;
  f2Volume: bigint;
  f1Count: bigint;
}

async function fetchUser(address: string): Promise<UserData> {
  const [stakeBasic, referralInfo, teamVolume, f1Count, pendingReward] = await Promise.all([
    callArbiSmart<[bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint]>(
      'getStakeBasic',
      address,
    ),
    callArbiSmart<[string, bigint, bigint, bigint, bigint]>('getReferralInfo', address),
    callArbiSmart<[bigint, bigint, bigint]>('getTeamVolume', address),
    callArbiSmart<bigint>('getF1Count', address),
    callArbiSmart<bigint>('getReward', address),
  ]);
  const [amount, plan, rate, , active, freeStake, totalClaimed, claimCount] = stakeBasic;
  const [referrer, referralTotalEarned, referralPending, activeReferrals, level] = referralInfo;
  const [f1Volume, f2Volume] = teamVolume;
  return {
    amount,
    plan,
    rate,
    pendingReward,
    totalClaimed,
    claimCount,
    active,
    freeStake,
    referrer,
    referralTotalEarned,
    referralPending,
    activeReferrals,
    level,
    f1Volume,
    f2Volume,
    f1Count,
  };
}

export function ArbiSmart() {
  const { data: g, error: gError } = usePolling(fetchGlobal, 15000);

  const [lookupInput, setLookupInput] = useState('');
  const [lookupAddress, setLookupAddress] = useState<string | undefined>();
  const [lookupError, setLookupError] = useState<string | undefined>();
  const {
    data: u,
    error: uError,
    loading: uLoading,
  } = usePolling(
    () => (lookupAddress ? fetchUser(lookupAddress) : Promise.resolve(undefined)),
    15000,
    lookupAddress,
  );

  function onLookup(e: FormEvent) {
    e.preventDefault();
    setLookupError(undefined);
    if (!isAddress(lookupInput)) {
      setLookupError('Not a valid address');
      return;
    }
    setLookupAddress(lookupInput);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-white">ArbiSmart Contract</h1>
        <a
          href={ARBISMART_EXPLORER_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent hover:underline"
        >
          View on Polygonscan ↗
        </a>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        <span className="label mb-0">Contract</span>
        <span className="font-mono text-xs text-slate-300">{ARBISMART_ADDRESS}</span>
        <CopyButton text={ARBISMART_ADDRESS} />
        {g?.paused && (
          <span className="rounded-full bg-loss/20 px-2 py-0.5 text-xs font-medium text-loss">
            Paused
          </span>
        )}
        {g?.emergencyMode && (
          <span className="rounded-full bg-loss/20 px-2 py-0.5 text-xs font-medium text-loss">
            Emergency mode
          </span>
        )}
        {g?.freePeriod && (
          <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">
            Free period — {secsToDuration(g.timeLeft)} left
          </span>
        )}
      </div>

      {gError && <div className="text-sm text-loss">{gError.message}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Users" value={g ? g.userCount.toString() : '—'} />
        <StatCard label="Total Staked" value={usdt(g?.totalStaked)} />
        <StatCard label="Total Paid Out" value={usdt(g?.totalPaidOut)} />
        <StatCard label="Contract Balance" value={usdt(g?.balance)} />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-white">Staking Plans</h2>
        <table className="table-base">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Daily Rate</th>
              <th>Duration</th>
              <th>Min Stake</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_LABELS.map((label, i) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{pct(g?.dailyRates[i])}</td>
                <td>{g ? `${g.planDurations[i]?.toString()}d` : '—'}</td>
                <td>{usdt(g?.minStakes[i], 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-white">Referral Rates</h2>
          <table className="table-base">
            <thead>
              <tr>
                <th>Level</th>
                <th>F1 (direct)</th>
                <th>F2</th>
                <th>F3</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3].map((lvl) => (
                <tr key={lvl}>
                  <td>Level {lvl}</td>
                  <td>{pct(g?.referralRates[lvl * 2])}</td>
                  <td>{pct(g?.referralRates[lvl * 2 + 1])}</td>
                  <td>{lvl >= 1 ? pct(g?.f3Rates[lvl - 1]) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-white">
            Partners {g ? `(${g.partners.length}/4)` : ''}
          </h2>
          <div className="space-y-2">
            {g?.partners.map((p) => (
              <div key={p} className="flex items-center gap-2 font-mono text-xs text-slate-300">
                <span>{shortAddr(p)}</span>
                <CopyButton text={p} />
              </div>
            ))}
            {g?.partners.length === 0 && (
              <div className="text-sm text-slate-500">No partners configured yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-white">Look up a staker</h2>
        <form onSubmit={onLookup} className="flex flex-wrap gap-2">
          <input
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            placeholder="0x… staker address"
            className="input-field flex-1"
          />
          <button type="submit" className="btn-primary">
            Look up
          </button>
        </form>
        {lookupError && <div className="text-sm text-loss">{lookupError}</div>}
        {uError && <div className="text-sm text-loss">{uError.message}</div>}
        {uLoading && lookupAddress && <div className="text-sm text-slate-500">Loading…</div>}

        {u && lookupAddress && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Staked Amount"
                value={usdt(u.amount)}
                sublabel={`${PLAN_LABELS[Number(u.plan)] ?? '—'}${u.freeStake ? ' · free' : ''}`}
              />
              <StatCard
                label="Status"
                value={u.active ? 'Active' : 'Inactive'}
                tone={u.active ? 'profit' : 'default'}
              />
              <StatCard label="Claimable Reward" value={usdt(u.pendingReward)} tone="profit" />
              <StatCard label="Total Claimed" value={usdt(u.totalClaimed)} />
              <StatCard label="Referral Pending" value={usdt(u.referralPending)} tone="profit" />
              <StatCard label="Referral Total Earned" value={usdt(u.referralTotalEarned)} />
              <StatCard label="Active Referrals" value={u.activeReferrals.toString()} />
              <StatCard label="Direct Referrals (F1)" value={u.f1Count.toString()} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard label="Referral Level" value={u.level.toString()} />
              <StatCard label="F1 Team Volume" value={usdt(u.f1Volume)} />
              <StatCard label="F2 Team Volume" value={usdt(u.f2Volume)} />
            </div>
            {u.referrer !== ZeroAddress && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span>Referred by</span>
                <span className="font-mono text-slate-300">{shortAddr(u.referrer)}</span>
                <CopyButton text={u.referrer} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
