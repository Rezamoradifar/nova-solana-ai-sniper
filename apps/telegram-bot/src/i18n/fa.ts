import type { Dict } from './en.js';

/**
 * Persian (Farsi) dictionary — must mirror en.ts's shape exactly. `satisfies
 * Dict` below makes a missing/renamed key a compile error instead of a silent
 * English fallback. Telegram clients auto-render Persian text RTL; no markup
 * needed here. Numbers/amounts stay in Latin digits (parsed back as free text
 * elsewhere) even though the surrounding sentence is Persian.
 */
export const fa = {
  common: {
    back: '⬅️ بازگشت',
    somethingWrongScreen: '⚠️ مشکلی در نمایش این صفحه پیش آمد.',
    somethingWrong: '⚠️ مشکلی پیش آمد.',
    walletGone: '⚠️ این کیف پول دیگر وجود ندارد.',
    noShareCaption: '⚠️ کپشن اشتراک‌گذاری برای این معامله در دسترس نیست.',
    enabled: '🟢 فعال',
    disabled: '🔴 غیرفعال',
    menu: {
      home: '🏠 خانه',
      sniperStart: '▶️ شروع اسنایپر',
      sniperStop: '⏹ توقف اسنایپر',
      wallet: '👛 کیف پول',
      dashboard: '📊 داشبورد',
      positions: '📈 پوزیشن‌ها',
      trades: '💱 معاملات',
      leaderboard: '🏆 جدول برترین‌ها',
      alerts: '🔔 هشدارها',
      settings: '⚙️ تنظیمات',
      profile: '👤 پروفایل',
      portfolio: '💰 پرتفوی',
      referrals: '🔗 دعوت از دوستان',
      help: '❓ راهنما',
      trending: '🚀 پرطرفدارها',
      arbitrage: '🚧 آربیتراژ',
      liveOpportunities: '🔥 فرصت‌های زنده',
      telegramTrends: '📡 ترندهای تلگرام',
      trendSettings: '⚙️ تنظیمات ترند',
      feeDashboard: '💸 کارمزد و درآمد',
    },
  },

  home: {
    title: '👋 *GSP Bank Sniper*',
    openApp: '🚀 باز کردن اپ GSP',
    freeNote: 'همه امکانات زیر رایگان است — بدون سطح‌بندی، بدون محدودیت.',
    wallets: (n: number) => `👛 کیف پول‌ها: *${n}*`,
    activeSnipes: (n: number) => `🎯 پیکربندی‌های فعال اسنایپ: *${n}*`,
    openPositions: (n: number) => `📈 پوزیشن‌های باز: *${n}*`,
    pickSection: 'یک بخش را از پایین انتخاب کنید یا از منوی پایین چت استفاده کنید.',
  },

  welcome: {
    text: '👋 *GSP Bank Sniper* آماده است. برای پیمایش از منوی زیر استفاده کنید.',
  },

  language: {
    title: '🌐 *زبان*',
    prompt: 'زبان ربات را انتخاب کنید.',
    english: '🇬🇧 English',
    persian: '🇮🇷 فارسی',
    updated: '✅ زبان با موفقیت تغییر کرد.',
  },

  sniper: {
    noActiveWallet: '⚠️ کیف پول فعالی نیست',
    on: 'روشن',
    off: 'خاموش',
    active: 'فعال 🟢',
    paused: 'متوقف‌شده ⏸',
    card: (
      index: number,
      wallet: string,
      buy: string,
      minAiScore: number,
      autoBuy: string,
      status: string,
    ) =>
      `🎯 *اسنایپر #${index}*\n` +
      `کیف پول: ${wallet}\n` +
      `خرید: ${buy}\n` +
      `حداقل امتیاز هوش مصنوعی: ${minAiScore}\n` +
      `خرید خودکار: ${autoBuy}\n` +
      `وضعیت: ${status}`,
    startTitle: '▶️ *شروع اسنایپر*\n\n',
    noConfigText:
      'هنوز پیکربندی اسنایپی وجود ندارد.\n\nشروع سریع یک پیکربندی پیش‌فرض خرید خودکار می‌سازد که بعداً می‌توانید در تنظیمات دقیق‌تر کنید.',
    quickStartBtn: '➕ شروع سریع (0.1 SOL)',
    moreNote: (n: number) => `\n\n… و ${n} مورد دیگر (برای پاکسازی با پشتیبانی تماس بگیرید).`,
    pauseBtn: '⏸ توقف',
    resumeBtn: '▶️ ازسرگیری',
    deleteConfigBtn: '🗑 حذف پیکربندی',
    resumeAllBtn: '▶️ ازسرگیری همه',
    addAnotherBtn: '➕ افزودن پیکربندی دیگر (0.1 SOL)',
    stopTitle: '⏹ *توقف همه پیکربندی‌های اسنایپر؟*\n\n',
    activeNote: (n: number) =>
      `${n} پیکربندی در حال حاضر فعال است. توقف فقط خریدهای خودکار جدید را متوقف می‌کند — به پوزیشن‌های باز فعلی شما دست نمی‌زند و چیزی را حذف نمی‌کند.`,
    nothingActive: 'در حال حاضر چیزی فعال نیست.',
    pauseAllBtn: '⏸ توقف همه',
    selectConfigBtn: '🔎 انتخاب پیکربندی',
    cancelBtn: '❌ لغو',
    pausedConfirmation: (n: number) =>
      `✅ خرید خودکار با موفقیت متوقف شد (${n} پیکربندی).\n\n` +
      'پوزیشن‌های باز فعلی شما همچنان توسط مدیر پوزیشن رصد می‌شوند.',
    openPositionsBtn: '📊 پوزیشن‌های باز',
    closeAllPositionsBtn: '🔴 بستن همه پوزیشن‌ها',
    homeBtn: '🏠 خانه',
    deleteConfirmTitle: '🗑 *این پیکربندی اسنایپ حذف شود؟*\n\n',
    deleteConfirmBody:
      'این فقط خود پیکربندی را حذف می‌کند — کیف پول، پوزیشن‌های باز و کل تاریخچه معاملات/سود و زیان شما دست‌نخورده باقی می‌مانند.',
    confirmDeleteBtn: '✅ تأیید حذف',
    tradingRestricted:
      '🔒 معامله‌ی زنده فعلاً فقط برای مدیر ربات فعاله. بقیه‌ی صفحات رو می‌تونی ببینی، ولی فعال/ازسرگیری پیکربندی اسنایپ برای این اکانت غیرفعاله.',
  },

  settings: {
    noConfig:
      '⚙️ *تنظیمات*\n\nهنوز پیکربندی اسنایپی ندارید — ابتدا از ▶️ شروع اسنایپر یکی بسازید، سپس برای تنظیم دقیق آن به اینجا برگردید.',
    title: '⚙️ *تنظیمات*\n\n',
    editingNote: 'در حال ویرایش آخرین پیکربندی اسنایپ شما:\n\n',
    buyAmount: (s: string) => `💰 مقدار خرید: *${s}*`,
    maxSlippage: (bps: number) => `📉 حداکثر اسلیپیج: *${bps} bps*`,
    minLiquidity: (s: string) => `💧 حداقل نقدینگی: *$${s}*`,
    minAiScore: (n: number) => `🤖 حداقل امتیاز هوش مصنوعی: *${n}*`,
    stopLoss: (pct: number) => `🛑 حد ضرر: *${pct}%*`,
    stopLossDefault: (pct: number, ceiling: number) =>
      `🛑 حد ضرر: *${pct}%* _(پیش‌فرض سیستم — هرگز شل‌تر از ${ceiling}% نیست)_`,
    exitStrategy: (label: string) => `📐 استراتژی خروج: *${label}*`,
    trailingOnlyNote:
      '\n_بدون تیک‌پرافیت ثابت — فقط تریلینگ استاپ، فاصله بر اساس نقدینگی/تمرکز هولدرها تطبیق می‌یابد._',
    customPresetLabel: 'سفارشی (TP/SL/تریلینگ دستی برای هر پوزیشن)',
    buyAmountBtn: '✏️ مقدار خرید',
    slippageBtn: '✏️ اسلیپیج',
    stopLossBtn: '✏️ حد ضرر',
    minLiquidityBtn: '✏️ حداقل نقدینگی',
    minAiScoreBtn: '✏️ حداقل امتیاز هوش مصنوعی',
    customPresetBtn: '↩️ سفارشی (TP/SL/تریلینگ دستی)',
    languageBtn: '🌐 زبان',
    fieldMeta: {
      buyAmountSol: {
        label: 'مقدار خرید',
        prompt: 'مقدار جدید خرید را به SOL ارسال کنید (مثلاً `0.25`).',
      },
      maxSlippageBps: {
        label: 'حداکثر اسلیپیج',
        prompt:
          'حداکثر اسلیپیج جدید را بر حسب بیسیس پوینت، بین 1 تا 10000 ارسال کنید (مثلاً `300` برای 3%).',
      },
      minLiquidityUsd: {
        label: 'حداقل نقدینگی',
        prompt: 'حداقل نقدینگی جدید را به دلار ارسال کنید (مثلاً `1000`).',
      },
      minAiScore: {
        label: 'حداقل امتیاز هوش مصنوعی',
        prompt: 'حداقل امتیاز جدید هوش مصنوعی را بین 0 تا 100 ارسال کنید (مثلاً `60`).',
      },
      stopLossPercent: {
        label: 'حد ضرر',
        prompt: (ceiling: number) =>
          `درصد حد ضرر جدید را به‌صورت عدد ارسال کنید (مثلاً \`15\` برای -15%). هرگز شل‌تر از ${ceiling}% اعمال نمی‌شود — مقدار بزرگ‌تر به ${ceiling} محدود می‌شود.`,
      },
    },
    promptTitle: (label: string) => `⚙️ *${label}*\n\n`,
    invalidValue: (prompt: string) => `این مقدار درست به نظر نمی‌رسد. ${prompt}`,
    configGone: 'این پیکربندی اسنایپ دیگر وجود ندارد.',
  },

  notifications: {
    newLaunch: (dex: string) => `*لانچ جدید در ${dex}*`,
    liquidityLabel: 'نقدینگی',
    marketCapLabel: 'ارزش بازار',
    aiScoreLabel: 'امتیاز هوش مصنوعی',
    ruleScoreLabel: 'امتیاز قانونی (بدون ارائه‌دهنده هوش مصنوعی)',
    mintLabel: 'مینت',
    freezeLabel: 'فریز',
    lpLabel: 'LP',
    top10Label: 'Top10',
    riskLabel: 'ریسک',
    momentumLabel: 'مومنتوم (۱ساعته)',
    honeypotFlag: '⚠️ احتمال هانی‌پات/راگ پرچم‌گذاری شد',
    aiHighScoreLabel: 'امتیاز بالای هوش مصنوعی',
    highRuleScoreLabel: 'امتیاز قانونی بالا (بدون ارائه‌دهنده هوش مصنوعی)',
    priceLabel: 'قیمت',
    simulatedFill: '_(اجرای شبیه‌سازی‌شده، بدون تراکنش آنچین)_',
    amountLabel: 'مقدار',
    positionClosedLabel: 'پوزیشن بسته شد',
    reasonLabel: 'دلیل',
    pnlLabel: 'سود/زیان',
    entryLabel: 'ورود',
    athLabel: 'بیشترین قیمت (ATH)',
    lockedProfitLabel: 'سود قفل‌شده',
    exitReasonLabels: {
      take_profit: 'تیک‌پرافیت',
      stop_loss: 'حد ضرر',
      trailing_stop: 'تریلینگ استاپ',
      emergency: 'اضطراری',
      manual_emergency: 'اضطراری دستی',
      time_stop: 'خروج زمانی',
    } as Record<string, string>,
    emergencyExitLabel: 'خروج اضطراری',
    emergencyReasonLabels: {
      liquidity_removed: 'نقدینگی برداشته شد',
      trading_disabled: 'معامله غیرفعال شد (بدون مسیر فروش)',
      mint_reenabled: 'اختیار مینت دوباره فعال شد',
      freeze_reenabled: 'اختیار فریز دوباره فعال شد',
      critical_rug_score: 'امتیاز راگ بحرانی',
      dev_wallet_dump: 'شناسایی دامپ بزرگ کیف پول',
    } as Record<string, string>,
    tradeReportTitle: 'گزارش معامله',
    grossProfitLabel: 'سود ناخالص',
    tradingCostsLabel: 'هزینه‌های معامله',
    netProfitLabel: 'سود خالص',
    performanceFeeLabel: (pct: string) => `کارمزد عملکرد پلتفرم (${pct}%)`,
    referralRewardsLabel: 'پاداش‌های دعوت',
    finalAmountCreditedLabel: 'مبلغ نهایی واریزشده',
    refLabel: 'شناسه',
    referralEarnedTitle: 'پاداش دعوت دریافت شد!',
    referralEarnedBody: (level: number, symbol: string) =>
      `یکی از دعوت‌شدگان سطح ${level} شما یک معامله سودآور روی \`${symbol}\` بست.`,
    youEarnedLabel: 'شما دریافت کردید',
    migrationDetectedLabel: 'مهاجرت شناسایی شد',
    lowBalanceTitle: 'خرید خودکار متوقف شد — موجودی کیف پول ناکافی است',
    lowBalanceBody: (balance: string, required: string) =>
      `موجودی کیف پول شما *${balance} SOL* است — کمتر از *${required} SOL* ` +
      'که پیکربندی خرید خودکار شما برای اجرای خرید (مبلغ معامله + ذخیره کارمزد) نیاز دارد.',
    lowBalanceSkipNote: (shortfall: string) =>
      `هر لانچ توکن جدید در حال حاضر برای حساب شما رد می‌شود. حداقل *${shortfall} SOL* واریز کنید ` +
      '— آدرس خود را از 👛 کیف پول ← 🧾 واریز باز کنید — و خرید خودکار در لانچ بعدی خودکار از سر گرفته می‌شود.',
    lowBalanceOneTimeNote:
      '_اطلاعیه یک‌باره — این پیام برای هر معامله ردشده دوباره ارسال نمی‌شود._',
    referralRewardUnlockedTitle: 'پاداش دعوت فعال شد!',
    referralRewardUnlockedBody: (n: number) =>
      `شما ${n} نفر را دعوت کرده‌اید — یک پیکربندی پیش‌فرض اسنایپر با خرید خودکار اکنون برای شما فعال است.`,
    referralRewardCheckNote: (sniperStartLabel: string) =>
      `برای بررسی یا تنظیم آن، ${sniperStartLabel} را بررسی کنید.`,
  },

  arbitrage: {
    text: '🚧 *آربیتراژ*\n\nاین امکان هنوز در دسترس نیست.\nبه‌زودی برمی‌گردیم!',
  },

  help: {
    text:
      `❓ *راهنما*\n\n` +
      `*منو*\n` +
      `▶️ شروع اسنایپر — ساخت یا ازسرگیری پیکربندی‌های خرید خودکار\n` +
      `⏹ توقف اسنایپر — توقف موقت همه خریدهای خودکار\n` +
      `👛 کیف پول — ساخت/ایمپورت/بکاپ/بازیابی کیف پول‌ها\n` +
      `📊 داشبورد — نمای کلی پرتفوی\n` +
      `📈 پوزیشن‌ها — پوزیشن‌های باز، ویرایش TP/SL\n` +
      `💱 معاملات — تاریخچه معاملات اخیر\n` +
      `🏆 جدول برترین‌ها — کیف پول‌های برتر بر اساس سود و زیان\n` +
      `🔔 هشدارها — فعالیت‌های اخیر حساب\n` +
      `⚙️ تنظیمات — ویرایش پیکربندی اسنایپ شما\n` +
      `👤 پروفایل — اطلاعات حساب شما\n` +
      `💰 پرتفوی — تفکیک سود و زیان هر کیف پول\n` +
      `🔗 دعوت از دوستان — کد و لینک دعوت شما\n\n` +
      `*دستورات*\n` +
      `/start — باز کردن منوی اصلی\n\n` +
      `همه امکانات برای همه کاربران رایگان است — هیچ سطح پولی وجود ندارد.`,
  },

  wallet: {
    title: '👛 *کیف پول*\n\n',
    noWallets: 'هنوز کیف پولی ندارید.',
    walletRow: (dot: string, label: string, key: string) => `${dot} ${label}\n\`${key}\``,
    depositBtn: (label: string) => `🧾 واریز ${label}`,
    backupBtn: (label: string) => `💾 بکاپ ${label}`,
    deactivateBtn: (label: string) => `🗑 غیرفعال‌سازی ${label}`,
    createWalletBtn: '➕ ساخت کیف پول',
    importWalletBtn: '📥 ایمپورت کیف پول',
    restoreWalletBtn: '♻️ بازیابی کیف پول',
    seedPhraseWarning: (mnemonic: string) =>
      '🔐 *این عبارت بازیابی را همین حالا ذخیره کنید — دوباره نمایش داده نمی‌شود*\n\n' +
      `\`${mnemonic}\`\n\n` +
      'آن را جایی آفلاین یادداشت کنید. هرکس این کلمات را داشته باشد می‌تواند هر چیزی در این کیف پول را بردارد. ' +
      'این پیام تا ۶۰ ثانیه دیگر خودش حذف می‌شود.',
    importPromptText:
      '📥 *ایمپورت کیف پول*\n\nکلید مخفی (به فرمت base58) کیف پولی که می‌خواهید ایمپورت کنید را ارسال کنید.\n\n' +
      '⚠️ بلافاصله پس از ارسال، پیام خود را حذف کنید — تلگرام تاریخچه چت را نگه می‌دارد و هرکس این کلید را داشته باشد کنترل کیف پول را در دست می‌گیرد.',
    invalidSecretKey:
      '⚠️ این کلید مخفی نامعتبر است. یک کلید مخفی معتبر base58 ارسال کنید یا با ⬅️ بازگشت لغو کنید.',
    backupPasswordPromptText:
      '💾 *بکاپ کیف پول*\n\nیک رمز عبور برای رمزنگاری کلید این کیف پول ارسال کنید (حداقل ۸ کاراکتر). ' +
      'برای بازیابی بعدی به همین رمز نیاز خواهید داشت — این رمز هیچ‌جا ذخیره نمی‌شود.',
    passwordTooShort: 'رمز عبور باید حداقل ۸ کاراکتر باشد. یک رمز جدید ارسال کنید.',
    walletGoneNoEmoji: 'این کیف پول دیگر وجود ندارد.',
    restoreFilePromptText:
      '♻️ *بازیابی کیف پول*\n\nفایل بکاپ (.json) که قبلاً خروجی گرفته‌اید را به‌صورت سند تلگرام ارسال کنید.',
    restorePasswordPromptText:
      '♻️ *بازیابی کیف پول*\n\nفایل دریافت شد. اکنون رمز عبوری که هنگام ساخت این بکاپ استفاده کردید را ارسال کنید.',
    incorrectPasswordOrCorrupted:
      '⚠️ رمز عبور نادرست یا فایل بکاپ خراب است. رمز عبور را دوباره ارسال کنید یا با ⬅️ بازگشت لغو کنید.',
    invalidBackupKey: '⚠️ آن بکاپ حاوی کلید معتبر کیف پول نبود.',
    alreadyAdded: 'این کیف پول قبلاً اضافه شده است.',
    alreadyActive: 'این کیف پول از قبل فعال است.',
    depositTitle: (label: string) => `🧾 *واریز — ${label}*\n\n`,
    network: 'Solana Mainnet',
    depositBody: (pubkey: string, network: string, balance: string, lastUpdated: string) =>
      `\`${pubkey}\`\n\n` +
      `شبکه: ${network}\n` +
      `موجودی: ${balance}\n` +
      `آخرین به‌روزرسانی: ${lastUpdated}\n\n` +
      'فقط SOL یا توکن‌های SPL روی شبکه سولانا به این آدرس ارسال کنید. برای کپی، روی آدرس بالا بزنید.',
    refreshBalanceBtn: '🔄 تازه‌سازی موجودی',
    showQrBtn: '🖼 نمایش QR',
    transactionHistoryBtn: '🧾 تاریخچه تراکنش‌ها',
    walletHistoryBtn: '📜 تاریخچه کیف پول',
    qrCaption: (label: string, pubkey: string) => `🖼 آدرس واریز *${label}*\n\`${pubkey}\``,
    walletHistoryTitle: (label: string) => `📜 *تاریخچه کیف پول — ${label}*\n\n`,
    noHistoryYet: 'هنوز تاریخچه‌ای وجود ندارد.',
    historyRow: (date: string, action: string, status: string) => `${date} — ${action} (${status})`,
    depositScreenBtn: '🧾 صفحه واریز',
    newerBtn: '⬅️ جدیدتر',
    olderBtn: '➡️ قدیمی‌تر',
    transactionHistoryTitle: (label: string) => `🧾 *تاریخچه تراکنش‌ها — ${label}*\n\n`,
    noTransactionsYet: 'هنوز تراکنشی وجود ندارد.',
    transactionRow: (date: string, type: string, sign: string, amount: string) =>
      `${date} — ${type} ${sign}${amount}`,
    invalidBackupFile:
      '⚠️ این فایل بکاپ معتبر نوا به نظر نمی‌رسد. فایل درست را ارسال کنید یا با ⬅️ بازگشت لغو کنید.',
    couldNotReadFile: '⚠️ امکان خواندن این فایل نبود. دوباره تلاش کنید یا با ⬅️ بازگشت لغو کنید.',
    sendAsDocumentNote:
      'فایل بکاپ را به‌صورت سند تلگرام ارسال کنید (فایل .json را پیوست کنید)، نه به‌صورت متن.',
    backupCaption: '💾 بکاپ رمزنگاری‌شده کیف پول — این فایل و رمز آن را جایی امن نگه دارید.',
  },

  positions: {
    notConfigured: '📈 *پوزیشن‌ها*\n\n⚠️ یکپارچه‌سازی موتور معاملاتی پیکربندی نشده است.',
    loadFailed:
      '📈 *پوزیشن‌ها*\n\n⚠️ در حال حاضر امکان بارگذاری داده زنده پوزیشن‌ها نیست — ممکن است موتور معاملاتی ' +
      'موقتاً در دسترس نباشد. کمی بعد دوباره تلاش کنید.',
    title: '📈 *پوزیشن‌ها*\n\n',
    empty: 'پوزیشن باز وجود ندارد.',
    positionHeader: (symbol: string, mint: string) => `🪙 *${symbol}* (\`${mint}\`)`,
    walletLine: (w: string) => `کیف پول: ${w}`,
    buyEntryLine: (buy: string, entry: string) => `خرید: ${buy} · ورود: $${entry}`,
    currentValueLine: (est: string, emoji: string, pnl: string) =>
      `ارزش فعلی: ${est} · ${emoji} سود/زیان: ${pnl}%`,
    currentValueUnavailable: 'ارزش فعلی در حال حاضر در دسترس نیست',
    tokenBalance: (n: string) => `موجودی توکن: ${n} (ثبت‌شده)`,
    statusOpen: 'وضعیت: باز',
    pageLabel: (page: number, total: number) => `\n\nصفحه ${page}/${total}`,
    tpBtn: (symbol: string) => `✏️ ${symbol} TP`,
    slBtn: (symbol: string) => `✏️ ${symbol} SL`,
    closePositionBtn: '🔴 بستن پوزیشن',
    explorerBtn: '🔍 اکسپلورر',
    prevBtn: '⬅️ قبلی',
    nextBtn: '➡️ بعدی',
    closeAllBtn: '🔴 بستن همه پوزیشن‌ها',
    closedCountLine: (n: number) => `\n\n📜 پوزیشن‌های بسته‌شده: *${n}*`,
    confirmCloseTitle: (symbol: string) => `⚠️ *این پوزیشن بسته شود؟*\n\n${symbol}\n\n`,
    confirmCloseBody: 'این پوزیشن بسته شده و موجودی توکن موجود فروخته شود؟',
    confirmSellBtn: '✅ تأیید فروش',
    cancelBtn: '❌ لغو',
    notConfiguredShort: '⚠️ یکپارچه‌سازی موتور معاملاتی پیکربندی نشده است.',
    alreadyProcessing:
      '⏳ درخواست قبلی شما برای این پوزیشن در حال پردازش است — لطفاً منتظر بمانید.',
    positionGoneOrNotYours: '⚠️ این پوزیشن دیگر وجود ندارد یا متعلق به شما نیست.',
    alreadyClosed: 'ℹ️ این پوزیشن قبلاً بسته شده است.',
    alreadyHandled: 'ℹ️ این پوزیشن قبلاً توسط عملیات دیگری مدیریت شده — کار دیگری لازم نیست.',
    zeroBalanceReconciliation: (symbol: string) =>
      `⚠️ این پوزیشن موجودی آنچین صفر دارد و نیاز به تطبیق دارد.\n\n` +
      `${symbol} برای ثبت حسابداری بسته شد — از آنجا که وضعیت واقعی توکن‌ها مشخص نیست، ` +
      'سود/زیانی ثبت نشد.',
    closedSuccess: (symbol: string) => `✅ *پوزیشن بسته شد*\n\n${symbol} فروخته شد.`,
    realizedPnlLine: (emoji: string, usd: string) => `\nسود/زیان محقق‌شده: ${emoji} ${usd}`,
    txLine: (sig: string) => `\n\nتراکنش: \`${sig}\``,
    unexpectedCloseError: 'خطای غیرمنتظره هنگام بستن پوزیشن.',
    closeFailedTitle: (msg: string) =>
      `❌ *بستن ناموفق بود*\n\n${msg}\n\nپوزیشن همچنان باز است — می‌توانید دوباره تلاش کنید.`,
    closeAllConfirmTitle: '⚠️ *همه پوزیشن‌های باز بسته شوند؟*\n\n',
    closeAllConfirmBody:
      'شما در حال تلاش برای بستن همه پوزیشن‌های باز در کیف پول‌های فعال خود هستید.',
    confirmCloseAllBtn: '⚠️ تأیید بستن همه',
    alreadyProcessingCloseAll: '⏳ یک درخواست بستن همه در حال پردازش است — لطفاً منتظر بمانید.',
    closeAllSummaryTitle: (closed: number, failed: number, skipped: number) =>
      `📊 *خلاصه بستن همه پوزیشن‌ها*\n\nبسته‌شده: ${closed}\nناموفق: ${failed}\nرد‌شده: ${skipped}`,
    failureRow: (symbol: string, reason: string) => `• ${symbol}: ${reason}`,
    moreFailures: (n: number) => `\n… و ${n} مورد دیگر`,
    unexpectedCloseAllError: 'خطای غیرمنتظره هنگام بستن پوزیشن‌ها.',
    closeAllFailedTitle: (msg: string) => `❌ *بستن همه ناموفق بود*\n\n${msg}`,
    tpPromptTitle:
      '✏️ *تیک‌پرافیت*\n\nدرصد جدید تیک‌پرافیت را به‌صورت عدد ارسال کنید (مثلاً `50` برای +50%).',
    slPromptTitle:
      '✏️ *حد ضرر*\n\nدرصد جدید حد ضرر را به‌صورت عدد ارسال کنید (مثلاً `20` برای -20%).',
    invalidNumber: 'این مقدار درست به نظر نمی‌رسد — یک عدد مثبت ارسال کنید.',
    positionGone: 'این پوزیشن دیگر وجود ندارد.',
    friendlyReasons: {
      routeUnavailable:
        'در حال حاضر مسیر معامله‌ای برای این توکن در دسترس نیست — کمی بعد دوباره تلاش کنید.',
      liquidity: 'در حال حاضر نقدینگی کافی برای فروش نیست — کمی بعد دوباره تلاش کنید.',
      slippage: 'قیمت از حد مجاز اسلیپیج عبور کرد — دوباره تلاش کنید.',
      networkSlow: 'شبکه در تأیید معامله کند بود — دوباره تلاش کنید.',
      positionLock: 'این پوزیشن در حال حاضر توسط عملیات دیگری در حال بسته یا فروخته شدن است.',
    },
  },

  trades: {
    title: '💱 *معاملات*\n\n',
    empty: 'هنوز معامله‌ای انجام نشده.',
    row: (
      emoji: string,
      side: string,
      symbol: string,
      sol: string,
      statusBadge: string,
      date: string,
    ) => `${emoji} *${side}* ${symbol} — ${sol}${statusBadge}\n${date}`,
    statusLabels: { pending: 'در انتظار', failed: 'ناموفق' } as Record<string, string>,
  },

  leaderboard: {
    header: '🏆 *جدول برترین‌ها*\n\nکیف پول‌های برتر بر اساس سود و زیان محقق‌شده:\n\n',
    empty: 'هنوز معامله بسته‌شده‌ای وجود ندارد — اولین نفر باشید!',
    row: (rank: number, emoji: string, label: string, usd: string, closed: number) =>
      `${rank}. ${emoji} ${label} — ${usd} (${closed} بسته‌شده)`,
  },

  dashboard: {
    title: '📊 *داشبورد*',
    openPositions: (n: number) => `📈 پوزیشن‌های باز: *${n}*`,
    invested: (s: string) => `💵 سرمایه‌گذاری‌شده: *${s}*`,
    realizedPnl: (emoji: string, s: string) => `${emoji} سود/زیان محقق‌شده: *${s}*`,
    unrealizedPnl: (emoji: string, s: string) => `${emoji} سود/زیان محقق‌نشده: *${s}*`,
    yourTrades: (n: number) => `💱 معاملات شما: *${n}*`,
    tokensTracked: (n: number) => `🪙 توکن‌های ردیابی‌شده در کل پلتفرم: *${n}*`,
  },

  portfolio: {
    title: '💰 *پرتفوی*',
    empty: 'هنوز کیف پولی ندارید — یکی از بخش 👛 کیف پول بسازید.',
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
      `باز: ${open} · سرمایه‌گذاری‌شده: ${invested}\n` +
      `${pnlEmojiR} محقق‌شده: ${realized} · ${pnlEmojiU} محقق‌نشده: ${unrealized}`,
  },

  alerts: {
    title: '🔔 *هشدارها*\n\nفعالیت‌های اخیر حساب شما:\n\n',
    empty: 'هنوز فعالیتی ثبت نشده — تغییرات کیف پول و معاملات اینجا نمایش داده می‌شوند.',
    actionLabels: {
      'wallet.create': '👛 کیف پول ساخته شد',
      'wallet.import': '👛 کیف پول ایمپورت شد',
      'auth.register': '🆕 حساب ساخته شد',
      'auth.login': '🔓 ورود انجام شد',
      'auth.login_failed': '⚠️ تلاش ناموفق برای ورود',
      'referral.pro_unlocked': '🎉 پاداش دعوت',
    } as Record<string, string>,
    unmapped: (action: string) => `ℹ️ ${action}`,
  },

  profile: {
    title: '👤 *پروفایل*',
    name: (n: string) => `نام: ${n}`,
    username: (u: string) => `نام کاربری: ${u}`,
    telegramId: (id: string) => `شناسه تلگرام: \`${id}\``,
    memberSince: (d: string) => `عضویت از: ${d}`,
    wallets: (n: number) => `کیف پول‌ها: *${n}*`,
    plan: (tier: string) => `پلن: *${tier}* — همه امکانات رایگان و بازند`,
    referralCode: (code: string) => `کد دعوت: \`${code}\``,
  },

  referrals: {
    title: '🔗 *دعوت از دوستان*',
    yourCode: (code: string) => `کد شما: \`${code}\``,
    peopleReferred: (n: number) => `افراد دعوت‌شده: *${n}*`,
    shareLink: (link: string) =>
      `لینک خود را به اشتراک بگذارید — هرکس با آن وارد ربات شود به‌طور خودکار به شما نسبت داده می‌شود:\n\`${link}\``,
    shareCodeOnly: 'کد خود را با دوستانتان به اشتراک بگذارید تا هنگام عضویت به شما نسبت داده شوند.',
    refresh: '🔄 تازه‌سازی',
  },

  referralEarnings: {
    header: '📜 *تاریخچه درآمد دعوت*\n\n',
    empty: 'هنوز درآمدی از دعوت ندارید — لینک دعوت خود را از 🔗 دعوت از دوستان به اشتراک بگذارید.',
    row: (level: number, usd: string, from: string, date: string) =>
      `🔗 سطح ${level} — ${usd} از ${from}\n${date}`,
  },

  referralLeaderboard: {
    header: '🏆 *جدول برترین دعوت‌کنندگان*\n\nدعوت‌کنندگان برتر بر اساس مجموع درآمد:\n\n',
    empty: 'هنوز درآمدی از دعوت ثبت نشده است.',
    row: (rank: number, label: string, usd: string) => `${rank}. ${label} — ${usd}`,
  },

  telegramTrends: {
    header: (statusLine: string, channels: string) =>
      `📡 *ترندهای تلگرام*\n\nوضعیت منبع: ${statusLine}\nکانال‌ها: ${channels}\n\n`,
    fetchError: '⚠️ در حال حاضر امکان اتصال به سرویس آمار نیست — کمی بعد دوباره تلاش کنید.',
    signalsReceived: (n: number) => `📥 سیگنال‌های دریافتی: *${n}*`,
    mintsExtracted: (n: number) => `🪙 مینت‌های استخراج‌شده: *${n}*`,
    duplicateRejected: (n: number) => `♻️ رد شده به دلیل تکراری بودن: *${n}*`,
    blacklistRejected: (n: number) => `🚫 رد شده به دلیل لیست سیاه: *${n}*`,
    liquidityZeroRejected: (n: number) => `💧 رد شده به دلیل نقدینگی صفر: *${n}*`,
    aiRejected: (n: number) => `🤖 رد شده توسط هوش مصنوعی: *${n}*`,
    qualifiedOpportunities: (n: number) => `✅ فرصت‌های واجد شرایط: *${n}*`,
    executedTrades: (n: number) => `💰 معاملات اجراشده: *${n}*`,
    rpcSaved: (n: number) => `📉 تماس‌های RPC صرفه‌جویی‌شده (تخمینی): *${n}*`,
  },

  trendSettings: {
    title: '⚙️ *تنظیمات ترند*',
    status: (s: string) => `وضعیت: ${s}`,
    channels: (c: string) => `کانال‌ها: ${c}`,
    minAiScore: (n: number) => `حداقل امتیاز هوش مصنوعی: *${n}*`,
    pollInterval: (s: string) => `فاصله بررسی: *${s} ثانیه*`,
    globalNote: 'این یک تنظیم سراسری است، نه مخصوص هر کاربر.',
    statusPaused: '🟡 متوقف‌شده (توسط ادمین)',
    statusNotConfigured: '🔴 غیرفعال',
    notConfiguredNote:
      '\nTELEGRAM\\_TREND\\_SOURCE\\_ENABLED خاموش است — یک اپراتور باید آن را فعال کند و nova-api را ری‌استارت کند تا این بخش کار کند.',
    pauseBtn: '⏸ توقف مانیتور ترند',
    resumeBtn: '▶️ ازسرگیری مانیتور ترند',
  },

  liveOpportunities: {
    header: '🔥 *فرصت‌های زنده*\n\n',
    empty: 'هنوز توکنی شناسایی نشده است.',
  },

  trending: {
    header: '🚀 *پرطرفدارها — سیگنال‌های تلگرام*\n\n',
    empty:
      'هنوز توکنی از منبع تلگرام دریافت نشده. سیگنال‌های t.me/trendingssol و t.me/trending که فیلترهای نقدینگی و امتیاز هوش مصنوعی را رد کنند اینجا نمایش داده می‌شوند.',
  },

  tokenList: {
    mintRevoked: 'اختیار مینت لغو شده',
    freezeRevoked: 'اختیار فریز لغو شده',
    lpLocked: 'LP قفل شده',
    liquidityReason: (n: string) => `$${n} نقدینگی`,
    aiReason: (n: string) => `هوش مصنوعی ${n}/100`,
    passedThresholds: 'شرایط پیکربندی‌شده را رد کرده',
    sourceLine: (ch: string) => `\n📡 منبع: t.me/${ch}`,
    aiLine: (n: string) => `\n🤖 امتیاز هوش مصنوعی: *${n}/100*`,
    liquidityLine: (n: string) => `\n💧 نقدینگی: *$${n}*`,
    riskLine: (parts: string) => `\n⚠️ ریسک: ${parts}`,
    honeypotLine: '\n🚨 احتمال هانی‌پات/راگ پرچم‌گذاری شد',
    whyAcceptedLine: (reasons: string) => `✅ دلیل پذیرش: ${reasons}`,
    chartButton: '📊 نمودار',
    buyButton: '💰 خرید',
  },

  feeDashboard: {
    header: '💸 *کارمزد و درآمد*\n\n',
    todaysProfit: (emoji: string, s: string) => `${emoji} سود امروز: *${s}*`,
    lifetimeProfit: (emoji: string, s: string) => `${emoji} سود کل: *${s}*`,
    feesPaid: (s: string) => `📉 کارمزد عملکرد پرداختی: *${s}*`,
    referralEarnings: (s: string) => `🔗 درآمد دعوت: *${s}*`,
    directReferrals: (n: number) => `👥 دعوت‌های مستقیم: *${n}*`,
    topReferralsHeader: '\n\n🏅 *برترین دعوت‌شدگان*\n',
    topReferralsRow: (rank: number, label: string, s: string) => `${rank}. ${label} — ${s}`,
    referralEarningsHistoryBtn: '📜 تاریخچه درآمد دعوت',
    referralLeaderboardBtn: '🏆 جدول برترین دعوت‌کنندگان',
  },

  feePolicyConsent: {
    title: '📜 *سیاست کارمزد عملکرد و دعوت*\n\n',
    freeNote: 'ثبت‌نام رایگان است — بدون اشتراک ماهانه، هرگز.\n\n',
    feeSectionTitle: '💸 *کارمزد عملکرد*\n',
    feeSectionBody:
      'شما فقط بابت یک معامله *سودآور و تکمیل‌شده* کارمزد می‌پردازید — هرگز روی معامله زیان‌ده یا سربه‌سر، و هرگز پیش از بسته شدن واقعی معامله.\n',
    currentFee: (pct: string) =>
      `کارمزد فعلی: *${pct}%* از سود خالص محقق‌شده، پس از هزینه‌های معامله.\n\n`,
    yourShareTitle: '👤 *سهم شما از سود*\n',
    yourShareBody: (pct: string) =>
      `شما *${pct}%* از سود خالص هر معامله سودآور را دریافت می‌کنید.\n\n`,
    referralTitle: '🔗 *برنامه دعوت*\n',
    referralLevelRow: (level: number, pct: string) => `  • سطح ${level}: ${pct}% از سود خالص شما`,
    referralDisabled: '  • برنامه دعوت در حال حاضر غیرفعال است',
    referralSourceNote: (pct: string) =>
      `\nپاداش‌های دعوت از سهم ${pct}% خود پلتفرم پرداخت می‌شود — هرگز هزینه اضافه‌ای روی سود شما نیست.\n\n`,
    ctaNote:
      'برای پذیرش و فعال‌سازی معاملات خودکار، دکمه زیر را بزنید. اگر این سیاست تغییر کند، دوباره از شما خواسته می‌شود پیش از اعمال آن، آن را بپذیرید.',
    acceptButton: '✅ موافقم، معاملات خودکار را فعال کن',
  },
} as const satisfies Dict;
