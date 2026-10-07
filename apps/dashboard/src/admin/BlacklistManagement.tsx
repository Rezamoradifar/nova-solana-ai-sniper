import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';

type Entry={id:string;type:'MINT'|'DEPLOYER';value:string;reason:string|null;createdAt:string};
const errorText=(e:unknown)=>e instanceof ApiError?e.message:e instanceof Error?e.message:'Request failed';

export function BlacklistManagement(){
  const [refresh,setRefresh]=useState(0);
  const q=usePolling(()=>api.get<Entry[]>('/admin/blacklist'),15000,refresh);
  const [type,setType]=useState<'MINT'|'DEPLOYER'>('MINT');
  const [value,setValue]=useState('');
  const [reason,setReason]=useState('');
  const [error,setError]=useState<string|null>(null);

  async function add(e:FormEvent){
    e.preventDefault();setError(null);
    try{
      await api.post('/admin/blacklist',{type,value,reason:reason||undefined});
      setValue('');setReason('');setRefresh(v=>v+1);
    }catch(e){setError(errorText(e));}
  }
  async function remove(id:string){
    if(!window.confirm('Remove this blacklist entry?'))return;
    try{await api.del('/admin/blacklist/'+id);setRefresh(v=>v+1);}
    catch(e){window.alert(errorText(e));}
  }

  return <div className="space-y-4">
    <section className="card"><h2 className="font-semibold text-white">Add to Blacklist</h2><form onSubmit={add} className="mt-4 grid gap-3 md:grid-cols-3"><div><label className="label">Type</label><select className="input-field" value={type} onChange={e=>setType(e.target.value as 'MINT'|'DEPLOYER')}><option value="MINT">Mint</option><option value="DEPLOYER">Deployer</option></select></div><div><label className="label">Address</label><input required className="input-field font-mono" value={value} onChange={e=>setValue(e.target.value)}/></div><div><label className="label">Reason</label><input className="input-field" value={reason} onChange={e=>setReason(e.target.value)}/></div>{error&&<div className="md:col-span-3 text-sm text-loss">{error}</div>}<div className="md:col-span-3"><button className="btn-primary">Block</button></div></form></section>
    <section className="card overflow-x-auto"><h2 className="mb-4 text-lg font-semibold text-white">Blacklist</h2><table className="table-base min-w-[800px]"><thead><tr><th>Type</th><th>Address</th><th>Reason</th><th>Created</th><th /></tr></thead><tbody>{(q.data??[]).map(row=><tr key={row.id}><td>{row.type}</td><td className="font-mono text-xs">{row.value}</td><td>{row.reason??'—'}</td><td>{new Date(row.createdAt).toLocaleString()}</td><td><button className="text-xs text-loss" onClick={()=>void remove(row.id)}>Remove</button></td></tr>)}</tbody></table></section>
  </div>;
}
