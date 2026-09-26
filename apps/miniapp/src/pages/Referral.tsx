import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Gift, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { numberOrFallback } from '../lib/format.js';
import { haptics } from '../lib/telegram.js';
import { Button, Card, CardSkeleton } from '../components/ui/index.js';
import { TopBar } from '../components/TopBar.js';

interface ReferralSummary {
  referralCode: string | null;
  subscriptionTier: 'FREE' | 'PRO';
  referredCount: number;
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong loading this.';
}

/**
 * Referral screen (Increment 4). GET /referrals only returns
 * { referralCode, subscriptionTier, referredCount } — no rewards list,
 * leaderboard, or invite tree exist (MISSING_APIS.md #6), shown below as an
 * honest empty state. No bot-username deep link (t.me/<bot>?start=<code>) is
 * constructed here — the Mini App has no way to know the bot's real
 * username, and guessing one would be a fabricated URL; "copy" shares the
 * real referral code as plain text instead.
 */
export function Referral() {
  const [copied, setCopied] = useState(false);

  const referrals = useQuery({
    queryKey: ['referrals'],
    queryFn: () => api.get<ReferralSummary>('/referrals'),
  });

  const copyInvite = async () => {
    if (!referrals.data?.referralCode) return;
    const text = `Join me on GSP Bank Sniper — use my referral code: ${referrals.data.referralCode}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    haptics.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title="Referral" subtitle="Invite others, earn rewards" />

      {referrals.isLoading ? (
        <CardSkeleton />
      ) : referrals.isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">{errorMessage(referrals.error)}</p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-gradient">
              <Gift size={22} className="text-white" />
            </div>
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              Your referral code
            </span>
            {referrals.data?.referralCode ? (
              <p className="font-mono text-3xl font-extrabold tracking-wider text-text-primary">
                {referrals.data.referralCode}
              </p>
            ) : (
              <p className="text-sm text-text-secondary">No referral code yet.</p>
            )}
            {referrals.data?.referralCode && (
              <Button variant="secondary" onClick={copyInvite} className="mt-1">
                <span className="inline-flex items-center gap-2">
                  {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                  {copied ? 'Copied' : 'Copy invite message'}
                </span>
              </Button>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <Users size={16} className="text-text-secondary" />
              <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
                Referred
              </span>
              <p className="mt-1 text-xl font-bold text-text-primary">
                {numberOrFallback(referrals.data?.referredCount, '0')}
              </p>
            </Card>
            <Card className="p-4">
              <Gift size={16} className="text-text-secondary" />
              <span className="mt-2 block text-xs uppercase tracking-wide text-text-secondary">
                Your tier
              </span>
              <p className="mt-1 text-xl font-bold text-text-primary">
                {referrals.data?.subscriptionTier ?? 'FREE'}
              </p>
            </Card>
          </div>

          <Card className="p-5">
            <span className="text-sm font-semibold text-text-primary">Rewards</span>
            <p className="mt-1 text-sm text-text-secondary">
              Reward tracking, a leaderboard, and your invite tree aren't available yet — this
              screen currently only shows your code and referral count.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
