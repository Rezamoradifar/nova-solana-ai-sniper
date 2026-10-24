import { test, expect } from '@playwright/test';
import { mockServices, mainnetFixture, genesis, injectWallet } from './fixtures.js';

test.beforeEach(async ({ page }) => { await mockServices(page); });

test('luxury landing shows observed prices and network proof without horizontal overflow', async ({page}, info) => {
  await page.goto('/?lang=fa');
  await expect(page.getByRole('heading', {level:1})).toContainText('روی سولانا.');
  await expect(page.getByTestId('hero-sol-price')).toHaveText('$102.63');
  await expect(page.getByTestId('mainnet-status')).toHaveText('شبکه تأیید شده');
  await expect(page.getByRole('button', {name:'اتصال یا مدیریت کیف پول'}).first()).toBeVisible();
  await expect(page.locator('.n-header-wallet svg')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => Array.from(document.fonts).some(f => f.family === 'MLDisplay' && f.status === 'loaded'))).toBe(true);
  await page.screenshot({path:info.outputPath('luxury-home-fa.png'), fullPage:true});
  await page.screenshot({path:info.outputPath('luxury-home-fa-viewport.png')});
  await page.getByRole('button', {name:'Switch language to English'}).click();
  await expect(page.getByRole('heading', {level:1})).toContainText('ON SOLANA.');
  await expect(page.locator('html')).toHaveAttribute('dir','ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({path:info.outputPath('luxury-home-en.png'), fullPage:true});
  await page.screenshot({path:info.outputPath('luxury-home-en-viewport.png')});
  await page.setViewportSize({width:320,height:740});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button',{name:'Connect or manage wallet'}).first()).toBeVisible();
  await expect(page.locator('.n-header-wallet svg')).toBeVisible();
});

test('network programs and paper trading remain distinct and the page fits mobile', async ({page}, info) => {
  await page.goto('/network?lang=fa');
  await expect(page.getByRole('heading',{name:'شبکهٔ اصلی سولانا تأیید شد'})).toBeVisible();
  await expect(page.locator('.lux-genesis code')).toHaveText(genesis);
  await expect(page.locator('.lux-execution-status')).toContainText('خرید جدید متوقف است');
  await expect(page.locator('.lux-execution-status')).toContainText('PAPER');
  const links = await page.locator('.lux-program a').evaluateAll(elements => elements.map(e => (e as HTMLAnchorElement).href));
  expect(links.length).toBe(2);
  expect(links.every(url => url.startsWith('https://explorer.solana.com/address/') && url.endsWith('?cluster=mainnet-beta'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:info.outputPath('luxury-network-fa.png'),fullPage:true});
});

test('wrong or stale chain evidence never turns a ready label green and refresh recovers', async ({page}) => {
  let valid = false;
  await page.route('**/api/public/solana/overview', route => route.fulfill({json:{...mainnetFixture(),genesisHash:valid?genesis:'devnet'}}));
  await page.goto('/network?lang=fa');
  await expect(page.getByTestId('mainnet-status')).toHaveText('اتصال در دسترس نیست');
  await expect(page.getByRole('heading',{name:'اتصال شبکهٔ اصلی تأیید نشده است'})).toBeVisible();
  await expect(page.locator('.lux-network-proof dd').first()).toHaveText('—');
  valid = true;
  await page.getByRole('button',{name:'بررسی دوبارهٔ اتصال'}).click();
  await expect(page.getByTestId('mainnet-status')).toHaveText('شبکه تأیید شده');
  await page.route('**/api/public/solana/overview',route => route.fulfill({json:{...mainnetFixture(),checkedAt:Date.now()-60_000}}));
  await page.getByRole('button',{name:'بررسی دوبارهٔ اتصال'}).click();
  await expect(page.getByTestId('mainnet-status')).toHaveText('اتصال در دسترس نیست');
});

test('wallet balance requires mainnet identity independently of the approved wallet address', async ({page}) => {
  await injectWallet(page);
  await page.route('**/api/public/wallet/*',route=>route.fulfill({json:{address:route.request().url().split('/').pop(),mainnetVerified:true,genesisHash:'devnet',chain:'solana',cluster:'mainnet-beta',sol:999,slot:100,signatures:[]}}));
  await page.goto('/wallet?lang=fa');
  await page.getByRole('button',{name:'اتصال یا مدیریت کیف پول'}).first().click();
  await page.getByRole('dialog').getByRole('button',{name:/Phantom/}).click();
  await page.getByRole('dialog').getByRole('button',{name:'بستن',exact:true}).click();
  await expect(page.locator('.wallet-access-details')).not.toContainText('999');
  await expect(page.locator('.wallet-message.wallet-error')).toBeVisible();
});
