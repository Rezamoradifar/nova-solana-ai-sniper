import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { CopyButton } from '../components/CopyButton.js';

export function Referrals() {
  const state = usePolling(
    () =>
      api.get<{ referralCode: string | null; referredCount: number; subscriptionTier: string }>(
        '/referrals',
      ),
    30_000,
  );
  const link = state.data?.referralCode
    ? `${window.location.origin}/login?ref=${encodeURIComponent(state.data.referralCode)}`
    : null;
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Invite friends</h1>
        <p className="mt-2 text-sm text-slate-400">
          Share your link. The referral code is included when a new user creates an account.
        </p>
      </div>
      {state.error && (
        <p className="card text-loss" role="alert">
          {state.error.message}
        </p>
      )}
      {state.loading && <p className="card text-slate-400">Loading your referral details…</p>}
      {state.data && (
        <>
          <div className="card">
            <div className="label">Registered referrals</div>
            <p className="text-3xl font-semibold text-white">{state.data.referredCount}</p>
          </div>
          <div className="card">
            <h2 className="font-semibold text-white">Your invitation</h2>
            {link ? (
              <>
                <p className="my-4 break-all text-sm text-slate-300">{link}</p>
                <CopyButton text={link} label="Copy invitation link" />
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                A referral code is not available for this account. Contact support.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
