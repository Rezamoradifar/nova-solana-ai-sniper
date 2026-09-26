import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  RefreshCw,
  Shield,
  ShieldCheck,
  Wallet as WalletIcon,
} from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { lamportsToSol, sol, timeAgo, usd } from '../lib/format.js';
import { haptics } from '../lib/telegram.js';
import type { AuditLogEntry, LedgerEntry, Wallet as WalletType } from '../lib/types.js';
import { Button, Card, CardSkeleton, Skeleton, TabPanel, Tabs } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';
import { WalletBackupModal } from '../components/WalletBackupModal.js';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

function truncateKey(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 6)}…${key.slice(-6)}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => {});
        haptics.tap();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-text-primary"
      aria-label="Copy address"
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

const LEDGER_LABEL: Record<LedgerEntry['type'], string> = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  REFERRAL_CREDIT: 'Referral credit',
  PROFIT_CREDIT: 'Profit credit',
  OWNER_FEE: 'Fee',
  LEDGER_ADJUSTMENT: 'Adjustment',
};

function WalletCard({ wallet, onBackup }: { wallet: WalletType; onBackup: () => void }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.post(`/wallets/${wallet.id}/refresh-balance`),
    onSuccess: () => {
      haptics.success();
      void queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
    onError: () => haptics.error(),
  });

  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex items-center gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-gradient">
          <WalletIcon size={20} className="text-[#07090F]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-text-primary">{wallet.label}</span>
            {!wallet.isActive && (
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-text-secondary">
                inactive
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-secondary">{truncateKey(wallet.publicKey)}</span>
            <CopyButton value={wallet.publicKey} />
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <span className="text-xs uppercase tracking-wide text-text-secondary">Balance</span>
          <p className="mt-0.5 font-mono text-2xl font-bold text-text-primary sm:text-3xl">
            {sol(lamportsToSol(wallet.lastKnownBalanceLamports))}
          </p>
          <span className="text-xs text-text-secondary">
            Updated {timeAgo(wallet.balanceUpdatedAt)}
          </span>
        </div>
        <Button
          variant="secondary"
          className="!px-3 !py-2"
          loading={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw size={16} />
        </Button>
      </div>

      <Button variant="secondary" onClick={onBackup}>
        <span className="inline-flex items-center gap-2">
          <Shield size={16} /> Back up wallet
        </span>
      </Button>
    </Card>
  );
}

/**
 * Wallet screen (Increment 4). Real endpoints only: GET /wallets,
 * POST /wallets/:id/refresh-balance, GET /wallets/:id/transactions,
 * GET /wallets/:id/audit-log, POST /wallets/:id/backup. Create/import/
 * restore-wallet flows exist as real routes too but aren't built into this
 * screen yet (mnemonic-reveal and restore-from-file are their own
 * security-sensitive UI, deferred rather than rushed).
 */
export function Wallet() {
  const [backupTarget, setBackupTarget] = useState<WalletType | null>(null);
  const [tab, setTab] = useState('transactions');

  const wallets = useQuery({
    queryKey: ['wallets'],
    queryFn: () => api.get<WalletType[]>('/wallets'),
  });
  const primaryWallet = wallets.data?.find((w) => w.isActive) ?? wallets.data?.[0];

  const transactions = useQuery({
    queryKey: ['wallet-transactions', primaryWallet?.id],
    queryFn: () => api.get<LedgerEntry[]>(`/wallets/${primaryWallet!.id}/transactions`),
    enabled: !!primaryWallet,
  });
  const auditLog = useQuery({
    queryKey: ['wallet-audit-log', primaryWallet?.id],
    queryFn: () => api.get<AuditLogEntry[]>(`/wallets/${primaryWallet!.id}/audit-log`),
    enabled: !!primaryWallet,
  });

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Wallet" subtitle="Balance, transactions & security" />

      {wallets.isLoading ? (
        <CardSkeleton />
      ) : wallets.isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">{errorMessage(wallets.error)}</p>
        </Card>
      ) : !primaryWallet ? (
        <Card className="p-5">
          <p className="text-sm text-text-secondary">No wallet connected yet.</p>
        </Card>
      ) : (
        <>
          <WalletCard wallet={primaryWallet} onBackup={() => setBackupTarget(primaryWallet)} />

          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'transactions', label: 'Transactions' },
              { value: 'activity', label: 'Activity' },
            ]}
          >
            <TabPanel value="transactions" className="mt-4 flex flex-col gap-2">
              {transactions.isLoading ? (
                <Skeleton count={4} className="h-14 w-full" />
              ) : transactions.isError ? (
                <Card className="p-5">
                  <p className="text-sm text-danger">{errorMessage(transactions.error)}</p>
                </Card>
              ) : !transactions.data || transactions.data.length === 0 ? (
                <Card className="p-5">
                  <p className="text-sm text-text-secondary">No transactions recorded yet.</p>
                </Card>
              ) : (
                transactions.data.map((entry) => (
                  <Card key={entry.id} className="flex items-center gap-3 p-3.5" static>
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        entry.direction === 'CREDIT'
                          ? 'bg-success/15 text-success'
                          : 'bg-danger/15 text-danger'
                      }`}
                    >
                      {entry.direction === 'CREDIT' ? (
                        <ArrowDownLeft size={14} />
                      ) : (
                        <ArrowUpRight size={14} />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium text-text-primary">
                        {LEDGER_LABEL[entry.type]}
                      </span>
                      <span className="text-xs text-text-secondary">
                        {timeAgo(entry.createdAt)}
                      </span>
                    </div>
                    <span
                      className={`text-sm font-semibold ${
                        entry.direction === 'CREDIT' ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {entry.direction === 'CREDIT' ? '+' : '-'}
                      {entry.asset === 'SOL'
                        ? sol(lamportsToSol(entry.amountLamports))
                        : usd(entry.amountUsd)}
                    </span>
                  </Card>
                ))
              )}
            </TabPanel>

            <TabPanel value="activity" className="mt-4 flex flex-col gap-2">
              {auditLog.isLoading ? (
                <Skeleton count={4} className="h-12 w-full" />
              ) : auditLog.isError ? (
                <Card className="p-5">
                  <p className="text-sm text-danger">{errorMessage(auditLog.error)}</p>
                </Card>
              ) : !auditLog.data || auditLog.data.length === 0 ? (
                <Card className="p-5">
                  <p className="text-sm text-text-secondary">No activity recorded yet.</p>
                </Card>
              ) : (
                auditLog.data.map((entry) => (
                  <Card key={entry.id} className="flex items-center gap-3 p-3.5" static>
                    <ShieldCheck
                      size={16}
                      className={entry.status === 'SUCCESS' ? 'text-success' : 'text-danger'}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-text-primary">{entry.action}</span>
                      <span className="text-xs text-text-secondary">
                        {timeAgo(entry.createdAt)}
                      </span>
                    </div>
                  </Card>
                ))
              )}
            </TabPanel>
          </Tabs>
        </>
      )}

      <WalletBackupModal
        walletId={backupTarget?.id ?? null}
        walletLabel={backupTarget?.label ?? ''}
        onOpenChange={(next) => {
          if (!next) setBackupTarget(null);
        }}
      />
    </div>
  );
}
