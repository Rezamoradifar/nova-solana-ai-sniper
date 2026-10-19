/**
 * Moneyland funded WSOL -> USDC -> WSOL atomic executor.
 * Standalone: never reads Nova's .env/database, changes LIVE_TRADING, or starts a worker.
 * No flash loan, CEX routing, customer wallets, unsigned public execute endpoint, or auto-loop.
 * Off by default. Simulation never loads a private key or broadcasts a transaction.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM = '11111111111111111111111111111111';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEXES = ['Raydium CLMM', 'Whirlpool', 'Meteora DLMM'];
const U64 = (1n << 64n) - 1n;
const fail = (code) => { throw new Error(code); };
const must = (test, code) => { if (!test) fail(code); };
export function raw(value, name = 'AMOUNT', zero = false) {
  must(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), `INVALID_${name}`);
  const n = BigInt(value); must(n <= U64 && (zero || n > 0n), `INVALID_${name}`); return n;
}
function integer(value, fallback, min, max, name) {
  const s = value === undefined || value === '' ? String(fallback) : value;
  must(/^\d+$/.test(s), `INVALID_${name}`); const n = Number(s);
  must(Number.isSafeInteger(n) && n >= min && n <= max, `INVALID_${name}`); return n;
}
export function config(env = process.env) {
  const c = {
    mode: env.ARB_MODE || 'off', owner: env.ARB_OWNER || '', rpc: env.ARB_RPC_URL || '',
    apiKey: env.ARB_JUPITER_API_KEY || '', buyDex: env.ARB_BUY_DEX || DEXES[0],
    sellDex: env.ARB_SELL_DEX || DEXES[1], amount: raw(env.ARB_AMOUNT_LAMPORTS || '10000000'),
    maxAmount: raw(env.ARB_MAX_AMOUNT_LAMPORTS || '10000000'),
    maxFee: raw(env.ARB_MAX_FEE_LAMPORTS || '100000'), minProfit: raw(env.ARB_MIN_PROFIT_LAMPORTS || '50000'),
    reserve: raw(env.ARB_SOL_RESERVE_LAMPORTS || '10000000'),
    dailyFees: raw(env.ARB_DAILY_FEE_BUDGET_LAMPORTS || '100000'),
    slippage: integer(env.ARB_SLIPPAGE_BPS, 5, 0, 50, 'SLIPPAGE'),
    maxAgeMs: integer(env.ARB_MAX_QUOTE_AGE_MS, 8000, 1000, 15000, 'QUOTE_AGE'),
    microLamports: integer(env.ARB_CU_PRICE_MICROLAMPORTS, 1000, 0, 100000, 'CU_PRICE'),
    maxAttempts: integer(env.ARB_MAX_ATTEMPTS_PER_DAY, 1, 1, 10, 'ATTEMPTS'),
    stateDir: env.ARB_STATE_DIR || '/state', keyFile: env.ARB_KEYPAIR_FILE || '',
    approvalFile: env.ARB_APPROVAL_FILE || '', release: env.ARB_RELEASE_SHA || 'development',
  };
  must(['off', 'simulate', 'live'].includes(c.mode), 'INVALID_MODE');
  // Deliberately restrictive initial deployment ceilings, not a suggested investment size.
  must(c.amount <= c.maxAmount && c.maxAmount <= 100000000n, 'INPUT_LIMIT');
  must(c.maxFee <= 1000000n && c.dailyFees >= c.maxFee && c.dailyFees <= 10000000n, 'FEE_LIMIT');
  must(c.minProfit <= 100000000n, 'PROFIT_LIMIT');
  must(DEXES.includes(c.buyDex) && DEXES.includes(c.sellDex) && c.buyDex !== c.sellDex, 'DEX_LIMIT');
  return c;
}
export function readiness(c) {
  return { component: 'moneyland-atomic-arbitrage', mode: c.mode, network: 'solana-mainnet-beta',
    executionEnabled: false, liveRequires: 'execute-once + live mode + expiring approval + separate signer + all gates',
    missing: ['owner', 'rpc'].filter(k => !c[k]), apiKeyConfigured: !!c.apiKey,
    amountLamports: String(c.amount), maxFeeLamports: String(c.maxFee), minProfitLamports: String(c.minProfit),
    route: [c.buyDex, c.sellDex], keyFileConfigured: !!c.keyFile, novaTradingFlagsModified: false };
}
export function checkFresh(start, c, now = Date.now()) {
  must(Number.isSafeInteger(start) && now >= start && now - start <= c.maxAgeMs, 'STALE_QUOTE');
}
export function requiredBalance(before, c) {
  const n = before + c.maxFee + c.minProfit; must(n <= U64, 'BALANCE_OVERFLOW'); return n;
}
const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
function bytes(ix) {
  must(ix && typeof ix.data === 'string' && ix.data.length <= 8192 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ix.data), 'INVALID_INSTRUCTION');
  const b = Buffer.from(ix.data, 'base64'); must(b.length > 0, 'EMPTY_INSTRUCTION'); return b;
}
function meta(ix) {
  must(Array.isArray(ix.accounts) && ix.accounts.length <= 64 && ix.accounts.every(k =>
    typeof k.pubkey === 'string' && typeof k.isSigner === 'boolean' && typeof k.isWritable === 'boolean'), 'INVALID_ACCOUNTS');
}
/** Only the published Jupiter V6 route/shared_accounts_route layouts are accepted.
 * API V2 is independent of the on-chain instruction version. New instruction variants fail closed.
 */
