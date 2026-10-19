import type { PrismaClient } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { runGmgnTool } from '../integrations/gmgnTools.js';
import { normalizeGmgnSmartMoney } from '../integrations/gmgn.js';
import { loadRankedCopyWallets, COPY_RECOMMENDATION_POLICY } from './copyWalletRanking.js';

const MINUTE = 60_000;
const MAX_CANDIDATES = 10;
export function walletAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { const key = new PublicKey(value); return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()); } catch { return false; }
}
const number = (v: unknown): number | null => {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const count = (v: unknown): number | null => { const n = number(v); return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null; };
export interface ProviderWallet {
  address: string; label: string | null; source: 'GMGN'; periodDays: 30; receivedAt: number;
  score: number | null; rank: number | null; realizedPnlUsd: number | null;
  realizedRoiPct: number | null; winRatePct: number | null; sellCount: number | null;
  buyCount: number | null; distinctTokens: number | null; lastActivityAt: number;
  qualifiedSample: boolean; riskAssessment: 'not_available'; drawdownPct: null; followers: null;
}
export function providerWallet(raw: unknown, allowed: Map<string, number>, now: number): ProviderWallet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!walletAddress(r.wallet_address) || !allowed.has(r.wallet_address)) return null;
  const realized = number(r.realized_profit), cost = number(r.total_cost), wr = number(r.winrate);
  const winRate = wr !== null && wr >= 0 && wr <= 1 ? wr * 100 : null;
  const sells = count(r.sell_count), buys = count(r.buy_count), tokens = count(r.token_num);
  const candidateRoi = realized !== null && cost !== null && cost > 0 ? realized / cost * 100 : null;
  const roi = candidateRoi !== null && Number.isFinite(candidateRoi) ? candidateRoi : null;
  const qualified = realized !== null && realized > 0 && roi !== null && roi > 0 &&
    winRate !== null && winRate >= 50 && sells !== null && sells >= 20 && buys !== null && buys > 0;
  const score = winRate !== null && roi !== null && sells !== null && realized !== null ?
    Math.round(Math.max(0, Math.min(100, winRate * .4 + Math.min(Math.max(roi, 0), 100) * .3 + Math.min(sells / 50, 1) * 20 + Math.min((tokens ?? 0) / 20, 1) * 10))) : null;
  const common = r.common && typeof r.common === 'object' ? r.common as Record<string, unknown> : {};
  return { address: r.wallet_address, label: typeof common.name === 'string' ? common.name.slice(0, 80) : null,
    source: 'GMGN', periodDays: 30, receivedAt: now, score, rank: null,
    realizedPnlUsd: realized, realizedRoiPct: roi, winRatePct: winRate, sellCount: sells, buyCount: buys,
    distinctTokens: tokens, lastActivityAt: allowed.get(r.wallet_address)!, qualifiedSample: qualified,
    riskAssessment: 'not_available', drawdownPct: null, followers: null };
}
export function rankProviderWallets(rows: ProviderWallet[]) {
  return [...rows].sort((a,b) => Number(b.qualifiedSample) - Number(a.qualifiedSample) ||
    (b.score ?? -1) - (a.score ?? -1) || a.address.localeCompare(b.address))
    .map((w, index) => ({ ...w, rank: w.score === null ? null : index + 1 }));
}
export function createCopyLeaderboard(prisma: PrismaClient, apiKey: () => string | undefined,
  run = runGmgnTool, clock = Date.now) {
  let local: Awaited<ReturnType<typeof loadRankedCopyWallets>> = [];
  let localAt: number | null = null, localAttempt = -Infinity;
  let localStatus: 'loading' | 'ready' | 'empty' | 'unavailable' = 'loading';
  let localFlight: Promise<void> | undefined;
  let provider: ProviderWallet[] = [], providerAt: number | null = null, providerAttempt = -Infinity;
  let providerStatus: 'loading' | 'ready' | 'empty' | 'not_configured' | 'unavailable' = 'not_configured';
  let providerFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  async function refreshLocal() {
    if (localFlight) return localFlight;
    if (clock() - localAttempt < MINUTE) return;
    localAttempt = clock();
    localFlight = (async () => {
      try {
        const value = await loadRankedCopyWallets(prisma, clock());
        if (!stopped) { local = value; localAt = clock(); localStatus = value.length ? 'ready' : 'empty'; }
      } catch { if (!stopped) { local = []; localStatus = 'unavailable'; } }
    })().finally(() => { localFlight = undefined; });
    return localFlight;
  }
  async function refreshProvider() {
    const key = apiKey()?.trim();
    if (!key) { providerStatus = 'not_configured'; provider = []; providerAt = null; return; }
    if (providerFlight) return providerFlight;
    if (clock() - providerAttempt < 5 * MINUTE) return;
    providerAttempt = clock(); providerStatus = providerAt ? providerStatus : 'loading';
    providerFlight = (async () => {
      try {
        const activity = normalizeGmgnSmartMoney(await run(['track','smartmoney','--chain','sol','--limit','50','--raw'], key));
        const candidates = new Map<string, number>();
        const seen = new Set<string>();
        for (const t of activity) {
          const timestamp = (t.timestamp ?? 0) * 1000;
          if (!walletAddress(t.maker) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t.transactionHash) ||
              seen.has(t.transactionHash + ':' + t.maker) || timestamp > clock() || clock() - timestamp > 72 * 3_600_000) continue;
          seen.add(t.transactionHash + ':' + t.maker);
          candidates.set(t.maker, Math.max(timestamp, candidates.get(t.maker) ?? 0));
        }
        const internal = await prisma.wallet.findMany({ where: { publicKey: { in: [...candidates.keys()] } }, select: { publicKey: true } });
        for (const w of internal) candidates.delete(w.publicKey);
        const selected = new Map([...candidates].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_CANDIDATES));
        if (!selected.size) { if (!stopped) { provider = []; providerAt = clock(); providerStatus = 'empty'; } return; }
        // Fixed read-only CLI, bounded batch, no shell, no private key or trade command.
        await new Promise(r => setTimeout(r, 2100));
        if (stopped) return;
        const response = await run(['portfolio','stats','--chain','sol','--period','30d', ...[...selected.keys()].flatMap(a => ['--wallet', a]), '--raw'], key);
        const rawRows = Array.isArray(response) ? response : [response];
        if (rawRows.length > 100) throw new Error('SOURCE_SCHEMA');
        const unique = new Map<string, ProviderWallet>();
        for (const raw of rawRows) { const w = providerWallet(raw, selected, clock()); if (w) unique.set(w.address, w); }
        if (!unique.size) throw new Error('SOURCE_SCHEMA');
        if (!stopped) { provider = rankProviderWallets([...unique.values()]); providerAt = clock(); providerStatus = 'ready'; }
      } catch { if (!stopped) { provider = []; providerStatus = 'unavailable'; } }
    })().finally(() => { providerFlight = undefined; });
    return providerFlight;
  }
  return {
    start() { if (timer) return; stopped = false; void refreshLocal(); void refreshProvider(); timer = setInterval(() => { void refreshLocal(); void refreshProvider(); }, MINUTE); timer.unref?.(); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; },
    async read() {
      await refreshLocal(); void refreshProvider();
      const freshLocal = localAt !== null && clock() - localAt < 2 * MINUTE;
      const freshProvider = providerAt !== null && clock() - providerAt < 6 * MINUTE;
      return {
        version: 'real-copy-v1', chain: 'solana', sampleData: false, refreshMs: 20_000,
        scope: 'monitored_wallets_not_all_market', recommendationPolicy: COPY_RECOMMENDATION_POLICY,
        local: { status: freshLocal ? localStatus : localStatus === 'ready' ? 'stale' : localStatus, updatedAt: localAt,
          wallets: freshLocal && localStatus === 'ready' ? local.map((w,i) => ({ ...w, rank: i+1 })) : [] },
        gmgn: { status: freshProvider ? providerStatus : providerStatus === 'ready' ? 'stale' : providerStatus,
          updatedAt: providerAt, wallets: freshProvider && providerStatus === 'ready' ? provider : [],
          scoreMethod: '40% win rate + 30% realized return/buy-cost + 20% sell sample + 10% token diversity; not risk or guaranteed returns',
          nextRefreshAt: apiKey()?.trim() ? Math.max(clock(), providerAttempt + 5 * MINUTE) : null },
      };
    },
  };
}
