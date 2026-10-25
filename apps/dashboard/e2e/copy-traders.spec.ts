import { test, expect, type Page } from '@playwright/test';
import { mockServices, injectWallet } from './fixtures.js';

const first = 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam';
const second = '7BWy2mtHNdnWLMZejk5E5sfDDSQfXsjzjy9jPzeDyYk5';
function traderFixture(period = '7d', age = 0) {
  return {
    source: 'GMGN',
    chain: 'solana',
    scope: 'active_smart_money_sample',
    period,
    status: 'connected',
    updatedAt: Date.now() - age,
    performanceUpdatedAt: Date.now() - age,
    refreshMs: 30000,
    traders: [
      {
        address: first,
        name: 'Verified Alpha',
        tags: ['smart_degen', 'kol'],
        observedTrades: 8,
        observedVolumeUsd: 12000,
        lastActivityAt: Date.now() - 20000,
        performance: {
          realizedPnlUsd: period === '7d' ? 2677.72 : 7123.45,
          roiPct: 7.05,
          winRatePct: 65.2,
          buys: 612,
          sells: 166,
        },
      },
      {
        address: second,
        name: 'Active Beta',
        tags: ['axiom'],
        observedTrades: 3,
        observedVolumeUsd: 90000,
        lastActivityAt: Date.now() - 40000,
        performance: { realizedPnlUsd: -125.5, roiPct: -3.5, winRatePct: 37.5, buys: 12, sells: 9 },
      },
    ],
  };
}
async function setup(page: Page, live = false) {
  await mockServices(page);
  await page.route('**/api/public/copy-trading', (route) =>
    route.fulfill({
      json: {
        executionMode: live ? 'live' : 'disabled',
        copyWatcherReady: live,
        liveExecutionEnabled: live,
        watcher: { running: live, healthy: live },
        buyReadiness: {
          ready: live,
          blockers: live ? [] : ['COPY_EXECUTION_DISABLED'],
          checkedAt: Date.now(),
        },
        localWallets: [],
        recommendations: [],
        gmgn: { status: 'connected', trades: [], wallets: [] },
        limits: { maxBuySol: 0.1, maxDailyBuys: 10, maxOpenPositions: 3, slippageBps: 150 },
      },
    }),
  );
  await page.route('**/api/public/copy-trading/traders?*', (route) =>
    route.fulfill({
      json: traderFixture(new URL(route.request().url()).searchParams.get('period') ?? '7d'),
    }),
  );
}

test('real performance cards distinguish live analytics, losses and a paused copy engine', async ({
  page,
}, info) => {
  await setup(page);
  await page.goto('/copy-trading?lang=fa');
  await expect(page.getByTestId('copy-feed-state')).toHaveText('LIVE DATA');
  await expect(page.getByTestId('copy-engine-state')).toHaveText('متوقف');
  const cards = page.getByTestId('trader-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Verified Alpha');
  await expect(cards.first().getByTestId('trader-pnl')).toHaveText('+$2,677.72');
  await expect(cards.last().getByTestId('trader-pnl')).toHaveText('-$125.50');
  await expect(cards.last().getByTestId('trader-pnl')).toHaveCSS('color', 'rgb(237, 155, 152)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath('copy-traders-fa.png'), fullPage: true });
  await page.screenshot({ path: info.outputPath('copy-traders-fa-viewport.png') });
  await cards.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('copy-traders-profit-viewport.png') });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  await expect(page.locator('.wallet-header-link svg')).toBeVisible();
});

test('trader choice survives browser wallet approval, account login and saves explicitly paused', async ({
  page,
}) => {
  await setup(page);
  await injectWallet(page);
  const writes: unknown[] = [];
  let saved: unknown[] = [];
  await page.route(/\/api\/copy-trades(?:\/drafts)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ path: new URL(route.request().url()).pathname, body });
      const row = {
        id: 'cfg',
        targetAddress: body.targetAddress,
        copyPercentSize: body.copyPercentSize,
        maxAmountSol: body.maxAmountSol,
        isActive: !route.request().url().endsWith('/drafts'),
      };
      saved = [row];
      await route.fulfill({ status: 201, json: row });
    } else await route.fulfill({ json: saved });
  });
  await page.goto('/copy-trading?lang=fa');
  await page.getByRole('button', { name: 'تنظیم کپی', exact: true }).first().click();
  await expect(page).toHaveURL(/#copy-setup$/);
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  await expect(page.getByLabel('آدرس کیف پول تریدر', { exact: true })).toHaveValue(first);
  await page
    .locator('.ct-connection-steps')
    .getByRole('button', { name: 'اتصال یا مدیریت کیف پول' })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Phantom/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'بستن', exact: true }).click();
  expect(writes).toEqual([]);
  await page.locator('.ct-copy-form').getByRole('link', { name: 'ورود و ادامه' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('ایمیل', { exact: true }).fill('user@example.com');
  await page.getByLabel('رمز عبور', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
  await expect(page.getByLabel('آدرس کیف پول تریدر', { exact: true })).toHaveValue(first);
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'ذخیرهٔ تنظیم کپی متوقف' })).toBeDisabled();
  await page.getByLabel('سقف هر خرید (SOL)', { exact: true }).fill('0.05');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'ذخیرهٔ تنظیم کپی متوقف' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: '/api/copy-trades/drafts',
    body: { targetAddress: first, copyPercentSize: 25, maxAmountSol: 0.05 },
  });
  await expect(page.locator('.ct-saved')).toContainText('متوقف');
  await expect(
    page.locator('.ct-saved').getByRole('button', { name: 'فعال‌سازی', exact: true }),
  ).toBeDisabled();
});

