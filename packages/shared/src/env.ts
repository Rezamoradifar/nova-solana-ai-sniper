import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

/** Real, on-curve base58 Solana address check — used for
 * PLATFORM_TREASURY_WALLET_ADDRESS below. Deliberately fails closed (boot
 * error) rather than accepting a malformed/mistyped address silently, since
 * a wrong treasury address means real, unrecoverable fund loss the moment
 * the first payout fires — see payoutExecutor.ts. */
function isValidSolanaPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * `z.coerce.boolean()` is a footgun for env vars: `Boolean("false")` is `true`,
 * so it would turn LIVE_TRADING=false into `true`. This only accepts the literal
 * strings "true"/"false".
 */
function booleanFlag(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');
}

/**
 * Full superset of env vars used anywhere in the platform. Individual apps
 * import `envSchema.pick({...})` to validate only the vars they actually need,
 * so a missing Twitter key doesn't stop the API from booting, for example.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // Core infra
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Trading mode — the one hard safety switch. Real swaps only ever execute
  // when LIVE_TRADING is the literal string "true"; every other value (unset,
  // "false", typos) keeps the position manager in paper-fill mode.
  PAPER_TRADING: booleanFlag(true),
  LIVE_TRADING: booleanFlag(false),

  // Live-trading safety rails — operator-controlled ceilings independent of any
  // per-user SnipeConfig, enforced on every open (paper or live) except the
  // on-chain balance check, which only makes sense for real swaps.
  MAX_TRADE_SOL: z.coerce.number().positive().default(1),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(50),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  MIN_WALLET_RESERVE_SOL: z.coerce.number().nonnegative().default(0.01),

  // Real on-chain payout of referral commissions + the platform's own share
  // (2026-07-23 — apps/api/src/business/payoutExecutor.ts), replacing the
  // previous ledger-only bookkeeping. A real base58 Solana public key the
  // operator supplies — never generated or invented in code. Required, no
  // default: a missing/malformed treasury address must fail loud at boot,
  // not silently at the moment of the first real payout.
  PLATFORM_TREASURY_WALLET_ADDRESS: z
    .string()
    .refine(
      isValidSolanaPublicKey,
      'PLATFORM_TREASURY_WALLET_ADDRESS must be a valid base58 Solana public key',
    ),
  // How stale a PayoutAttempt row (status PENDING/SUBMITTED, no terminal
  // state reached) can be before it's treated as "a previous attempt likely
  // crashed mid-flight, needs manual reconciliation" rather than "another
  // concurrent close is actively handling it right now" — same TTL-staleness
  // idiom as positionManager.ts's unverifiedSwapLocks.
  PAYOUT_ATTEMPT_STALE_MS: z.coerce
    .number()
    .positive()
    .default(10 * 60 * 1000),

  // Emergency stop. This env value is a hard, restart-required override; the
  // real "flip it right now without redeploying" switch lives in Redis (see
  // apps/api/src/trading/safety.ts) and is toggled via the /killswitch admin command.
  KILL_SWITCH: booleanFlag(false),

  // Master switches for the staged profitability improvements — each defaults
  // to false (today's behavior, unchanged) and is a second layer on top of the
  // per-SnipeConfig opt-in fields (entryFilterEnabled, dynamicSizingEnabled,
  // etc): both this flag AND the per-user config must opt in before any new
  // logic runs. Lets an operator dark-launch or kill a whole stage instantly,
  // without a redeploy, independent of what any individual user has configured.
  ENTRY_FILTER_ENABLED: booleanFlag(false),
  DYNAMIC_SIZING_ENABLED: booleanFlag(false),
  PARTIAL_EXITS_ENABLED: booleanFlag(false),
  BEST_ROUTE_EXECUTION_ENABLED: booleanFlag(false),
  // Final Opportunity Score (Section 7, 2026-07-18) gate — same double
  // opt-in convention as the others above: this AND a config's own
  // useOpportunityScoreGate must both be true before AutoTrader uses the
  // weighted composite instead of today's Math.min(ruleScore, aiScore) gate.
  OPPORTUNITY_SCORE_GATE_ENABLED: booleanFlag(false),
  // Smart Money + Early Pump Detection (Sections 3-4, 2026-07-22): master
  // switches for SmartWalletTracker/EarlyMomentumDetector actually running at
  // all — both default false so a deploy doesn't silently start new RPC/
  // DexScreener work. Ships strictly shadow-mode: these feed
  // OpportunityScoreComponents.walletScore/momentumScore, which stay inert
  // while BusinessSettings.walletWeightBps/momentumWeightBps remain at their
  // own default of 0 — see packages/shared/src/opportunityScore.ts. No
  // SnipeConfig opt-in exists yet because there is no auto-buy behavior for
  // these signals to gate; that's a deliberate future step, not an oversight.
  SMART_MONEY_ANALYSIS_ENABLED: booleanFlag(false),
  EARLY_MOMENTUM_DETECTION_ENABLED: booleanFlag(false),
  // Shadow-mode logging/evaluation layer (ShadowModeDecisionLog) — on by
  // default since it's pure logging (null score fields when the two switches
  // above are off) and is this feature's only supported mode; never gates a
  // real trade.
  SHADOW_MODE_ENABLED: booleanFlag(true),

  // Auth / secrets
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(32),

  // Solana / RPC
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().url().optional(),
  HELIUS_API_KEY: z.string().optional(),
  // Additional RPC providers, all optional — when set, each becomes one more
  // provider in the load-balanced/failover pool (see solana/connection.ts and
  // solana/resilientConnection.ts). Same graceful-no-op pattern as every other
  // optional integration in this codebase: unset simply means one less provider
  // in the rotation, not a startup error.
  QUICKNODE_RPC_URL: z.string().url().optional(),
  // QuickNode's WSS endpoint (same host as QUICKNODE_RPC_URL) — only used for
  // subscriptions when QuickNode ends up as the primary (first) provider.
  QUICKNODE_WS_URL: z.string().url().optional(),
  CHAINSTACK_RPC_URL: z.string().url().optional(),
  // Comma-separated list of any further RPC endpoints an operator wants in the
  // rotation (e.g. a self-hosted node, Ankr, Triton) without a dedicated env var each.
  ADDITIONAL_RPC_URLS: z.string().optional(),
  JITO_BLOCK_ENGINE_URL: z.string().url().optional(),
  JITO_AUTH_KEYPAIR: z.string().optional(),
  // Ceiling passed to Jupiter's dynamic/tiered priority-fee estimation — an
  // operator-controlled cap, same pattern as MAX_TRADE_SOL, so a fee spike can't
  // silently burn an unbounded amount of SOL per swap.
  MAX_PRIORITY_FEE_LAMPORTS: z.coerce.number().positive().default(1_000_000),

  // AI providers
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Never logged — see packages/ai/src/provider.ts's GeminiProvider and
  // riskScorer.ts's structured logging, neither of which include the key itself.
  GEMINI_API_KEY: z.string().optional(),
  // Multi-LLM consensus (2026-07-22): Gemini + OpenRouter run in parallel and
  // both must independently recommend BUY before AutoTrader ever runs (see
  // packages/ai/src/consensus.ts, apps/api/src/worker.ts's processAiCall).
  // Never logged — same convention as every other key above.
  OPENROUTER_API_KEY: z.string().optional(),
  // OpenRouter's free-tier model slugs churn on the order of weeks — this
  // default was verified live against OpenRouter's own /api/v1/models
  // endpoint and smoke-tested against this account at implementation time
  // (2026-07-22), not guessed from training data. Deliberately a single
  // explicit value with no fallback/auto-substitution: if this model becomes
  // unavailable, the OpenRouter request fails and riskScorer.ts's existing
  // fail-closed handling turns that into a SKIP — never a silent switch to a
  // different, unvetted model. Override via this var, not by editing code.
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
  // Self-hosted Ollama (2026-07-26): third, best-effort consensus vote — see
  // packages/ai/src/consensus.ts's `ollama` parameter and provider.ts's
  // resolveOllamaProvider. Both optional, same undefined-means-not-configured
  // convention as OPENROUTER_API_KEY/OPENROUTER_MODEL above; unlike a Gemini/
  // OpenRouter outage, an unreachable/misbehaving Ollama host never blocks a
  // BUY on its own (see consensus.ts's ollamaParticipated).
  OLLAMA_HOST: z.string().url().optional(),
  OLLAMA_MODEL: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_IDS: z.string().optional(),
  // Public broadcast channel for apps/marketing-engine's scheduled posts —
  // deliberately separate from TELEGRAM_CHAT_ID (an admin/ops chat, not a
  // public audience). Accepts either "@channelusername" or a numeric chat id,
  // exactly as Telegram's sendMessage API does. Falls back to TELEGRAM_CHAT_ID
  // when unset so a dev/test setup with only one chat configured keeps working.
  MARKETING_TELEGRAM_CHANNEL_ID: z.string().optional(),
  // Visual marketing pipeline (2026-07-23, apps/marketing-engine/src/visuals/)
  // — master switch for the AI-generated-background attempt specifically
  // (GeminiImageProvider). Defaults false: verified live (2026-07-23) that
  // Gemini's image-capable models return a 0-quota 429 on this project's
  // current (non-billed) API key, so leaving this on by default would add a
  // guaranteed-fail ~15-30s round trip to every eligible post for no benefit.
  // The branded template renderer (visuals/statCard.ts, headlineCard.ts) is
  // unaffected by this flag — it always runs, free and local, regardless.
  MARKETING_AI_IMAGE_ENABLED: booleanFlag(false),

  // Twitter / X
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_SECRET: z.string().optional(),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_SEARCH_QUERY: z
    .string()
    .default('(pump.fun OR "solana memecoin" OR $SOL) -is:retweet lang:en'),
  TWITTER_POLL_INTERVAL_MS: z.coerce.number().min(15000).default(60000),

  // Telegram trend channels (signal source only — see apps/api/src/social/
  // telegramTrend.ts). Reads each channel's public HTML preview
  // (https://t.me/s/<channel>), no bot membership or login required. Master
  // switch defaults to false, same double-opt-in convention as
  // ENTRY_FILTER_ENABLED: a mint surfaced here still goes through the exact
  // same risk/AI/safety pipeline as any on-chain detection before anything
  // can buy it, gated per-user by each SnipeConfig's own autoBuyOnLaunch.
  TELEGRAM_TREND_SOURCE_ENABLED: booleanFlag(false),
  TELEGRAM_TREND_CHANNELS: z.string().default('trendingssol,trending'),
  TELEGRAM_TREND_POLL_INTERVAL_MS: z.coerce.number().min(15000).default(20000),
  // "AI Score < configured minimum" gate for this source specifically —
  // deliberately separate from SnipeConfig.minAiScore (a buy-gate) since this
  // one exists purely to keep low-quality Telegram-sourced candidates out of
  // the Launch Feed/notifications before a user-level config is even consulted.
  TELEGRAM_TREND_MIN_AI_SCORE: z.coerce.number().min(0).max(100).default(50),

  // Notify gate (apps/api/src/notify/notifyGate.ts) — the "is this token worth
  // a Telegram notification at all" bar, applied uniformly to every detection
  // source (on-chain scanners + the Telegram trend source) in worker.ts's
  // shared notifyAndAutoTrade. Independent of any per-user SnipeConfig
  // buy-gate: this only decides whether the New Launch/AI High Score alert
  // fires, never whether AutoTrader buys (that has its own, unaffected gates).
  // minLiquidityUsd defaults to 500 to match the exact bar already baked into
  // RiskAnalyzer's own isHoneypotSuspected heuristic; minAiScore defaults to
  // 50 to match TELEGRAM_TREND_MIN_AI_SCORE's precedent.
  NOTIFY_MIN_LIQUIDITY_USD: z.coerce.number().min(0).default(500),
  NOTIFY_MIN_AI_SCORE: z.coerce.number().min(0).max(100).default(50),

  // Third-party market data
  DEXSCREENER_API_BASE: z.string().url().default('https://api.dexscreener.com'),
  JUPITER_API_BASE: z.string().url().default('https://lite-api.jup.ag'),
  // How often open positions are re-priced to evaluate take-profit/stop-loss/trailing-stop.
  PRICE_CHECK_INTERVAL_MS: z.coerce.number().min(5000).default(15000),
  // How often recently-seen pump.fun tokens are polled for a bonding-curve migration —
  // rarer than a price tick, so a longer default interval than PRICE_CHECK_INTERVAL_MS.
  MIGRATION_CHECK_INTERVAL_MS: z.coerce.number().min(10000).default(30000),

  // Stale-position monitoring (2026-07-22 audit): once a position's first
  // stale-price/no-sell-route alert has fired (10 min in, see
  // priceMonitor.ts's STALE_PRICE_ALERT_AFTER_MS), it is never repeated on
  // every tick — only again this long after the last alert, for a position
  // still unresolved. 24h default: frequent enough that a still-broken
  // position isn't forgotten, far below the noise floor of "every 10 min."
  STALE_POSITION_REMINDER_INTERVAL_MS: z.coerce
    .number()
    .min(60_000)
    .default(24 * 60 * 60 * 1000),
  // How long a position may sit in the confirmed NO_SELL_ROUTE state before
  // being escalated to MANUAL_REVIEW — a stronger diagnostic flag only,
  // never an automatic close. 24h default, same rationale as the reminder
  // interval above: long enough that a temporary aggregator/liquidity gap
  // isn't over-escalated, short enough that a genuinely stuck position gets
  // flagged for a human within a day.
  STALE_POSITION_MANUAL_REVIEW_AFTER_MS: z.coerce
    .number()
    .min(60_000)
    .default(24 * 60 * 60 * 1000),

  // 2026-07-19 production investigation: Solana's onLogs pubsub can silently drop
  // notifications under load (see PumpFunMonitor's doc comment) — this periodically
  // tears down and re-creates the pump.fun log subscription as a cheap (zero RPC
  // cost) mitigation attempt. 0/unset disables it (today's exact one-subscription-
  // for-the-process's-lifetime behavior).
  PUMPFUN_RESUBSCRIBE_INTERVAL_MS: z.coerce.number().min(0).default(0),
  // Companion alert, distinct from SourceHealthMonitor's raw-traffic check: fires
  // when no *qualified new-token* pump.fun launch has been detected in this long,
  // even though raw program traffic (which SourceHealthMonitor watches) is still
  // flowing — the specific failure pattern the above investigation found. 25 min
  // default: live sampling found launches averaging ~1/11min even during the
  // silent-drop episodes that prompted this, so 25 min is well past normal variance.
  PUMPFUN_LAUNCH_SILENCE_ALERT_MS: z.coerce
    .number()
    .min(60000)
    .default(25 * 60 * 1000),

  // Recurring-outage follow-up (2026-07-23): the silence alert above used to only
  // ever trigger a same-provider resubscribe, which repeatedly failed to actually
  // fix a dropping subscription — see PumpFunMonitor's multi-provider failover.
  // After a resubscribe (same provider) is attempted, this is how long we wait for
  // a fresh raw log event before concluding it didn't help and escalating to
  // failoverToNextProvider instead of trying the same provider again.
  PUMPFUN_WATCHDOG_VERIFY_WINDOW_MS: z.coerce.number().min(5_000).default(30_000),
  // Bounded exponential backoff (with jitter) applied to a WS provider that just
  // failed a subscription/verification — same shape as resilientConnection.ts's
  // ordinary-RPC-call cooldown, kept separate since subscription failures are a
  // different signal (silently dropped events, not a request-level error).
  PUMPFUN_PROVIDER_COOLDOWN_BASE_MS: z.coerce.number().min(1_000).default(30_000),
  PUMPFUN_PROVIDER_COOLDOWN_MAX_MS: z.coerce
    .number()
    .min(1_000)
    .default(5 * 60 * 1000),
  // How often, while running on a non-primary WS provider, PumpFunMonitor
  // attempts to switch back to the primary and verify it's actually receiving
  // events again — "periodically test whether the primary has recovered."
  PUMPFUN_PRIMARY_RECOVERY_PROBE_INTERVAL_MS: z.coerce
    .number()
    .min(30_000)
    .default(5 * 60 * 1000),

  // Independent fallback discovery path (2026-07-23): polls getSignaturesForAddress
  // on the pump.fun program directly, over plain RPC, never the WS subscription —
  // see fallbackLaunchDiscovery.ts. The idle tick is cheap (one signature-list call,
  // no per-signature parsing) and runs continuously just to prove this path's own
  // RPC connectivity and keep its watermark from drifting far behind; the expensive
  // per-signature active scan only ever runs while the WS source is unhealthy, or
  // once, bounded, to reconcile a just-ended outage window.
  FALLBACK_DISCOVERY_IDLE_INTERVAL_MS: z.coerce.number().min(10_000).default(60_000),
  // Caps how far back an active scan will page, so a long outage still bounds RPC
  // cost instead of parsing every signature back to the start of the outage
  // unconditionally.
  FALLBACK_DISCOVERY_MAX_LOOKBACK_MS: z.coerce
    .number()
    .min(60_000)
    .default(2 * 60 * 60 * 1000),

  // Scanner health state machine (HEALTHY/DEGRADED/RECOVERING/UNHEALTHY) — how
  // often it re-evaluates PumpFunMonitor + FallbackLaunchDiscovery + the existing
  // per-DEX SourceHealthMonitor to decide the overall detection health and whether
  // NEW auto-buys must be safety-paused (see scannerHealth.ts).
  SCANNER_HEALTH_CHECK_INTERVAL_MS: z.coerce.number().min(5_000).default(30_000),
  // Default false: once a total detection outage (UNHEALTHY) safety-pauses NEW
  // auto-buys, recovery back to HEALTHY does NOT automatically clear that pause —
  // an admin must explicitly resume it (see the /resumeautobuy Telegram command),
  // matching this task's "request admin approval" requirement. Flipping this to
  // true is an explicit, auditable operator decision to allow automatic resume
  // instead, same opt-in convention as ENTRY_FILTER_ENABLED etc.
  SCANNER_AUTO_BUY_AUTO_RESUME_ENABLED: booleanFlag(false),

  // Two-stage discovery pipeline (2026-07-22): bounds how many candidates the
  // discovery queue (raw WS event -> parsed tx -> candidatePipeline.ts) and
  // the AI-provider-call queue run concurrently, so a burst of launches can
  // no longer fan out unbounded concurrent RPC/AI calls (see
  // PriorityConcurrencyQueue). AI_QUEUE_CONCURRENCY is smaller — AI-provider
  // calls are rate-limited/cost-sensitive in a way plain RPC/HTTP reads aren't.
  DISCOVERY_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  AI_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // Massive Scanner Scalability (Phase 2, 2026-07-26): ScannerConcurrencyGovernor
  // periodically re-tunes discoveryQueue's concurrency between these bounds
  // instead of leaving it fixed at DISCOVERY_QUEUE_CONCURRENCY for the
  // process's whole lifetime — scaling up while backlogged and RPC/event-loop
  // are healthy, scaling down the moment either isn't. See
  // dynamicConcurrency.ts / scannerConcurrencyGovernor.ts. Only ever governs
  // discoveryQueue, never aiQueue — AI-provider rate limits are a distinct,
  // untracked constraint this signal set doesn't model.
  SCANNER_CONCURRENCY_GOVERNOR_ENABLED: booleanFlag(true),
  SCANNER_CONCURRENCY_GOVERNOR_INTERVAL_MS: z.coerce.number().min(1_000).default(10_000),
  SCANNER_CONCURRENCY_MIN: z.coerce.number().int().positive().default(2),
  SCANNER_CONCURRENCY_MAX: z.coerce.number().int().positive().default(24),
  // Node event-loop-delay p95 (ms) above which the single process (see
  // ecosystem.config.cjs: `exec_mode: 'fork'`, `instances: 1` — everything
  // runs in one process) is judged to be falling behind regardless of queue
  // backlog or RPC health, and concurrency is cut regardless of those signals.
  SCANNER_EVENT_LOOP_LAG_CEILING_MS: z.coerce.number().positive().default(200),
  // FAST PATH thresholds (see riskAnalyzer.ts's isFastPathCandidate): a
  // candidate whose recent (m5, falling back to h1) buys AND volume both
  // clear these gets queued ahead of ordinary candidates for the AI call —
  // priority only, never a security bypass.
  FAST_PATH_MIN_RECENT_BUYS: z.coerce.number().int().nonnegative().default(15),
  FAST_PATH_MIN_RECENT_VOLUME_USD: z.coerce.number().nonnegative().default(2000),

  // Candidate retry (2026-07-23 audit): a brand-new pump.fun launch has no
  // DexScreener listing yet and its mint/holder accounts can lag behind the
  // fastest RPC read by a few seconds — candidatePipeline.ts's critical
  // security gate correctly fails closed on both (dexscreener_validation_failed,
  // holder_data_unknown, etc.), but treating that first failure as final meant
  // *every* fresh launch was rejected forever, not just genuinely bad ones —
  // confirmed live: zero buys for a full day while the gate worked exactly as
  // designed. isRetryableRejection (candidatePipeline.ts) distinguishes "data
  // not available yet" from "confirmed bad" — only the former gets re-tried,
  // on the same fixed interval, up to this many times, before falling back to
  // today's permanent-rejection behavior.
  CANDIDATE_RETRY_INTERVAL_MS: z.coerce.number().min(2000).default(10000),
  CANDIDATE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().nonnegative().default(6),

  // Section 8 follow-up (2026-07-23): how often securityGateSummaryReporter.ts
  // turns candidatePipeline.ts's accumulated securityGateStats window into one
  // Telegram report to the owner, replacing the old per-rejection alert this
  // same audit removed. 15 minutes by default — frequent enough to catch a
  // stuck scanner quickly, infrequent enough to not just be a different
  // flavor of alert noise.
  SECURITY_GATE_SUMMARY_INTERVAL_MS: z.coerce.number().min(60_000).default(900_000),

  // EmergencyExitMonitor — Institutional Mode's safety net: force-closes an
  // OPEN institutional-mode position on a detected liquidity-removal/rug
  // signal, independent of that position's own TP/SL/trailing-stop (see
  // emergencyExitMonitor.ts). Defaults off, same convention as the staged
  // profitability flags above. On-chain/liquidity checks are slower and
  // heavier than a plain price tick, hence its own, longer interval rather
  // than reusing PRICE_CHECK_INTERVAL_MS.
  EMERGENCY_EXIT_ENABLED: booleanFlag(false),
  EMERGENCY_EXIT_CHECK_INTERVAL_MS: z.coerce.number().min(15000).default(45000),

  // Dynamic Risk Tiers / bundled-wallet detection / extreme-pump protection
  // (2026-07-23, USOH incident follow-up — see apps/api/src/trading/riskTier.ts,
  // apps/api/src/detection/holderClustering.ts, apps/api/src/detection/
  // pumpProtection.ts). Unlike the staged-feature flags above, these default
  // ON: they're a direct safety response to a live incident (a bundled-wallet
  // token cleared every existing check), not an experimental opt-in. Every
  // threshold here is a multiplier/percentage/duration, never a hardcoded
  // absolute SOL amount — riskTier.ts's sizing always scales the user's own
  // SnipeConfig.buyAmountSol.
  RISK_TIER_ULTRA_EARLY_MAX_AGE_MS: z.coerce
    .number()
    .nonnegative()
    .default(5 * 60 * 1000),
  RISK_TIER_EARLY_MAX_AGE_MS: z.coerce
    .number()
    .nonnegative()
    .default(15 * 60 * 1000),
  // Basis points (10000 = 100%) of a config's own buyAmountSol. Established
  // defaults to 10000 — an exact no-op, reproducing today's behavior for any
  // token 15min+ old.
  RISK_TIER_ULTRA_EARLY_SIZE_BPS: z.coerce.number().int().min(0).max(10_000).default(2500),
  RISK_TIER_EARLY_SIZE_BPS: z.coerce.number().int().min(0).max(10_000).default(5000),
  RISK_TIER_ESTABLISHED_SIZE_BPS: z.coerce.number().int().min(0).max(10_000).default(10_000),
  // Bundled-wallet / holder-clustering detection thresholds — calibrated
  // against the USOH incident's actual holder data (18 wallets each within
  // ~0.05% of each other, ~4.45% of supply combined). A confirmed cluster
  // above both thresholds blocks auto-buy unconditionally (see
  // criticalSecurityGate.ts) — this is not a staged/opt-in feature either.
  BUNDLE_CLUSTER_SIMILARITY_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
  BUNDLE_CLUSTER_MIN_WALLET_COUNT: z.coerce.number().int().positive().default(4),
  BUNDLE_CLUSTER_MIN_SUPPLY_PERCENT: z.coerce.number().nonnegative().default(3),
  // Extreme-pump protection: priceChangeH1 at/above this % escalates the risk
  // tier one notch stricter (see riskTier.ts's escalateTierForPump) but never
  // blocks a buy by itself — price appreciation alone is deliberately not
  // used to classify a token as a scam (see pumpProtection.ts).
  EXTREME_PUMP_H1_THRESHOLD_PERCENT: z.coerce.number().positive().default(500),

  // Permanent-route-failure retry cap (2026-07-26): a SELL that fails because
  // no Jupiter (or native-DEX-fallback) route exists for a mint — see
  // sellFailureClassifier.ts's `permanent: true` classification — can never
  // succeed by simply retrying on the next price tick, unlike every other
  // SELL failure category. Before this, PositionManager retried such a
  // position on every single price tick forever (confirmed in production:
  // one position's sellFailureCount reached the thousands). After this many
  // consecutive permanent (no-route) SELL failures for a position,
  // PositionManager marks it unsellable and stops scheduling further sell
  // attempts for it (see Position.sellUnsellable in schema.prisma).
  SELL_MAX_PERMANENT_ROUTE_RETRIES: z.coerce.number().int().positive().default(3),

  // NO_SELL_ROUTE fix (2026-07-26, Phase 6): exponential backoff between
  // permanent (no-route) SELL retries — see sellRetryBackoff.ts. Before this,
  // every attempt up to SELL_MAX_PERMANENT_ROUTE_RETRIES fired on the very
  // next price tick with zero delay. Base is the wait after the 1st failure;
  // it doubles each subsequent failure, capped at Max.
  SELL_PERMANENT_RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(60_000),
  SELL_PERMANENT_RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(1_800_000),

  // DepositMonitor — polls every active wallet's live SOL balance and records
  // an increase as a DEPOSIT ledger/audit event (see
  // packages/shared/src/wallet/balanceLedger.ts). Defaults on: deposits are
  // core wallet functionality, not opt-in, unlike the staged/experimental
  // trading features above. Independent of the on-demand refresh-balance
  // route and the Telegram refresh button, which share the same underlying
  // helper and can still be disabled here without affecting either.
  DEPOSIT_MONITOR_ENABLED: booleanFlag(true),
  DEPOSIT_MONITOR_INTERVAL_MS: z.coerce.number().min(10000).default(20000),

  // Marketing / links
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
  COMMUNITY_URL: z.string().url().optional(),
  REFERRAL_BASE_URL: z.string().url().optional(),
});

export type FullEnv = z.infer<typeof envSchema>;

/**
 * A key present in `.env` but left blank (`COMMUNITY_URL=`) is how operators
 * naturally spell "not configured yet" — but dotenv loads that as `""`, not
 * `undefined`, so it fails `.optional()` fields that also validate shape
 * (`.url()`, `.email()`, etc.): blank fails the shape check instead of being
 * treated as absent. Normalizing blank strings to `undefined` before parsing
 * makes "key missing" and "key present but blank" behave identically for
 * every optional field, without weakening required (non-optional) fields —
 * a blank required field still fails validation, just as "Required" instead
 * of a shape error, which is arguably clearer anyway.
 */
function withBlankStringsAsUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]));
}

export function loadEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(withBlankStringsAsUndefined(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
