/**
 * Source-of-truth English dictionary. Every string here must match today's
 * hardcoded copy verbatim — screens are being extracted, not reworded, so
 * existing `.toContain('...')` test assertions keep passing unchanged.
 */
export const en = {
  common: {
    back: '⬅️ Back',
    somethingWrongScreen: '⚠️ Something went wrong rendering that screen.',
    somethingWrong: '⚠️ Something went wrong.',
    walletGone: '⚠️ That wallet no longer exists.',
    noShareCaption: '⚠️ No share caption available for this trade.',
    enabled: '🟢 Enabled',
    disabled: '🔴 Disabled',
    menu: {
      home: '🏠 Home',
      sniperStart: '▶️ Start Sniper',
      sniperStop: '⏹ Stop Sniper',
      wallet: '👛 Wallet',
      dashboard: '📊 Dashboard',
      positions: '📈 Positions',
      trades: '💱 Trades',
      leaderboard: '🏆 Leaderboard',
      alerts: '🔔 Alerts',
      settings: '⚙️ Settings',
      profile: '👤 Profile',
      portfolio: '💰 Portfolio',
      referrals: '🔗 Referrals',
      help: '❓ Help',
      trending: '🚀 Trending',
      arbitrage: '🚧 Arbitrage',
      liveOpportunities: '🔥 Live Opportunities',
      telegramTrends: '📡 Telegram Trends',
      trendSettings: '⚙️ Trend Settings',
      feeDashboard: '💸 Fees & Earnings',
    },
  },

  home: {
    title: '👋 *GSP Bank Sniper*',
    openApp: '🚀 Open GSP App',
    freeNote: 'Every feature below is free — no tiers, no limits.',
    wallets: (n: number) => `👛 Wallets: *${n}*`,
    activeSnipes: (n: number) => `🎯 Active snipe configs: *${n}*`,
    openPositions: (n: number) => `📈 Open positions: *${n}*`,
    pickSection: 'Pick a section below or use the menu at the bottom of the chat.',
  },

  welcome: {
    text: '👋 *GSP Bank Sniper* is ready. Use the menu below to navigate.',
  },

  language: {
    title: '🌐 *Language*',
    prompt: 'Choose your language for the bot.',
    english: '🇬🇧 English',
    persian: '🇮🇷 فارسی',
    updated: '✅ Language updated.',
  },

  sniper: {
    noActiveWallet: '⚠️ no active wallet',
    on: 'ON',
    off: 'OFF',
    active: 'Active 🟢',
    paused: 'Paused ⏸',
    card: (
      index: number,
      wallet: string,
      buy: string,
      minAiScore: number,
      autoBuy: string,
      status: string,
    ) =>
      `🎯 *Sniper #${index}*\n` +
      `Wallet: ${wallet}\n` +
      `Buy: ${buy}\n` +
      `Min AI Score: ${minAiScore}\n` +
      `Auto Buy: ${autoBuy}\n` +
      `Status: ${status}`,
    startTitle: '▶️ *Start Sniper*\n\n',
    noConfigText:
      'No snipe config yet.\n\nQuick-start creates a default auto-buy config you can fine-tune later in Settings.',
    quickStartBtn: '➕ Quick Start (0.1 SOL)',
    moreNote: (n: number) => `\n\n… and ${n} more (contact support to clean these up).`,
    pauseBtn: '⏸ Pause',
    resumeBtn: '▶️ Resume',
    deleteConfigBtn: '🗑 Delete Config',
    resumeAllBtn: '▶️ Resume All',
    addAnotherBtn: '➕ Add Another Config (0.1 SOL)',
    stopTitle: '⏹ *Pause all sniper configurations?*\n\n',
    activeNote: (n: number) =>
      `${n} config(s) are currently active. Pausing stops new auto-buys — it never touches your existing open positions or deletes anything.`,
    nothingActive: 'Nothing is currently active.',
    pauseAllBtn: '⏸ Pause All',
    selectConfigBtn: '🔎 Select Config',
    cancelBtn: '❌ Cancel',
    pausedConfirmation: (n: number) =>
      `✅ Auto-buy paused successfully (${n} config(s)).\n\n` +
      'Your existing open positions are still being monitored by the position manager.',
    openPositionsBtn: '📊 Open Positions',
    closeAllPositionsBtn: '🔴 Close All Positions',
    homeBtn: '🏠 Home',
    deleteConfirmTitle: '🗑 *Delete this snipe config?*\n\n',
    deleteConfirmBody:
      'This only removes the config itself — your wallet, open positions, and full trade/PnL history are never touched.',
    confirmDeleteBtn: '✅ Confirm Delete',
    tradingRestricted:
      '🔒 Live trading is restricted to the bot operator right now. You can still browse every other screen, but starting/resuming a sniper config is disabled for this account.',
  },

  settings: {
    noConfig:
      '⚙️ *Settings*\n\nYou have no snipe config yet — create one from ▶️ Start Sniper first, then come back here to fine-tune it.',
    title: '⚙️ *Settings*\n\n',
    editingNote: 'Editing your most recent snipe config:\n\n',
    buyAmount: (s: string) => `💰 Buy amount: *${s}*`,
    maxSlippage: (bps: number) => `📉 Max slippage: *${bps} bps*`,
    minLiquidity: (s: string) => `💧 Min liquidity: *$${s}*`,
    minAiScore: (n: number) => `🤖 Min AI score: *${n}*`,
    stopLoss: (pct: number) => `🛑 Stop loss: *${pct}%*`,
    stopLossDefault: (pct: number, ceiling: number) =>
      `🛑 Stop loss: *${pct}%* _(system default — never looser than ${ceiling}%)_`,
    exitStrategy: (label: string) => `📐 Exit strategy: *${label}*`,
    trailingOnlyNote:
      '\n_No fixed take-profit — trailing stop only, distance adapts to liquidity/holder concentration._',
    customPresetLabel: 'Custom (manual TP/SL/trailing on each position)',
    buyAmountBtn: '✏️ Buy amount',
    slippageBtn: '✏️ Slippage',
    stopLossBtn: '✏️ Stop loss',
    minLiquidityBtn: '✏️ Min liquidity',
    minAiScoreBtn: '✏️ Min AI score',
    customPresetBtn: '↩️ Custom (manual TP/SL/trailing)',
    languageBtn: '🌐 Language',
    fieldMeta: {
      buyAmountSol: {
        label: 'Buy amount',
        prompt: 'Send the new buy amount in SOL (e.g. `0.25`).',
      },
      maxSlippageBps: {
        label: 'Max slippage',
        prompt: 'Send the new max slippage in basis points, 1-10000 (e.g. `300` for 3%).',
      },
      minLiquidityUsd: {
        label: 'Min liquidity',
        prompt: 'Send the new minimum liquidity in USD (e.g. `1000`).',
      },
      minAiScore: {
        label: 'Min AI score',
        prompt: 'Send the new minimum AI score, 0-100 (e.g. `60`).',
      },
      stopLossPercent: {
        label: 'Stop loss',
        prompt: (ceiling: number) =>
          `Send the new stop-loss percentage as a number (e.g. \`15\` for -15%). Never honored looser than ${ceiling}% — a larger value is capped to ${ceiling}.`,
      },
    },
    promptTitle: (label: string) => `⚙️ *${label}*\n\n`,
    invalidValue: (prompt: string) => `That doesn't look right. ${prompt}`,
    configGone: 'That snipe config no longer exists.',
  },

  notifications: {
    newLaunch: (dex: string) => `*New ${dex} launch*`,
    liquidityLabel: 'Liquidity',
    marketCapLabel: 'Market Cap',
    aiScoreLabel: 'AI Score',
    ruleScoreLabel: 'Rule Score (no AI provider)',
    mintLabel: 'Mint',
    freezeLabel: 'Freeze',
    lpLabel: 'LP',
    top10Label: 'Top10',
    riskLabel: 'Risk',
    momentumLabel: 'Momentum (1h)',
    honeypotFlag: '⚠️ Honeypot/rug risk flagged',
    aiHighScoreLabel: 'AI High Score',
    highRuleScoreLabel: 'High Rule Score (no AI provider)',
    priceLabel: 'Price',
    simulatedFill: '_(simulated fill, no on-chain tx)_',
    amountLabel: 'Amount',
    positionClosedLabel: 'Position closed',
    reasonLabel: 'Reason',
    pnlLabel: 'PnL',
    entryLabel: 'Entry',
    athLabel: 'ATH',
    lockedProfitLabel: 'Locked profit',
    exitReasonLabels: {
      take_profit: 'take profit',
      stop_loss: 'stop loss',
      trailing_stop: 'trailing stop',
      emergency: 'emergency',
      manual_emergency: 'manual emergency',
      time_stop: 'time stop',
    } as Record<string, string>,
    emergencyExitLabel: 'EMERGENCY EXIT',
    emergencyReasonLabels: {
      liquidity_removed: 'Liquidity Removed',
      trading_disabled: 'Trading Disabled (no sell route)',
      mint_reenabled: 'Mint Authority Re-enabled',
      freeze_reenabled: 'Freeze Authority Re-enabled',
      critical_rug_score: 'Critical Rug Score',
      dev_wallet_dump: 'Major Wallet Dumping Detected',
    } as Record<string, string>,
    tradeReportTitle: 'Trade Report',
    grossProfitLabel: 'Gross Profit',
    tradingCostsLabel: 'Trading Costs',
    netProfitLabel: 'Net Profit',
    performanceFeeLabel: (pct: string) => `Platform Performance Fee (${pct}%)`,
    referralRewardsLabel: 'Referral Rewards',
    finalAmountCreditedLabel: 'Final Amount Credited',
    refLabel: 'Ref',
    referralEarnedTitle: 'Referral reward earned!',
    referralEarnedBody: (level: number, symbol: string) =>
      `One of your Level ${level} referrals just closed a profitable trade on \`${symbol}\`.`,
    youEarnedLabel: 'You earned',
    migrationDetectedLabel: 'Migration detected',
    lowBalanceTitle: 'Auto-Buy Paused — Wallet Balance Too Low',
    lowBalanceBody: (balance: string, required: string) =>
      `Your wallet balance is *${balance} SOL* — below the *${required} SOL* ` +
      'your auto-buy config requires (trade amount + fee reserve) to execute a buy.',
    lowBalanceSkipNote: (shortfall: string) =>
      `Every new token launch is currently being skipped for your account. Deposit at least *${shortfall} SOL* ` +
      '— open 👛 Wallet → 🧾 Deposit for your address — and auto-buy will resume automatically on the next launch.',
    lowBalanceOneTimeNote: "_One-time notice — you won't get this again for every skipped trade._",
    referralRewardUnlockedTitle: 'Referral reward unlocked!',
    referralRewardUnlockedBody: (n: number) =>
      `You've referred ${n} people — a default auto-buy sniper config is now active for you.`,
    referralRewardCheckNote: (sniperStartLabel: string) =>
      `Check ${sniperStartLabel} to review or adjust it.`,
  },

  arbitrage: {
    text: '🚧 *Arbitrage*\n\nThis feature is not yet available.\nCheck back soon!',
  },

  help: {
    text:
      `❓ *Help*\n\n` +
      `*Menu*\n` +
      `▶️ Start Sniper — create or resume auto-buy configs\n` +
      `⏹ Stop Sniper — pause all auto-buying\n` +
      `👛 Wallet — create/import/backup/restore wallets\n` +
      `📊 Dashboard — portfolio overview\n` +
      `📈 Positions — open positions, edit TP/SL\n` +
      `💱 Trades — recent trade history\n` +
      `🏆 Leaderboard — top wallets by PnL\n` +
      `🔔 Alerts — recent account activity\n` +
      `⚙️ Settings — edit your snipe config\n` +
      `👤 Profile — your account info\n` +
      `💰 Portfolio — per-wallet PnL breakdown\n` +
      `🔗 Referrals — your invite code and link\n\n` +
      `*Commands*\n` +
      `/start — open the main menu\n\n` +
      `Every feature is free for every user — there are no paid tiers.`,
  },

  wallet: {
    title: '👛 *Wallet*\n\n',
    noWallets: 'You have no wallets yet.',
    walletRow: (dot: string, label: string, key: string) => `${dot} ${label}\n\`${key}\``,
    depositBtn: (label: string) => `🧾 Deposit ${label}`,
    backupBtn: (label: string) => `💾 Backup ${label}`,
    deactivateBtn: (label: string) => `🗑 Deactivate ${label}`,
    createWalletBtn: '➕ Create Wallet',
    importWalletBtn: '📥 Import Wallet',
    restoreWalletBtn: '♻️ Restore Wallet',
    seedPhraseWarning: (mnemonic: string) =>
      '🔐 *Save this seed phrase now — it will not be shown again*\n\n' +
      `\`${mnemonic}\`\n\n` +
      'Write it down somewhere offline. Anyone with these words can take everything in this wallet. ' +
      'This message deletes itself in 60 seconds.',
    importPromptText:
      '📥 *Import Wallet*\n\nSend the secret key (base58-encoded) of the wallet you want to import.\n\n' +
      '⚠️ Delete your message right after sending it — Telegram keeps chat history, and anyone with this key controls the wallet.',
    invalidSecretKey:
      '⚠️ That secret key is invalid. Send a valid base58 secret key, or ⬅️ Back to cancel.',
    backupPasswordPromptText:
      "💾 *Backup Wallet*\n\nSend a password to encrypt this wallet's key (min 8 characters). " +
      "You'll need this exact password to restore it later — it is never saved anywhere.",
    passwordTooShort: 'Password must be at least 8 characters. Send a new one.',
    walletGoneNoEmoji: 'That wallet no longer exists.',
    restoreFilePromptText:
      '♻️ *Restore Wallet*\n\nSend the backup file (.json) you exported earlier, as a Telegram document.',
    restorePasswordPromptText:
      '♻️ *Restore Wallet*\n\nGot the file. Now send the password you used when creating this backup.',
    incorrectPasswordOrCorrupted:
      '⚠️ Incorrect password or corrupted backup file. Send the password again, or ⬅️ Back to cancel.',
    invalidBackupKey: '⚠️ That backup did not contain a valid wallet key.',
    alreadyAdded: 'This wallet has already been added.',
    alreadyActive: 'This wallet is already active.',
    depositTitle: (label: string) => `🧾 *Deposit — ${label}*\n\n`,
    network: 'Solana Mainnet',
    depositBody: (pubkey: string, network: string, balance: string, lastUpdated: string) =>
      `\`${pubkey}\`\n\n` +
      `Network: ${network}\n` +
      `Balance: ${balance}\n` +
      `Last Updated: ${lastUpdated}\n\n` +
      'Send only SOL or SPL tokens on Solana to this address. Tap the address above to copy it.',
    refreshBalanceBtn: '🔄 Refresh Balance',
    showQrBtn: '🖼 Show QR',
    transactionHistoryBtn: '🧾 Transaction History',
    walletHistoryBtn: '📜 Wallet History',
    qrCaption: (label: string, pubkey: string) => `🖼 *${label}* deposit address\n\`${pubkey}\``,
    walletHistoryTitle: (label: string) => `📜 *Wallet History — ${label}*\n\n`,
    noHistoryYet: 'No history yet.',
    historyRow: (date: string, action: string, status: string) => `${date} — ${action} (${status})`,
    depositScreenBtn: '🧾 Deposit Screen',
    newerBtn: '⬅️ Newer',
    olderBtn: '➡️ Older',
    transactionHistoryTitle: (label: string) => `🧾 *Transaction History — ${label}*\n\n`,
    noTransactionsYet: 'No transactions yet.',
    transactionRow: (date: string, type: string, sign: string, amount: string) =>
      `${date} — ${type} ${sign}${amount}`,
    invalidBackupFile:
      "⚠️ That doesn't look like a valid GSP Bank Sniper wallet backup file. Send the correct file, or ⬅️ Back to cancel.",
    couldNotReadFile: '⚠️ Could not read that file. Try again, or ⬅️ Back to cancel.',
    sendAsDocumentNote:
      'Send the backup file as a Telegram document (attach the .json file), not as text.',
    backupCaption: '💾 Encrypted wallet backup — store this file and its password somewhere safe.',
  },

  positions: {
    notConfigured: '📈 *Positions*\n\n⚠️ Trading engine integration is not configured.',
    loadFailed:
      '📈 *Positions*\n\n⚠️ Could not load live position data right now — the trading engine ' +
      'may be temporarily unavailable. Try again shortly.',
    title: '📈 *Positions*\n\n',
    empty: 'No open positions.',
    positionHeader: (symbol: string, mint: string) => `🪙 *${symbol}* (\`${mint}\`)`,
    walletLine: (w: string) => `Wallet: ${w}`,
    buyEntryLine: (buy: string, entry: string) => `Buy: ${buy} · Entry: $${entry}`,
    currentValueLine: (est: string, emoji: string, pnl: string) =>
      `Current Value: ${est} · ${emoji} PnL: ${pnl}%`,
    currentValueUnavailable: 'Current Value: unavailable right now',
    tokenBalance: (n: string) => `Token Balance: ${n} (recorded)`,
    statusOpen: 'Status: OPEN',
    pageLabel: (page: number, total: number) => `\n\nPage ${page}/${total}`,
    tpBtn: (symbol: string) => `✏️ ${symbol} TP`,
    slBtn: (symbol: string) => `✏️ ${symbol} SL`,
    closePositionBtn: '🔴 Close Position',
    explorerBtn: '🔍 Explorer',
    prevBtn: '⬅️ Prev',
    nextBtn: '➡️ Next',
    closeAllBtn: '🔴 Close All Positions',
    closedCountLine: (n: number) => `\n\n📜 Closed positions: *${n}*`,
    confirmCloseTitle: (symbol: string) => `⚠️ *Close this position?*\n\n${symbol}\n\n`,
    confirmCloseBody: 'Close this position and sell the available token balance?',
    confirmSellBtn: '✅ Confirm Sell',
    cancelBtn: '❌ Cancel',
    notConfiguredShort: '⚠️ Trading engine integration is not configured.',
    alreadyProcessing:
      '⏳ Already processing your previous request for this position — please wait for it to finish.',
    positionGoneOrNotYours: '⚠️ That position no longer exists or does not belong to you.',
    alreadyClosed: 'ℹ️ That position is already closed.',
    alreadyHandled:
      'ℹ️ That position was already handled by another operation — nothing more to do.',
    zeroBalanceReconciliation: (symbol: string) =>
      `⚠️ Position has zero on-chain balance and requires reconciliation.\n\n` +
      `${symbol} was closed for bookkeeping — no realized PnL was recorded since ` +
      'the actual disposition of the tokens is unknown.',
    closedSuccess: (symbol: string) => `✅ *Position closed*\n\n${symbol} sold.`,
    realizedPnlLine: (emoji: string, usd: string) => `\nRealized PnL: ${emoji} ${usd}`,
    txLine: (sig: string) => `\n\nTx: \`${sig}\``,
    unexpectedCloseError: 'Unexpected error while closing the position.',
    closeFailedTitle: (msg: string) =>
      `❌ *Close failed*\n\n${msg}\n\nThe position remains open — you can try again.`,
    closeAllConfirmTitle: '⚠️ *Close ALL open positions?*\n\n',
    closeAllConfirmBody:
      'You are about to attempt to close ALL open positions across your active wallets.',
    confirmCloseAllBtn: '⚠️ Confirm Close All',
    alreadyProcessingCloseAll:
      '⏳ Already processing a Close All request — please wait for it to finish.',
    closeAllSummaryTitle: (closed: number, failed: number, skipped: number) =>
      `📊 *Close All Positions — Summary*\n\nClosed: ${closed}\nFailed: ${failed}\nSkipped: ${skipped}`,
    failureRow: (symbol: string, reason: string) => `• ${symbol}: ${reason}`,
    moreFailures: (n: number) => `\n… and ${n} more`,
    unexpectedCloseAllError: 'Unexpected error while closing positions.',
    closeAllFailedTitle: (msg: string) => `❌ *Close All failed*\n\n${msg}`,
    tpPromptTitle:
      '✏️ *Take-profit*\n\nSend the new take-profit percentage as a number (e.g. `50` for +50%).',
    slPromptTitle:
      '✏️ *Stop-loss*\n\nSend the new stop-loss percentage as a number (e.g. `20` for -20%).',
    invalidNumber: "That doesn't look right — send a positive number.",
    positionGone: 'That position no longer exists.',
    friendlyReasons: {
      routeUnavailable: 'No swap route is available for this token right now — try again shortly.',
      liquidity: 'Not enough liquidity to sell right now — try again shortly.',
      slippage: 'Price moved past the allowed slippage — try again.',
      networkSlow: 'The network was slow to confirm — try again.',
      positionLock: 'This position is already being closed or sold by another operation.',
    },
  },

  trades: {
    title: '💱 *Trades*\n\n',
    empty: 'No trades yet.',
    row: (
      emoji: string,
      side: string,
      symbol: string,
      sol: string,
      statusBadge: string,
      date: string,
    ) => `${emoji} *${side}* ${symbol} — ${sol}${statusBadge}\n${date}`,
    statusLabels: { pending: 'pending', failed: 'failed' } as Record<string, string>,
  },

  leaderboard: {
    header: '🏆 *Leaderboard*\n\nTop wallets by realized PnL:\n\n',
    empty: 'No closed trades yet — be the first!',
    row: (rank: number, emoji: string, label: string, usd: string, closed: number) =>
      `${rank}. ${emoji} ${label} — ${usd} (${closed} closed)`,
  },

  dashboard: {
    title: '📊 *Dashboard*',
    openPositions: (n: number) => `📈 Open positions: *${n}*`,
    invested: (s: string) => `💵 Invested: *${s}*`,
    realizedPnl: (emoji: string, s: string) => `${emoji} Realized PnL: *${s}*`,
    unrealizedPnl: (emoji: string, s: string) => `${emoji} Unrealized PnL: *${s}*`,
    yourTrades: (n: number) => `💱 Your trades: *${n}*`,
    tokensTracked: (n: number) => `🪙 Tokens tracked platform-wide: *${n}*`,
  },

  portfolio: {
    title: '💰 *Portfolio*',
    empty: 'You have no wallets yet — create one from 👛 Wallet.',
    row: (
      label: string,
      key: string,
      open: number,
      invested: string,
      pnlEmojiR: string,
      realized: string,
      pnlEmojiU: string,
      unrealized: string,
    ) =>
      `👛 ${label} \`${key}\`\n` +
      `Open: ${open} · Invested: ${invested}\n` +
      `${pnlEmojiR} Realized: ${realized} · ${pnlEmojiU} Unrealized: ${unrealized}`,
  },

  alerts: {
    title: '🔔 *Alerts*\n\nRecent activity on your account:\n\n',
    empty: 'Nothing yet — activity like wallet changes and trades will show up here.',
    actionLabels: {
      'wallet.create': '👛 Wallet created',
      'wallet.import': '👛 Wallet imported',
      'auth.register': '🆕 Account created',
      'auth.login': '🔓 Logged in',
      'auth.login_failed': '⚠️ Failed login attempt',
      'referral.pro_unlocked': '🎉 Referral reward',
    } as Record<string, string>,
    unmapped: (action: string) => `ℹ️ ${action}`,
  },

  profile: {
    title: '👤 *Profile*',
    name: (n: string) => `Name: ${n}`,
    username: (u: string) => `Username: ${u}`,
    telegramId: (id: string) => `Telegram ID: \`${id}\``,
    memberSince: (d: string) => `Member since: ${d}`,
    wallets: (n: number) => `Wallets: *${n}*`,
    plan: (tier: string) => `Plan: *${tier}* — every feature is free and unlocked`,
    referralCode: (code: string) => `Referral code: \`${code}\``,
  },

  referrals: {
    title: '🔗 *Referrals*',
    yourCode: (code: string) => `Your code: \`${code}\``,
    peopleReferred: (n: number) => `People referred: *${n}*`,
    shareLink: (link: string) =>
      `Share your link — anyone who opens the bot through it is automatically credited to you:\n\`${link}\``,
    shareCodeOnly: 'Share your code with friends so they get credited to you when they join.',
    refresh: '🔄 Refresh',
  },

  referralEarnings: {
    header: '📜 *Referral Earnings History*\n\n',
    empty:
      'No referral earnings yet — share your referral link from 🔗 Referrals to start earning.',
    row: (level: number, usd: string, from: string, date: string) =>
      `🔗 Level ${level} — ${usd} from ${from}\n${date}`,
  },

  referralLeaderboard: {
    header: '🏆 *Referral Leaderboard*\n\nTop referrers by total earned:\n\n',
    empty: 'No referral earnings recorded yet.',
    row: (rank: number, label: string, usd: string) => `${rank}. ${label} — ${usd}`,
  },

  telegramTrends: {
    header: (statusLine: string, channels: string) =>
      `📡 *Telegram Trends*\n\nSource status: ${statusLine}\nChannels: ${channels}\n\n`,
    fetchError: '⚠️ Could not reach the metrics service right now — try again shortly.',
    signalsReceived: (n: number) => `📥 Signals received: *${n}*`,
    mintsExtracted: (n: number) => `🪙 Mints extracted: *${n}*`,
    duplicateRejected: (n: number) => `♻️ Duplicate rejected: *${n}*`,
    blacklistRejected: (n: number) => `🚫 Blacklist rejected: *${n}*`,
    liquidityZeroRejected: (n: number) => `💧 Liquidity=0 rejected: *${n}*`,
    aiRejected: (n: number) => `🤖 AI rejected: *${n}*`,
    qualifiedOpportunities: (n: number) => `✅ Qualified opportunities: *${n}*`,
    executedTrades: (n: number) => `💰 Executed trades: *${n}*`,
    rpcSaved: (n: number) => `📉 RPC calls saved (est.): *${n}*`,
  },

  trendSettings: {
    title: '⚙️ *Trend Settings*',
    status: (s: string) => `Status: ${s}`,
    channels: (c: string) => `Channels: ${c}`,
    minAiScore: (n: number) => `Min AI Score: *${n}*`,
    pollInterval: (s: string) => `Poll Interval: *${s}s*`,
    // Plain text, not italicized (_..._) - Telegram's legacy Markdown parser
    // can fail to parse entities when one italic span ends right where the
    // next begins (globalNote's trailing "._" immediately followed by
    // notConfiguredNote's leading "_"), even separated by a newline -
    // GrammyError 400: "can't parse entities". The env var name's own
    // underscores are still escaped (\_) even in plain text - three bare
    // underscores is an odd count, so the parser would otherwise pair the
    // first two into an unwanted italic span and leave the third as an
    // unmatched, unclosed entity - the same error under a different cause.
    globalNote: 'This is a global setting, not per-user.',
    statusPaused: '🟡 Paused (admin)',
    statusNotConfigured: '🔴 Disabled',
    notConfiguredNote:
      '\nTELEGRAM\\_TREND\\_SOURCE\\_ENABLED is off — an operator must set it and restart nova-api before this can run.',
    pauseBtn: '⏸ Pause Trend Monitor',
    resumeBtn: '▶️ Resume Trend Monitor',
  },

  liveOpportunities: {
    header: '🔥 *Live Opportunities*\n\n',
    empty: 'No tokens detected yet.',
  },

  trending: {
    header: '🚀 *Trending — Telegram Signals*\n\n',
    empty:
      'No Telegram-sourced tokens yet. Signals from t.me/trendingssol and t.me/trending that clear the liquidity and AI-score filters will show up here.',
  },

  tokenList: {
    mintRevoked: 'mint revoked',
    freezeRevoked: 'freeze revoked',
    lpLocked: 'LP locked',
    liquidityReason: (n: string) => `$${n} liquidity`,
    aiReason: (n: string) => `AI ${n}/100`,
    passedThresholds: 'passed configured thresholds',
    sourceLine: (ch: string) => `\n📡 Source: t.me/${ch}`,
    aiLine: (n: string) => `\n🤖 AI Score: *${n}/100*`,
    liquidityLine: (n: string) => `\n💧 Liquidity: *$${n}*`,
    riskLine: (parts: string) => `\n⚠️ Risk: ${parts}`,
    honeypotLine: '\n🚨 Honeypot/rug risk flagged',
    whyAcceptedLine: (reasons: string) => `✅ Why accepted: ${reasons}`,
    chartButton: '📊 Chart',
    buyButton: '💰 Buy',
  },

  feeDashboard: {
    header: '💸 *Fees & Earnings*\n\n',
    todaysProfit: (emoji: string, s: string) => `${emoji} Today's Profit: *${s}*`,
    lifetimeProfit: (emoji: string, s: string) => `${emoji} Lifetime Profit: *${s}*`,
    feesPaid: (s: string) => `📉 Performance Fees Paid: *${s}*`,
    referralEarnings: (s: string) => `🔗 Referral Earnings: *${s}*`,
    directReferrals: (n: number) => `👥 Direct Referrals: *${n}*`,
    topReferralsHeader: '\n\n🏅 *Top Referrals*\n',
    topReferralsRow: (rank: number, label: string, s: string) => `${rank}. ${label} — ${s}`,
    referralEarningsHistoryBtn: '📜 Referral Earnings History',
    referralLeaderboardBtn: '🏆 Referral Leaderboard',
  },

  feePolicyConsent: {
    title: '📜 *Performance Fee & Referral Policy*\n\n',
    freeNote: 'Registration is free — no monthly subscription, ever.\n\n',
    feeSectionTitle: '💸 *Performance Fee*\n',
    feeSectionBody:
      'You only pay a fee on a *profitable, completed* trade — never on a losing or break-even trade, and never before a trade actually closes.\n',
    currentFee: (pct: string) =>
      `Current fee: *${pct}%* of realized net profit, after trading costs.\n\n`,
    yourShareTitle: '👤 *Your Profit Share*\n',
    yourShareBody: (pct: string) =>
      `You keep *${pct}%* of net profit on every profitable trade.\n\n`,
    referralTitle: '🔗 *Referral Program*\n',
    referralLevelRow: (level: number, pct: string) =>
      `  • Level ${level}: ${pct}% of your net profit`,
    referralDisabled: '  • Referral program is currently disabled',
    referralSourceNote: (pct: string) =>
      `\nReferral rewards come out of the platform's own ${pct}% share — never an extra charge on your profit.\n\n`,
    ctaNote:
      "Tap below to accept and enable auto-trading. If this policy ever changes, you'll be asked to accept again before it applies to you.",
    acceptButton: '✅ I Agree, Enable Auto-Trading',
  },
};

export type Dict = typeof en;