test('selecting and reselecting a wallet reveals its setup without submitting a trade', async ({
  page,
}, info) => {
  await setup(page);
  let submissions = 0;
  await page.route(/\/api\/copy-trades(?:\/drafts)?$/, async (route) => {
    if (route.request().method() !== 'GET') submissions += 1;
    await route.fulfill({ json: [] });
  });
  await page.goto('/copy-trading?lang=fa');
  const choose = page.getByRole('button', { name: 'تنظیم کپی', exact: true }).first();
  await choose.click();
  await expect(choose).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  await expect(page.locator('.ct-selected-wallet')).toContainText(first);
  await expect(page.locator('.ct-selected-wallet')).toContainText('مرحلهٔ بعد: وارد حساب شو');
  await expect(page.getByTestId('copy-engine-state')).toHaveText('متوقف');
  await choose.click();
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  expect(submissions).toBe(0);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await choose.click();
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('selected-copy-wallet.png') });
});

test('delayed trader cards preserve the deep-linked setup and refresh preserves input focus', async ({
  page,
}) => {
  await setup(page);
  let delayed = true;
  const pending: Array<() => void> = [];
  const finish = () => {
    delayed = false;
    pending.splice(0).forEach((resolve) => resolve());
  };
  await page.route('**/api/public/copy-trading/traders?*', async (route) => {
    // Strict Mode can cancel and restart the initial request. Gate the whole
    // initial batch, rather than asserting a particular number of attempts.
    if (delayed) await new Promise<void>((resolve) => pending.push(resolve));
    await route.fulfill({ json: traderFixture() });
  });
  await page.goto('/copy-trading?lang=en&trader=' + first + '#copy-setup');
  await expect(page.locator('#copy-setup')).toBeFocused();
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  await expect.poll(() => pending.length > 0).toBe(true);
  finish();
  await expect(page.getByTestId('trader-card')).toHaveCount(2);
  await expect(page.locator('#copy-setup-title')).toBeInViewport();
  delayed = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => pending.length > 0).toBe(true);
  const input = page.getByLabel('Maximum per buy (SOL)', { exact: true });
  await input.focus();
  finish();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(input).toBeFocused();
});

test('copy address writes the full selected address and announces success', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    const values: string[] = [];
    Object.assign(window, { __copiedAddresses: values });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          values.push(value);
        },
      },
    });
  });
  await page.goto('/copy-trading?lang=fa&trader=' + first + '#copy-setup');
  const summary = page.locator('.ct-selected-wallet');
  await summary.getByRole('button', { name: 'کپی آدرس', exact: true }).click();
  await expect(summary.getByRole('button', { name: 'کپی شد!', exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __copiedAddresses: string[] }).__copiedAddresses,
    ),
  ).toEqual([first]);
});

test('blocked clipboard APIs offer a selected manual address without claiming success', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        },
      },
    });
    document.execCommand = () => false;
  });
  await page.goto('/copy-trading?lang=en&trader=' + first + '#copy-setup');
  const summary = page.locator('.ct-selected-wallet');
  await summary.getByRole('button', { name: 'Copy address', exact: true }).click();
  const manual = summary.getByRole('textbox', { name: 'Address to copy manually' });
  await expect(summary.getByRole('alert')).toContainText('Automatic copying failed');
  await expect(manual).toHaveValue(first);
  await expect(manual).toBeFocused();
  expect(
    await manual.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, first.length]);
  await expect(summary.getByRole('button', { name: 'Copied!', exact: true })).toHaveCount(0);
});

