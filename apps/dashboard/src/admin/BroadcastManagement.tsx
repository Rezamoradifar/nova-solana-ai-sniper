import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Page<T>={total:number;rows:T[]};
type Row={id:string;text:string;status:string;totalRecipients:number|null;sentCount:number;failedPermanentCount:number;failedTempCount:number;createdAt:string;completedAt:string|null};
const errorText=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'Request failed';

export function BroadcastManagement(){
  const [refresh,setRefresh]=useState(0);
  const q=usePolling(()=>api.get<Page<Row>>('/admin/broadcasts?limit=50'),10000,refresh);
  const [text,setText]=useState('');
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);

  async function send(e:FormEvent){
    e.preventDefault();
    if(!window.confirm('Queue this message for all active Telegram users?'))return;
    setBusy(true);setError(null);
    try{
      const result=await api.post<{recipientCount:number}>('/admin/broadcasts',{text});
      window.alert('Broadcast queued for '+result.recipientCount+' recipients.');
      setText('');setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}
    finally{setBusy(false);}
  }

  return <div className="space-y-4">
    <section className="card"><h2 className="font-semibold text-white">Telegram Broadcast</h2><p className="mt-1 text-xs text-slate-500">Only active, non-suspended, non-deleted users are queued.</p><form onSubmit={send} className="mt-4"><textarea required maxLength={4000} rows={6} className="input-field resize-y" value={text} onChange={e=>setText(e.target.value)} placeholder="Write announcement…"/><div className="mt-2 flex items-center justify-between"><span className="text-xs text-slate-500">{text.length}/4000</span><button disabled={busy||!text.trim()} className="btn-primary">{busy?'Queueing…':'Queue broadcast'}</button></div>{error&&<div className="mt-2 text-sm text-loss">{error}</div>}</form></section>
    <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Broadcast History · {q.data?.total??0}</h2><table className="table-base min-w-[850px]"><thead><tr><th>Message</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Created</th></tr></thead><tbody>{(q.data?.rows??[]).map(row=><tr key={row.id}><td className="max-w-sm truncate">{row.text}</td><td>{row.status}</td><td>{row.totalRecipients??0}</td><td className="text-profit">{row.sentCount}</td><td className={row.failedPermanentCount+row.failedTempCount>0?'text-loss':''}>{row.failedPermanentCount+row.failedTempCount}</td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}</tbody></table></section>
  </div>;
}
