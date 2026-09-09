import {useState} from 'react';
import {api} from './api.js';

export function WorkareaSettings({value,onChange,area,onSelect}) {
  const [project,setProject]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const selected=value.areas.find(item=>item.id===area);
  const room=value.rooms.find(item=>item.id===project?.room_id);
  async function change(path,method,body){
    setBusy(true);setError('');
    try{await api(path,method,body);onChange(await api('/workareas'));setProject(null);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className="form-stack">
    <label className="field"><span>作業場所</span><select aria-label="作業場所" value={area} disabled={busy} onChange={e=>onSelect(e.target.value)}>
      <option value="">全員共有（従来のフォルダー）</option>
      {value.areas.map(item=><option key={item.id} value={item.id} disabled={!value.enabled||!item.available}>{item.kind==='personal'?`${value.agents.find(a=>a.id===item.owner_id)?.name||'Bot'}の個人作業`:item.name} · {value.rooms.find(r=>r.id===item.room_id)?.title}{!item.available?'（復元後・未接続）':''}</option>)}
    </select></label>
    {selected?<p className="field-hint">{selected.kind==='personal'?'所有Botと管理者が読書きできます。':'参加者と管理者が読書きできます。'} 会話をまたぐ自動共有はしません。</p>:null}
    <details><summary>作業場所の設定</summary><div className="form-stack">
      <label><input type="checkbox" checked={!!value.enabled} disabled={busy} onChange={e=>change('/workareas','PATCH',{enabled:e.target.checked})}/> 個人・案件の作業場所を有効にする</label>
      <div className="inline-actions"><button className="button secondary" disabled={busy||!value.enabled||!value.rooms.length} onClick={()=>setProject({name:'',room_id:value.rooms[0].id,members:[]})}>案件を作成</button>
      {selected?.kind==='project'?<button className="button subtle" disabled={busy} onClick={()=>setProject({id:selected.id,name:selected.name,room_id:selected.room_id,members:selected.members,expected_revision:selected.revision})}>参加者を変更</button>:null}</div>
      {project?<form className="form-stack" onSubmit={e=>{e.preventDefault();change('/workareas/projects','POST',project);}}>
        <label className="field"><span>案件名</span><input required maxLength={100} value={project.name} onChange={e=>setProject({...project,name:e.target.value})}/></label>
        <label className="field"><span>関連する会話</span><select aria-label="関連する会話" value={project.room_id} disabled={!!project.id} onChange={e=>setProject({...project,room_id:e.target.value,members:[]})}>{value.rooms.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
        <fieldset><legend>共同編集するBot</legend>{value.agents.filter(a=>room?.visibility==='shared'||room?.participants.includes(a.id)).map(a=><label key={a.id} style={{display:'block'}}><input type="checkbox" checked={project.members.includes(a.id)} onChange={e=>setProject({...project,members:e.target.checked?[...project.members,a.id]:project.members.filter(id=>id!==a.id)})}/>{a.name}</label>)}</fieldset>
        <div className="inline-actions"><button className="button primary" disabled={busy||!project.members.length}>設定を保存</button><button type="button" className="button subtle" onClick={()=>setProject(null)}>取消</button></div>
      </form>:null}
      <p className="field-hint">個人領域はBotが仕事中に選ぶと作成されます。管理者はすべて閲覧できます。案件から外したBotは以後の取得と変更ができません。</p>
    </div></details>{error?<p role="alert" className="field-error">{error}</p>:null}
  </div>;
}
