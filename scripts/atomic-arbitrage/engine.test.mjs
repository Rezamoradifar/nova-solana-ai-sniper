import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, raw, checkBuild, checkFresh, readiness, checkApproval, checkHalt, requiredBalance,
  reserveAttempt, withJournal, main, WSOL, USDC, JUP, TOKEN, ATA, SYSTEM, MAINNET_GENESIS } from './engine.mjs';
const owner = 'GG8ftVUxs1vMuDQJGgtcTtZLJtm6sYjq22kw'; // Test-only string, never contacted.
const goodOwner = '11111111111111111111111111111111';
const source = 'source', destination = 'destination';
const e = { inputMint: WSOL, outputMint: USDC, amount: 10000000n, owner, source, destination, slippage: 5, dex: 'Whirlpool' };
function fixture(shared = false) {
  const q = { inputMint: WSOL, outputMint: USDC, inAmount: '10000000', outAmount: '1500000', otherAmountThreshold: '1499250', swapMode: 'ExactIn', slippageBps: 5,
    routePlan: [{ percent: 100, bps: 10000, swapInfo: { label: 'Whirlpool', ammKey: 'test-pool', inputMint: WSOL, outputMint: USDC, inAmount: '10000000', outAmount: '1500000' } }],
    setupInstructions: [], otherInstructions: [], cleanupInstruction: null, tipInstruction: null, addressesByLookupTableAddress: {} };
  const b = Buffer.alloc(shared ? 36 : 35);
  createHash('sha256').update('global:' + (shared ? 'shared_accounts_route' : 'route')).digest().copy(b, 0, 0, 8);
  b.writeUInt32LE(1, shared ? 9 : 8); b.writeBigUInt64LE(10000000n, b.length - 19); b.writeBigUInt64LE(1500000n, b.length - 11); b.writeUInt16LE(5, b.length - 3);
  const keys = shared ? [TOKEN,'authority',owner,source,'program-source','program-destination',destination,WSOL,USDC,JUP,JUP,'event',JUP] : [TOKEN,owner,source,destination,JUP,USDC,JUP,'event',JUP];
  q.swapInstruction = { programId: JUP, data: b.toString('base64'), accounts: keys.map(pubkey => ({pubkey,isSigner:pubkey===owner,isWritable:pubkey===source || pubkey===destination})) };
  return q;
}
function invalid(name, change, error) { test(name, () => { const q=fixture();change(q);assert.throws(()=>checkBuild(q,e),new RegExp(error)); }); }
for (const value of ['', '1.5', '-1', '0', ' 1', '1e6', 'NaN', 'Infinity', '001', '18446744073709551616'])
  test('reject raw amount '+JSON.stringify(value),()=>assert.throws(()=>raw(value)));
test('BigInt preserves full u64 precision',()=>assert.equal(raw('18446744073709551615'),(1n<<64n)-1n));
test('zero allowed only for balances',()=>assert.equal(raw('0','BALANCE',true),0n));
test('default off, no inferred wallet, no Nova flag inheritance',()=>{const c=config({LIVE_TRADING:'true',KILL_SWITCH:'false'});assert.equal(c.mode,'off');assert.deepEqual(readiness(c).missing,['owner','rpc']);assert.equal(readiness(c).executionEnabled,false);});
for (const [key,value] of [['ARB_MODE','true'],['ARB_AMOUNT_LAMPORTS','10000001'],['ARB_MAX_AMOUNT_LAMPORTS','100000001'],['ARB_MAX_FEE_LAMPORTS','1000001'],['ARB_DAILY_FEE_BUDGET_LAMPORTS','1'],['ARB_SLIPPAGE_BPS','51'],['ARB_MAX_QUOTE_AGE_MS','30000'],['ARB_MAX_ATTEMPTS_PER_DAY','100'],['ARB_SELL_DEX','Raydium CLMM']])
  test('configuration ceiling '+key,()=>assert.throws(()=>config({[key]:value})));
