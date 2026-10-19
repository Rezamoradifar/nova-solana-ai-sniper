/** Synthetic fixtures only; uses the actual Solana SDK with a mocked RPC/quote gateway. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as web3 from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import bs58 from 'bs58';
import { buildCycle, config, execute, withJournal, WSOL, USDC, JUP, TOKEN, SYSTEM } from './engine.mjs';
const k = { ...web3, ...spl, bs58 };
const pub = n => web3.Keypair.fromSeed(Uint8Array.from({length:32},()=>n)).publicKey;
function account(mint,owner,amount=0n) {
  const b=Buffer.alloc(165);mint.toBuffer().copy(b,0);owner.toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=1;
  if(mint.toBase58()===WSOL){b.writeUInt32LE(1,109);b.writeBigUInt64LE(2039280n,113);}
  return {owner:spl.TOKEN_PROGRAM_ID,lamports:2039280+Number(mint.toBase58()===WSOL?amount:0n),data:b,executable:false,rentEpoch:0};
}
function mockBuild(e) {
  const b=Buffer.alloc(35);createHash('sha256').update('global:route').digest().copy(b,0,0,8);b.writeUInt32LE(1,8);
  const out=e.inputMint===WSOL?2000000n:11000000n;
  b.writeBigUInt64LE(BigInt(e.amount),16);b.writeBigUInt64LE(out,24);b.writeUInt16LE(5,32);
  const source=spl.getAssociatedTokenAddressSync(new web3.PublicKey(e.inputMint),new web3.PublicKey(e.taker));
  const keys=[TOKEN,e.taker,source.toBase58(),e.destinationTokenAccount,JUP,e.outputMint,JUP,pub(4).toBase58(),JUP];
  const instruction={programId:JUP,data:b.toString('base64'),accounts:keys.map(pubkey=>({pubkey,isSigner:pubkey===e.taker,isWritable:pubkey===source.toBase58()||pubkey===e.destinationTokenAccount}))};
  return {inputMint:e.inputMint,outputMint:e.outputMint,inAmount:e.amount,outAmount:String(out),otherAmountThreshold:String(out*9995n/10000n),swapMode:'ExactIn',slippageBps:5,
    routePlan:[{percent:100,bps:10000,swapInfo:{ammKey:pub(e.inputMint===WSOL?5:6).toBase58(),label:e.dexes,inputMint:e.inputMint,outputMint:e.outputMint,inAmount:e.amount,outAmount:String(out)}}],
    setupInstructions:[],otherInstructions:[],cleanupInstruction:null,tipInstruction:null,swapInstruction:instruction,addressesByLookupTableAddress:{}};
}
async function harness(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-sdk-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const signer=web3.Keypair.fromSeed(new Uint8Array(32).fill(11)),owner=signer.publicKey;
  const c=config({ARB_MODE:'simulate',ARB_OWNER:owner.toBase58(),ARB_RPC_URL:'https://rpc.invalid',ARB_JUPITER_API_KEY:'synthetic-test-only',ARB_STATE_DIR:dir,ARB_RELEASE_SHA:'a'.repeat(40)});
  const source=spl.getAssociatedTokenAddressSync(new web3.PublicKey(WSOL),owner),middle=spl.getAssociatedTokenAddressSync(new web3.PublicKey(USDC),owner);
  const preSol=100000000, preWs=20000000n;
  const payer={owner:web3.SystemProgram.programId,lamports:preSol,data:Buffer.alloc(0),executable:false};
  const a=account(new web3.PublicKey(WSOL),owner,preWs),b=account(new web3.PublicKey(USDC),owner,0n);
  const calls={sim:[],send:0,build:0};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(new URL(url).origin,'https://api.jup.ag');assert.equal(new URL(url).pathname,'/swap/v2/build');assert.equal(options.redirect,'error');
    calls.build++;return new Response(JSON.stringify(mockBuild(Object.fromEntries(new URL(url).searchParams))),{status:200});
  });
  const rpc={
    getMultipleAccountsInfoAndContext:async()=>({context:{slot:123},value:[payer,a,b]}),
    getMinimumBalanceForRentExemption:async()=>2039280,
    getMultipleAccountsInfo:async(keys)=>keys.map(key=>key.equals(source)?a:key.equals(middle)?b:null),
    getLatestBlockhash:async()=>({blockhash:pub(8).toBase58(),lastValidBlockHeight:999}),
    getFeeForMessage:async()=>({value:5000}),
    simulateTransaction:async(tx,opts)=>{
      calls.sim.push({tx,opts});
      const post=x=>({...x,owner:x.owner.toBase58(),data:[x.data.toString('base64'),'base64']});
      return {value:{err:null,unitsConsumed:200000,accounts:[post(account(new web3.PublicKey(WSOL),owner,preWs+c.maxFee+c.minProfit)),post(b),{...post(payer),lamports:preSol-5000},null]}};
    },
    sendRawTransaction:async(serialized,options)=>{calls.send++;assert.equal(options.skipPreflight,false);assert.equal(options.maxRetries,0);return bs58.encode(web3.VersionedTransaction.deserialize(serialized).signatures[0]);},
  };
  return {c,deps:{k,rpc,owner},calls,signer,preWs,source,middle};
}
test('actual SDK composes both swaps and the balance guard in ONE v0 transaction',async t=>{
  const {c,deps,calls,preWs}=await harness(t);const cycle=await buildCycle(c,deps);
  assert.equal(calls.send,0);assert.equal(calls.build,2);assert.equal(calls.sim.length,2);assert.equal(cycle.tx.message.header.numRequiredSignatures,1);
  assert.ok(cycle.tx.serialize().length<=1232);
  const ixs=web3.TransactionMessage.decompile(cycle.tx.message).instructions;
  assert.equal(ixs.filter(x=>x.programId.toBase58()===JUP).length,2);
  const tail=ixs.slice(-3);assert.deepEqual(tail.map(x=>x.data[0]),[12,12,9]);
  assert.equal(tail[0].data.readBigUInt64LE(1),preWs+c.maxFee+c.minProfit);
  assert.ok(tail.every(x=>x.programId.equals(spl.TOKEN_PROGRAM_ID)));
  assert.ok(calls.sim.every(x=>x.opts.replaceRecentBlockhash===false && x.opts.sigVerify===false));
  assert.equal(cycle.report.broadcast,false);
});
test('simulation failure never reaches a sender',async t=>{
  const {c,deps,calls}=await harness(t);deps.rpc.simulateTransaction=async()=>({value:{err:{InstructionError:[4,'Custom']}}});
  await assert.rejects(buildCycle(c,deps),/SIMULATION_FAILED/);assert.equal(calls.send,0);
});
test('post-state below required WSOL balance is rejected',async t=>{
  const {c,deps,calls}=await harness(t);const sim=deps.rpc.simulateTransaction;
  deps.rpc.simulateTransaction=async(...a)=>{const r=await sim(...a),b=Buffer.from(r.value.accounts[0].data[0],'base64');b.writeBigUInt64LE(1n,64);r.value.accounts[0].data[0]=b.toString('base64');return r;};
  await assert.rejects(buildCycle(c,deps),/POST_BALANCE_GUARD/);assert.equal(calls.send,0);
});
test('fee above independent cap is rejected',async t=>{
  const {c,deps,calls}=await harness(t);deps.rpc.getFeeForMessage=async()=>({value:100001});
  await assert.rejects(buildCycle(c,deps),/TRANSACTION_FEE_LIMIT/);assert.equal(calls.send,0);
});
test('LIVE sender signs exact simulated message and persists signature BEFORE network',async t=>{
  const {c,deps,calls,signer}=await harness(t);c.mode='live';
  c.keyFile=path.join(c.stateDir,'key.json');c.approvalFile=path.join(c.stateDir,'approval.json');
  fs.writeFileSync(c.keyFile,JSON.stringify([...signer.secretKey]),{mode:0o600});
  fs.writeFileSync(c.approvalFile,JSON.stringify({purpose:'moneyland-arbitrage-one-shot',release:c.release,owner:c.owner,network:'mainnet-beta',expiresAt:new Date(Date.now()+600000).toISOString(),buyDex:c.buyDex,sellDex:c.sellDex,maxInputLamports:String(c.amount),maxFeeLamports:String(c.maxFee),minProfitLamports:String(c.minProfit)}),{mode:0o600});
  const send=deps.rpc.sendRawTransaction;
  deps.rpc.sendRawTransaction=async(...args)=>{
    const j=JSON.parse(fs.readFileSync(path.join(c.stateDir,c.owner,'journal.json'),'utf8'));
    assert.equal(j.attempts[0].status,'pending');assert.equal(j.attempts[0].signature,bs58.encode(web3.VersionedTransaction.deserialize(args[0]).signatures[0]));
    return send(...args);
  };
  await withJournal(c,async journal=>{
    const r=await execute(c,deps,journal,c.owner);assert.equal(r.status,'SUBMITTED_NOT_FINALIZED');assert.equal(calls.send,1);
    assert.equal(calls.sim.at(-1).opts.sigVerify,true);
    await assert.rejects(execute(c,deps,journal,c.owner),/UNRESOLVED_TRANSACTION/);assert.equal(calls.send,1);
  });
});
test('network timeout leaves pending signature and never retries a new transaction',async t=>{
  const {c,deps,calls,signer}=await harness(t);c.mode='live';
  c.keyFile=path.join(c.stateDir,'key.json');c.approvalFile=path.join(c.stateDir,'approval.json');
  fs.writeFileSync(c.keyFile,JSON.stringify([...signer.secretKey]),{mode:0o600});
  fs.writeFileSync(c.approvalFile,JSON.stringify({purpose:'moneyland-arbitrage-one-shot',release:c.release,owner:c.owner,network:'mainnet-beta',expiresAt:new Date(Date.now()+600000).toISOString(),buyDex:c.buyDex,sellDex:c.sellDex,maxInputLamports:String(c.amount),maxFeeLamports:String(c.maxFee),minProfitLamports:String(c.minProfit)}),{mode:0o600});
  deps.rpc.sendRawTransaction=async()=>{calls.send++;throw new Error('Synthetic timeout');};
  await withJournal(c,async journal=>{const r=await execute(c,deps,journal,c.owner);assert.equal(r.broadcast,'unknown');assert.equal(journal.get().attempts[0].status,'pending');await assert.rejects(execute(c,deps,journal,c.owner),/UNRESOLVED_TRANSACTION/);assert.equal(calls.send,1);});
});
