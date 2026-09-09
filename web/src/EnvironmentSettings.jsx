import {useEffect,useState} from 'react';
import {api} from './api.js';
const labels={queued:'資源待ち',running:'実行中',completed:'終了',failed:'失敗',cancelled:'停止済み',outcome_unknown:'結果の確認が必要',ready:'準備済み',retired:'利用終了',preparing:'準備中'};
export function EnvironmentSettings({area}){
 const [value,setValue]=useState(null),[runs,setRuns]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState(null),[log,setLog]=useState(null);
 const base=`/workareas/${area}`;
 async function refresh(){const [v,r]=await Promise.all([api(`${base}/environments`),api(`${base}/executions`)]);setValue(v);setRuns(r.executions||[]);setPreview(p=>p&&r.executions?.some(e=>e.id===p.id&&e.state==='running')?p:null);}
 useEffect(()=>{let active=true;let pending=false;setValue(null);setPreview(null);setLog(null);setError('');
  const load=async()=>{if(pending)return;pending=true;try{const [v,r]=await Promise.all([api(`${base}/environments`),api(`${base}/executions`)]);if(active){setValue(v);setRuns(r.executions||[]);setPreview(p=>p&&r.executions?.some(e=>e.id===p.id&&e.state==='running')?p:null);}}catch(e){if(active)setError(e.message);}finally{pending=false;}};
  load();const timer=setInterval(load,3000);return()=>{active=false;clearInterval(timer);};
 },[base]);
 async function action(path,body={}){setBusy(true);setError('');try{const result=await api(path,'POST',body);if(result.error)throw Error(result.error);await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function view(run,mobile=false){setBusy(true);setError('');try{const image=await api(`${base}/executions/${run.id}/preview?mobile=${mobile}`);if(!image.data)throw Error('プレビューを取得できませんでした。');setPreview({...image,id:run.id});}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function upload(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;try{if(file.size>60000)throw Error('環境定義は60KB以内です。');const definition=JSON.parse(await file.text());await action(`${base}/environments`,{definition});}catch(e){setError(e.message);}}
 function example(){const definition={name:'作業環境',base_image:value.base_image,catalog_revision:value.catalog_revision,dependencies:[],lockfiles:[],workdir:'/workspace',prepare:[],run:['python','-c','print("Hello")'],verify:['python','-c','print("OK")'],profile:'standard'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(definition,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='environment.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(value?.error==='environments_disabled')return <p className="field-hint">案件の固定環境は未接続です。</p>;
 return <details><summary>実行環境と実行状況</summary><div className="form-stack">
  {error?<p role="alert" className="field-error">{error}</p>:null}
  {value?.versions?<><p className="field-hint">採用中：{value.versions.find(v=>v.id===value.active)?.definition.name||'未選択'}。作業ファイルと環境の保持・削除は別です。</p>
   <div className="inline-actions"><button className="button subtle" disabled={busy} onClick={example}>定義のひな形</button><label className="field"><span>環境定義を読み込む（JSON）</span><input type="file" accept="application/json,.json" disabled={busy} onChange={upload}/></label></div>
   {value.versions.map(v=><details key={v.id}><summary>{v.definition.name||'削除済みの定義'} · {labels[v.state]||v.state}{v.id===value.active?' · 採用中':''}</summary>
    <p className="field-hint">{v.resources?.memory_mib}MiB / CPU {v.resources?.cpu} / 最大{v.resources?.seconds}秒</p>
    <pre className="artifact-document">{[...(v.definition.prepare||[]),v.definition.run,v.definition.verify].filter(Boolean).map(c=>c.join(' ')).join('\n')}</pre>
    <div className="inline-actions"><button className="button subtle" disabled={busy||v.state!=='ready'} onClick={()=>action(`${base}/environments/${v.id}/test`,{seconds:300,operation_id:crypto.randomUUID()})}>検証</button><button className="button secondary" disabled={busy||!v.tested_revision||v.state!=='ready'||v.id===value.active} onClick={()=>action(`${base}/environments/${v.id}/activate`,{expected_environment:value.active,operation_id:crypto.randomUUID()})}>採用</button><button className="button subtle" disabled={busy||v.id===value.active||v.state==='retired'} onClick={()=>action(`${base}/environments/${v.id}/retire`)}>利用を終了</button></div>
   </details>)}
   <button className="button subtle" disabled={busy} onClick={()=>action(`${base}/environments/collect`)}>利用終了から24時間経過した未参照imageを回収</button>
  </>:null}
  {runs.map(run=><div key={run.id}><p>{value?.versions?.find(v=>v.id===run.environment)?.definition.name||'隔離実行'} · {labels[run.state]||run.state}</p><div className="inline-actions">
    <button className="button subtle" onClick={async()=>{try{const r=await api(`${base}/executions/${run.id}`);setLog(r.logs||r.result||{});}catch(e){setError(e.message);}}}>ログ</button>
    {['queued','running'].includes(run.state)?<button className="button secondary" disabled={busy} onClick={()=>action(`${base}/executions/${run.id}/stop`)}>停止</button>:null}
    {run.preview&&run.state==='running'?<><button className="button subtle" disabled={busy} onClick={()=>view(run)}>画面を確認</button><button className="button subtle" disabled={busy} onClick={()=>view(run,true)}>モバイル表示</button></>:null}
  </div></div>)}
  {log?<pre className="artifact-document">{[log.stdout,log.stderr,log.error].filter(Boolean).join('\n')||'まだ出力はありません。'}</pre>:null}
  {preview?<><p className="field-hint">隔離ブラウザーの画面です。外部公開していません。操作後の確認は再取得してください。</p><img alt="制作中の画面プレビュー" src={`data:image/jpeg;base64,${preview.data}`} style={{maxWidth:'100%',height:'auto'}}/></>:null}
 </div></details>;
}
