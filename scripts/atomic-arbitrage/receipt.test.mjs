import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledRecord, reconcile, WSOL, USDC, TOKEN, MAINNET_GENESIS } from './engine.mjs';
const owner = 'owner', source = 'source', middle = 'middle';
const attempt = { signature: 'test-signature', status: 'pending', reservedFee: '100000' };
const balances = (wsol, usdc, includeOwner = true) => [
  { accountIndex: 1, mint: WSOL, ...(includeOwner ? { owner } : {}), programId: TOKEN, uiTokenAmount: { amount: wsol, decimals: 9 } },
  { accountIndex: 2, mint: USDC, ...(includeOwner ? { owner } : {}), programId: TOKEN, uiTokenAmount: { amount: usdc, decimals: 6 } },
];
function receipt() {
  return { transaction: { signatures: ['test-signature'], message: { getAccountKeys: () => ({ length: 3, get: i => ({ toBase58: () => [owner, source, middle][i] }) }) } },
    meta: { err: null, fee: 5000, preBalances: [100000000, 20000000, 2039280], postBalances: [99995000, 21000000, 2039280],
      preTokenBalances: balances('20000000', '0'), postTokenBalances: balances('21000000', '17') } };
}
const read = r => settledRecord(r, attempt, owner, source, middle);
test('receipt computes actual WSOL and SOL delta; residual USDC has no invented price', () => {
  const result = read(receipt()); assert.equal(result.realizedNetLamports, '995000'); assert.equal(result.residualUsdcRaw, '17');
  assert.equal(result.actualFeeLamports, 5000); assert.equal(result.status, 'finalized'); assert.equal(attempt.status, 'pending');
});
test('missing optional owner metadata is resolved by the exact ATA account index', () => {
  const r = receipt(); r.meta.preTokenBalances = balances('20000000', '0', false);
  assert.equal(read(r).realizedNetLamports, '995000');
});
test('explicit failed receipt records fees but no profit', () => {
  const r = receipt(); r.meta.err = { InstructionError: [3, 'Custom'] }; delete r.meta.preTokenBalances;
  const result = read(r); assert.equal(result.status, 'failed'); assert.equal(result.actualFeeLamports, 5000);
  assert.equal(result.realizedNetLamports, undefined);
});
for (const key of ['preTokenBalances', 'postTokenBalances', 'preBalances', 'postBalances', 'err']) {
  test('incomplete receipt rejects missing ' + key, () => { const r = receipt(); delete r.meta[key]; assert.throws(() => read(r)); });
}
test('unrelated owned-token account is not counted as arbitrage proceeds', () => {
  const r = receipt(); r.meta.postTokenBalances.push({ ...r.meta.postTokenBalances[0], accountIndex: 42, uiTokenAmount: { amount: '9999999999', decimals: 9 } });
  assert.equal(read(r).realizedNetLamports, '995000');
});
test('duplicate balance rows rejected', () => { const r=receipt();r.meta.postTokenBalances.push(r.meta.postTokenBalances[0]);assert.throws(()=>read(r),/RECEIPT_TOKEN_BALANCE_INVALID/); });
test('missing pre-ATA row cannot become apparent profit', () => { const r=receipt();r.meta.preTokenBalances=[];assert.throws(()=>read(r),/RECEIPT_TOKEN_BALANCE_INVALID/); });
test('wrong reported owner rejected', () => { const r=receipt();r.meta.postTokenBalances[0].owner='attacker';assert.throws(()=>read(r)); });
test('receipt signature must match reserved signature', () => { const r=receipt();r.transaction.signatures[0]='other';assert.throws(()=>read(r),/RECEIPT_SIGNATURE/); });
test('unsafe number rounding rejected', () => { const r=receipt();r.meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>read(r),/RECEIPT_SOL_BALANCES/); });
test('failed schema cannot be mistaken for a finalized success', () => { const r=receipt();r.meta.fee=NaN;assert.throws(()=>read(r),/RECEIPT_FEE/); });
test('negative net is retained rather than clipped to profit', () => { const r=receipt();r.meta.postTokenBalances=balances('19999000','0');assert.equal(read(r).realizedNetLamports,'-6000'); });
const deps = r => ({ owner, k: { PublicKey: class { constructor(value) { this.value=value; } },
  getAssociatedTokenAddressSync: mint => ({toBase58:()=>mint.value===WSOL?source:middle}) }, rpc: { getTransaction: async () => r } });
function journal() { let state={owner,network:MAINNET_GENESIS,attempts:[{...attempt}]};return {get:()=>state,write:s=>{state=s;}}; }
test('missing finalized RPC receipt remains pending without retry', async () => { const j=journal();const result=await reconcile({owner},deps(null),j);assert.equal(result.status,'RECONCILIATION_REQUIRED');assert.equal(j.get().attempts[0].status,'pending'); });
test('incomplete RPC receipt cannot clear pending state in memory or disk', async () => { const r=receipt();delete r.meta.preTokenBalances;const j=journal();await assert.rejects(reconcile({owner},deps(r),j));assert.equal(j.get().attempts[0].status,'pending'); });
test('finalized complete receipt is journaled once', async () => { const j=journal();const d=deps(receipt());await reconcile({owner},d,j);d.rpc.getTransaction=async()=>{throw new Error('No second lookup required');};assert.equal((await reconcile({owner},d,j)).status,'RECONCILED');assert.equal(j.get().attempts[0].realizedNetLamports,'995000'); });
