import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {DomainError} from '../../domain/types.ts';
import {readInstallation,saveMcpInstallation,mcpConfigRevision} from '../../config/installation.ts';
import {productPaths} from '../../config/paths.ts';
import {McpConnector,McpLoginRequired,mcpServerSchema,mcpTokenSchema,mcpEndpoint,mcpEndpointValid,mcpUrl,type McpOAuthSource,type McpServerConfig} from './client.ts';
import {readMcpTokens,writeMcpToken} from './secrets.ts';
import {McpOAuth} from './oauth.ts';
import {listMcpOAuth,listMcpOAuthClients,readMcpOAuthClient,removeMcpOAuthFile,writeMcpOAuth,writeMcpOAuthClient,type McpOAuthClient,type McpOAuthCredential} from './oauth-store.ts';

const {id,socket,url}=mcpServerSchema.properties;
/** Tokens travel only browser→server: a string sets, null removes, absence keeps the stored one while the URL origin is unchanged. */
export const mcpUpdateSchema=Type.Object({revision:Type.String({pattern:'^[a-f0-9]{64}$'}),servers:Type.Array(mcpServerSchema,{maxItems:8}),tokens:Type.Optional(Type.Array(Type.Object({id,value:Type.Union([mcpTokenSchema,Type.Null()])},{additionalProperties:false}),{maxItems:8}))},{additionalProperties:false});
export const mcpProbeSchema=Type.Object({socket,url,token:Type.Optional(mcpTokenSchema),id:Type.Optional(id),oauth:Type.Optional(Type.Literal(true))},{additionalProperties:false});
export const mcpOAuthStartSchema=Type.Object({id,url:Type.String({pattern:'^https?://',maxLength:500}),client_id:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]{1,512}$'})),client_secret:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]{1,4096}$'}))},{additionalProperties:false});
export const mcpOAuthLogoutSchema=Type.Object({id,url:Type.Optional(Type.String({pattern:'^[Hh][Tt][Tt][Pp][Ss]?://',maxLength:500}))},{additionalProperties:false});
const connectionMessage='接続できませんでした。サービスの起動、ソケットのパスと権限（URLの場合はURLと認証トークン）、対応する会話範囲・ツールを確認してください。';
const storageMessage='MCP設定を保存できませんでした。Niwaの保存先の書き込み権限と空き容量を確認してください。';
const loginRequiredMessage='ログインが必要な接続があります。各接続の「ログイン」からログインしてください。';
const loginMessage='ログインが必要です。「ログイン」からログインしてください。';
const canonicalUrl=(value:string)=>{try{return mcpUrl(new URL(value).href)?.href;}catch{return undefined;}};
const origin=(value:string|undefined)=>value===undefined?undefined:mcpUrl(value)?.origin;

