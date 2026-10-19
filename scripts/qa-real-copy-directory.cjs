/* Local browser verification only. Mock responses are test fixtures, never production fallback data. */
const { chromium } = require('/tmp/moneyland-real-browser/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Keypair } = require('@solana/web3.js');
const root=path.resolve(__dirname,'..'), out=path.join(root,'real-copy-verification');
fs.mkdirSync(out,{recursive:true});
const address=Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey.toBase58();
const other=Keypair.fromSeed(new Uint8Array(32).fill(72)).publicKey.toBase58();
const report={checks:[],failures:[],mutations:[],captures:[]};
const base='http://127.0.0.1:4173';
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','4173'],{cwd:path.join(root,'apps/dashboard'),stdio:'inherit'});
let browser;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function check(name,fn){try{await fn();report.checks.push({name,passed:true});console.log('PASS',name);}catch(e){report.checks.push({name,passed:false,error:String(e)});report.failures.push(name+': '+String(e));console.error('FAIL',name,String(e));}}
function fixture(){return {version:'real-copy-v1',chain:'solana',sampleData:false,scope:'monitored_wallets_not_all_market',refreshMs:20000,
 local:{status:'ready',updatedAt:Date.now(),wallets:[{address,label:'QA source wallet',rank:1,recommendation:{score:82,eligible:true,closedTrades:34,realizedPnlSol:1.2345,winRatePct:62.5,reasons:[],warnings:[]}}]},
 gmgn:{status:'ready',updatedAt:Date.now(),wallets:[{address:other,label:'QA provider record',rank:1,score:72,qualifiedSample:true,realizedPnlUsd:321.45,realizedRoiPct:14.2,winRatePct:65,sellCount:27}]},
 execution:{mode:'disabled',watcherHealthy:false,directoryReadOnly:true,activationPerformed:false}};}
(async()=>{
 for(let i=0;i<40;i++){try{if((await fetch(base)).ok)break;}catch{}await delay(250);}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const [width,lang] of [[1440,'en'],[390,'fa']]){
  const context=await browser.newContext({viewport:{width,height:950},reducedMotion:'reduce'});
  await context.addInitScript(l=>localStorage.setItem('moneyland-language',l),lang);
  await context.route('**/api/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"QA source not connected"}'}));
  let available=true; let value=fixture();
  await context.route('**/api/public/copy-leaderboard',r=>r.fulfill({status:available?200:503,contentType:'application/json',body:JSON.stringify(available?value:{error:'source unavailable'})}));
  const page=await context.newPage();
  page.on('pageerror',e=>report.failures.push(`${width}/${lang} ${e.message}`));
  page.on('request',r=>{if(r.url().includes('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method()))report.mutations.push({method:r.method(),url:r.url()});});
  await check(`${width}/${lang}: supplied records, source rank and realized unit render`,async()=>{
   await page.goto(base+'/copy?demo=1',{waitUntil:'networkidle'});
   await page.getByText('QA source wallet',{exact:true}).waitFor();
   assert.equal(new URL(page.url()).searchParams.has('demo'),false);
   assert.match(await page.locator('.live-copy-table').innerText(),/1.2345 SOL/);
   assert.match(await page.locator('.live-copy-table').innerText(),/62.5%/);
   assert.equal(await page.locator('.n-trader-card,.n-sparkline,.n-candle-chart').count(),0);
   const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,dir:document.documentElement.dir}));
   assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes)); assert.equal(sizes.dir,lang==='fa'?'rtl':'ltr');
   const file=`copy-${width}-${lang}.png`;await page.screenshot({path:path.join(out,file),fullPage:true});report.captures.push(file);
  });
  await check(`${width}/${lang}: filters and provider source selection use API records`,async()=>{
   await page.locator('.live-copy-controls input:not([type=checkbox])').fill('not-present');assert.equal(await page.locator('.live-copy-table tbody tr').count(),0);
   await page.locator('.live-copy-controls input:not([type=checkbox])').fill('');
   await page.locator('.live-copy-controls button').filter({hasText:'GMGN'}).click();
   await page.getByText('QA provider record',{exact:true}).waitFor();assert.match(await page.locator('.live-copy-table').innerText(),/321.45 USD/);
  });
  await check(`${width}/${lang}: actual address profile does not invent history`,async()=>{
   await page.goto(base+'/copy/'+address,{waitUntil:'networkidle'});await page.locator('p.live-address').getByText(address,{exact:true}).waitFor();
   const href=await page.locator('a[href*="solscan.io/account/"]').getAttribute('href');assert.equal(href,'https://solscan.io/account/'+address);
   assert.equal(await page.locator('svg.n-sparkline').count(),0);
  });
  await check(`${width}/${lang}: unavailable source clears existing records`,async()=>{
   await page.goto(base+'/copy',{waitUntil:'networkidle'});available=false;
   await page.locator('.n-page-title button').click();await page.locator('.live-feedback').waitFor();
   assert.equal(await page.locator('.live-copy-table tbody tr').count(),0);assert.equal(await page.getByText('QA source wallet',{exact:true}).count(),0);available=true;
  });
  await check(`${width}/${lang}: demo-tagged source cannot impersonate real records`,async()=>{
   value={...fixture(),sampleData:true};await page.goto(base+'/copy',{waitUntil:'networkidle'});await page.locator('.live-feedback').waitFor();assert.equal(await page.locator('.live-copy-table tbody tr').count(),0);value=fixture();
  });
  await check(`${width}/${lang}: public demo entry points are removed`,async()=>{
   for(const route of ['/','/trade','/exchange','/bots','/flash-loans','/meme-hub','/classic','/v2','/design-system','/terminal/copy','/terminal/exchange']){
    await page.goto(base+route+'?demo=1',{waitUntil:'networkidle'});
    assert.equal(new URL(page.url()).searchParams.has('demo'),false,route);
    assert.equal(await page.locator('.ml2-frame,.n-console-preview,.n-floating-swap,.n-trader-card,.n-candle-chart').count(),0,route);
    const content=await page.locator('body').innerText();
    assert.doesNotMatch(content,/Quant Wolf|CryptoWhale|DESIGN PREVIEW|Record paper buy|SIMULATION MODE/);
   }
  });
  await check(`${width}/${lang}: wallet address-only dialog handles Escape`,async()=>{
   await page.goto(base+'/',{waitUntil:'networkidle'});await page.locator('.n-header-wallet').click();await page.locator('dialog[open]').waitFor();
   for(let i=0;i<6;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('dialog')),true);}
   await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
  });
  await context.close();
 }
 await check('Public views make no financial or configuration API mutation',async()=>assert.equal(report.mutations.length,0));
})().catch(e=>report.failures.push(String(e))).finally(async()=>{
 if(browser)await browser.close();server.kill('SIGTERM');fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:report.checks.length,failures:report.failures},null,2));if(report.failures.length)process.exitCode=1;
});
