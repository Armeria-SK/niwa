import {SettingDisclosure} from './SettingDisclosure.jsx';
import {Switch} from './components.jsx';
import {useState} from 'react';
import {api} from './api.js';
import {t} from './i18n.js';

export function WorkareaSettings({value,onChange,area,onSelect}) {
  const [project,setProject]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const selected=value.areas.find(item=>item.id===area);
  const room=value.rooms.find(item=>item.id===project?.room_id);
  async function change(path,method,body){
    if(busy)return;setBusy(true);setError('');
    try{await api(path,method,body);onChange(await api('/workareas'));setProject(null);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className="form-stack">
    <label className="field"><span>{t('artifacts.workarea')}</span><select aria-label={t('artifacts.workarea')} value={area} disabled={busy} onChange={e=>onSelect(e.target.value)}>
      <option value="">{t('artifacts.everyoneSharedLegacy')}</option>
      {value.areas.map(item=><option key={item.id} value={item.id} disabled={!value.enabled||!item.available}>{item.kind==='personal'?t('artifacts.personalArea', { name: value.agents.find(a=>a.id===item.owner_id)?.name||t('artifacts.botFallback') }):item.name} · {value.rooms.find(r=>r.id===item.room_id)?.title}{!item.available?t('artifacts.restoredDisconnected'):''}</option>)}
    </select></label>
    {selected?<p className="field-hint">{selected.kind==='personal'?t('artifacts.accessPersonal'):t('artifacts.accessProject')}</p>:null}
    <SettingDisclosure title={t('artifacts.workareaSettings')} value={busy?t('artifacts.savingShort'):value.enabled?t('artifacts.enabled'):t('artifacts.disabled')} busy={busy}>
      <Switch label={t('artifacts.personalProjectAreas')} checked={!!value.enabled} disabled={busy} onChange={enabled=>change('/workareas','PATCH',{enabled})}/>
      <div className="inline-actions"><button className="button secondary" disabled={busy||!value.enabled||!value.rooms.length} onClick={()=>setProject({name:'',room_id:value.rooms[0].id,members:[]})}>{t('artifacts.createProject')}</button>
      {selected?.kind==='project'?<button className="button subtle" disabled={busy} onClick={()=>setProject({id:selected.id,name:selected.name,room_id:selected.room_id,members:selected.members,expected_revision:selected.revision})}>{t('artifacts.changeMembers')}</button>:null}</div>
      {project?<form className="form-stack" onSubmit={e=>{e.preventDefault();change('/workareas/projects','POST',project);}}>
        <label className="field"><span>{t('artifacts.projectName')}</span><input disabled={busy} required maxLength={100} value={project.name} onChange={e=>setProject({...project,name:e.target.value})}/></label>
        <label className="field"><span>{t('artifacts.relatedConversation')}</span><select aria-label={t('artifacts.relatedConversation')} value={project.room_id} disabled={busy||!!project.id} onChange={e=>setProject({...project,room_id:e.target.value,members:[]})}>{value.rooms.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
        <fieldset><legend>{t('artifacts.coEditors')}</legend>{value.agents.filter(a=>room?.visibility==='shared'||room?.participants.includes(a.id)).map(a=><label key={a.id} style={{display:'block'}}><input type="checkbox" disabled={busy} checked={project.members.includes(a.id)} onChange={e=>setProject({...project,members:e.target.checked?[...project.members,a.id]:project.members.filter(id=>id!==a.id)})}/>{a.name}</label>)}</fieldset>
        <div className="inline-actions"><button className="button primary" disabled={busy||!project.members.length}>{t('artifacts.saveSettings')}</button><button type="button" className="button subtle" disabled={busy} onClick={()=>setProject(null)}>{t('artifacts.cancelProject')}</button></div>
      </form>:null}
      <p className="field-hint">{t('artifacts.personalAreaCreated')}<br />{t('artifacts.adminCanView')}<br />{t('artifacts.removedBotNote')}</p>
    </SettingDisclosure>{error?<p role="alert" className="field-error">{error}</p>:null}
  </div>;
}
