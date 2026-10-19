/* Browser checks use local demo data only. Never connects to a production wallet or sends an order. */
const { chromium } = require('/tmp/moneyland-browser/node_modules/playwright');
const AxeBuilder = require('/tmp/moneyland-browser/node_modules/@axe-core/playwright').default;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'moneyland-deliverables');
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const report = { captures: [], interactions: [], accessibility: [], failures: [], mutations: [] };
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4173'], { cwd: path.join(root,'apps/dashboard'), stdio: 'inherit' });
const base = 'http://127.0.0.1:4173';
const pause = ms => new Promise(r=>setTimeout(r,ms));
let browser;
async function test(name, fn) { try { await fn(); report.interactions.push({ name, passed:true }); console.log('PASS:',name); } catch (e) { report.interactions.push({name,passed:false,error:String(e)}); report.failures.push(name+': '+e); console.error('FAIL:',name,e); } }
(async()=>{
  for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break;}catch{}await pause(500);}
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const routes=[['home','/'],['dex','/trade'],['exchange','/exchange'],['copy','/copy'],['trader','/copy/quant-wolf'],['arbitrage','/opportunities'],['memes','/meme-hub'],['flash-loans','/flash-loans'],['bots','/bots'],['portfolio','/portfolio'],['design-system','/design-system']];
  for(const device of ['desktop','mobile'])for(const lang of ['en','fa']){
    const width=device==='desktop'?1440:390;
    const ctx=await browser.newContext({viewport:{width,height:device==='desktop'?1000:844},deviceScaleFactor:1,reducedMotion:'reduce'});
    await ctx.addInitScript(l=>localStorage.setItem('moneyland-language',l),lang);
    await ctx.route('**/api/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"QA offline boundary"}'}));
    const page=await ctx.newPage();
    page.on('pageerror',e=>report.failures.push(`${device}/${lang} runtime: ${e.message}`));
    page.on('request',r=>{if(r.url().includes('/api/')&&!['GET','HEAD'].includes(r.method()))report.mutations.push({url:r.url(),method:r.method()});});
    for(const [name,route] of routes){
      try{
        await page.goto(base+route+'?demo=1',{waitUntil:'networkidle',timeout:30000});
        await page.locator('main h1').first().waitFor({timeout:10000});
        await page.evaluate(()=>Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1500))]));
        const sizes=await page.evaluate(()=>({width:window.innerWidth,scroll:document.documentElement.scrollWidth,dir:document.documentElement.dir}));
        const good=sizes.scroll<=sizes.width+1&&sizes.dir===(lang==='fa'?'rtl':'ltr');
        if(!good)report.failures.push(`${device}/${lang}/${name} layout ${JSON.stringify(sizes)}`);
        const file=`${device}-${name}-${lang}.png`;
        await page.screenshot({path:path.join(out,'screenshots',file),fullPage:true,animations:'disabled'});
        report.captures.push({file,route,lang,viewport:width,rootScrollWidth:sizes.scroll,passed:good});
        if(device==='desktop'&&lang==='en'&&['home','dex','flash-loans','design-system'].includes(name)){
          const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
          report.accessibility.push({route,violations:results.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});
          for(const v of results.violations)if(['critical','serious'].includes(v.impact))report.failures.push(`Accessibility ${route}: ${v.id} (${v.nodes.length} nodes)`);
        }
      }catch(e){report.failures.push(`${device}/${lang}/${name}: ${e}`);}
    }
    await ctx.close();
  }
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.route('**/api/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"QA offline boundary"}'}));
  const page=await context.newPage();
  page.on('request',r=>{if(r.url().includes('/api/')&&!['GET','HEAD'].includes(r.method()))report.mutations.push({url:r.url(),method:r.method()});});
  const go=async url=>{await page.goto(base+url,{waitUntil:'networkidle'});};
  await test('Products menu opens and Escape dismisses',async()=>{await go('/?demo=1');await page.locator('.n-desktop-nav button').click();assert.equal(await page.locator('.n-mega').count(),1);await page.keyboard.press('Escape');assert.equal(await page.locator('.n-mega').count(),0);});
  await test('Wallet modal traps focus and restores trigger',async()=>{await page.locator('.n-header-wallet').click();assert.equal(await page.locator('dialog[open]').count(),1);for(let i=0;i<8;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('dialog')),true);}await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('n-header-wallet')),true);});
  await test('Swap preview validates inputs and submits no transaction',async()=>{await go('/trade?demo=1');await page.locator('#swap-amount').fill('-1');assert.equal(await page.getByRole('button',{name:'Preview swap',exact:true}).isDisabled(),true);await page.locator('#swap-amount').fill('1000');await page.getByRole('button',{name:'Preview swap',exact:true}).click();await page.getByRole('button',{name:'Finish preview',exact:true}).click();assert.match(await page.locator('.n-toast').innerText(),/No transaction/);});
  await test('Paper exchange order can be recorded and canceled',async()=>{await go('/exchange?demo=1');await page.getByRole('button',{name:'Record paper buy',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),1);await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),0);});
  await test('Copy filter and profile allocation validation work',async()=>{await go('/copy?demo=1');await page.getByLabel('Filter risk').selectOption('High');assert.equal(await page.locator('.n-trader-card').count(),1);await page.locator('.n-trader-card').getByRole('link',{name:'View profile'}).click();const action=page.getByRole('button',{name:'Preview copy setup',exact:true});assert.equal(await action.isDisabled(),true);await page.locator('input[type=checkbox]').check();assert.equal(await action.isEnabled(),true);await action.click();assert.match(await page.locator('.n-toast').innerText(),/No trader followed/);});
  await test('Flash cost model scales fees with notional and clears stale results',async()=>{await go('/flash-loans?demo=1');await page.getByRole('button',{name:'Run cost model',exact:true}).click();assert.equal(await page.locator('.n-net-result strong').innerText(),'$37.00');await page.getByLabel('Loan amount (USDC)',{exact:true}).fill('20000');assert.equal(await page.locator('.n-net-result strong').innerText(),'—');await page.getByRole('button',{name:'Run cost model',exact:true}).click();assert.equal(await page.locator('.n-net-result strong').innerText(),'$82.00');});
  await test('Bot builder rejects bad budgets and creates session-only state',async()=>{await go('/bots?demo=1');await page.getByRole('button',{name:'Create paper bot',exact:true}).click();const modal=page.locator('dialog[open]');await modal.getByLabel('Bot name',{exact:true}).fill('QA Grid');await modal.getByLabel('Paper budget (USDC)',{exact:true}).fill('-10');assert.equal(await modal.getByRole('button',{name:'Create paper configuration',exact:true}).isDisabled(),true);await modal.getByLabel('Paper budget (USDC)',{exact:true}).fill('500');await modal.getByRole('button',{name:'Create paper configuration',exact:true}).click();const row=page.locator('tr').filter({hasText:'QA Grid'});await row.getByRole('button',{name:'Start QA Grid',exact:true}).click();assert.match(await row.innerText(),/Paper active/);});
  await test('Portfolio hides sample balance',async()=>{await go('/portfolio?demo=1');await page.getByRole('button',{name:'Toggle balance visibility',exact:true}).click();assert.equal(await page.locator('.n-balance-value').innerText(),'••••••');});
  await test('Real mode never substitutes fictional profiles or balances',async()=>{await go('/copy');assert.equal(await page.locator('.n-trader-card').count(),0);await go('/portfolio');assert.equal(await page.locator('.n-balance-value').innerText(),'—');});
  await test('Live market adapter displays supplied observation, not platform totals',async()=>{await page.route('**/api/public/markets',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{chainId:'solana',dexId:'raydium',pairAddress:'qa-public-pair',url:'',baseToken:{address:'So11111111111111111111111111111111111111112',name:'Solana',symbol:'SOL'},quoteToken:{address:'qa-usdc',symbol:'USDC'},priceUsd:'151.25',liquidity:{usd:1000000},volume:{h24:2000000},priceChange:{h24:4.5}}])}));await go('/');await page.locator('.n-market-table').getByText('$151.25',{exact:true}).waitFor();assert.deepEqual(await page.locator('.n-stats strong').allInnerTexts(),['—','—','—','—']);});
  await test('Persian direction and preference persist across reload',async()=>{await page.locator('.n-language').click();await page.waitForFunction(()=>document.documentElement.dir==='rtl');await page.reload({waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>document.documentElement.lang),'fa');assert.equal(await page.evaluate(()=>document.documentElement.dir),'rtl');});
  await test('No mutating API request was made',async()=>{assert.equal(report.mutations.length,0);});
  await context.close();
})().catch(e=>report.failures.push(String(e))).finally(async()=>{
  if(browser)await browser.close();server.kill('SIGTERM');fs.writeFileSync(path.join(out,'qa-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({captures:report.captures.length,interactions:report.interactions.length,failures:report.failures},null,2));
  if(report.failures.length)process.exitCode=1;
});