/** Immutable connectors make configuration changes take effect at the next model step. Servers that failed to connect are retried with backoff while open. */
export class McpSettings{
 private busy=false;
 private closed=false;
 private applied='';
 private built='';
 private delay:number;
 private timer:NodeJS.Timeout|undefined;
 private last?:ReturnType<McpSettings['read']>;
 private secrets:string;
 private oauth:McpOAuth;
 private constructor(private root:string,public connector:McpConnector,private saved:(servers:McpServerConfig[])=>void,private retry:{initial:number;max:number},fetcher?:typeof fetch){
  this.delay=retry.initial;this.secrets=productPaths(root).secrets;
  this.oauth=new McpOAuth(this.secrets,{...(fetcher?{fetcher}:{}),onLogin:()=>{void this.reconnect();}});
 }
 static async open(root:string,saved:(servers:McpServerConfig[])=>void=()=>{},retry={initial:5000,max:300000},fetcher?:typeof fetch){
  const settings=new McpSettings(root,await McpConnector.connect([]),saved,retry,fetcher);
  const servers=readInstallation(root).mcpServers??[];
  settings.connector=await McpConnector.connect(servers,undefined,true,settings.tokens(),settings.source);settings.watch(settings.connector);settings.adopt(servers);
  return settings;
 }
 private source=(config:McpServerConfig):McpOAuthSource=>this.oauth.source(config.id,config.url!);
 /** A server that drops out at run time (its login ended) is retried like one that failed to connect. Retries read credentials afresh. */
 private watch(connector:McpConnector){
  connector.endpointFor=config=>mcpEndpoint(config,config.url===undefined||config.oauth?undefined:this.tokens()[config.id],config.oauth?this.source(config):undefined);
  connector.onFailed=()=>{if(this.closed||this.connector!==connector)return;this.applied='';if(!this.timer)this.delay=this.retry.initial;this.schedule();};
 }
 /** A login just completed: servers waiting for it connect now instead of after the backoff. */
 private async reconnect(){
  const connector=this.connector;
  if(this.closed||!connector.failed().length)return;
  await connector.retryFailed(undefined,true).catch(()=>{});
  if(!this.closed&&this.connector===connector&&!connector.failed().length)this.applied=this.built;
 }
 private adopt(servers:McpServerConfig[]){
  this.built=mcpConfigRevision(servers);this.delay=this.retry.initial;
  if(this.connector.failed().length){this.applied='';this.schedule();}else this.applied=this.built;
 }
 private schedule(){
  if(this.closed||this.timer)return;
  this.timer=setTimeout(()=>{this.timer=undefined;void this.recover();},this.delay);this.timer.unref();
 }
 private async recover(){
  const connector=this.connector;
  if(!this.closed&&!this.busy){
   await connector.retryFailed().catch(()=>{});
   if(this.closed||this.connector!==connector)return;
   if(!connector.failed().length){this.applied=this.built;return;}
   this.delay=Math.min(this.delay*2,this.retry.max);
  }
  this.schedule();
 }
 /** An unreadable credential leaves that server unauthenticated; its connection failure is reported instead. */
 private tokens(){try{return readMcpTokens(this.secrets,[]);}catch{return {};}}
 /** Ids whose saved token file cannot be read (reported without any content), so the screen can say so and let the administrator remove it. */
 private unreadableTokens(){const bad:string[]=[];try{readMcpTokens(this.secrets,bad);}catch{}return bad;}
 read(){
  const servers=readInstallation(this.root).mcpServers??[],revision=mcpConfigRevision(servers),failed=this.connector.failed().map(({id,reason})=>({id,reason})),stored=this.tokens();
  // Only which servers have a credential is reported; the value never leaves the server.
  return {available:true,revision,servers,tokens:servers.filter(s=>s.url!==undefined&&!s.oauth&&stored[s.id]!==undefined).map(s=>s.id),oauth:this.oauth.states(servers),token_errors:this.unreadableTokens().filter(id=>servers.some(s=>s.id===id&&s.url!==undefined&&!s.oauth)),connected:this.connector.connections(),failed,applied:revision===this.applied,error:failed.length?failed.every(f=>f.reason==='login_required')?loginRequiredMessage:connectionMessage:null,busy:this.busy,tools:this.connector.tools(true).map(t=>({name:t.name,description:t.description}))};
 }
 status(){
  try{return this.last=this.read();}
  catch(error){
   // A bad file must not hide the last good state: report it and keep the page usable.
   if(!this.last)throw error;
   const reason=(error as Error).message.startsWith('Invalid ')||(error as Error).message.startsWith('Unsafe ')?(error as Error).message:'unreadable';
   return {...this.last,busy:this.busy,connected:this.connector.connections(),error:`設定ファイルを読み込めません（${reason}）。直前の正常な状態を表示しています。ファイルを修正してから読み直してください。`};
  }
 }
 async probe(input:Static<typeof mcpProbeSchema>){
  if(!Value.Check(mcpProbeSchema,input)||!mcpEndpointValid(input)||(input.oauth&&(input.id===undefined||input.token!==undefined)))throw new DomainError('invalid','Invalid MCP address');
  if(this.busy||this.closed)throw new DomainError('conflict','MCP connection in progress');
  let token=input.token;
  // An OAuth login is used only for the exact URL it was made for (the source checks this on every request).
  const source=input.oauth?this.oauth.source(input.id!,input.url!):undefined;
  // A stored credential is sent only to the origin it was saved for.
  if(!input.oauth&&token===undefined&&input.url!==undefined&&input.id!==undefined){const saved=this.status().servers.find(s=>s.id===input.id);if(saved&&origin(saved.url)===origin(input.url))token=this.tokens()[input.id];}
  this.busy=true;
  try{return {ok:true,...await McpConnector.discover(mcpEndpoint(input,token,source),AbortSignal.timeout(10000))};}
  catch(error){return {ok:false,message:error instanceof McpLoginRequired?loginMessage:`${connectionMessage}（${McpConnector.reason(error)}）`};}
  finally{this.busy=false;}
 }
 async save(input:Static<typeof mcpUpdateSchema>){
  if(!Value.Check(mcpUpdateSchema,input))throw new DomainError('invalid','Invalid MCP settings');
  if(this.busy||this.closed||this.status().revision!==input.revision)throw new DomainError('conflict','MCP settings changed');
  const ids=new Set<string>();
  for(const server of input.servers){
   if(ids.has(server.id)||!mcpEndpointValid(server)||new Set(server.tools.map(t=>t.name)).size!==server.tools.length||server.tools.some(t=>`mcp_${server.id}_${t.name}`.length>64)||(server.enabled!==false&&!server.tools.length))throw new DomainError('invalid','Choose unique IDs and tools');
   ids.add(server.id);
  }
  const changes=new Map<string,string|null>();
  for(const token of input.tokens??[]){
   const target=input.servers.find(s=>s.id===token.id);
   if(changes.has(token.id)||target?.url===undefined||target.oauth)throw new DomainError('invalid','Tokens apply only to URL connections without OAuth');changes.set(token.id,token.value);
  }
  let stored:Record<string,string>;const unreadable:string[]=[];
  try{stored=readMcpTokens(this.secrets,unreadable);}catch{return {ok:false,message:'保存済みの認証トークンを読み込めません。secretsフォルダーの mcp-token-* の権限と内容を確認してください。'};}
  // An unreadable file blocks only the connections that would have kept its token; others, and ones given a new value, replace or remove it.
  const kept=unreadable.filter(key=>input.servers.some(s=>s.id===key&&s.url!==undefined&&!s.oauth)&&!changes.has(key));
  if(kept.length)return {ok:false,message:`保存済みの認証トークンを読み込めません（${kept.join(', ')}）。secretsフォルダーの mcp-token-* の権限と内容を確認するか、トークンを入力し直してください。`};
  const previous=this.status().servers,tokens:Record<string,string>={};
  for(const server of input.servers){
   if(server.url===undefined||server.oauth)continue;
   const change=changes.get(server.id),value=change!==undefined?change??undefined:origin(previous.find(p=>p.id===server.id)?.url)===origin(server.url)?stored[server.id]:undefined;
   if(value!==undefined)tokens[server.id]=value;
  }
  this.busy=true;
  try{
   let next:McpConnector;
   try{next=await McpConnector.connect(input.servers,undefined,true,tokens,this.source);}
   catch{return {ok:false,message:connectionMessage};}
   // Servers already known to be down and unchanged do not block saving the rest.
   const known=this.connector.failed(),bad=next.failed().filter(f=>!known.some(k=>k.id===f.id&&JSON.stringify(k.config)===JSON.stringify(f.config))||tokens[f.id]!==stored[f.id]);
   if(bad.length){next.retire();return {ok:false,message:`${connectionMessage}（${bad.map(f=>`${f.id}: ${f.reason}`).join(' / ').slice(0,300)}）`};}
   if(this.closed){next.retire();throw new DomainError('conflict','MCP service closing');}
   let servers:McpServerConfig[];const written:string[]=[],removed:typeof dropped=[],removedClients:string[]=[];
   // OAuth logins of deleted or no-longer-OAuth connections, and ones made for another URL than the saved one, are removed with the configuration.
   const logins=new Map(input.servers.filter(s=>s.oauth&&s.url!==undefined).map(s=>[s.id,mcpUrl(s.url!)!.href])),dropped:ReturnType<typeof listMcpOAuth>=[],clients=new Map<string,McpOAuthClient|undefined>();
   try{for(const entry of listMcpOAuth(this.secrets)){
    const want=logins.get(entry.id);
    if(want===undefined||(entry.credential&&entry.credential.resource!==want))dropped.push(entry);
   }}catch{}
   try{for(const key of listMcpOAuthClients(this.secrets))if(!logins.has(key)){let client:McpOAuthClient|undefined;try{client=readMcpOAuthClient(this.secrets,key);}catch{}clients.set(key,client);}}catch{}
   // Credentials first (removed servers' too), then the configuration; a failure restores the previous credentials.
   try{
    for(const key of new Set([...Object.keys(stored),...Object.keys(tokens),...unreadable]))if(tokens[key]!==stored[key]||unreadable.includes(key)){written.push(key);writeMcpToken(this.secrets,key,tokens[key]);}
    for(const entry of dropped){removed.push(entry);removeMcpOAuthFile(this.secrets,entry.file);}
    for(const key of clients.keys()){removedClients.push(key);writeMcpOAuthClient(this.secrets,key,undefined);}
    servers=saveMcpInstallation(this.root,input.servers,input.revision);
   }catch(error){
    next.retire();
    for(const key of written)try{writeMcpToken(this.secrets,key,stored[key]);}catch{}
    for(const entry of removed)if(entry.credential)try{writeMcpOAuth(this.secrets,entry.id,entry.credential);}catch{}
    for(const key of removedClients){const client=clients.get(key);if(client)try{writeMcpOAuthClient(this.secrets,key,client);}catch{}}
    if(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException).code??''))return {ok:false,message:storageMessage};
    throw error;
   }
   this.connector.retire();this.connector=next;this.watch(next);this.adopt(servers);this.saved(servers);
   const held=this.oauth.forgetExcept(logins);
   for(const entry of dropped)if(!logins.has(entry.id))this.oauth.forget(entry.id);
   // The provider is told too, in the background; the logins are gone from here either way. A renewed login that was only held in memory is the one to revoke, not the older copy on disk.
   const revoking=new Map<string,McpOAuthCredential>();
   for(const entry of dropped)if(entry.credential)revoking.set(`${entry.id}\n${entry.credential.resource}`,entry.credential);
   for(const entry of held)revoking.set(`${entry.id}\n${entry.credential.resource}`,entry.credential);
   for(const credential of revoking.values())void this.oauth.revoke(credential);
   return {ok:true,...this.status(),busy:false};
  }finally{this.busy=false;}
 }
 /** Starts a login. The administrator opens the returned address in a browser; the provider sends them back to `callback`. */
 async oauthStart(input:Static<typeof mcpOAuthStartSchema>,callback:string){
  if(!Value.Check(mcpOAuthStartSchema,input)||!mcpUrl(input.url)||(input.client_secret!==undefined&&input.client_id===undefined))throw new DomainError('invalid','Invalid OAuth request');
  if(this.closed)throw new DomainError('conflict','MCP service closing');
  return this.oauth.start(input.id,input.url,input.client_id!==undefined?{client_id:input.client_id,client_secret:input.client_secret}:undefined,callback);
 }
 /** The browser's return from the provider (no admin cookie): true when the login was stored. */
 async oauthFinish(params:{state?:string|undefined;code?:string|undefined;error?:string|undefined;iss?:string|undefined}){
  return !this.closed&&!!await this.oauth.finish(params);
 }
 async oauthLogout(input:Static<typeof mcpOAuthLogoutSchema>){
  if(!Value.Check(mcpOAuthLogoutSchema,input))throw new DomainError('invalid','Invalid OAuth request');
  if(this.closed)throw new DomainError('conflict','MCP service closing');
  // Equivalent spellings of the URL (case of scheme and host, default port) name the same login.
  const resource=input.url!==undefined?canonicalUrl(input.url):undefined;
  if(input.url!==undefined&&!resource)throw new DomainError('invalid','Invalid OAuth request');
  await this.oauth.logout(input.id,resource);
  // The running connection stops being reported as connected right away, if it was the one that lost its login.
  const live=this.status().servers.find(s=>s.id===input.id&&s.oauth&&s.url!==undefined);
  if(live&&(resource===undefined||mcpUrl(live.url!)?.href===resource))this.connector.markFailed(input.id,'login_required');
  return {ok:true};
 }
 close(){this.closed=true;clearTimeout(this.timer);this.timer=undefined;this.connector.retire();this.oauth.close();}
}
