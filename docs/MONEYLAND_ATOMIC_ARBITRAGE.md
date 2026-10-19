# Moneyland — isolated atomic arbitrage runner

## وضعیت تحویل

موتور مستقل برای مسیر سرمایه‌دار `WSOL → USDC → WSOL` روی Solana ساخته شده است. هر دو سواپ و کنترل موجودی پایانی در یک تراکنش نسخه صفر قرار می‌گیرند. حالت نصب اولیه `off` است؛ نصب هیچ معامله‌ای ارسال نمی‌کند، به کیف‌پول مشتریان وصل نمی‌شود و API، دیتابیس، اسنایپر یا کپی‌ترید Nova را راه‌اندازی مجدد یا فعال نمی‌کند.

این تحویل **ممیزی مستقل، اثبات سودآوری یا تأیید اجرای Mainnet نیست**. تست‌ها شامل اعتبارسنجی، ذخیره‌سازی، ساخت واقعی پیام با SDK سولانا و پاسخ‌های ساختگی RPC/Jupiter هستند؛ هیچ تستی در CI معامله واقعی نمی‌فرستد. شبیه‌سازی واقعی باید با آدرس عمومی کیف‌پول اختصاصی و RPC خود اپراتور اجرا و بررسی شود.

## نصب از GitHub — بدون فعال‌سازی معامله

این پروژه به صورت پیش‌فرض در `/opt/nova-solana-ai-sniper` روی VPS شما قرار دارد. ابتدا feature branch را fetch و SHA دقیق نسخه‌ای که CI آن موفق بوده بررسی کنید. اسکریپت نصب فقط همان SHA را می‌پذیرد؛ checkout فعلی Nova را تغییر نمی‌دهد.

```sh
cd /opt/nova-solana-ai-sniper
git fetch --no-tags origin codex/moneyland-atomic-arbitrage-20261019
# RELEASE را فقط با SHA دقیق بررسی‌شده در گزارش CI جایگزین کنید.
RELEASE=REVIEWED_40_CHARACTER_COMMIT
installer=$(mktemp /tmp/moneyland-arbitrage.XXXXXXXX.sh)
git show "$RELEASE:scripts/install-moneyland-arbitrage.sh" > "$installer" &&
  bash "$installer" "$RELEASE"
rm -f "$installer"
```

خروجی نصب موفق: `ARBITRAGE_RUNNER_INSTALLED_NO_TRADES`. سپس `moneyland-arbitrage status` وضعیت بدون شبکه را نشان می‌دهد. وجود `executionEnabled: false` طبیعی است: این runner یک سرویس خودکار فعال نیست و دستور ارسال یک‌باره چند مجوز مجزا لازم دارد.

محل‌ها:

| بخش | مسیر |
| --- | --- |
| تنظیمات مستقل، فقط root | `/etc/moneyland-arbitrage.env` |
| اطلاعات پایدار، مالک UID 1000 | `/var/lib/moneyland-arbitrage` |
| مسیر کلید و مجوز، read-only داخل کانتینر | `/etc/moneyland-arbitrage/secrets` |
| نسخه مجزا | `/opt/moneyland-arbitrage/releases/<SHA>` |
| فرمان اجرا | `/usr/local/bin/moneyland-arbitrage` |

هیچ پورت عمومی باز نمی‌شود. نصب با DNS دامنه `moneyland.tr` کاری ندارد و برای کارکرد مستقل موتور، وب‌سایت لازم نیست. هر فرمان یک کانتینر محدود با root filesystem فقط‌خواندنی، بدون Linux capabilities و بدون دسترسی به دیتابیس Nova اجرا می‌کند. کانتینر UID 1000 دارد؛ کلیدها و مجوزهای واقعی، در صورت تأیید مرحله live، باید برای همین UID قابل خواندن و mode 0600 باشند. توکن یا کلید خصوصی را در گیت، گفت‌وگو، لاگ یا تصویر منتشر نکنید.

## شبیه‌سازی — فقط اطلاعات عمومی کیف‌پول

پس از نصب، فایل مستقل را **روی همان سرور** با ویرایشگر باز کنید؛ محتوایش را در گفت‌وگو نفرستید. فقط این موارد را تنظیم کنید:

```dotenv
ARB_MODE=simulate
ARB_OWNER=PUBLIC_ADDRESS_OF_A_DEDICATED_OPERATOR_WALLET
ARB_RPC_URL=YOUR_HTTPS_SOLANA_MAINNET_RPC
ARB_JUPITER_API_KEY=YOUR_API_KEY_IF_AVAILABLE
```

