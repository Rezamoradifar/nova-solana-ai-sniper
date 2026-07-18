-- Production blocking fix (2026-07-14): DB-level idempotency guard for
-- maybeActivateReferralReward. referrerUserId as the primary key means the
-- grant itself is a single atomic INSERT — two concurrent referral signups
-- for the same referrer crossing the reward threshold at nearly the same
-- moment can never both succeed in granting a reward.

CREATE TABLE "referral_reward_grants" (
    "referrerUserId" TEXT NOT NULL,
    "referredCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_reward_grants_pkey" PRIMARY KEY ("referrerUserId")
);
