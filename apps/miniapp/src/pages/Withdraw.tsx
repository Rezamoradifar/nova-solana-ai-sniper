import { useQuery } from '@tanstack/react-query';
import { Clock, Wallet as WalletIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { lamportsToSol, sol, timeAgo } from '../lib/format.js';
import type { Wallet } from '../lib/types.js';
import { Card, CardSkeleton } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

/**
 * Withdraw screen (Increment 4). POST /wallets/:id/withdrawals is
 * admin-only and record-only — it logs that a withdrawal happened manually
 * out-of-band, it never signs or broadcasts anything (MISSING_APIS.md #5).
 * There is no user-facing "request a withdrawal" flow to wire up, so this
 * screen shows the real wallet balance for context plus an honest
 * unavailable state, rather than a form that would silently do nothing.
 */
export function Withdraw() {
  const wallets = useQuery({
    queryKey: ['wallets'],
    queryFn: () => api.get<Wallet[]>('/wallets'),
  });
  const primaryWallet = wallets.data?.find((w) => w.isActive) ?? wallets.data?.[0];

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Withdraw" subtitle="Move funds out of your wallet" />

      {wallets.isLoading ? (
        <CardSkeleton />
      ) : wallets.isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">{errorMessage(wallets.error)}</p>
        </Card>
      ) : primaryWallet ? (
        <Card className="flex items-center gap-4 p-5 sm:p-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-gradient">
            <WalletIcon size={20} className="text-[#07090F]" />
          </div>
          <div>
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              Available balance
            </span>
            <p className="mt-0.5 font-mono text-2xl font-bold text-text-primary sm:text-3xl">
              {sol(lamportsToSol(primaryWallet.lastKnownBalanceLamports))}
            </p>
          </div>
        </Card>
      ) : null}

      <Card className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06]">
          <Clock size={22} className="text-text-secondary" />
        </div>
        <p className="text-sm font-semibold text-text-primary">
          Self-service withdrawals aren't available yet
        </p>
        <p className="text-sm text-text-secondary">
          Withdrawals are currently processed manually by the team. Contact support in Telegram to
          request one — this screen will gain a real request flow once that API exists.
        </p>
        {primaryWallet?.balanceUpdatedAt && (
          <p className="text-xs text-text-secondary">
            Balance last updated {timeAgo(primaryWallet.balanceUpdatedAt)}
          </p>
        )}
      </Card>
    </div>
  );
}