کلید خصوصی برای `simulate` لازم نیست و خوانده نمی‌شود. از آدرس خزانه یا کیف‌پول مشتریان به عنوان مقدار پیش‌فرض استفاده نشده است. اپراتور باید کیف‌پول اختصاصی را انتخاب کند. پیش‌نیاز حساب‌ها: ATA استاندارد WSOL از قبل ایجاد و دارای موجودی کافی باشد؛ ATA استاندارد USDC نیز از قبل ایجاد و موجودی آن صفر باشد. موجودی SOL عادی باید ذخیره کارمزد و اجاره موقت حساب کنترل را پوشش دهد. هیچ حساب یا انتقال وجهی برای تأمین این پیش‌نیازها توسط نصب انجام نمی‌شود.

```sh
moneyland-arbitrage status
moneyland-arbitrage simulate
```

`SIMULATION_PASSED` تنها موفقیت شبیه‌سازی آن پیام و آن وضعیت شبکه است؛ تضمین اجرای بعدی یا سود نیست. `NO_PROFITABLE_CYCLE`، `STALE_QUOTE`، `TRANSACTION_TOO_LARGE` یا `SIMULATION_FAILED` باعث **عدم ارسال** می‌شوند. محدودیت‌ها را صرفاً برای عبور از خطا و دیدن معامله کاهش ندهید. RPC یا برنامه DEX ممکن است پیش از ارسال تغییر کند.

## ساخت و کنترل مسیر

- Jupiter Swap API V2 `/build` برای هر پای سواپ، تنها روی برچسب‌های Raydium CLMM، Whirlpool یا Meteora DLMM استفاده می‌شود. دو پای معامله باید در دو استخر متفاوت باشند.
- خروجی حداقل مجاز پای اول، ورودی پای دوم است؛ خروجی خوش‌بینانه مبنای معامله دوم نیست.
- تنها instructionهای شناخته‌شده Jupiter V6 با نام `route` و `shared_accounts_route` پذیرفته می‌شوند. **نسخه HTTP API با نسخه instruction آن‌چین یک چیز نیست.** خروجی با layout جدید یا مسیر چندمرحله‌ای عمداً با خطا متوقف می‌شود؛ سازگاری همه خروجی‌های امروز Jupiter ادعا نمی‌شود.
- کلید امضاکننده، مبدأ و مقصد ATA، mintها، مقدار خام، slippage، صفر بودن platform fee، نبود cleanup/tip/ledger و signer اضافه بررسی می‌شوند. lookup tableها از RPC خوانده می‌شوند، نه از محتوای غیرقابل‌اعتماد پاسخ ساخت.
- حدود اندازه پیام، compute units، هزینه کل، تازگی قیمت و نتیجه شبیه‌سازی اعمال می‌شوند.
- کنترل موجودی درون تراکنش: حساب WSOL موقت خود اپراتور ساخته می‌شود؛ پس از دو سواپ، انتقالی به اندازه کل موجودی اولیه WSOL به‌اضافه سقف کارمزد و حداقل سود، به آن حساب و سپس برگشت به ATA انجام می‌شود. اگر این موجودی وجود نداشته باشد، SPL Token انتقال را رد و تراکنش برگشت می‌خورد. حساب موقت بسته و اجاره‌اش به اپراتور برمی‌گردد. **کارمزد تراکنش شکست‌خورده می‌تواند پرداخت شود.**

## حدود اولیه کد — پیشنهاد سرمایه‌گذاری نیستند

| کنترل | پیش‌فرض |
| --- | --- |
| اندازه ورودی | 10,000,000 lamports = 0.01 WSOL |
| سقف هزینه هر تلاش | 100,000 lamports = 0.0001 SOL |
| حداقل سود WSOL پس از سقف هزینه | 50,000 lamports = 0.00005 SOL |
| حداکثر تلاش ارسالی روزانه | 1 |
| بودجه روزانه هزینه | 100,000 lamports |
| slippage | 5 bps |
| حداکثر عمر مرحله دریافت quote | 8 seconds |

بالاتر بردن متغیرها نیز سقف‌های سخت‌افزاری/مهندسی مشخصی در `config()` دارد. مجموع هزینه تمام تلاش‌ها، حتی تلاش شکست‌خورده، از بودجه روزانه کم می‌شود. معیارها احتمال یافتن فرصت را محدود می‌کنند؛ سیستم سود یا تعداد معامله را تضمین نمی‌کند.

## مرز live — پیش از آن متوقف شوید

مسیر `execute-once` پیاده‌سازی شده، اما نصب آن را فعال نمی‌کند. هیچ worker خودکار و هیچ دکمه عمومی Execute به این runner متصل نشده است. **قبل از حالت live، بررسی مستقل کد/وابستگی‌ها و شبیه‌سازی زنجیره‌ای همان کیف‌پول ضروری است.** موجودی مشتریان یا کیف‌پول اصلی نباید در این مرحله استفاده شود.

