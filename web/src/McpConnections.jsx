import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {origin,savedToken,tokenCleared,probeToken,tokenChanges,initialAuth} from './mcp-tokens.js';
import {hrefOf,clientChoice,settleClientForm,clientOnFile,loginEntry,loginFor,loggedIn,loginNote,loginFailure,loginUnsaved,loginState,connectionState,connectionError} from './mcp-login.js';
import {carryTools,resetTools,mergeCatalog} from './mcp-tools.js';
import {serverText,t} from './i18n.js';
import {rich} from './i18n-react.js';
import './McpConnections.css';

const draftServer=(server,status)=>({...server,auth:initialAuth(server,status),awaitingLogin:false,savedOAuth:server.oauth===true,remembered:{},toolsOrigin:origin(server.url??''),clientId:'',clientSecret:'',needClient:false,loginLink:'',transport:server.url!==undefined?'url':'socket',socket:server.socket??'',url:server.url??'',savedId:server.id,savedUrl:server.url,token:'',clearToken:false,enabled:server.enabled!==false,key:crypto.randomUUID(),catalog:server.tools.map(tool=>({...tool,selected:true,saved:true})),checked:false});
const address=server=>server.transport==='url'?/^https?:\/\/./.test(server.url):server.socket.startsWith('/');
const idValid=id=>/^[a-z][a-z0-9_]{0,19}$/.test(id);
export function McpConnections(){
 const [status,setStatus]=useState(null),[servers,setServers]=useState([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[dirty,setDirty]=useState(()=>new Set()),[removed,setRemoved]=useState(false);
 const working=useRef(false);
 useEffect(()=>{
  let active=true;
  api('/mcp').then(value=>{if(active){setStatus(value);setServers((value.servers??[]).map(server=>draftServer(server,value)));setDirty(new Set());setRemoved(false);setError('');}}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[reload]);
 useEffect(()=>{
  if(!status?.failed?.length)return;
  const timer=setInterval(()=>api('/mcp').then(value=>setStatus(current=>current&&value.revision===current.revision?value:current)).catch(()=>{}),10000);
  return()=>clearInterval(timer);
 },[status]);
 const waiting=!!status?.oauth?.some(o=>o.pending);
 useEffect(()=>{
  // While a login is open in another tab, look for its result every 2 seconds, for at most 10 minutes.
  if(!waiting)return;
  const stop=Date.now()+10*60_000;
  const timer=setInterval(()=>{if(Date.now()>stop){clearInterval(timer);return;}api('/mcp').then(value=>setStatus(current=>current&&value.revision===current.revision?value:current)).catch(()=>{});},2000);
  return()=>clearInterval(timer);
 },[waiting]);
 useEffect(()=>{
  // The client ID form closes once the login that was started from it has succeeded.
  if(servers.some(s=>settleClientForm(s,status)))setServers(current=>current.map(s=>({...s,...settleClientForm(s,status)})));
  // A tool list that was fetched with a login is out of date once that login (or the URL or ID it was for) is gone.
  if(servers.some(s=>s.checked&&s.transport==='url'&&s.auth==='oauth'&&!loggedIn(s,status)))setServers(current=>current.map(s=>s.checked&&s.transport==='url'&&s.auth==='oauth'&&!loggedIn(s,status)?{...s,checked:false}:s));
 },[status,servers]);
 const touch=key=>setDirty(current=>new Set(current).add(key));
 function change(key,patch){setServers(current=>current.map(s=>s.key===key?{...s,...patch}:s));touch(key);setNotice('');}
 const local=(key,patch)=>setServers(current=>current.map(s=>s.key===key?{...s,...patch}:s));
 async function run(action){
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){setError(e.message);}finally{working.current=false;setBusy(false);}
 }
 function login(server){return run(async()=>{
  const manual=server.needClient&&server.clientId?{client_id:server.clientId,...(server.clientSecret?{client_secret:server.clientSecret}:{})}:{};
  const result=await api('/mcp/oauth/start','POST',{id:server.id,url:server.url,...manual});
  // A refused start is shown on the card (the server keeps the reason), not as a message at the bottom of the form.
  // The tab opens at once, while the click still counts for the browser; the link stays on the card in case it is blocked. The server keeps what was typed for the login that is open, so the form does not hold the secret (or the ID) any longer.
  if(result.ok){local(server.key,{loginLink:result.url,clientId:'',clientSecret:''});window.open(result.url,'_blank','noopener,noreferrer');}
  else if(result.code==='client_registration_required')local(server.key,{needClient:true});
  const value=await api('/mcp');setStatus(current=>current&&value.revision===current.revision?value:current);
  // Only now does the status show the login as pending, which is what tells "open" from "ended".
  if(result.ok)local(server.key,{awaitingLogin:true});
 });}
 function logout(server){return run(async()=>{
  await api('/mcp/oauth/logout','POST',{id:server.id,url:hrefOf(server.url)});local(server.key,{loginLink:'',checked:false});
  const value=await api('/mcp');setStatus(current=>current&&value.revision===current.revision?value:current);setNotice(t('connections.mcpLogoutDone'));
 });}
 function check(server){return run(async()=>{
  if(server.transport==='url'&&server.auth==='oauth'&&!loggedIn(server,status))throw Error(t('connections.mcpLoginFirst'));
  const result=await api('/mcp/probe','POST',server.transport!=='url'?{socket:server.socket}:server.auth==='oauth'?{url:server.url,id:server.id,oauth:true}:{url:server.url,...probeToken(server,status)});
  if(!result.ok)throw Error(result.message);
  const catalog=mergeCatalog(result.tools,server);
  setServers(current=>current.map(s=>s.key===server.key?{...s,catalog,toolsOrigin:origin(server.url),checked:true,conversationIsolation:result.conversationIsolation}:s));
  if(server.catalog.some(tool=>tool.selected&&!catalog.some(t=>t.name===tool.name)))touch(server.key);
  setNotice(t('connections.mcpCheckOk'));
 });}
 function save(e){e.preventDefault();return run(async()=>{
  const configs=servers.map(({id,transport,socket,url,scope,enabled,catalog,auth})=>({id,...(transport==='url'?{url,...(auth==='oauth'?{oauth:true}:{})}:{socket}),scope,enabled,tools:catalog.filter(t=>t.selected).map(t=>({name:t.name,readOnly:t.readOnly,...(!t.readOnly&&t.approval===true?{approval:true}:{})}))}));
  // OAuth servers never carry a static token; choosing "none" removes a saved one.
  const tokens=tokenChanges(servers,status);
  if(new Set(configs.map(s=>s.id)).size!==configs.length)throw Error(t('connections.mcpDuplicateId'));
  if(configs.some(s=>s.enabled&&!s.tools.length))throw Error(t('connections.mcpNoTools'));
  if(configs.some(s=>s.tools.some(t=>`mcp_${s.id}_${t.name}`.length>64)))throw Error(t('connections.mcpNameTooLong'));
  if(servers.some(s=>s.enabled&&s.scope==='conversation'&&s.checked&&!s.conversationIsolation))throw Error(t('connections.mcpNoIsolation'));
  const result=await api('/mcp','PUT',{revision:status.revision,servers:configs,...(tokens.length?{tokens}:{})});
  if(!result.ok)throw Error(result.message);
  setStatus(result);setServers(result.servers.map(server=>draftServer(server,result)));setDirty(new Set());setRemoved(false);setNotice(t('connections.mcpSavedApplied'));
 });}
 const ready=status?.available&&status.revision;
 return <form className="settings-form mcp-settings" onSubmit={save} aria-busy={busy}>
  <section className="settings-section"><h2>{t('connections.mcpTitle')}</h2><p>{t('connections.mcpLead1')}<br />{t('connections.mcpLead2')}</p>
   <p className="field-hint">{t('connections.mcpHint1')}<br />{t('connections.mcpHint2')}<br />{t('connections.mcpHint3')}</p>
   {!status&&!error?<p role="status">{t('connections.mcpLoading')}</p>:null}
   {status&&!ready?<p className="field-error">{t('connections.mcpNeedsUpdate')}</p>:null}
   {status?.error?<p className="field-error">{serverText(status.error)}{status.failed?.length&&!status.failed.every(f=>f.reason==='login_required')?' '+t('connections.mcpAutoReconnect'):''}</p>:null}
   {removed?<p className="field-hint">{t('connections.mcpRemoveOnSave')}</p>:null}
   {ready&&!status.applied&&!status.error?<p className="field-hint">{t('connections.mcpUnapplied')}</p>:null}
   {ready&&!servers.length?<div className="mcp-empty">{t('connections.mcpEmpty')}</div>:null}
   {servers.map((server,index)=><fieldset key={server.key} className="mcp-server" disabled={busy}>
    <legend>{t('connections.mcpLegend',{n:index+1})}{server.id?` · ${server.id}`:''}</legend>
    <div className="connection-row"><label className="mcp-enabled"><input type="checkbox" checked={server.enabled} onChange={e=>change(server.key,{enabled:e.target.checked})}/>{t('connections.mcpExpose')}</label><span className="connection-state">{connectionState(server,status,dirty.has(server.key))}</span></div>
    <div className="field-pair"><label className="field"><span>{t('connections.mcpId')}</span><input aria-label={t('connections.mcpId')} aria-describedby={`${server.key}-id-hint`} value={server.id} pattern="[a-z][a-z0-9_]{0,19}" maxLength={20} required onChange={e=>change(server.key,{id:e.target.value})} placeholder="local"/><small id={`${server.key}-id-hint`}>{t('connections.mcpIdHint')}</small></label>
    <label className="field"><span>{t('connections.mcpScope')}</span><select value={server.scope} onChange={e=>change(server.key,{scope:e.target.value})}><option value="conversation">{t('connections.mcpScopeConversation')}</option><option value="shared">{t('connections.mcpScopeShared')}</option></select></label></div>
    <label className="field"><span>{t('connections.mcpTransport')}</span><select value={server.transport} onChange={e=>change(server.key,{transport:e.target.value,...resetTools,checked:false,conversationIsolation:undefined})}><option value="socket">{t('connections.mcpTransportSocket')}</option><option value="url">{t('connections.mcpTransportUrl')}</option></select></label>
    {server.transport==='url'?<><label className="field"><span>URL</span><input type="url" value={server.url} maxLength={500} pattern="https?://.+" required onChange={e=>change(server.key,{url:e.target.value,...carryTools(server,e.target.value),checked:false,conversationIsolation:undefined})} placeholder="https://example.com/mcp" spellCheck={false}/><small>{t('connections.mcpUrlHint1')}<br />{t('connections.mcpUrlHint2')}</small></label>
     <label className="field"><span>{t('connections.mcpAuth')}</span><select value={server.auth} onChange={e=>change(server.key,{auth:e.target.value,token:'',clearToken:false})}><option value="none">{t('common.none')}</option><option value="token">{t('connections.mcpAuthToken')}</option><option value="oauth">{t('connections.mcpAuthOauth')}</option></select></label>
     {status?.token_errors?.includes(server.id)&&server.auth!=='oauth'?<p className="field-error">{t('connections.mcpTokenUnreadable1')}<br />{t('connections.mcpTokenUnreadable2')}<br />{t('connections.mcpTokenUnreadable3')}</p>:null}
     {server.auth==='token'?<>
     <label className="field"><span>{t('connections.mcpAuthToken')}</span><input type="password" autoComplete="off" value={server.token} maxLength={4096} disabled={tokenCleared(server,status)} onChange={e=>change(server.key,{token:e.target.value})} placeholder={savedToken(server,status)?t('connections.mcpTokenPlaceholderSaved'):t('connections.placeholderNotSet')} spellCheck={false}/><small>{t('connections.mcpTokenHint')}{server.savedUrl&&server.url&&origin(server.url)!==origin(server.savedUrl)&&status?.tokens?.includes(server.savedId)?' '+t('connections.mcpTokenOriginChanged'):''}</small></label>
     {savedToken(server,status)?<label className="mcp-enabled"><input type="checkbox" checked={server.clearToken} onChange={e=>change(server.key,{clearToken:e.target.checked,token:''})}/>{t('connections.mcpDeleteSavedToken')}</label>:null}</>:null}
     {server.auth==='oauth'?<>
      <p className="field-hint mcp-oauth-state" role="status">{loginState(server,status)}{!loggedIn(server,status)&&loginNote(server,status)?` · ${loginNote(server,status)}`:''}</p>
      {loginFailure(server,status)?<p className="field-error">{loginFailure(server,status)}</p>:null}
      {loginUnsaved(server,status)?<p className="field-error">{t('connections.mcpKeyUnsaved')}<br />{t('connections.checkStorage')}</p>:null}
      {clientChoice(server,status)?<div className="mcp-client-toggle"><button className="button subtle" type="button" onClick={()=>local(server.key,server.needClient?{needClient:false,clientId:'',clientSecret:''}:{needClient:true})}>{t(server.needClient?'connections.mcpClientClose':'connections.mcpClientOpen')}</button>{!server.needClient&&clientOnFile(server,status)?<p className="field-hint">{t('connections.mcpClientReuse')}</p>:null}</div>:null}
      {server.needClient?<><p className="field-hint">{t('connections.mcpClientHint1')}<br />{t('connections.mcpClientHint2')}<br />{rich('connections.mcpClientHint3',{url:<code>{location.origin}/api/mcp/oauth/callback</code>})}</p>
       <div className="field-pair mcp-client-fields"><label className="field"><span>{t('connections.mcpClientId')}</span><input value={server.clientId} maxLength={512} autoComplete="off" spellCheck={false} onChange={e=>local(server.key,{clientId:e.target.value.trim()})}/></label>
       <label className="field"><span>{t('connections.mcpClientSecret')}</span><input type="password" value={server.clientSecret} maxLength={4096} autoComplete="off" spellCheck={false} onChange={e=>local(server.key,{clientSecret:e.target.value.trim()})}/></label></div></>:null}
      <div className="inline-actions"><button className="button secondary" type="button" disabled={!idValid(server.id)||!address(server)||(server.needClient&&!server.clientId)} onClick={()=>login(server)}>{t('connections.mcpLogin')}</button>
       {loginFor(server,status)?<button className="button subtle" type="button" onClick={()=>logout(server)}>{t('connections.mcpLogout')}</button>:null}</div>
      {!idValid(server.id)?<p className="field-hint">{t('connections.mcpIdBeforeLogin')}</p>:null}
      {server.loginLink&&/^https?:\/\//.test(server.loginLink)?<p className="field-hint">{t('connections.mcpLoginTab1')}<br />{rich('connections.mcpLoginTab2',{link:<a href={server.loginLink} target="_blank" rel="noopener noreferrer">{t('connections.mcpLoginTabLink')}</a>})}</p>:null}
      <p className="field-hint">{t('connections.mcpLoginStored1')}<br />{t('connections.mcpLoginStored2')}</p></>:null}
    </>
    :<label className="field"><span>{t('connections.mcpSocketPath')}</span><input value={server.socket} maxLength={100} pattern="/.*" required onChange={e=>change(server.key,{socket:e.target.value,catalog:[],checked:false,conversationIsolation:undefined})} placeholder="/home/niwa/tool-service/runtime/mcp.sock" spellCheck={false}/></label>}
    <div className="inline-actions"><button className="button secondary" type="button" disabled={!address(server)} onClick={()=>check(server)}>{t('connections.checkConnection')}</button><button className="button subtle" type="button" onClick={()=>{setServers(current=>current.filter(s=>s.key!==server.key));setRemoved(true);setNotice(t('connections.mcpDeleteOnSave'));}}>{t('connections.mcpDelete')}</button></div>
    {connectionError(server,status,dirty.has(server.key))?<p className="field-error">{connectionError(server,status,dirty.has(server.key))}</p>:null}
    {server.checked?<p className="field-hint">{t(server.conversationIsolation?'connections.mcpCheckedIsolated':'connections.mcpCheckedShared')}</p>:null}
    {server.catalog.length?<div className="mcp-tools"><h3>{t('connections.mcpToolsHeading')}</h3><p className="field-hint">{t('connections.mcpToolsHint1')}<br />{t('connections.mcpToolsHint2')}</p>{server.catalog.map(tool=><div className="mcp-tool" key={tool.name}>
     <label><input type="checkbox" checked={tool.selected} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>t.name===tool.name?{...t,selected:e.target.checked}:t)})}/><span><strong>{tool.name}</strong><small>{tool.saved?t('connections.mcpSavedTool'):tool.description}</small>{tool.hint?<small>{t('connections.mcpToolReadOnlyHint')}</small>:null}</span></label>
     <select aria-label={t('connections.mcpToolCategory',{name:tool.name})} disabled={!tool.selected} value={tool.readOnly?'read':tool.approval===true?'write-approval':'write'} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>{if(t.name!==tool.name)return t;const {approval,...rest}=t;return {...rest,readOnly:e.target.value==='read',...(e.target.value==='write-approval'?{approval:true}:{})};})})}><option value="write">{t('connections.mcpWrite')}</option><option value="write-approval">{t('connections.mcpWriteApproval')}</option><option value="read">{t('connections.mcpReadOnly')}</option></select>
    </div>)}</div>:<p className="field-hint">{t('connections.mcpFetchTools')}</p>}
   </fieldset>)}
   {ready?<button className="button secondary" type="button" disabled={busy||servers.length>=8} onClick={()=>{const added=draftServer({id:'',socket:'',scope:'conversation',enabled:true,tools:[]},{});setServers(current=>[...current,added]);touch(added.key);setNotice('');}}>{t('connections.mcpAdd')}</button>:null}
   <p className="field-hint">{t('connections.mcpFooter1')}<br />{t('connections.mcpFooter2')}</p>
   {error?<p className="field-error" role="alert">{serverText(error)}</p>:null}<p className="saved-inline" role="status">{busy?t('connections.mcpChecking'):notice}</p>
  </section>
  <div className="form-actions settings-save"><button type="button" className="button subtle" disabled={busy} onClick={()=>{setReload(v=>v+1);setNotice('');}}>{t('connections.mcpReload')}</button><button className="button primary" disabled={busy||!ready}>{t(busy?'connections.mcpBusy':'connections.mcpSaveApply')}</button></div>
 </form>;
}