test('status runs without installing Solana libraries or contacting RPC',async()=>{assert.equal((await main(['status'],{})).mode,'off');});
test('off mode rejects simulation before RPC',async()=>{await assert.rejects(main(['simulate'],{}),/ARBITRAGE_OFF/);});
test('live command requires owner-specific acknowledgement',async()=>{await assert.rejects(main(['execute-once'],{ARB_MODE:'live'}),/LIVE_NOT_AUTHORIZED/);});
test('simulation mode cannot submit',async()=>{await assert.rejects(main(['execute-once','--confirm-owner=x'],{ARB_MODE:'simulate',ARB_OWNER:'x'}),/LIVE_NOT_AUTHORIZED/);});
test('genesis pin is the full RPC hash, not truncated CAIP identifier',()=>assert.equal(MAINNET_GENESIS,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'));
test('reject future and stale quotes',()=>{const c=config({});assert.throws(()=>checkFresh(100,c,99));assert.throws(()=>checkFresh(100,c,8101));checkFresh(100,c,8100);});
test('guard includes ENTIRE starting balance, fee ceiling and minimum profit',()=>assert.equal(requiredBalance(100000000n,config({})),100150000n));
test('guard cannot wrap u64',()=>assert.throws(()=>requiredBalance((1n<<64n)-1n,config({})),/BALANCE_OVERFLOW/));
test('accept independently validated direct route',()=>assert.equal(checkBuild(fixture(),e).minimum,1499250n));
test('accept published shared-accounts layout',()=>assert.equal(checkBuild(fixture(true),e).minimum,1499250n));
invalid('reject fake input mint',q=>q.inputMint='fake','QUOTE_MISMATCH');
invalid('reject ExactOut',q=>q.swapMode='ExactOut','QUOTE_MISMATCH');
invalid('reject amount inflation',q=>q.inAmount='10000001','QUOTE_MISMATCH');
invalid('reject slippage substitution',q=>q.slippageBps=100,'QUOTE_MISMATCH');
invalid('reject overstated minimum',q=>q.otherAmountThreshold='1500000','OVERSTATED_MINIMUM');
invalid('reject route splitting',q=>q.routePlan.push(q.routePlan[0]),'INDIRECT_ROUTE');
invalid('reject substituted DEX',q=>q.routePlan[0].swapInfo.label='fake','ROUTE_MISMATCH');
invalid('reject cleanup/WSOL close from provider',q=>q.cleanupInstruction={fake:true},'UNEXPECTED_SIDE_EFFECT');
invalid('reject unsolicited tip',q=>q.tipInstruction={fake:true},'UNEXPECTED_SIDE_EFFECT');
invalid('reject extra instructions',q=>q.otherInstructions=[{}],'UNEXPECTED_SIDE_EFFECT');
invalid('reject token-ledger amount substitution',q=>q.tokenLedgerInstruction={fake:true},'UNEXPECTED_SIDE_EFFECT');
invalid('reject foreign swap program',q=>q.swapInstruction.programId=SYSTEM,'UNAPPROVED_SWAP_PROGRAM');
invalid('reject unsupported on-chain variant',q=>{const b=Buffer.from(q.swapInstruction.data,'base64');b[0]^=255;q.swapInstruction.data=b.toString('base64');},'UNSUPPORTED_JUPITER_INSTRUCTION');
invalid('reject amount encoded differently in transaction',q=>{const b=Buffer.from(q.swapInstruction.data,'base64');b.writeBigUInt64LE(99999999n,b.length-19);q.swapInstruction.data=b.toString('base64');},'SWAP_AMOUNT_MISMATCH');
invalid('reject nonzero encoded platform fee',q=>{const b=Buffer.from(q.swapInstruction.data,'base64');b[b.length-1]=1;q.swapInstruction.data=b.toString('base64');},'SWAP_AMOUNT_MISMATCH');
invalid('reject hidden destination override',q=>q.swapInstruction.accounts[4].pubkey='attacker','DESTINATION_OVERRIDE');
invalid('reject foreign token account',q=>q.swapInstruction.accounts[3].pubkey='attacker','TOKEN_ACCOUNT_MISMATCH');
invalid('reject extra signer',q=>q.swapInstruction.accounts[7].isSigner=true,'UNEXPECTED_SIGNER');
invalid('reject program-provided SOL transfers in setup',q=>q.setupInstructions=[{programId:SYSTEM,data:'Ag==',accounts:[]}],'UNAPPROVED_SETUP');
test('omit only verified idempotent own ATA no-ops',()=>{const q=fixture();q.setupInstructions=[{programId:ATA,data:'AQ==',accounts:[owner,source,owner,WSOL,SYSTEM,TOKEN].map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:i===0||i===1}))}];assert.equal(checkBuild(q,e).minimum,1499250n);});
const now=Date.now();
const c=config({ARB_OWNER:goodOwner,ARB_RELEASE_SHA:'a'.repeat(40)});
const approval={purpose:'moneyland-arbitrage-one-shot',release:c.release,owner:c.owner,network:'mainnet-beta',expiresAt:new Date(now+3600000).toISOString(),buyDex:c.buyDex,sellDex:c.sellDex,maxInputLamports:String(c.amount),maxFeeLamports:String(c.maxFee),minProfitLamports:String(c.minProfit)};
test('specific, expiring operator approval',()=>checkApproval(approval,c,now));
for(const [key,value] of [['release','b'.repeat(40)],['owner','foreign'],['expiresAt',new Date(now-100).toISOString()],['expiresAt',new Date(now+86400001).toISOString()],['maxInputLamports','1'],['maxFeeLamports','1'],['minProfitLamports','50001'],['sellDex',c.buyDex]])
  test('approval rejects '+key+' '+value,()=>assert.throws(()=>checkApproval({...approval,[key]:value},c,now)));
