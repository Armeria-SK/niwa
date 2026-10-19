import {useEffect,useState} from 'react';
import {api} from './api.js';
import {t} from './i18n.js';
const STATES={queued:'envQueued',running:'envRunning',completed:'envCompleted',failed:'envFailed',cancelled:'envCancelled',outcome_unknown:'envOutcomeUnknown',ready:'envReady',retired:'envRetired',preparing:'envPreparing'};
const stateLabel=state=>Object.hasOwn(STATES,state)?t(`artifacts.${STATES[state]}`):state;
export function EnvironmentSettings({area}){
 const [value,setValue]=useState(null),[runs,setRuns]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState(null),[log,setLog]=useState(null);
 const base=`/workareas/${area}`;
 async function refresh(){const [v,r]=await Promise.all([api(`${base}/environments`),api(`${base}/executions`)]);setValue(v);setRuns(r.executions||[]);setPreview(p=>p&&r.executions?.some(e=>e.id===p.id&&e.state==='running')?p:null);}
 useEffect(()=>{let active=true;let pending=false;setValue(null);setPreview(null);setLog(null);setError('');
  const load=async()=>{if(pending)return;pending=true;try{const [v,r]=await Promise.all([api(`${base}/environments`),api(`${base}/executions`)]);if(active){setValue(v);setRuns(r.executions||[]);setPreview(p=>p&&r.executions?.some(e=>e.id===p.id&&e.state==='running')?p:null);}}catch(e){if(active)setError(e.message);}finally{pending=false;}};
  load();const timer=setInterval(load,3000);return()=>{active=false;clearInterval(timer);};
 },[base]);
 async function action(path,body={}){setBusy(true);setError('');try{const result=await api(path,'POST',body);if(result.error)throw Error(result.error);await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function view(run,mobile=false){setBusy(true);setError('');try{const image=await api(`${base}/executions/${run.id}/preview?mobile=${mobile}`);if(!image.data)throw Error(t('artifacts.previewFailed'));setPreview({...image,id:run.id});}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function upload(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;try{if(file.size>60000)throw Error(t('artifacts.definitionTooLarge'));const definition=JSON.parse(await file.text());await action(`${base}/environments`,{definition});}catch(e){setError(e.message);}}
 function example(){const definition={name:t('artifacts.exampleEnvironmentName'),base_image:value.base_image,catalog_revision:value.catalog_revision,dependencies:[],lockfiles:[],workdir:'/workspace',prepare:[],run:['python','-c','print("Hello")'],verify:['python','-c','print("OK")'],profile:'standard'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(definition,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='environment.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(value?.error==='environments_disabled')return <p className="field-hint">{t('artifacts.environmentsDisabled')}</p>;
 return <details><summary>{t('artifacts.environmentsSummary')}</summary><div className="form-stack">
  {error?<p role="alert" className="field-error">{error}</p>:null}
  {value?.versions?<><p className="field-hint">{t('artifacts.activeEnvironment', { name: value.versions.find(v=>v.id===value.active)?.definition.name||t('artifacts.notSelected') })}</p>
   <div className="inline-actions"><button className="button subtle" disabled={busy} onClick={example}>{t('artifacts.definitionTemplate')}</button><label className="field"><span>{t('artifacts.loadDefinition')}</span><input type="file" accept="application/json,.json" disabled={busy} onChange={upload}/></label></div>
   {value.versions.map(v=><details key={v.id}><summary>{v.definition.name||t('artifacts.deletedDefinition')} · {stateLabel(v.state)}{v.id===value.active?` · ${t('artifacts.inUse')}`:''}</summary>
    <p className="field-hint">{t('artifacts.resources', { memory: v.resources?.memory_mib ?? '', cpu: v.resources?.cpu ?? '', seconds: v.resources?.seconds ?? '' })}</p>
    <pre className="artifact-document">{[...(v.definition.prepare||[]),v.definition.run,v.definition.verify].filter(Boolean).map(c=>c.join(' ')).join('\n')}</pre>
    <div className="inline-actions"><button className="button subtle" disabled={busy||v.state!=='ready'} onClick={()=>action(`${base}/environments/${v.id}/test`,{seconds:300,operation_id:crypto.randomUUID()})}>{t('artifacts.testEnvironment')}</button><button className="button secondary" disabled={busy||!v.tested_revision||v.state!=='ready'||v.id===value.active} onClick={()=>action(`${base}/environments/${v.id}/activate`,{expected_environment:value.active,operation_id:crypto.randomUUID()})}>{t('artifacts.activateEnvironment')}</button><button className="button subtle" disabled={busy||v.id===value.active||v.state==='retired'} onClick={()=>action(`${base}/environments/${v.id}/retire`)}>{t('artifacts.retireEnvironment')}</button></div>
   </details>)}
   <button className="button subtle" disabled={busy} onClick={()=>action(`${base}/environments/collect`)}>{t('artifacts.collectImages')}</button>
  </>:null}
  {runs.map(run=><div key={run.id}><p>{value?.versions?.find(v=>v.id===run.environment)?.definition.name||t('artifacts.isolatedRun')} · {stateLabel(run.state)}</p><div className="inline-actions">
    <button className="button subtle" onClick={async()=>{try{const r=await api(`${base}/executions/${run.id}`);setLog(r.logs||r.result||{});}catch(e){setError(e.message);}}}>{t('artifacts.log')}</button>
    {['queued','running'].includes(run.state)?<button className="button secondary" disabled={busy} onClick={()=>action(`${base}/executions/${run.id}/stop`)}>{t('artifacts.stopRun')}</button>:null}
    {run.preview&&run.state==='running'?<><button className="button subtle" disabled={busy} onClick={()=>view(run)}>{t('artifacts.viewScreen')}</button><button className="button subtle" disabled={busy} onClick={()=>view(run,true)}>{t('artifacts.mobileView')}</button></>:null}
  </div></div>)}
  {log?<pre className="artifact-document">{[log.stdout,log.stderr,log.error].filter(Boolean).join('\n')||t('artifacts.noOutput')}</pre>:null}
  {preview?<><p className="field-hint">{t('artifacts.previewNoteIsolated')}<br />{t('artifacts.previewNoteNotPublic')}<br />{t('artifacts.previewNoteRefresh')}</p><img alt={t('artifacts.previewAlt')} src={`data:image/jpeg;base64,${preview.data}`} style={{maxWidth:'100%',height:'auto'}}/></>:null}
 </div></details>;
}
