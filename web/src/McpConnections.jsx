import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {origin,savedToken,tokenCleared,probeToken,tokenChanges} from './mcp-tokens.js';
import {hrefOf,clientChoice,loginEntry,loginFor,loggedIn,loginNote,loginFailure,loginUnsaved,loginState,connectionState,connectionError} from './mcp-login.js';
import {carryTools,resetTools,mergeCatalog} from './mcp-tools.js';
import './McpConnections.css';

const draftServer=(server,tokens)=>({...server,auth:server.oauth?'oauth':server.url!==undefined&&tokens?.includes(server.id)?'token':'none',savedOAuth:server.oauth===true,remembered:{},toolsOrigin:origin(server.url??''),clientId:'',clientSecret:'',needClient:false,loginLink:'',transport:server.url!==undefined?'url':'socket',socket:server.socket??'',url:server.url??'',savedId:server.id,savedUrl:server.url,token:'',clearToken:false,enabled:server.enabled!==false,key:crypto.randomUUID(),catalog:server.tools.map(tool=>({...tool,selected:true,description:'保存済みのツール'})),checked:false});
const address=server=>server.transport==='url'?/^https?:\/\/./.test(server.url):server.socket.startsWith('/');
const idValid=id=>/^[a-z][a-z0-9_]{0,19}$/.test(id);
export function McpConnections(){
 const [status,setStatus]=useState(null),[servers,setServers]=useState([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[dirty,setDirty]=useState(()=>new Set()),[removed,setRemoved]=useState(false);
 const working=useRef(false);
 useEffect(()=>{
  let active=true;
  api('/mcp').then(value=>{if(active){setStatus(value);setServers((value.servers??[]).map(server=>draftServer(server,value.tokens)));setDirty(new Set());setRemoved(false);setError('');}}).catch(e=>{if(active)setError(e.message);});
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
  // The client secret is only needed while the login is open; it leaves the form once the login is complete.
  if(servers.some(s=>s.clientSecret&&loggedIn(s,status)))setServers(current=>current.map(s=>s.clientSecret&&loggedIn(s,status)?{...s,clientSecret:''}:s));
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
  if(result.ok){local(server.key,{loginLink:result.url});window.open(result.url,'_blank','noopener,noreferrer');}
  else if(result.code==='client_registration_required')local(server.key,{needClient:true});
  const value=await api('/mcp');setStatus(current=>current&&value.revision===current.revision?value:current);
 });}
 function logout(server){return run(async()=>{
  await api('/mcp/oauth/logout','POST',{id:server.id,url:hrefOf(server.url)});local(server.key,{loginLink:'',checked:false});
  const value=await api('/mcp');setStatus(current=>current&&value.revision===current.revision?value:current);setNotice('ログアウトしました。');
 });}
 function check(server){return run(async()=>{
  if(server.transport==='url'&&server.auth==='oauth'&&!loggedIn(server,status))throw Error('先にログインしてください。');
  const result=await api('/mcp/probe','POST',server.transport!=='url'?{socket:server.socket}:server.auth==='oauth'?{url:server.url,id:server.id,oauth:true}:{url:server.url,...probeToken(server,status)});
  if(!result.ok)throw Error(result.message);
  const catalog=mergeCatalog(result.tools,server);
  setServers(current=>current.map(s=>s.key===server.key?{...s,catalog,toolsOrigin:origin(server.url),checked:true,conversationIsolation:result.conversationIsolation}:s));
  if(server.catalog.some(tool=>tool.selected&&!catalog.some(t=>t.name===tool.name)))touch(server.key);
  setNotice('接続できました。Botに公開するツールを選んで保存してください。');
 });}
 function save(e){e.preventDefault();return run(async()=>{
  const configs=servers.map(({id,transport,socket,url,scope,enabled,catalog,auth})=>({id,...(transport==='url'?{url,...(auth==='oauth'?{oauth:true}:{})}:{socket}),scope,enabled,tools:catalog.filter(t=>t.selected).map(t=>({name:t.name,readOnly:t.readOnly,...(!t.readOnly&&t.approval===true?{approval:true}:{})}))}));
  // OAuth servers never carry a static token; choosing "none" removes a saved one.
  const tokens=tokenChanges(servers,status);
  if(new Set(configs.map(s=>s.id)).size!==configs.length)throw Error('接続IDが重複しています。別のIDを指定してください。');
  if(configs.some(s=>s.enabled&&!s.tools.length))throw Error('有効な接続には、公開するツールを1つ以上選んでください。');
  if(configs.some(s=>s.tools.some(t=>`mcp_${s.id}_${t.name}`.length>64)))throw Error('接続IDとツール名が長すぎます。接続IDを短くしてください。');
  if(servers.some(s=>s.enabled&&s.scope==='conversation'&&s.checked&&!s.conversationIsolation))throw Error('この接続先は会話ごとの分離に対応していません。利用する会話の範囲を確認してください。');
  const result=await api('/mcp','PUT',{revision:status.revision,servers:configs,...(tokens.length?{tokens}:{})});
  if(!result.ok)throw Error(result.message);
  setStatus(result);setServers(result.servers.map(server=>draftServer(server,result.tokens)));setDirty(new Set());setRemoved(false);setNotice('保存して反映しました。再起動は不要です。');
 });}
 const ready=status?.available&&status.revision;
 return <form className="settings-form mcp-settings" onSubmit={save} aria-busy={busy}>
  <section className="settings-section"><h2>外部ツールを接続する</h2><p>MCPサーバーを登録し、Botが使えるツールを選びます。保存すると、次の呼び出しから反映されます。</p>
   <p className="field-hint">このPCのソケットか、URL（HTTPS）で接続できます。接続先のサービスを起動してから設定してください。URLの接続先にはツールに渡す内容が送られるため、信頼できるサービスだけを登録してください。</p>
   {!status&&!error?<p role="status">接続設定を読み込んでいます…</p>:null}
   {status&&!ready?<p className="field-error">MCPの設定機能を使うにはNiwa本体の更新が必要です。</p>:null}
   {status?.error?<p className="field-error">{status.error}{status.failed?.length&&!status.failed.every(f=>f.reason==='login_required')?' サービスを起動すると自動で再接続します。設定を直す場合は「保存して反映」を押してください。':''}</p>:null}
   {removed?<p className="field-hint">接続の削除は保存すると反映されます。</p>:null}
   {ready&&!status.applied&&!status.error?<p className="field-hint">保存済みの設定に未反映の変更があります。</p>:null}
   {ready&&!servers.length?<div className="mcp-empty">MCP接続はまだ登録されていません。</div>:null}
   {servers.map((server,index)=><fieldset key={server.key} className="mcp-server" disabled={busy}>
    <legend>接続 {index+1}{server.id?` · ${server.id}`:''}</legend>
    <div className="connection-row"><label className="mcp-enabled"><input type="checkbox" checked={server.enabled} onChange={e=>change(server.key,{enabled:e.target.checked})}/>Botに公開する</label><span className="connection-state">{connectionState(server,status,dirty.has(server.key))}</span></div>
    <div className="field-pair"><label className="field"><span>接続ID</span><input aria-label="接続ID" aria-describedby={`${server.key}-id-hint`} value={server.id} pattern="[a-z][a-z0-9_]{0,19}" maxLength={20} required onChange={e=>change(server.key,{id:e.target.value})} placeholder="local"/><small id={`${server.key}-id-hint`}>英小文字で始め、英数字・_で20文字まで。</small></label>
    <label className="field"><span>利用する会話</span><select value={server.scope} onChange={e=>change(server.key,{scope:e.target.value})}><option value="conversation">会話ごとに分離</option><option value="shared">共有会話のみ</option></select></label></div>
    <label className="field"><span>接続方法</span><select value={server.transport} onChange={e=>change(server.key,{transport:e.target.value,...resetTools,checked:false,conversationIsolation:undefined})}><option value="socket">このPCのソケット</option><option value="url">URL（HTTPS）</option></select></label>
    {server.transport==='url'?<><label className="field"><span>URL</span><input type="url" value={server.url} maxLength={500} pattern="https?://.+" required onChange={e=>change(server.key,{url:e.target.value,...carryTools(server,e.target.value),checked:false,conversationIsolation:undefined})} placeholder="https://example.com/mcp" spellCheck={false}/><small>https:// で始まるURLを入力します（このPCのサービスなら http://127.0.0.1 も使えます）。ユーザー名・パスワード・#は含められません。</small></label>
     <label className="field"><span>認証の方法</span><select value={server.auth} onChange={e=>change(server.key,{auth:e.target.value,token:'',clearToken:false})}><option value="none">なし</option><option value="token">認証トークン</option><option value="oauth">OAuthでログイン</option></select></label>
     {status?.token_errors?.includes(server.id)&&server.auth!=='oauth'?<p className="field-error">保存済みの認証トークンのファイルを読み込めません。トークンを入力し直すか、認証の方法を「なし」にして保存してください。</p>:null}
     {server.auth==='token'?<>
     <label className="field"><span>認証トークン</span><input type="password" autoComplete="off" value={server.token} maxLength={4096} disabled={tokenCleared(server,status)} onChange={e=>change(server.key,{token:e.target.value})} placeholder={savedToken(server,status)?'設定済み（変更するときだけ入力）':'未設定'} spellCheck={false}/><small>トークンだけを入力すると「Bearer」を付けて送ります。保存したトークンは画面に表示しません。{server.savedUrl&&server.url&&origin(server.url)!==origin(server.savedUrl)&&status?.tokens?.includes(server.savedId)?' 接続先が変わったため、保存済みのトークンは使いません。':''}</small></label>
     {savedToken(server,status)?<label className="mcp-enabled"><input type="checkbox" checked={server.clearToken} onChange={e=>change(server.key,{clearToken:e.target.checked,token:''})}/>保存済みのトークンを削除する</label>:null}</>:null}
     {server.auth==='oauth'?<>
      <p className="field-hint mcp-oauth-state" role="status">{loginState(server,status)}{!loggedIn(server,status)&&loginNote(server,status)?` · ${loginNote(server,status)}`:''}</p>
      {loginFailure(server,status)?<p className="field-error">{loginFailure(server,status)}</p>:null}
      {loginUnsaved(server,status)?<p className="field-error">新しい鍵をまだ保存できていません。保存先の空き容量と権限を確認してください。</p>:null}
      {clientChoice(server,status)?<div className="mcp-client-toggle"><button className="button subtle" type="button" onClick={()=>local(server.key,server.needClient?{needClient:false,clientId:'',clientSecret:''}:{needClient:true})}>{server.needClient?'クライアントIDの入力を閉じる':'クライアントIDを入力する'}</button>{!server.needClient?<p className="field-hint">前回のログインで使ったクライアントは、入力しなくても再利用します。</p>:null}</div>:null}
      {server.needClient?<><p className="field-hint">この接続先は、クライアントの自動登録に対応していない場合があります。提供元の開発者向けの画面でアプリを登録し、発行されたクライアントIDを入力してください。登録するリダイレクトURL（コールバックURL）は <code>{location.origin}/api/mcp/oauth/callback</code> です。</p>
       <div className="field-pair mcp-client-fields"><label className="field"><span>クライアントID</span><input value={server.clientId} maxLength={512} autoComplete="off" spellCheck={false} onChange={e=>local(server.key,{clientId:e.target.value.trim()})}/></label>
       <label className="field"><span>クライアントシークレット（任意）</span><input type="password" value={server.clientSecret} maxLength={4096} autoComplete="off" spellCheck={false} onChange={e=>local(server.key,{clientSecret:e.target.value.trim()})}/></label></div></>:null}
      <div className="inline-actions"><button className="button secondary" type="button" disabled={!idValid(server.id)||!address(server)||(server.needClient&&!server.clientId)} onClick={()=>login(server)}>ログイン</button>
       {loginFor(server,status)?<button className="button subtle" type="button" onClick={()=>logout(server)}>ログアウト</button>:null}</div>
      {!idValid(server.id)?<p className="field-hint">ログインの前に、接続IDを入力してください。</p>:null}
      {server.loginLink&&/^https?:\/\//.test(server.loginLink)&&loginEntry(server,status)?.pending?<p className="field-hint">別のタブで開いたログイン画面で手続きを完了してください。開かないときは、<a href={server.loginLink} target="_blank" rel="noopener noreferrer">こちらを開いてください</a>。</p>:null}
      <p className="field-hint">ログイン情報はNiwaのsecretsフォルダーに保存し、画面には表示しません。URLを変えたときは、もう一度ログインが必要です。</p></>:null}
    </>
    :<label className="field"><span>ソケットのパス</span><input value={server.socket} maxLength={100} pattern="/.*" required onChange={e=>change(server.key,{socket:e.target.value,catalog:[],checked:false,conversationIsolation:undefined})} placeholder="/home/niwa/tool-service/runtime/mcp.sock" spellCheck={false}/></label>}
    <div className="inline-actions"><button className="button secondary" type="button" disabled={!address(server)} onClick={()=>check(server)}>接続を確認</button><button className="button subtle" type="button" onClick={()=>{setServers(current=>current.filter(s=>s.key!==server.key));setRemoved(true);setNotice('保存すると接続を削除します。');}}>接続を削除</button></div>
    {connectionError(server,status,dirty.has(server.key))?<p className="field-error">{connectionError(server,status,dirty.has(server.key))}</p>:null}
    {server.checked?<p className="field-hint">接続確認済み · {server.conversationIsolation?'会話ごとの分離に対応':'共有会話での利用に対応'}</p>:null}
    {server.catalog.length?<div className="mcp-tools"><h3>Botに公開するツール</h3><p className="field-hint">操作区分は、ツールの実際の動作に合わせて確認してください。初期値は「書き込みあり」です。</p>{server.catalog.map(tool=><div className="mcp-tool" key={tool.name}>
     <label><input type="checkbox" checked={tool.selected} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>t.name===tool.name?{...t,selected:e.target.checked}:t)})}/><span><strong>{tool.name}</strong><small>{tool.description}</small>{tool.hint?<small>接続先の申告: 読み取りのみ（実際の動作を確認して操作区分を選んでください）</small>:null}</span></label>
     <select aria-label={`${tool.name} の操作区分`} disabled={!tool.selected} value={tool.readOnly?'read':tool.approval===true?'write-approval':'write'} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>{if(t.name!==tool.name)return t;const {approval,...rest}=t;return {...rest,readOnly:e.target.value==='read',...(e.target.value==='write-approval'?{approval:true}:{})};})})}><option value="write">書き込みあり</option><option value="write-approval">書き込みあり（毎回承認）</option><option value="read">読み取りのみ</option></select>
    </div>)}</div>:<p className="field-hint">「接続を確認」でツール一覧を取得できます。</p>}
   </fieldset>)}
   {ready?<button className="button secondary" type="button" disabled={busy||servers.length>=8} onClick={()=>{const added=draftServer({id:'',socket:'',scope:'conversation',enabled:true,tools:[]},[]);setServers(current=>[...current,added]);touch(added.key);setNotice('');}}>MCP接続を追加</button>:null}
   <p className="field-hint">共有会話のみの接続は、共有会話間でデータを共有します。実行中の処理は現在の接続で続きます。</p>
   {error?<p className="field-error" role="alert">{error}</p>:null}<p className="saved-inline" role="status">{busy?'接続を確認しています…':notice}</p>
  </section>
  <div className="form-actions settings-save"><button type="button" className="button subtle" disabled={busy} onClick={()=>{setReload(v=>v+1);setNotice('');}}>保存済み設定を読み直す</button><button className="button primary" disabled={busy||!ready}>{busy?'確認中…':'保存して反映'}</button></div>
 </form>;
}