export function checkSwap(ix, q, expected) {
  must(ix?.programId === JUP, 'UNAPPROVED_SWAP_PROGRAM'); meta(ix); const b = bytes(ix);
  const route = b.subarray(0, 8).equals(disc('route'));
  const shared = b.subarray(0, 8).equals(disc('shared_accounts_route'));
  must(route || shared, 'UNSUPPORTED_JUPITER_INSTRUCTION');
  must(b.length >= (shared ? 36 : 35), 'SHORT_SWAP_DATA');
  must(b.readUInt32LE(shared ? 9 : 8) === 1, 'MULTIHOP_NOT_SUPPORTED');
  const tail = b.length - 19;
  must(b.readBigUInt64LE(tail) === expected.amount && b.readBigUInt64LE(tail + 8) === raw(q.outAmount) &&
    b.readUInt16LE(tail + 16) === q.slippageBps && b[tail + 18] === 0, 'SWAP_AMOUNT_MISMATCH');
  const a = ix.accounts;
  const match = (i, key) => a[i]?.pubkey === key;
  must(match(0, TOKEN), 'TOKEN_PROGRAM_MISMATCH');
  must(match(shared ? 2 : 1, expected.owner) && a[shared ? 2 : 1].isSigner, 'AUTHORITY_MISMATCH');
  must(match(shared ? 3 : 2, expected.source) && match(shared ? 6 : 3, expected.destination), 'TOKEN_ACCOUNT_MISMATCH');
  must(match(shared ? 8 : 5, expected.outputMint), 'OUTPUT_MINT_MISMATCH');
  if (shared) must(match(7, expected.inputMint), 'INPUT_MINT_MISMATCH');
  else must(match(4, JUP) || match(4, expected.destination), 'DESTINATION_OVERRIDE');
  must(match(shared ? 9 : 6, JUP), 'PLATFORM_FEE_ACCOUNT');
  if (shared) must(match(10, JUP) || match(10, TOKEN), 'TOKEN_2022_UNSUPPORTED');
  must(match(shared ? 12 : 8, JUP), 'JUPITER_PROGRAM_ACCOUNT');
  must(a.every(k => !k.isSigner || k.pubkey === expected.owner), 'UNEXPECTED_SIGNER');
  return ix;
}
export function checkBuild(q, e) {
  must(q && q.inputMint === e.inputMint && q.outputMint === e.outputMint &&
    raw(q.inAmount) === e.amount && q.swapMode === 'ExactIn' && q.slippageBps === e.slippage, 'QUOTE_MISMATCH');
  const out = raw(q.outAmount), minimum = raw(q.otherAmountThreshold);
  must(minimum <= out * BigInt(10000 - e.slippage) / 10000n, 'OVERSTATED_MINIMUM');
  must(Array.isArray(q.routePlan) && q.routePlan.length === 1, 'INDIRECT_ROUTE');
  const p = q.routePlan[0], s = p.swapInfo;
  must((p.percent === 100 || p.bps === 10000) && s?.label === e.dex &&
    s.inputMint === e.inputMint && s.outputMint === e.outputMint &&
    s.inAmount === q.inAmount && s.outAmount === q.outAmount && typeof s.ammKey === 'string', 'ROUTE_MISMATCH');
  must(!q.cleanupInstruction && !q.tipInstruction && Array.isArray(q.otherInstructions) &&
    q.otherInstructions.length === 0 && !q.tokenLedgerInstruction, 'UNEXPECTED_SIDE_EFFECT');
  must(Array.isArray(q.setupInstructions) && q.setupInstructions.length <= 2, 'UNEXPECTED_SETUP');
  // We precheck that both ATAs exist. Only verified idempotent ATA no-ops may be omitted.
  for (const ix of q.setupInstructions) {
    meta(ix); const b = bytes(ix); const a = ix.accounts;
    must(ix.programId === ATA && b.length === 1 && b[0] === 1 && a.length === 6 &&
      a[0].pubkey === e.owner && a[0].isSigner && !a.slice(1).some(k => k.isSigner) &&
      a[2].pubkey === e.owner && a[4].pubkey === SYSTEM && a[5].pubkey === TOKEN &&
      ((a[1].pubkey === e.source && a[3].pubkey === e.inputMint) ||
       (a[1].pubkey === e.destination && a[3].pubkey === e.outputMint)), 'UNAPPROVED_SETUP');
  }
  checkSwap(q.swapInstruction, q, e);
  return { minimum, out, pool: s.ammKey, instruction: q.swapInstruction, lookups: q.addressesByLookupTableAddress || {} };
}
export function checkApproval(a, c, now = Date.now()) {
  must(/^[0-9a-f]{40}$/.test(c.release) && a?.release === c.release, 'APPROVAL_RELEASE');
  must(a?.purpose === 'moneyland-arbitrage-one-shot' && a.owner === c.owner && a.network === 'mainnet-beta', 'APPROVAL_IDENTITY');
  const expiry = Date.parse(a.expiresAt);
  must(Number.isFinite(expiry) && expiry > now && expiry - now <= 86400000, 'APPROVAL_EXPIRED');
  must(a.buyDex === c.buyDex && a.sellDex === c.sellDex && raw(a.maxInputLamports) >= c.amount &&
    raw(a.maxFeeLamports) >= c.maxFee && raw(a.minProfitLamports) <= c.minProfit, 'APPROVAL_LIMITS');
}
export function reserveAttempt(state, c, signature, expiryHeight, now = Date.now()) {
  must(state.owner === c.owner && state.network === MAINNET_GENESIS && Array.isArray(state.attempts), 'JOURNAL_IDENTITY');
  must(!state.attempts.some(a => !['finalized', 'failed'].includes(a.status)), 'UNRESOLVED_TRANSACTION');
  const day = new Date(now).toISOString().slice(0, 10), today = state.attempts.filter(a => a.day === day);
  must(today.length < c.maxAttempts && today.reduce((n, a) => n + raw(a.reservedFee), 0n) + c.maxFee <= c.dailyFees, 'DAILY_LIMIT');
  const next = structuredClone(state);
  next.attempts.push({ signature, status: 'pending', day, reservedFee: String(c.maxFee),
    lastValidBlockHeight: expiryHeight, createdAt: new Date(now).toISOString() });
  return next;
}
function secureRead(file) {
  const s = fs.lstatSync(file);
  must(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 && s.size <= 32768, 'INSECURE_SECRET_FILE');
  return fs.readFileSync(file, 'utf8');
}
function persist(file, value) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export async function withJournal(c, callback) {
  const dir = path.join(c.stateDir, c.owner);
  must(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.owner), 'INVALID_OWNER');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'run.lock'), file = path.join(dir, 'journal.json'); let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { fail('JOURNAL_LOCKED'); }
  try {
    fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd);
    let state = fs.existsSync(file) ? JSON.parse(secureRead(file)) : { owner: c.owner, network: MAINNET_GENESIS, attempts: [] };
    return await callback({ get: () => state, write: next => { persist(file, next); state = next; } });
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function sdk() {
  const [w, s, b] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token'), import('bs58')]);
  return { ...w, ...s, bs58: b.default };
}
async function connect(c) {
  must(c.rpc && c.owner, 'MISSING_RPC_OR_PUBLIC_OWNER');
  const u = new URL(c.rpc);
  must(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)), 'INSECURE_RPC');
  const k = await sdk(), owner = new k.PublicKey(c.owner);
  must(k.PublicKey.isOnCurve(owner.toBytes()), 'OWNER_NOT_SIGNER');
  const rpc = new k.Connection(c.rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(10000), redirect: 'error' }) });
  must(await rpc.getGenesisHash() === MAINNET_GENESIS, 'WRONG_NETWORK');
  return { k, rpc, owner };
}
function tokenInfo(info, key, mint, owner, k) {
  must(info && info.owner.toBase58() === TOKEN && info.data.length === 165 && !info.executable, 'TOKEN_ACCOUNT_NOT_READY');
  const a = k.unpackAccount(key, info, k.TOKEN_PROGRAM_ID);
  must(a.mint.equals(mint) && a.owner.equals(owner) && a.isInitialized && !a.isFrozen &&
    a.delegate === null && a.closeAuthority === null, 'UNSAFE_TOKEN_ACCOUNT');
  return a;
}
export function checkHalt(c) { must(!fs.existsSync(path.join(c.stateDir, 'HALT')), 'EMERGENCY_HALT'); }
export async function buildCycle(c, deps) {
  checkHalt(c);
  const { k, rpc, owner } = deps;
  const mint = new k.PublicKey(WSOL), midMint = new k.PublicKey(USDC);
  const source = k.getAssociatedTokenAddressSync(mint, owner), middle = k.getAssociatedTokenAddressSync(midMint, owner);
  const pre = await rpc.getMultipleAccountsInfoAndContext([owner, source, middle], { commitment: 'confirmed' });
  const [payer, srcInfo, midInfo] = pre.value;
  must(payer?.owner.toBase58() === SYSTEM && !payer.executable && Number.isSafeInteger(payer.lamports), 'UNSAFE_PAYER');
  const src = tokenInfo(srcInfo, source, mint, owner, k), mid = tokenInfo(midInfo, middle, midMint, owner, k);
  must(src.isNative && src.amount >= c.amount && !mid.isNative && mid.amount === 0n, 'DEDICATED_ACCOUNTS_REQUIRED');
  const rent = await rpc.getMinimumBalanceForRentExemption(165);
  must(BigInt(payer.lamports) >= c.reserve + c.maxFee + BigInt(rent), 'INSUFFICIENT_FEE_RESERVE');
  const started = Date.now();
  const query = async (inputMint, outputMint, amount, dex, srcKey, dstKey) => {
    const url = new URL('https://api.jup.ag/swap/v2/build');
    url.search = new URLSearchParams({ inputMint, outputMint, amount: String(amount), dexes: dex,
      taker: c.owner, payer: c.owner, destinationTokenAccount: dstKey.toBase58(),
      wrapAndUnwrapSol: 'false', slippageBps: String(c.slippage), maxAccounts: '28' }).toString();
    const response = await fetch(url, { headers: c.apiKey ? { 'x-api-key': c.apiKey } : {},
      signal: AbortSignal.timeout(8000), redirect: 'error' });
    must(response.ok, `JUPITER_HTTP_${response.status}`);
    const text = await response.text(); must(text.length <= 100000, 'OVERSIZED_BUILD_RESPONSE');
    return checkBuild(JSON.parse(text), { owner: c.owner, source: srcKey.toBase58(), destination: dstKey.toBase58(),
      inputMint, outputMint, amount, dex, slippage: c.slippage });
  };
  const first = await query(WSOL, USDC, c.amount, c.buyDex, source, middle);
  // Pace keyless/free-tier requests instead of flooding the quote gateway.
  await new Promise(r => setTimeout(r, c.apiKey ? 1100 : 2100));
  const second = await query(USDC, WSOL, first.minimum, c.sellDex, middle, source);
  must(first.pool !== second.pool, 'SAME_POOL');
  must(second.minimum >= c.amount + c.maxFee + c.minProfit, 'NO_PROFITABLE_CYCLE');
  checkFresh(started, c);
  const ix = x => new k.TransactionInstruction({ programId: new k.PublicKey(x.programId),
    keys: x.accounts.map(a => ({ pubkey: new k.PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(x.data, 'base64') });
  const swaps = [ix(first.instruction), ix(second.instruction)];
  const permitted = new Set([source.toBase58(), middle.toBase58()]);
  const writable = [...new Set(swaps.flatMap(x => x.keys.filter(a => a.isWritable).map(a => a.pubkey.toBase58())))];
  must(writable.length <= 64, 'TOO_MANY_WRITABLE_ACCOUNTS');
  const infos = await rpc.getMultipleAccountsInfo(writable.map(s => new k.PublicKey(s)));
  infos.forEach((a, i) => {
    if (a && [TOKEN, k.TOKEN_2022_PROGRAM_ID.toBase58()].includes(a.owner.toBase58()) && a.data.length >= 165 && a.data.subarray(32,64).equals(owner.toBuffer()))
      must(permitted.has(writable[i]), 'UNEXPECTED_OWNED_ACCOUNT');
  });
  const lookupKeys = [...new Set([...Object.keys(first.lookups), ...Object.keys(second.lookups)])];
  must(lookupKeys.length <= 8, 'TOO_MANY_LOOKUPS');
  const tables = [];
  for (const address of lookupKeys) {
    const r = await rpc.getAddressLookupTable(new k.PublicKey(address));
    must(r.value?.isActive(), 'LOOKUP_UNAVAILABLE'); tables.push(r.value);
  }
  // On-chain ending-balance guard without deploying a new program. A temporary,
  // self-owned WSOL account receives and returns the minimum required ending balance.
  // SPL Token rejects the first transfer when that balance is unavailable: the TWO
  // swaps, guard account creation, and rent all roll back. Failed-tx fees still apply.
  const seed = randomBytes(12).toString('hex'), guard = await k.PublicKey.createWithSeed(owner, seed, k.TOKEN_PROGRAM_ID);
  const minimumEnding = requiredBalance(src.amount, c);
  const guarded = [k.SystemProgram.createAccountWithSeed({ fromPubkey: owner, newAccountPubkey: guard,
    basePubkey: owner, seed, lamports: rent, space: 165, programId: k.TOKEN_PROGRAM_ID }),
    k.createInitializeAccount3Instruction(guard, mint, owner), ...swaps,
    k.createTransferCheckedInstruction(source, mint, guard, owner, minimumEnding, 9),
    k.createTransferCheckedInstruction(guard, mint, source, owner, minimumEnding, 9),
    k.createCloseAccountInstruction(guard, owner, owner)];
  const life = await rpc.getLatestBlockhash('confirmed');
  const make = units => {
    const instructions = [k.ComputeBudgetProgram.setComputeUnitLimit({ units }),
      k.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: c.microLamports }), ...guarded];
    const tx = new k.VersionedTransaction(new k.TransactionMessage({ payerKey: owner,
      recentBlockhash: life.blockhash, instructions }).compileToV0Message(tables));
    must(tx.message.header.numRequiredSignatures === 1 && tx.message.staticAccountKeys[0].equals(owner), 'SIGNER_SET');
    let length; try { length = tx.serialize().length; } catch { fail('TRANSACTION_TOO_LARGE'); }
    must(length <= 1232, 'TRANSACTION_TOO_LARGE'); return tx;
  };
  const simulate = async (tx, signed = false) => {
    const result = await rpc.simulateTransaction(tx, { commitment: 'confirmed', sigVerify: signed,
      replaceRecentBlockhash: false, minContextSlot: pre.context.slot,
      accounts: { encoding: 'base64', addresses: [source.toBase58(), middle.toBase58(), owner.toBase58(), guard.toBase58()] } });
    must(!result.value.err && Number.isSafeInteger(result.value.unitsConsumed) && result.value.unitsConsumed > 0, 'SIMULATION_FAILED');
    const acc = result.value.accounts; must(acc?.length === 4, 'MISSING_POST_ACCOUNTS');
    const decode = (a, address, m) => tokenInfo(a && { ...a, owner: new k.PublicKey(a.owner), data: Buffer.from(a.data[0], 'base64') }, address, m, owner, k);
    const end = decode(acc[0], source, mint), intermediate = decode(acc[1], middle, midMint);
    must(end.amount >= minimumEnding && intermediate.amount >= mid.amount && (!acc[3] || acc[3].lamports === 0), 'POST_BALANCE_GUARD');
    must(acc[2] && Number.isSafeInteger(acc[2].lamports) && BigInt(acc[2].lamports) >= BigInt(payer.lamports) - c.maxFee, 'UNEXPECTED_SOL_SPEND');
    return result.value.unitsConsumed;
  };
  let tx = make(1400000); const used = await simulate(tx);
  const units = Math.ceil(used * 1.2); must(units <= 1400000, 'COMPUTE_LIMIT'); tx = make(units);
  const fee = (await rpc.getFeeForMessage(tx.message, 'confirmed')).value;
  must(Number.isSafeInteger(fee) && fee > 0 && BigInt(fee) <= c.maxFee, 'TRANSACTION_FEE_LIMIT');
  await simulate(tx); checkFresh(started, c);
  return { tx, simulate, source, middle, life, started, fee, units,
    report: { status: 'SIMULATION_PASSED', broadcast: false, owner: c.owner, route: [c.buyDex, c.sellDex],
      amountLamports: String(c.amount), minimumReturnLamports: String(second.minimum),
      conservativeNetLamports: String(second.minimum - c.amount - c.maxFee),
      guardedEndingWsolLamports: String(minimumEnding), feeLamports: fee, computeUnits: units,
      bytes: tx.serialize().length, simulationIsNotProfitGuarantee: true } };
}
/** Require complete indexed receipts, never treat absent balances as zero profit. */
export function settledRecord(receipt, attempt, owner, sourceAddress, middleAddress) {
  const meta = receipt?.meta;
  must(meta && receipt.transaction?.signatures?.[0] === attempt.signature, 'RECEIPT_SIGNATURE');
  must(Number.isSafeInteger(meta.fee) && meta.fee >= 0, 'RECEIPT_FEE');
  must(Object.hasOwn(meta, 'err'), 'RECEIPT_OUTCOME_MISSING');
  const record = { ...attempt, status: meta.err === null ? 'finalized' : 'failed', actualFeeLamports: meta.fee };
  if (meta.err !== null) return record;
  const index = receipt.transaction.message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? { writable: [], readonly: [] },
  });
  must(Number.isSafeInteger(index.length) && index.length > 0 && index.get(0)?.toBase58() === owner, 'RECEIPT_OWNER_MISSING');
  const addresses = Array.from({ length: index.length }, (_, i) => index.get(i)?.toBase58());
  const sourceIndex = addresses.indexOf(sourceAddress), middleIndex = addresses.indexOf(middleAddress);
  must(sourceIndex > 0 && middleIndex > 0 && sourceIndex !== middleIndex, 'RECEIPT_ACCOUNTS_MISSING');
  must(Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances) &&
    meta.preBalances.length === index.length && meta.postBalances.length === index.length &&
    [meta.preBalances[0], meta.postBalances[0]].every(n => Number.isSafeInteger(n) && n >= 0), 'RECEIPT_SOL_BALANCES');
  const read = (balances, accountIndex, mint, decimals) => {
    must(Array.isArray(balances), 'RECEIPT_TOKEN_BALANCES_MISSING');
    const rows = balances.filter(b => b.accountIndex === accountIndex);
    must(rows.length === 1 && rows[0].mint === mint && rows[0].uiTokenAmount?.decimals === decimals &&
      (rows[0].owner === undefined || rows[0].owner === owner) &&
      (rows[0].programId === undefined || rows[0].programId === TOKEN), 'RECEIPT_TOKEN_BALANCE_INVALID');
    return raw(rows[0].uiTokenAmount.amount, 'RECEIPT_BALANCE', true);
  };
  const wsolDelta = read(meta.postTokenBalances, sourceIndex, WSOL, 9) - read(meta.preTokenBalances, sourceIndex, WSOL, 9);
  const usdcDelta = read(meta.postTokenBalances, middleIndex, USDC, 6) - read(meta.preTokenBalances, middleIndex, USDC, 6);
  const solDelta = BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]);
  record.realizedNetLamports = String(wsolDelta + solDelta);
  record.residualUsdcRaw = String(usdcDelta); // No price assumption for residual USDC.
  return record;
}
export async function reconcile(c, deps, journal) {
  const current = journal.get();
  must(current.owner === c.owner && current.network === MAINNET_GENESIS && Array.isArray(current.attempts), 'JOURNAL_IDENTITY');
  const source = deps.k.getAssociatedTokenAddressSync(new deps.k.PublicKey(WSOL), deps.owner).toBase58();
  const middle = deps.k.getAssociatedTokenAddressSync(new deps.k.PublicKey(USDC), deps.owner).toBase58();
  for (let i = 0; i < current.attempts.length; i++) {
    const a = journal.get().attempts[i];
    if (a.status !== 'pending') continue;
    const receipt = await deps.rpc.getTransaction(a.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!receipt?.meta) continue; // An absent finalized receipt is NOT a failed trade.
    const next = structuredClone(journal.get());
    next.attempts[i] = settledRecord(receipt, a, c.owner, source, middle);
    journal.write(next); // Incomplete receipt leaves the prior pending reservation intact.
  }
  const state = journal.get();
  return { status: state.attempts.some(a => a.status === 'pending') ? 'RECONCILIATION_REQUIRED' : 'RECONCILED',
    attempts: state.attempts, broadcast: false };
}
export async function execute(c, deps, journal, confirmOwner) {
  checkHalt(c);
  must(c.mode === 'live' && confirmOwner === c.owner && c.keyFile && c.approvalFile, 'LIVE_NOT_AUTHORIZED');
  checkApproval(JSON.parse(secureRead(c.approvalFile)), c);
  // Enforce limits before making quote requests or reading a key.
  reserveAttempt(journal.get(), c, 'precheck', 0);
  const cycle = await buildCycle(c, deps);
  checkHalt(c);
  const secret = JSON.parse(secureRead(c.keyFile));
  must(Array.isArray(secret) && secret.length === 64 && secret.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'KEYPAIR_FORMAT');
  const key = deps.k.Keypair.fromSecretKey(Uint8Array.from(secret));
  must(key.publicKey.equals(deps.owner), 'WRONG_SIGNER'); cycle.tx.sign([key]); secret.fill(0); key.secretKey.fill(0);
  await cycle.simulate(cycle.tx, true); checkFresh(cycle.started, c);
  checkApproval(JSON.parse(secureRead(c.approvalFile)), c);
  checkHalt(c);
  const signature = deps.k.bs58.encode(cycle.tx.signatures[0]);
  journal.write(reserveAttempt(journal.get(), c, signature, cycle.life.lastValidBlockHeight));
  // Durable reservation precedes any send. ONE signature, ONE RPC send, no second
  // transaction fallback, no blind retry. Unknown outcomes remain locked in journal.
  try {
    const sent = await deps.rpc.sendRawTransaction(cycle.tx.serialize(), { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' });
    must(sent === signature, 'RPC_SIGNATURE_MISMATCH');
  } catch { return { status: 'SUBMISSION_UNCERTAIN', signature, broadcast: 'unknown', action: 'reconcile; do not resend' }; }
  return { status: 'SUBMITTED_NOT_FINALIZED', signature, broadcast: true, action: 'reconcile', ...{ minProfitLamports: String(c.minProfit) } };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0] || 'status', c = config(env);
  must(['status', 'simulate', 'execute-once', 'reconcile'].includes(command), 'UNKNOWN_COMMAND');
  if (command === 'status') return readiness(c);
  if (command !== 'reconcile') must(c.mode !== 'off', 'ARBITRAGE_OFF');
  if (command === 'execute-once') must(c.mode === 'live' && argv[1] === `--confirm-owner=${c.owner}`, 'LIVE_NOT_AUTHORIZED');
  const deps = await connect(c);
  return withJournal(c, async journal => {
    if (command === 'reconcile') return reconcile(c, deps, journal);
    if (command === 'simulate') return (await buildCycle(c, deps)).report;
    return execute(c, deps, journal, argv[1]?.slice('--confirm-owner='.length));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    // Provider exceptions can contain credential-bearing RPC URLs. Never print them.
    const safe = typeof e?.message === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(e.message) ? e.message : 'OPERATION_FAILED';
    console.error(JSON.stringify({ status: 'BLOCKED', code: safe, broadcast: false })); process.exitCode = 1;
  });
}
