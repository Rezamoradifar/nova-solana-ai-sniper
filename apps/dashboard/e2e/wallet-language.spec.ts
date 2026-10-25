import { test, expect } from '@playwright/test';
import { address, secondAddress, mockServices, injectWallet } from './fixtures.js';

const chartScriptUrl =
  'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
// Exercise the asynchronous embed boundary without depending on the live vendor's
// network, market data or cross-origin ResizeObserver implementation.
const chartScriptFixture = `(() => {
  const script = document.currentScript;
  const config = JSON.parse(script.textContent);
  const host = script.parentElement.querySelector('.tradingview-widget-container__widget');
  const frame = document.createElement('iframe');
  frame.title = 'Fixture TradingView chart';
  frame.srcdoc = '<!doctype html><html><body>Approved chart fixture</body></html>';
  frame.dataset.symbol = config.symbol;
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
  host.append(frame);
})();`;

test.beforeEach(async ({ page }) => {
  await mockServices(page);
  await page.route(chartScriptUrl, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: chartScriptFixture }),
  );
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('همراهِ معامله‌گرهای برتر.');
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
  await expect(page.getByRole('heading', { level: 1 })).toContainText('همراهِ معامله‌گرهای برتر.');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Follow the edge.');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('account changes and disconnect update every approved-address surface without stale balances', async ({
  page,
}) => {
  await page.addInitScript((firstAddress) => {
    const original = Response.prototype.json;
    Response.prototype.json = async function () {
      const value = await original.call(this);
      if (this.url.endsWith('/api/public/wallet/' + firstAddress)) {
        Object.assign(window, { __oldWalletJsonReading: true });
        await new Promise<void>((resolve) =>
          Object.assign(window, { __releaseOldWalletJson: resolve }),
        );
      }
      return value;
    };
  }, address);
  await injectWallet(page);
  await page.goto('/wallet?lang=fa');
  await page.getByRole('button', { name: 'اتصال یا مدیریت کیف پول' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Phantom/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'بستن', exact: true }).click();
  await expect(page.locator('.wallet-address code')).toHaveText(address);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __oldWalletJsonReading?: boolean }).__oldWalletJsonReading,
      ),
    )
    .toBe(true);
  await page.evaluate((next) => {
    (window as unknown as { __novaWalletChange: (value: string) => void }).__novaWalletChange(next);
  }, secondAddress);
  await expect(page.locator('.wallet-address code')).toHaveText(secondAddress);
  await expect(page.locator('.wallet-access-details')).toContainText('2.000000 SOL');
  await page.evaluate(async () => {
    (window as unknown as { __releaseOldWalletJson: () => void }).__releaseOldWalletJson();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
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
  await expect(page.getByRole('cell', { name: 'Home', exact: true })).toBeVisible();
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

test('a delayed chart response cannot access a removed route and the next visit renders one chart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(chartScriptUrl, async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ contentType: 'application/javascript', body: chartScriptFixture });
  });
  try {
    await page.goto('/copy-trading?lang=fa');
    await page.locator('footer').getByRole('link', { name: 'محیط معاملاتی', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.locator('footer a[href="/terminal/copy"]').click();
    await expect(page).toHaveURL(/\/copy-trading$/);
    await expect(page.getByTitle('نمودار بازار TradingView', { exact: true })).toHaveCount(0);
    release();
    for (let visit = 0; visit < 2; visit++) {
      await page
        .locator('footer')
        .getByRole('link', { name: 'محیط معاملاتی', exact: true })
        .click();
      const chart = page.getByTitle('نمودار بازار TradingView', { exact: true });
      await expect(chart).toHaveCount(1);
      const embeddedChart = chart
        .contentFrame()
        .getByTitle('Fixture TradingView chart', { exact: true });
      await expect(embeddedChart).toHaveAttribute('data-symbol', 'COINBASE:SOLUSD');
      await expect(embeddedChart.contentFrame().locator('body')).toHaveText(
        'Approved chart fixture',
      );
      await page.locator('footer a[href="/terminal/copy"]').click();
    }
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