const initial={owner:c.owner,network:MAINNET_GENESIS,attempts:[]};
test('persist a pending reservation before any submission',()=>{const next=reserveAttempt(initial,c,'sig',100,now);assert.equal(initial.attempts.length,0);assert.equal(next.attempts[0].status,'pending');assert.equal(next.attempts[0].reservedFee,'100000');});
test('unknown submission blocks next day too',()=>{const s=reserveAttempt(initial,c,'sig',100,now);assert.throws(()=>reserveAttempt(s,c,'new',200,now+86400000),/UNRESOLVED_TRANSACTION/);});
test('failed attempts consume budget too',()=>{const s=reserveAttempt(initial,c,'sig',100,now);s.attempts[0].status='failed';assert.throws(()=>reserveAttempt(s,c,'new',200,now),/DAILY_LIMIT/);});
test('journal identity cannot switch wallets',()=>assert.throws(()=>reserveAttempt({...initial,owner:'other'},c,'sig',100),/JOURNAL_IDENTITY/));
test('completed prior day can start a new bounded attempt',()=>{const s=reserveAttempt(initial,c,'sig',100,now);s.attempts[0].status='finalized';assert.equal(reserveAttempt(s,c,'new',200,now+86400000).attempts.length,2);});
test('persistent lock prevents concurrent operator sessions',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-'));const x={...c,stateDir:dir};try{await withJournal(x,async j=>{await assert.rejects(withJournal(x,()=>{}),/JOURNAL_LOCKED/);j.write(reserveAttempt(j.get(),x,'sig',100));});await withJournal(x,async j=>assert.equal(j.get().attempts[0].signature,'sig'));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('corrupt state fails closed, never resets budget',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-'));fs.mkdirSync(path.join(dir,c.owner));fs.writeFileSync(path.join(dir,c.owner,'journal.json'),'bad',{mode:0o600});try{await assert.rejects(withJournal({...c,stateDir:dir},()=>{}));assert.equal(fs.readFileSync(path.join(dir,c.owner,'journal.json'),'utf8'),'bad');}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('HALT file stops even live configuration',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-'));try{fs.writeFileSync(path.join(dir,'HALT'),'');assert.throws(()=>checkHalt({...c,stateDir:dir}),/EMERGENCY_HALT/);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
