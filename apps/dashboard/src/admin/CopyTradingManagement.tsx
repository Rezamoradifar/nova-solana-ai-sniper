import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Page<T>={total:number;rows:T[]};
type Row={id:string;userId:string;targetAddress:string;isActive:boolean;copyPercentSize:number;maxAmountSol:number|null;createdAt:string;user:{email:string|null;telegramId:string|null}};
const short=(v:string)=>v.length>16?v.slice(0,8)+'…'+v.slice(-5):v;
const errorText=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'Request failed';

export function CopyTradingManagement(){
  const [refresh,setRefresh]=useState(0);
  const q=usePolling(()=>api.get<Page<Row>>('/admin/copy-trades?limit=100'),15_000,refresh);
  const [form,setForm]=useState({userId:'',targetAddress:'',copyPercentSize:'100',maxAmountSol:''});
  const [error,setError]=useState<string|null>(null);

  async function create(e:FormEvent){
    e.preventDefault(); setError(null);
    try{
      await api.post('/admin/users/'+form.userId+'/copy-trades',{
        targetAddress:form.targetAddress,
        copyPercentSize:Number(form.copyPercentSize),
        maxAmountSol:form.maxAmountSol===''?null:Number(form.maxAmountSol),
      });
      setForm({userId:'',targetAddress:'',copyPercentSize:'100',maxAmountSol:''});
      setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}
  }

  async function toggle(row:Row){
    try{await api.put('/admin/copy-trades/'+row.id+'/status',{enabled:!row.isActive});setRefresh(v=>v+1);}
    catch(e){window.alert(errorText(e));}
  }
  async function remove(row:Row){
    if(!window.confirm('Delete this copy-trade configuration?'))return;
    try{await api.del('/admin/copy-trades/'+row.id);setRefresh(v=>v+1);}
    catch(e){window.alert(errorText(e));}
  }

  return <div className="space-y-4">
    <section className="card"><h2 className="font-semibold text-white">Create Copy Trade Config</h2><form onSubmit={create} className="mt-4 grid gap-3 md:grid-cols-4"><div><label className="label">User ID</label><input required className="input-field" value={form.userId} onChange={e=>setForm({...form,userId:e.target.value})}/></div><div><label className="label">Target Solana wallet</label><input required className="input-field font-mono" value={form.targetAddress} onChange={e=>setForm({...form,targetAddress:e.target.value})}/></div><div><label className="label">Copy size %</label><input className="input-field" type="number" min="1" max="100" value={form.copyPercentSize} onChange={e=>setForm({...form,copyPercentSize:e.target.value})}/></div><div><label className="label">Max SOL</label><input className="input-field" type="number" min="0" step="0.01" placeholder="No cap" value={form.maxAmountSol} onChange={e=>setForm({...form,maxAmountSol:e.target.value})}/></div>{error&&<div className="md:col-span-4 text-sm text-loss">{error}</div>}<div className="md:col-span-4"><button className="btn-primary">Create config</button></div></form></section>
    <section className="card overflow-x-auto"><div className="mb-4"><h2 className="text-lg font-semibold text-white">Copy Trading · {q.data?.total??0}</h2><p className="text-xs text-slate-500">Configuration management only; live mirror execution depends on the verified signal worker.</p></div><table className="table-base min-w-[900px]"><thead><tr><th>User</th><th>Target</th><th>Size</th><th>Max</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{(q.data?.rows??[]).map(row=><tr key={row.id}><td>{row.user.email??row.user.telegramId??short(row.userId)}</td><td><a target="_blank" rel="noreferrer" className="text-violet-300" href={'https://solscan.io/account/'+row.targetAddress}>{short(row.targetAddress)}</a></td><td>{row.copyPercentSize}%</td><td>{row.maxAmountSol==null?'—':row.maxAmountSol+' SOL'}</td><td className={row.isActive?'text-profit':'text-slate-500'}>{row.isActive?'Active':'Paused'}</td><td>{new Date(row.createdAt).toLocaleDateString()}</td><td className="space-x-2"><button className="text-xs text-violet-300" onClick={()=>void toggle(row)}>{row.isActive?'Pause':'Resume'}</button><button className="text-xs text-loss" onClick={()=>void remove(row)}>Delete</button></td></tr>)}</tbody></table></section>
  </div>;
}