Live به صورت همزمان به `ARB_MODE=live`، فایل keypair اختصاصی، فایل تأیید کوتاه‌عمر و آرگومان دقیق `--confirm-owner=<public-address>` احتیاج دارد. هیچ فایل کلید یا تأییدی توسط نصب تولید نمی‌شود. فایل تأیید باید شامل این فیلدها باشد:

- `purpose`: `moneyland-arbitrage-one-shot`
- `release`: SHA دقیق image نصب‌شده
- `owner`: آدرس عمومی همان امضاکننده
- `network`: `mainnet-beta`
- `expiresAt`: زمان ISO آینده، حداکثر 24 ساعت
- `buyDex` و `sellDex`: مسیر تأییدشده
- `maxInputLamports`، `maxFeeLamports`، `minProfitLamports`: اعداد خام رشته‌ای، مطابق محدودیت‌های بازبینی‌شده

با وجود همه مجوزها، شبیه‌سازی نهایی امضاشده نیز اجباری است. سقف‌ها مستقل از متغیرهای `LIVE_TRADING` و `COPY_TRADING_EXECUTION_ENABLED` در Nova هستند؛ برای این قابلیت، اسکریپت قدیمی فعال‌سازی همه معاملات Nova را اجرا نکنید.

## ثبت نتیجه، توقف و بازیابی

امضای دقیق و رزرو بودجه **پیش از ارسال** روی دیسک و با fsync ثبت می‌شود. تنها یک درخواست ارسال با همان پیام وجود دارد؛ بدون fallback به دو تراکنش و بدون امضای تازه پس از timeout.

- `SUBMITTED_NOT_FINALIZED`: پاسخ ارسال دریافت شده، اما موفقیت زنجیره‌ای هنوز قطعی نیست.
- `SUBMISSION_UNCERTAIN`: نتیجه ارسال مشخص نیست؛ **دوباره نفرستید**.
- `moneyland-arbitrage reconcile`: رسید finalized را بررسی می‌کند و حتی در حالت off قابل استفاده است. سود از تغییر موجودی دقیق WSOL و SOL عادی محاسبه می‌شود. USDC باقیمانده جداگانه گزارش می‌شود و قیمت تخمینی به آن داده نمی‌شود.
- نبود رسید یا ناقص بودن metadata، مجوز پاک‌کردن pending یا فرض سود صفر/مثبت نیست. ارسال‌های بعدی تا تعیین تکلیف بلوکه می‌مانند.
- `touch /var/lib/moneyland-arbitrage/HALT`: تلاش‌های جدید در مراحل کنترل متوقف می‌شوند؛ تراکنش قبلاً ارسال‌شده قابل بازگرداندن با این فایل نیست.

فایل journal، lock یا پوشه state را برای دور زدن محدودیت‌ها حذف نکنید. در crash ناگهانی ممکن است lock باقی بماند؛ اپراتور باید نبود فرایند فعال و نتیجه signature قبلی را بررسی کند. اگر تراکنش هرگز finalized نشود، باز کردن محافظ نیازمند بررسی دستی و شواهد مستقل است؛ این نسخه timeout را اثبات شکست تلقی نمی‌کند. فایل journal عمداً محدودیت اندازه خواندن دارد و آرشیو امن آن در بهره‌برداری بلندمدت باید طراحی شود.

## محدودیت‌های صریح

این نسخه اولین runner بررسی‌شدنی است، نه سرویس معامله خودکار تأییدشده. Flash Loan، CEX، Jito bundle، معاملات چندزنجیره‌ای، مسیرهای token-2022، جفت‌های عمومی و UI Execute در این تغییر پیاده‌سازی نشده‌اند. دریافت quote واقعی، محدودیت ظرفیت ارائه‌دهنده، سازگاری layout فعلی، شبیه‌سازی برنامه‌های واقعی DEX و کیفیت اجرا باید روی زیرساخت اپراتور تأیید شوند. تست mocked موفق، ممیزی امنیتی وابستگی‌ها یا تضمین ایمنی سرمایه نیست.

## منابع فنی بررسی‌شده

- Jupiter V2 build schema: https://developers.jup.ag/docs/api-reference/swap/build
- Jupiter custom transaction construction: https://developers.jup.ag/docs/swap/build
- Jupiter V6 published CPI IDL: https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json
- Solana transaction atomicity and fees: https://solana.com/docs/core/transactions
- Wrapped SOL accounting: https://solana.com/docs/tokens/basics/sync-native

## تست‌های تکرارپذیر

```sh
HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund
node --test scripts/atomic-arbitrage/*.test.mjs
bash -n scripts/install-moneyland-arbitrage.sh
```

Workflow مربوطه همچنین image را می‌سازد و فرمان status را بدون شبکه اجرا می‌کند. هیچ کلید، RPC خصوصی، کیف‌پول تولیدی یا بودجه واقعی در CI وجود ندارد.
