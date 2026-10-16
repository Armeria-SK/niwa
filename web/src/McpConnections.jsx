import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import './McpConnections.css';

const draftServer=server=>({...server,transport:server.url!==undefined?'url':'socket',socket:server.socket??'',url:server.url??'',savedId:server.id,savedUrl:server.url,token:'',clearToken:false,enabled:server.enabled!==false,key:crypto.randomUUID(),catalog:server.tools.map(tool=>({...tool,selected:true,description:'保存済みのツール'})),checked:false});
const origin=value=>{try{return new URL(value).origin;}catch{return '';}};
/** The saved token is reused only for the same connection ID and URL origin; the server applies the same rule. */
const savedToken=(server,status)=>server.transport==='url'&&server.id===server.savedId&&!!server.savedUrl&&origin(server.url)===origin(server.savedUrl)&&!!status?.tokens?.includes(server.savedId);
const address=server=>server.transport==='url'?/^https?:\/\/./.test(server.url):server.socket.startsWith('/');
export function McpConnections(){
 const [status,setStatus]=useState(null),[servers,setServers]=useState([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[dirty,setDirty]=useState(()=>new Set()),[removed,setRemoved]=useState(false);
 const working=useRef(false);
 useEffect(()=>{
  let active=true;
  api('/mcp').then(value=>{if(active){setStatus(value);setServers((value.servers??[]).map(draftServer));setDirty(new Set());setRemoved(false);setError('');}}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[reload]);
 useEffect(()=>{
  if(!status?.failed?.length)return;
  const timer=setInterval(()=>api('/mcp').then(value=>setStatus(current=>current&&value.revision===current.revision?value:current)).catch(()=>{}),10000);
  return()=>clearInterval(timer);
 },[status]);
 const touch=key=>setDirty(current=>new Set(current).add(key));
 function change(key,patch){setServers(current=>current.map(s=>s.key===key?{...s,...patch}:s));touch(key);setNotice('');}
 async function run(action){
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){setError(e.message);}finally{working.current=false;setBusy(false);}
 }
 function check(server){return run(async()=>{
  const result=await api('/mcp/probe','POST',server.transport==='url'?{url:server.url,...(server.token?{token:server.token}:savedToken(server,status)&&!server.clearToken?{id:server.id}:{})}:{socket:server.socket});
  if(!result.ok)throw Error(result.message);
  const catalog=result.tools.map(tool=>{const saved=server.catalog.find(t=>t.name===tool.name);return {...tool,selected:saved?.selected??false,readOnly:saved?.readOnly??false,hint:tool.readOnlyHint===true};});
  setServers(current=>current.map(s=>s.key===server.key?{...s,catalog,checked:true,conversationIsolation:result.conversationIsolation}:s));
  if(server.catalog.some(tool=>tool.selected&&!catalog.some(t=>t.name===tool.name)))touch(server.key);
  setNotice('接続できました。Botに公開するツールを選んで保存してください。');
 });}
 function save(e){e.preventDefault();return run(async()=>{
  const configs=servers.map(({id,transport,socket,url,scope,enabled,catalog})=>({id,...(transport==='url'?{url}:{socket}),scope,enabled,tools:catalog.filter(t=>t.selected).map(t=>({name:t.name,readOnly:t.readOnly}))}));
  const tokens=servers.filter(s=>s.transport==='url'&&(s.token||s.clearToken)).map(s=>({id:s.id,value:s.token||null}));
  if(new Set(configs.map(s=>s.id)).size!==configs.length)throw Error('接続IDが重複しています。別のIDを指定してください。');
  if(configs.some(s=>s.enabled&&!s.tools.length))throw Error('有効な接続には、公開するツールを1つ以上選んでください。');
  if(configs.some(s=>s.tools.some(t=>`mcp_${s.id}_${t.name}`.length>64)))throw Error('接続IDとツール名が長すぎます。接続IDを短くしてください。');
  if(servers.some(s=>s.enabled&&s.scope==='conversation'&&s.checked&&!s.conversationIsolation))throw Error('この接続先は会話ごとの分離に対応していません。利用する会話の範囲を確認してください。');
  const result=await api('/mcp','PUT',{revision:status.revision,servers:configs,...(tokens.length?{tokens}:{})});
  if(!result.ok)throw Error(result.message);
  setStatus(result);setServers(result.servers.map(draftServer));setDirty(new Set());setRemoved(false);setNotice('保存して反映しました。再起動は不要です。');
 });}
 const ready=status?.available&&status.revision,failed=id=>status?.failed?.find(f=>f.id===id);
 return <form className="settings-form mcp-settings" onSubmit={save} aria-busy={busy}>
  <section className="settings-section"><h2>外部ツールを接続する</h2><p>MCPサーバーを登録し、Botが使えるツールを選びます。保存すると、次の呼び出しから反映されます。</p>
   <p className="field-hint">このPCのソケットか、URL（HTTPS）で接続できます。接続先のサービスを起動してから設定してください。URLの接続先にはツールに渡す内容が送られるため、信頼できるサービスだけを登録してください。</p>
   {!status&&!error?<p role="status">接続設定を読み込んでいます…</p>:null}
   {status&&!ready?<p className="field-error">MCPの設定機能を使うにはNiwa本体の更新が必要です。</p>:null}
   {status?.error?<p className="field-error">{status.error}{status.failed?.length?' サービスを起動すると自動で再接続します。設定を直す場合は「保存して反映」を押してください。':''}</p>:null}
   {removed?<p className="field-hint">接続の削除は保存すると反映されます。</p>:null}
   {ready&&!status.applied&&!status.error?<p className="field-hint">保存済みの設定に未反映の変更があります。</p>:null}
   {ready&&!servers.length?<div className="mcp-empty">MCP接続はまだ登録されていません。</div>:null}
   {servers.map((server,index)=><fieldset key={server.key} className="mcp-server" disabled={busy}>
    <legend>接続 {index+1}{server.id?` · ${server.id}`:''}</legend>
    <div className="connection-row"><label className="mcp-enabled"><input type="checkbox" checked={server.enabled} onChange={e=>change(server.key,{enabled:e.target.checked})}/>Botに公開する</label><span className="connection-state">{dirty.has(server.key)?'未保存の変更あり':!server.enabled?'無効':status.connected?.includes(server.id)?'接続済み':failed(server.id)?'接続失敗（自動で再試行します）':'未接続'}</span></div>
    <div className="field-pair"><label className="field"><span>接続ID</span><input aria-label="接続ID" aria-describedby={`${server.key}-id-hint`} value={server.id} pattern="[a-z][a-z0-9_]{0,19}" maxLength={20} required onChange={e=>change(server.key,{id:e.target.value})} placeholder="local"/><small id={`${server.key}-id-hint`}>英小文字で始め、英数字・_で20文字まで。</small></label>
    <label className="field"><span>利用する会話</span><select value={server.scope} onChange={e=>change(server.key,{scope:e.target.value})}><option value="conversation">会話ごとに分離</option><option value="shared">共有会話のみ</option></select></label></div>
    <label className="field"><span>接続方法</span><select value={server.transport} onChange={e=>change(server.key,{transport:e.target.value,catalog:[],checked:false,conversationIsolation:undefined})}><option value="socket">このPCのソケット</option><option value="url">URL（HTTPS）</option></select></label>
    {server.transport==='url'?<><label className="field"><span>URL</span><input type="url" value={server.url} maxLength={500} pattern="https?://.+" required onChange={e=>change(server.key,{url:e.target.value,catalog:[],checked:false,conversationIsolation:undefined})} placeholder="https://example.com/mcp" spellCheck={false}/><small>https:// で始まるURLを入力します。ユーザー名・パスワード・#は含められません。</small></label>
     <label className="field"><span>認証トークン（任意）</span><input type="password" autoComplete="off" value={server.token} maxLength={4096} disabled={server.clearToken} onChange={e=>change(server.key,{token:e.target.value.trim()})} placeholder={savedToken(server,status)?'設定済み（変更するときだけ入力）':'未設定'} spellCheck={false}/><small>トークンだけを入力すると「Bearer」を付けて送ります。保存したトークンは画面に表示しません。{server.savedUrl&&server.url&&origin(server.url)!==origin(server.savedUrl)&&status?.tokens?.includes(server.savedId)?' 接続先が変わったため、保存済みのトークンは使いません。':''}</small></label>
     {savedToken(server,status)?<label className="mcp-enabled"><input type="checkbox" checked={server.clearToken} onChange={e=>change(server.key,{clearToken:e.target.checked,token:''})}/>保存済みのトークンを削除する</label>:null}</>
    :<label className="field"><span>ソケットのパス</span><input value={server.socket} maxLength={100} pattern="/.*" required onChange={e=>change(server.key,{socket:e.target.value,catalog:[],checked:false,conversationIsolation:undefined})} placeholder="/home/niwa/tool-service/runtime/mcp.sock" spellCheck={false}/></label>}
    <div className="inline-actions"><button className="button secondary" type="button" disabled={!address(server)} onClick={()=>check(server)}>接続を確認</button><button className="button subtle" type="button" onClick={()=>{setServers(current=>current.filter(s=>s.key!==server.key));setRemoved(true);setNotice('保存すると接続を削除します。');}}>接続を削除</button></div>
    {failed(server.id)&&!dirty.has(server.key)?<p className="field-error">接続できません: {failed(server.id).reason}</p>:null}
    {server.checked?<p className="field-hint">接続確認済み · {server.conversationIsolation?'会話ごとの分離に対応':'共有会話での利用に対応'}</p>:null}
    {server.catalog.length?<div className="mcp-tools"><h3>Botに公開するツール</h3><p className="field-hint">操作区分は、ツールの実際の動作に合わせて確認してください。初期値は「実行・書き込みあり」です。</p>{server.catalog.map(tool=><div className="mcp-tool" key={tool.name}>
     <label><input type="checkbox" checked={tool.selected} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>t.name===tool.name?{...t,selected:e.target.checked}:t)})}/><span><strong>{tool.name}</strong><small>{tool.description}</small>{tool.hint?<small>接続先の申告: 読み取りのみ（実際の動作を確認して操作区分を選んでください）</small>:null}</span></label>
     <select aria-label={`${tool.name} の操作区分`} disabled={!tool.selected} value={tool.readOnly?'read':'write'} onChange={e=>change(server.key,{catalog:server.catalog.map(t=>t.name===tool.name?{...t,readOnly:e.target.value==='read'}:t)})}><option value="write">実行・書き込みあり</option><option value="read">読み取りのみ</option></select>
    </div>)}</div>:<p className="field-hint">「接続を確認」でツール一覧を取得できます。</p>}
   </fieldset>)}
   {ready?<button className="button secondary" type="button" disabled={busy||servers.length>=8} onClick={()=>{const added=draftServer({id:'',socket:'',scope:'conversation',enabled:true,tools:[]});setServers(current=>[...current,added]);touch(added.key);setNotice('');}}>MCP接続を追加</button>:null}
   <p className="field-hint">共有会話のみの接続は、共有会話間でデータを共有します。実行中の処理は現在の接続で続きます。</p>
   {error?<p className="field-error" role="alert">{error}</p>:null}<p className="saved-inline" role="status">{busy?'接続を確認しています…':notice}</p>
  </section>
  <div className="form-actions settings-save"><button type="button" className="button subtle" disabled={busy} onClick={()=>{setReload(v=>v+1);setNotice('');}}>保存済み設定を読み直す</button><button className="button primary" disabled={busy||!ready}>{busy?'確認中…':'保存して反映'}</button></div>
 </form>;
}
