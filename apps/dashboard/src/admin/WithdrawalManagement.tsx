import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Page<T>={total:number;rows:T[]};
type Withdrawal={id:string;userId:string;walletId:string;amountUsd:number;destinationAddress:string;status:string;riskScore:number;fraudFlags:unknown;rejectionReason:string|null;requestedAt:string;txSignature:string|null};
type Payout={id:string;positionId:string;status:string;totalLamports:string;estimatedFeeLamports:string;txSignature:string|null;failureReason:string|null;createdAt:string};
type Settings={id:string;minWithdrawalUsd:number;maxWithdrawalUsd:number;dailyWithdrawalLimitUsd:number};
const errorText=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'Request failed';
const short=(v:string)=>v.length>16?v.slice(0,8)+'…'+v.slice(-5):v;

export function WithdrawalManagement(){
  const [refresh,setRefresh]=useState(0);
  const w=usePolling(()=>api.get<Page<Withdrawal>>('/admin/withdrawals?limit=100'),10000,refresh);
  const p=usePolling(()=>api.get<Page<Payout>>('/admin/payouts?limit=100'),15000,refresh);
  const s=usePolling(()=>api.get<Settings>('/admin/withdrawal-settings'),30000,refresh);
  const [draft,setDraft]=useState({min:'',max:'',daily:''});

  useEffect(()=>{if(s.data&&draft.min==='')setDraft({min:String(s.data.minWithdrawalUsd),max:String(s.data.maxWithdrawalUsd),daily:String(s.data.dailyWithdrawalLimitUsd)});},[s.data,draft.min]);

  async function action(id:string,kind:'review'|'approve'|'reject'){
    try{
      if(kind==='reject'){
        const reason=window.prompt('Rejection reason:');
        if(!reason)return;
        await api.post('/admin/withdrawals/'+id+'/reject',{reason});
      }else{
        if(kind==='approve'&&!window.confirm('Approve this request? Approval itself does NOT broadcast a Solana transfer.'))return;
        await api.post('/admin/withdrawals/'+id+'/'+kind);
      }
      setRefresh(v=>v+1);
    }catch(e){window.alert(errorText(e));}
  }

  async function saveSettings(){
    try{
      await api.put('/admin/withdrawal-settings',{minWithdrawalUsd:Number(draft.min),maxWithdrawalUsd:Number(draft.max),dailyWithdrawalLimitUsd:Number(draft.daily)});
      setRefresh(v=>v+1);
    }catch(e){window.alert(errorText(e));}
  }

  return <div className="space-y-5">
    <section className="card"><h2 className="font-semibold text-white">Withdrawal Limits</h2><div className="mt-4 grid gap-3 md:grid-cols-4"><div><label className="label">Min USD</label><input className="input-field" type="number" value={draft.min} onChange={e=>setDraft({...draft,min:e.target.value})}/></div><div><label className="label">Max USD</label><input className="input-field" type="number" value={draft.max} onChange={e=>setDraft({...draft,max:e.target.value})}/></div><div><label className="label">Daily USD</label><input className="input-field" type="number" value={draft.daily} onChange={e=>setDraft({...draft,daily:e.target.value})}/></div><div className="flex items-end"><button className="btn-primary" onClick={()=>void saveSettings()}>Save limits</button></div></div></section>
    <section className="card overflow-x-auto"><div className="mb-4"><h2 className="text-lg font-semibold text-white">Withdrawal Queue · {w.data?.total??0}</h2><p className="text-xs text-slate-500">Reject refunds the reserved USD balance atomically. Approve does not broadcast a Solana transfer.</p></div><table className="table-base min-w-[1000px]"><thead><tr><th>Status</th><th>User</th><th>Amount</th><th>Destination</th><th>Risk</th><th>Requested</th><th>Actions</th></tr></thead><tbody>{(w.data?.rows??[]).map(row=><tr key={row.id}><td>{row.status}</td><td>{short(row.userId)}</td><td>{'$'}{row.amountUsd.toFixed(2)}</td><td><a className="text-violet-300" target="_blank" rel="noreferrer" href={'https://solscan.io/account/'+row.destinationAddress}>{short(row.destinationAddress)}</a></td><td>{row.riskScore.toFixed(0)}</td><td>{new Date(row.requestedAt).toLocaleString()}</td><td className="space-x-2">{row.status==='PENDING'&&<button className="text-xs text-violet-300" onClick={()=>void action(row.id,'review')}>Review</button>}{['PENDING','UNDER_REVIEW'].includes(row.status)&&<button className="text-xs text-profit" onClick={()=>void action(row.id,'approve')}>Approve</button>}{['PENDING','UNDER_REVIEW','APPROVED'].includes(row.status)&&<button className="text-xs text-loss" onClick={()=>void action(row.id,'reject')}>Reject</button>}</td></tr>)}</tbody></table></section>
    <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">On-chain Payout Attempts · {p.data?.total??0}</h2><table className="table-base min-w-[850px]"><thead><tr><th>Status</th><th>Position</th><th>Total</th><th>Fee</th><th>TX / Error</th><th>Created</th></tr></thead><tbody>{(p.data?.rows??[]).map(row=><tr key={row.id}><td>{row.status}</td><td>{short(row.positionId)}</td><td>{(Number(row.totalLamports)/1e9).toFixed(6)} SOL</td><td>{(Number(row.estimatedFeeLamports)/1e9).toFixed(6)} SOL</td><td>{row.txSignature?<a target="_blank" rel="noreferrer" className="text-violet-300" href={'https://solscan.io/tx/'+row.txSignature}>{short(row.txSignature)}</a>:row.failureReason??'—'}</td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}</tbody></table></section>
  </div>;
}
