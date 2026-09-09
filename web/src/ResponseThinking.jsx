import {useEffect,useState} from 'react';
import {Avatar} from './components.jsx';
import {api} from './api.js';

export function useResponseProgress(room) {
 const [items,setItems]=useState([]);
 useEffect(()=>{let active=true;let timer;setItems([]);
  async function poll(){try{const result=await api(`/rooms/${room}/response-progress`);if(active)setItems(result);}catch{if(active)setItems([]);}finally{if(active)timer=setTimeout(poll,2000);}}
  poll();return()=>{active=false;clearTimeout(timer);};
 },[room]);return items;
}
export function ResponseThinking({item,member}) {
 const [open,setOpen]=useState(!item.finished_at);
 useEffect(()=>{if(item.finished_at)setOpen(false);},[item.finished_at]);
 const running=!item.finished_at&&item.state==='running'&&item.kind!=='paused';
 const elapsed=Math.max(0,Math.floor(((running?Date.now():item.finished_at??item.last_activity_at??item.started_at)-item.started_at)/1000));
 // Fast answers without a provided summary do not leave an empty disclosure.
 if(item.finished_at&&!item.summary&&elapsed<2)return null;
 return <div className="response-thinking" data-response={item.id}>
  <Avatar member={member} size={32}/><div className="response-thinking-body"><span className="response-thinking-name">{member?.name||'Bot'}</span>
  <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{item.label}{elapsed>0?` · ${elapsed}秒`:''}</summary>
   {item.summary?<><span className="muted">思考の要約（提供元・未確定）</span><p>{item.summary}</p></>:null}
   {item.retry_at?<p>再確認予定：{new Date(item.retry_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</p>:null}
   {!!item.waiting_for?.length?<p>待っている相手：{item.waiting_for.join('・')}</p>:null}
   {!item.summary&&!item.retry_at&&!item.waiting_for?.length?<p>{item.finished_at?'提供元の要約はありません。':item.label}</p>:null}
  </details></div>
 </div>;
}
