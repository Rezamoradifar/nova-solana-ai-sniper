import { test, expect, type Page } from '@playwright/test';

const address = '11111111111111111111111111111111';
const secondAddress = 'So11111111111111111111111111111111111111112';

async function mockServices(page: Page) {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (pathname === '/api/public/network/status')
      json = {
        status: 'ready',
        workersReady: true,
        tradingMode: 'PAPER',
        slot: 100,
        scanner: { state: 'HEALTHY', wsHealthy: true, fallbackHealthy: false },
      };
    else if (pathname === '/api/public/copy-trading')
      json = {
        executionMode: 'disabled',
        copyWatcherReady: false,
        liveExecutionEnabled: false,
        buyReadiness: {
          ready: false,
          blockers: ['COPY_EXECUTION_DISABLED'],
          checkedAt: Date.now(),
        },
        recommendations: [],
        localWallets: [],
        gmgn: { status: 'not_configured', wallets: [], trades: [] },
        limits: { maxBuySol: 0.1, maxDailyBuys: 10, maxOpenPositions: 3, slippageBps: 150 },
      };
    else if (pathname.startsWith('/api/public/wallet/'))
      json = {
        address: pathname.split('/').pop(),
        sol: pathname.endsWith(secondAddress) ? 2 : 1,
        lamports: '1000000000',
        slot: 100,
        signatures: [],
        checkedAt: Date.now(),
      };
    else if (pathname === '/api/auth/login' || pathname === '/api/auth/register')
      json = { token: 'test-account-token' };
    else if (pathname === '/api/auth/me')
      json = { id: 'test-account', email: 'user@example.com', role: 'USER' };
    else if (pathname === '/api/public/gmgn/markets')
      json = { status: 'not_configured', tokens: [] };
    await route.fulfill({ json });
  });
}

async function injectWallet(page: Page, reject = false) {
  await page.addInitScript(
    ({ address, reject }) => {
      const events = new Map<string, Set<(value?: unknown) => void>>();
      const publicKey = (value: string) => ({ toBase58: () => value, toString: () => value });
      const provider = {
        isPhantom: true,
        publicKey: publicKey(address),
        connect: async () => {
          if (reject) throw Object.assign(new Error('User rejected connection'), { code: 4001 });
          return { publicKey: provider.publicKey };
        },
        disconnect: async () => {
          events.get('disconnect')?.forEach((fn) => fn());
        },
        on: (event: string, fn: (value?: unknown) => void) => {
          const listeners = events.get(event) ?? new Set();
          listeners.add(fn);
          events.set(event, listeners);
        },
        off: (event: string, fn: (value?: unknown) => void) => {
          events.get(event)?.delete(fn);
        },
        signTransaction: () => {
          throw new Error('UNEXPECTED_SIGNING_REQUEST');
        },
        signMessage: () => {
          throw new Error('UNEXPECTED_SIGNING_REQUEST');
        },
      };
      Object.assign(window, {
        phantom: { solana: provider },
        __novaWalletChange: (next: string) => {
          provider.publicKey = publicKey(next);
          events.get('accountChanged')?.forEach((fn) => fn(provider.publicKey));
        },
      });
    },
    { address, reject },
  );
}

test.beforeEach(async ({ page }) => {
  await mockServices(page);
});

test('one approved connection and Persian choice survive navigation across every site frame', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await injectWallet(page);
  await page.goto('/?lang=fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Phantom/ }).click();
  await expect(dialog.getByText(address, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'بستن', exact: true }).click();
  await page.locator('footer').getByRole('link', { name: 'کپی ترید', exact: true }).click();
  await expect(page).toHaveURL(/\/copy-trading$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'کیف پول‌ها را دنبال کنید؛ با محدودیت کپی کنید.',
  );
  await expect(page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first()).toContainText(
    '1111…1111',
  );
  await page.locator('footer').getByRole('link', { name: 'اتصال کیف پول', exact: true }).click();
  await expect(page.locator('.wallet-address code')).toHaveText(address);
  await page.locator('footer').getByRole('link', { name: 'محیط معاملاتی', exact: true }).click();
  await expect(page).toHaveURL(/\/terminal$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  await expect(page.getByRole('dialog').getByText(address, { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'بستن', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(errors).toEqual([]);
});

test('language switch translates connected tools and survives reload in both directions', async ({
  page,
}) => {
  await page.goto('/copy-trading');
  await page.getByRole('button', { name: 'تغییر زبان به فارسی' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('کیف پول‌ها را دنبال کنید');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Track conviction. Copy with limits.',
  );
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('account changes and disconnect update every approved-address surface without stale balances', async ({
  page,
}) => {
  await injectWallet(page);
  await page.goto('/wallet?lang=fa');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Phantom/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'بستن', exact: true }).click();
  await expect(page.locator('.wallet-address code')).toHaveText(address);
  await page.evaluate((next) => {
    (window as unknown as { __novaWalletChange: (value: string) => void }).__novaWalletChange(next);
  }, secondAddress);
  await expect(page.locator('.wallet-address code')).toHaveText(secondAddress);
  await expect(page.locator('.wallet-access-details')).toContainText('2.000000 SOL');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'قطع اتصال کیف پول', exact: true })
    .click();
  await expect(page.locator('.wallet-address code')).toHaveText(
    'برای مشاهدهٔ آدرس، کیف پول را متصل کنید',
  );
});

test('rejected approval stays disconnected and presents a translated retryable error', async ({
  page,
}) => {
  await injectWallet(page, true);
  await page.goto('/wallet?lang=fa');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Phantom/ })
    .click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('درخواست اتصال رد شد');
  await expect(page.locator('.wallet-address code')).not.toHaveText(address);
});

test('login returns to the requested account tool and preserves the selected language', async ({
  page,
}) => {
  await page.goto('/dashboard/wallets?lang=fa');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('ایمیل', { exact: true }).fill('user@example.com');
  await page.getByLabel('رمز عبور', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/wallets\?lang=fa$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'کیف پول‌ها', exact: true })).toBeVisible();
});

test('wallet chooser remains within the viewport and is keyboard dismissible', async ({
  page,
}, testInfo) => {
  await injectWallet(page);
  await page.goto('/wallet?lang=fa');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: testInfo.outputPath('wallet-persian.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first()).toBeFocused();
});