test('legacy clipboard fallback copies the full address and restores button focus', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.assign(window, { __legacyAddress: '' });
    document.execCommand = (command: string) => {
      if (command !== 'copy') return false;
      Object.assign(window, {
        __legacyAddress: (document.activeElement as HTMLTextAreaElement).value,
      });
      return true;
    };
  });
  await page.goto('/copy-trading?lang=en&trader=' + first + '#copy-setup');
  // The accessible name changes to Copied!; keep the locator stable while
  // asserting both labels, rather than filtering out the successful button.
  const button = page.locator('.ct-selected-wallet').getByRole('button');
  await expect(button).toHaveAccessibleName('Copy address');
  // Keyboard focus must survive the temporary textarea, including Safari taps.
  await button.focus();
  await button.click();
  await expect(button).toHaveText('Copied!');
  await expect(button).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as { __legacyAddress: string }).__legacyAddress),
  ).toBe(first);
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('period changes use the correct window and search never replaces loss with volume', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/copy-trading?lang=en');
  await expect(page.getByTestId('trader-pnl').first()).toHaveText('+$2,677.72');
  await page.getByRole('button', { name: '30D', exact: true }).click();
  await expect(page.getByTestId('trader-pnl').first()).toHaveText('+$7,123.45');
  await page.getByLabel('Search traders', { exact: true }).fill('Beta');
  await expect(page.getByTestId('trader-card')).toHaveCount(1);
  await expect(page.getByTestId('trader-pnl')).toHaveText('-$125.50');
});

test('stale and failed analytics never keep a live badge while old values stay labeled', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/api/public/copy-trading/traders?*', (route) =>
    route.fulfill({ json: traderFixture('7d', 120000) }),
  );
  await page.goto('/copy-trading?lang=en');
  await expect(page.getByTestId('trader-pnl').first()).toHaveText('+$2,677.72');
  await expect(page.getByTestId('copy-feed-state')).not.toHaveText('LIVE DATA');
  await page.route('**/api/public/copy-trading/traders?*', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('Data source temporarily unavailable. Retry to refresh.'),
  ).toBeVisible();
  await expect(page.getByTestId('copy-feed-state')).not.toHaveText('LIVE DATA');
});

test('an account without a trading wallet gets a working setup and return path', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => localStorage.setItem('nova.token', 'test-account-token'));
  await page.route('**/api/wallets', (route) => route.fulfill({ json: [] }));
  await page.goto('/copy-trading?lang=fa&trader=' + first);
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: 'ذخیرهٔ تنظیم کپی متوقف' })).toBeDisabled();
  await page.getByRole('link', { name: 'مدیریت کیف پول‌ها', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/wallets$/);
  await page.getByRole('link', { name: 'بازگشت به تنظیم کپی' }).click();
  await expect(page.getByLabel('آدرس کیف پول تریدر', { exact: true })).toHaveValue(first);
});

test('ready execution still requires an explicit reviewed account setup before enabling', async ({
  page,
}) => {
  await setup(page, true);
  await page.addInitScript(() => localStorage.setItem('nova.token', 'test-account-token'));
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/copy-trades', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { ...submitted, id: 'cfg', isActive: true } });
    } else await route.fulfill({ json: [] });
  });
  await page.goto('/copy-trading?lang=en&trader=' + first);
  await expect(page.locator('.ct-server-limits')).toContainText('10');
  await expect(page.getByTestId('copy-engine-state')).toHaveText('READY');
  await expect(page.getByRole('button', { name: 'Enable copy within limits' })).toBeDisabled();
  expect(submitted).toBeNull();
  await page.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Enable copy within limits' }).click();
  await expect.poll(() => submitted).toMatchObject({ targetAddress: first, maxAmountSol: 0.1 });
});

test('an older API cannot interpret a paused setup as an active copy instruction', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => localStorage.setItem('nova.token', 'test-account-token'));
  let activeWrites = 0;
  await page.route('**/api/copy-trades', (route) => {
    if (route.request().method() === 'POST') activeWrites++;
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/copy-trades/drafts', (route) =>
    route.fulfill({ status: 404, json: { error: 'Copy API upgrade required' } }),
  );
  await page.goto('/copy-trading?lang=en&trader=' + first);
  await expect(page.locator('.ct-server-limits')).toContainText('10');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save paused copy settings' }).click();
  await expect(page.getByText('Copy API upgrade required', { exact: true })).toBeVisible();
  expect(activeWrites).toBe(0);
  await expect(page.locator('.ct-saved')).not.toContainText('DZAa5');
});

test('a paused review does not authorize live buys after the engine becomes ready', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => localStorage.setItem('nova.token', 'test-account-token'));
  await page.goto('/copy-trading?lang=en&trader=' + first);
  await expect(page.locator('.ct-server-limits')).toContainText('10');
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: 'Save paused copy settings' })).toBeEnabled();
  await page.route('**/api/public/copy-trading', (route) =>
    route.fulfill({
      json: {
        executionMode: 'live',
        copyWatcherReady: true,
        liveExecutionEnabled: true,
        watcher: { running: true, healthy: true },
        buyReadiness: { ready: true, blockers: [], checkedAt: Date.now() },
        localWallets: [],
        gmgn: { status: 'connected', trades: [], wallets: [] },
        limits: { maxBuySol: 0.1, maxDailyBuys: 10, maxOpenPositions: 3, slippageBps: 150 },
      },
    }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('copy-engine-state')).toHaveText('READY');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Enable copy within limits' })).toBeDisabled();
});
