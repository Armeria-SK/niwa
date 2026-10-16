import {request as httpRequest,type ClientRequest,type IncomingMessage,type OutgoingHttpHeaders} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Type,type Static} from '@sinclair/typebox';
import {assertDirectoryPath} from '../../config/paths.ts';
import type {JsonObject,ModelToolDefinition} from '../../contracts/model.ts';
import {redactSecrets} from '../../shared/redaction.ts';

const name=Type.String({pattern:'^[a-z][a-z0-9_]{0,47}$'});
export const mcpServerSchema=Type.Object({id:Type.String({pattern:'^[a-z][a-z0-9_]{0,19}$'}),socket:Type.Optional(Type.String({pattern:'^/',maxLength:100})),url:Type.Optional(Type.String({pattern:'^https?://',maxLength:500})),oauth:Type.Optional(Type.Literal(true)),scope:Type.Union([Type.Literal('shared'),Type.Literal('conversation')]),enabled:Type.Optional(Type.Boolean()),tools:Type.Array(Type.Object({name,readOnly:Type.Boolean(),approval:Type.Optional(Type.Literal(true))},{additionalProperties:false}),{maxItems:32})},{additionalProperties:false});
export type McpServerConfig=Static<typeof mcpServerSchema>;
/** Static credential for a remote server: printable ASCII header value, kept in secrets/ only. */
export const mcpTokenSchema=Type.String({pattern:'^[\\x21-\\x7e](?:[\\x20-\\x7e]{0,4094}[\\x21-\\x7e])?$',maxLength:4096});
/** OAuth access/refresh tokens: printable ASCII without quote or backslash, so a JSON-encoded copy still matches the plain value when redacting. */
export const mcpOAuthTokenSchema=Type.String({pattern:'^[\\x21\\x23-\\x5b\\x5d-\\x7e]{8,16384}$',maxLength:16384});
/** Supplies Bearer tokens for one OAuth connection; `refresh` renews after the server rejected `rejected`, `reject` marks the login unusable. */
export interface McpOAuthSource{access(signal?:AbortSignal):Promise<string>;refresh(rejected:string,signal?:AbortSignal):Promise<string>;reject(token:string):boolean;secrets():string[]}
export type McpEndpoint={socket:string}|{url:string;token?:string|undefined;oauth?:McpOAuthSource|undefined};
/** The login is missing, expired for good or refused: the administrator has to sign in again. */
export class McpLoginRequired extends Error{constructor(){super('login_required');}}
const loopback=new Set(['127.0.0.1','localhost','[::1]']);
/** Canonical https URL without credentials or fragment; plain http only on loopback for local testing. */
export function mcpUrl(value:string){
 if(value.length>500||!/^[\x21-\x7e]+$/.test(value)||value.includes('#'))return undefined;
 let url:URL;try{url=new URL(value);}catch{return undefined;}
 if((url.href!==value&&url.href!==value+'/')||url.username||url.password||url.hash||!url.hostname||!(url.protocol==='https:'||(url.protocol==='http:'&&loopback.has(url.hostname))))return undefined;
 return url;
}
/** URL found in OAuth metadata: https, or plain http on loopback only when the MCP server itself is local. No credentials or fragment. */
export function oauthUrl(value:unknown,allowLoopback:boolean){
 if(typeof value!=='string'||value.length>2048||!/^[\x21-\x7e]+$/.test(value)||value.includes('#'))return undefined;
 let url:URL;try{url=new URL(value);}catch{return undefined;}
 if(url.username||url.password||url.hash||!url.hostname||!(url.protocol==='https:'||(allowLoopback&&url.protocol==='http:'&&loopback.has(url.hostname))))return undefined;
 return url;
}
/** Exactly one transport per server: a private local socket or a remote Streamable HTTP URL. An OAuth server never uses a static token. */
export function mcpEndpoint(config:{socket?:string|undefined;url?:string|undefined;oauth?:true|undefined},token?:string,oauth?:McpOAuthSource):McpEndpoint{
 if((config.socket===undefined)===(config.url===undefined))throw Error('MCP server needs exactly one of socket or url');
 if(config.url===undefined){if(config.oauth)throw Error('OAuth needs a URL');return {socket:config.socket!};}
 if(!mcpUrl(config.url))throw Error('Invalid MCP URL');
 if(config.oauth){if(!oauth)throw Error('MCP OAuth unavailable');return {url:config.url,oauth};}
 return {url:config.url,token};
}
const noOAuth:McpOAuthSource={access:()=>Promise.reject(new McpLoginRequired()),refresh:()=>Promise.reject(new McpLoginRequired()),reject:()=>false,secrets:()=>[]};
export const mcpEndpointValid=(config:{socket?:string|undefined;url?:string|undefined;oauth?:true|undefined})=>{try{mcpEndpoint(config,undefined,noOAuth);return true;}catch{return false;}};
export interface McpContext {scope:string;execution_id?:string;allow_start?:boolean;deadline:number}
interface Registered {definition:ModelToolDefinition;server:McpServerConfig;remote:string;readOnly:boolean;approval:boolean;replay:boolean;signature:string}
export const mcpScope=(epoch:string,room:string)=>createHash('sha256').update(JSON.stringify([epoch,room])).digest('hex');
export const mcpResourceUrl=(server:string,room:string,uri:string)=>`/api/mcp/${server}/resource?room=${encodeURIComponent(room)}&uri=${encodeURIComponent(uri)}`;

/** `lost` marks a session whose id was dropped but not yet replaced; `renewal` is the one shared re-initialization every caller waits for. */
export interface McpSession {id?:string|undefined;lost?:boolean|undefined;renewal?:Promise<void>|undefined}
/** Bounded text safe to show to the model and the administrator. */
export const mcpText=(value:unknown,max=200)=>String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ').trim().slice(0,max);
class McpHttpError extends Error{constructor(message:string,readonly status=0){super(message);}}
const initializeParams={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'niwa',version:'0.1.0'}};
// The credential is removed before the text is cut, so a long echoed token cannot leave a readable prefix.
const failure=(response:JsonObject,secrets:readonly string[])=>{const e=response.error as JsonObject|undefined;return Error(`MCP error ${typeof e?.code==='number'?e.code:'?'}: ${mcpText(redactSecrets(String(e?.message??'unknown'),secrets))}`.slice(0,200));};
/** One re-initialization at a time per session; it runs on its own deadline so a caller giving up does not break the others. */
function renew(target:string|McpEndpoint,session:McpSession,signal?:AbortSignal){
 session.lost=true;
 const shared=session.renewal??=mcpInitialize(target,session,AbortSignal.timeout(30000)).then(()=>undefined).finally(()=>{session.renewal=undefined;});
 if(!signal)return shared;
 return new Promise<void>((resolve,reject)=>{
  const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  shared.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
 });
}

type Send=(headers:OutgoingHttpHeaders,signal:AbortSignal,reply:(res:IncomingMessage)=>void)=>ClientRequest;
/** A scheme token ("Basic <credential>") also hides its credential part. */
const staticSecrets=(token:string)=>[token,...token.split(' ').filter(p=>p.length>=8)];
/** Every string in a tool result (keys included) with exactly the known credentials replaced; anything else in the result is left as the server sent it. */
function scrub(value:unknown,secrets:readonly string[],depth=0):unknown{
 if(depth>64)throw Error('Invalid MCP result');
 const clean=(text:string)=>secrets.reduce((out,secret)=>out.includes(secret)?out.split(secret).join('[REDACTED]'):out,text);
 if(typeof value==='string')return clean(value);
 if(Array.isArray(value))return value.map(item=>scrub(item,secrets,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[clean(key),scrub(item,secrets,depth+1)]));
 return value;
}
/** One POST per message. Redirects are never followed: any status other than 200/202 is a transport failure. */
function transport(target:string|McpEndpoint,bearer?:string):{send:Send;secrets:string[]}{
 const endpoint=typeof target==='string'?{socket:target}:target;
 if('socket' in endpoint){
  const socket=endpoint.socket;assertDirectoryPath(dirname(socket));const dir=lstatSync(dirname(socket)),stat=lstatSync(socket);
  if(!stat.isSocket()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||dir.uid!==stat.uid||(dir.mode&0o077)||(stat.mode&0o077))throw Error('MCP socket is not private');
  return {secrets:[],send:(headers,signal,reply)=>httpRequest({socketPath:socket,path:'/mcp',method:'POST',agent:false,signal,headers},reply)};
 }
 const url=mcpUrl(endpoint.url),token=endpoint.token;if(!url)throw Error('Invalid MCP URL');
 if(token!==undefined&&!new RegExp(mcpTokenSchema.pattern!).test(token))throw Error('Invalid MCP credential');
 if(bearer!==undefined&&(token!==undefined||!new RegExp(mcpOAuthTokenSchema.pattern!).test(bearer)))throw Error('Invalid MCP credential');
 // A bare token is sent as Bearer; a value with a scheme ("Basic ...") is sent as given.
 const auth=bearer!==undefined?{Authorization:`Bearer ${bearer}`}:token?{Authorization:token.includes(' ')?token:`Bearer ${token}`}:{},request=url.protocol==='https:'?httpsRequest:httpRequest;
 return {secrets:bearer!==undefined?[bearer]:token?staticSecrets(token):[],send:(headers,signal,reply)=>request(url,{method:'POST',agent:false,signal,headers:{...headers,...auth}},reply)};
}
/** MCP JSON-RPC over a private Unix HTTP socket or a remote Streamable HTTP endpoint. No subprocesses.
 * With an OAuth source the Bearer token comes from it; one 401 renews the token and repeats the request (a 401 means nothing ran), a second one asks for a new login. */
export async function mcpRpc(target:string|McpEndpoint,method:string,params:JsonObject={},signal?:AbortSignal,maxBytes=512*1024,session?:McpSession,reinitialize=true):Promise<JsonObject>{
 const oauth=typeof target==='string'||!('url' in target)?undefined:target.oauth;
 if(!oauth)return mcpPost(target,undefined,method,params,signal,maxBytes,session,reinitialize);
 let bearer=await oauth.access(signal);
 for(let attempt=0;;attempt++){
  try{return await mcpPost(target,bearer,method,params,signal,maxBytes,session,reinitialize);}
  catch(error){
   if(!(error instanceof McpHttpError&&error.status===401))throw error;
   if(attempt===0){bearer=await oauth.refresh(bearer,signal);continue;}
   // Refused again with a renewed token: the login is over, unless it was replaced while this request ran. Then the new login gets one try.
   if(oauth.reject(bearer)||attempt>=2)throw new McpLoginRequired();
   bearer=await oauth.access(signal);
  }
 }
}
async function mcpPost(target:string|McpEndpoint,bearer:string|undefined,method:string,params:JsonObject,signal:AbortSignal|undefined,maxBytes:number,session:McpSession|undefined,reinitialize:boolean):Promise<JsonObject>{
 // A session that lost its id (a failed or still running re-initialization) is restored before anything else is sent.
 if(session&&reinitialize&&method!=='initialize'&&(session.lost||session.renewal))await renew(target,session,signal);
 const {send,secrets}=transport(target,bearer);
 const oauthSource=typeof target==='string'||!('url' in target)?undefined:target.oauth;
 const known=()=>[...secrets,...(oauthSource?.secrets()??[])];
 const id=randomUUID(),notification=method.startsWith('notifications/'),sent=session?.id;
 const body=JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params});
 if(Buffer.byteLength(body)>65536)throw Error('MCP request too large');
 const cancellation=AbortSignal.any([AbortSignal.timeout(method==='tools/call'?3600000:30000),...(signal?[signal]:[])]);
 try{return await new Promise<JsonObject>((resolve,reject)=>{
  const req=send({'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18',...(sent?{'Mcp-Session-Id':sent}:{}),'Content-Length':Buffer.byteLength(body)},cancellation,res=>{
   const type=res.headers['content-type']??'';
   if(notification&&(res.statusCode===200||res.statusCode===202)){res.destroy();resolve({});return;}
   if(res.statusCode!==200||!(type.startsWith('application/json')||type.startsWith('text/event-stream'))){res.destroy();reject(new McpHttpError('MCP transport failed',res.statusCode));return;}
   const header=res.headers['mcp-session-id'];if(method==='initialize'&&session&&typeof header==='string'&&/^[\x21-\x7e]{1,256}$/.test(header))session.id=header;
   let size=0,done=false;
   const finish=(response:JsonObject|undefined)=>{
    if(done||!response||response.jsonrpc!=='2.0'||(response.id!==id&&!(response.id===null&&response.error)))return false;
    done=true;res.destroy();
    if(response.error&&typeof response.error==='object')reject(failure(response,known()));
    else if(!response.result||typeof response.result!=='object'||Array.isArray(response.result))reject(Error('Invalid MCP reply'));
    else resolve(response.result as JsonObject);
    return true;
   };
   const limit=(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){done=true;res.destroy();reject(Error('MCP response too large'));return false;}return true;};
   if(type.startsWith('text/event-stream')){
    const decoder=new TextDecoder('utf-8'),data:string[]=[];let pending='';
    const dispatch=()=>{if(!data.length)return;const text=data.join('\n');data.length=0;try{finish(JSON.parse(text) as JsonObject);}catch{}};
    const line=(value:string)=>{if(!value)dispatch();else if(value.startsWith('data:'))data.push(value.slice(value[5]===' '?6:5));};
    const lines=(text:string)=>{let tail='';if(text.endsWith('\r')){tail='\r';text=text.slice(0,-1);}const parts=text.split(/\r\n|\n|\r/);pending=parts.pop()!+tail;parts.forEach(line);};
    res.on('data',(chunk:Buffer)=>{if(done||!limit(chunk))return;lines(pending+decoder.decode(chunk,{stream:true}));});
    res.on('error',e=>{if(!done)reject(e);});
    res.on('end',()=>{if(done)return;lines(pending+decoder.decode()+'\n\n');if(!done)reject(Error('MCP request failed'));});
    return;
   }
   const chunks:Buffer[]=[];
   res.on('data',(chunk:Buffer)=>{if(limit(chunk))chunks.push(chunk);});
   res.on('error',e=>{if(!done)reject(e);});res.on('end',()=>{
    if(done)return;let response:JsonObject|undefined;
    try{response=JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;}catch{}
    if(!finish(response))reject(Error('MCP request failed'));
   });
  });req.on('error',reject);req.end(body);
 });}catch(error){
  if(sent&&reinitialize&&session&&method!=='initialize'&&error instanceof McpHttpError&&error.status===404&&!cancellation.aborted){
   // The server dropped the session before running anything: every caller that sees it waits for one new session, then retries once.
   if(session.id===sent)session.lost=true;
   if(session.lost||session.renewal)await renew(target,session,signal);
   return mcpPost(target,bearer,method,params,signal,maxBytes,session,false);
  }
  if(cancellation.aborted&&!notification)await mcpRpc(target,'notifications/cancelled',{requestId:id},AbortSignal.timeout(5000),undefined,session,false).catch(()=>{});
  // A remote server may echo the credential; never pass it on to logs, the model or the administrator.
  if(error instanceof Error&&(secrets.length||oauthSource))error.message=redactSecrets(error.message,known());
  throw error;
 }
}
export async function mcpInitialize(target:string|McpEndpoint,session:McpSession,signal?:AbortSignal){
 session.id=undefined;
 const hello=await mcpRpc(target,'initialize',initializeParams,signal,undefined,session);
 if(hello.protocolVersion!=='2025-06-18')throw Error('Unsupported MCP protocol');
 await mcpRpc(target,'notifications/initialized',{},signal,undefined,session,false);
 session.lost=false;
 return hello;
}
const endpointSecrets=(endpoint:McpEndpoint)=>'socket' in endpoint?[]:endpoint.oauth?endpoint.oauth.secrets():endpoint.token?staticSecrets(endpoint.token):[];
export class McpConnector{
 private registered=new Map<string,Registered>();
 private servers=new Map<string,McpServerConfig>();
 private sessions=new Map<string,McpSession>();
 private endpoints=new Map<string,McpEndpoint>();
 private failures=new Map<string,{config:McpServerConfig;endpoint:McpEndpoint;reason:string}>();
 private downloads=0;
 private retired=false;
 private retrying=false;
 private again=false;
 /** Called when a server drops out at run time (its login ended), so the owner can schedule reconnection. */
 onFailed:(()=>void)|undefined;
 /** Builds a server's endpoint from the credentials as they are now, so a retry sees a repaired or replaced credential. */
 endpointFor:((config:McpServerConfig)=>McpEndpoint)|undefined;
 private constructor(){}
 static async discover(target:string|McpEndpoint,signal?:AbortSignal,session:McpSession={}){
   const hello=await mcpInitialize(target,session,signal);
   const capabilities=(hello.capabilities as JsonObject|undefined)?.experimental as JsonObject|undefined;
   const list=await mcpRpc(target,'tools/list',{},signal,undefined,session);
   if(!Array.isArray(list.tools)||list.tools.length>128||list.nextCursor)throw Error('Unsupported MCP tool listing');
   const names=new Set<string>();
   const tools=list.tools.map((value:unknown)=>{
    const tool=value as JsonObject|null;
    if(!tool||typeof tool.name!=='string'||!/^[a-z][a-z0-9_]{0,47}$/.test(tool.name)||names.has(tool.name))throw Error('Invalid MCP tool name');
    names.add(tool.name);
    if(!tool.inputSchema||typeof tool.inputSchema!=='object'||Array.isArray(tool.inputSchema)||(tool.inputSchema as JsonObject).type!=='object')throw Error('Invalid MCP tool schema');
    return {name:tool.name,description:(typeof tool.description==='string'&&tool.description.trim()?tool.description:tool.name).slice(0,6000),inputSchema:tool.inputSchema as JsonObject,readOnlyHint:(tool.annotations as JsonObject|undefined)?.readOnlyHint===true};
   });
   return {conversationIsolation:capabilities?.niwaContextV1===true,tools};
 }
 /** Servers are checked independently (10s each). Strict mode rejects on the first failure; otherwise failures are recorded and can be retried. Remote tokens are keyed by server id; OAuth servers get their token source from `oauth`. */
 static async connect(configs:McpServerConfig[],signal?:AbortSignal,tolerant=false,tokens:Record<string,string>={},oauth?:(config:McpServerConfig)=>McpOAuthSource){
  const connector=new McpConnector();
  const ids=new Set<string>(),endpoints=new Map<string,McpEndpoint>();
  for(const config of configs){
   if(ids.has(config.id))throw Error('Duplicate MCP server');ids.add(config.id);
   if(config.enabled!==false&&!config.tools.length)throw Error('No MCP tools selected');
   endpoints.set(config.id,mcpEndpoint(config,config.url===undefined||config.oauth?undefined:tokens[config.id],config.oauth?oauth?.(config):undefined));
  }
  const active=configs.filter(c=>c.enabled!==false);
  const results=await Promise.allSettled(active.map(config=>connector.prepare(config,endpoints.get(config.id)!,signal)));
  results.forEach((result,i)=>{
   if(result.status==='fulfilled')result.value();
   else if(!tolerant)throw result.reason;
   else connector.failures.set(active[i]!.id,{config:active[i]!,endpoint:endpoints.get(active[i]!.id)!,reason:McpConnector.reason(result.reason)});
  });
  return connector;
 }
 static reason(error:unknown){const e=error as NodeJS.ErrnoException|undefined;return mcpText(e instanceof McpHttpError&&e.status?`HTTP ${e.status}`:typeof e?.code==='string'?e.code:e?.message??'unknown');}
 /** Discovers and validates one server without touching the registry; the returned function publishes it. */
 private async prepare(config:McpServerConfig,endpoint:McpEndpoint,signal?:AbortSignal){
  const session:McpSession={},list=await McpConnector.discover(endpoint,AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]),session);
  if(config.scope==='conversation'&&!list.conversationIsolation)throw Error('MCP server must isolate conversation context');
  const entries:[string,Registered][]=[];
  for(const allowed of config.tools){
   const tool=list.tools.find(t=>t.name===allowed.name);if(!tool)throw Error('Configured MCP tool missing');
   const exposed=`mcp_${config.id}_${allowed.name}`;
   if(exposed.length>64)throw Error('MCP tool name exceeds model limit');
   if(this.registered.has(exposed)||entries.some(([n])=>n===exposed))throw Error('Duplicate MCP tool name');
   const definition={name:exposed,description:tool.description,input_schema:tool.inputSchema};
   entries.push([exposed,{definition,server:config,remote:allowed.name,readOnly:allowed.readOnly,approval:!allowed.readOnly&&allowed.approval===true,replay:list.conversationIsolation,signature:createHash('sha256').update(JSON.stringify([config,definition])).digest('hex')}]);
  }
  return()=>{entries.forEach(([n,r])=>this.registered.set(n,r));this.servers.set(config.id,config);this.sessions.set(config.id,session);this.endpoints.set(config.id,endpoint);this.failures.delete(config.id);};
 }
 /** Takes a connected server out of service and queues it for retry; used when its OAuth login is gone. */
 markFailed(id:string,reason:string){
  const config=this.servers.get(id),endpoint=this.endpoints.get(id);
  if(this.retired||!config||!endpoint||!('url' in endpoint)||!endpoint.oauth)return;
  for(const [name,tool] of this.registered)if(tool.server.id===id)this.registered.delete(name);
  this.servers.delete(id);this.sessions.delete(id);this.endpoints.delete(id);this.failures.set(id,{config,endpoint,reason});
  this.onFailed?.();
 }
 private async guarded<T>(id:string,work:Promise<T>){
  try{return await work;}catch(error){if(error instanceof McpLoginRequired)this.markFailed(id,'login_required');throw error;}
 }
 failed(){return [...this.failures].map(([id,f])=>({id,reason:f.reason,config:f.config}));}
 /** Re-checks servers that failed to connect; returns true while any is still failing. */
 async retryFailed(signal?:AbortSignal,force=false){
  if(this.retired)return this.failures.size>0;
  // A forced retry (a login just completed) must not be lost to a run that already started.
  if(this.retrying){if(force)this.again=true;return this.failures.size>0;}
  this.retrying=true;
  try{do{
   this.again=false;
   await Promise.all([...this.failures.values()].map(async f=>{
    try{
     try{f.endpoint=this.endpointFor?.(f.config)??f.endpoint;}catch{}
     const publish=await this.prepare(f.config,f.endpoint,signal);if(!this.retired)publish();
    }
    catch(error){const current=this.failures.get(f.config.id);if(current)current.reason=McpConnector.reason(error);}
   }));
  }while(this.again&&!this.retired);}finally{this.retrying=false;}
  return this.failures.size>0;
 }
 retire(){this.retired=true;}
 connections(){return this.retired?[]:[...this.servers.keys()];}
 tools(sharedRoom:boolean){return this.retired?[]:[...this.registered.values()].filter(t=>sharedRoom||t.server.scope==='conversation').map(t=>t.definition);}
 tool(name:string,sharedRoom:boolean){const tool=this.registered.get(name);return !this.retired&&tool&&(sharedRoom||tool.server.scope==='conversation')?tool:undefined;}
 async call(name:string,args:JsonObject,context:McpContext,signal?:AbortSignal):Promise<JsonObject>{
  const tool=this.registered.get(name);if(this.retired||!tool)throw Error('MCP tool unavailable');
  if(!tool.readOnly&&context.allow_start===false&&!tool.replay)return {error:'outcome_unknown'};
  const endpoint=this.endpoints.get(tool.server.id)!,sent=endpointSecrets(endpoint);
  let result=await this.guarded(tool.server.id,mcpRpc(endpoint,'tools/call',{name:tool.remote,arguments:args,_meta:{'org.niwa/context':context}},signal,undefined,this.sessions.get(tool.server.id)));
  if(!Array.isArray(result.content)||result.content.length>100)throw Error('Invalid MCP result');
  // A remote server may echo its credential back; the model never sees it.
  // Tokens renewed during the call count as well as the one that was sent.
  const secrets=[...new Set([...sent,...endpointSecrets(endpoint)])].filter(secret=>secret.length>0).sort((a,b)=>b.length-a.length);
  if(secrets.length)result=scrub(result,secrets) as JsonObject;
  return {...result,untrusted:true};
 }
 async resource(server:string,uri:string,scope:string){
  const config=this.servers.get(server);if(this.retired||!config||uri.length>2048||this.downloads>=2)throw Error('MCP resource unavailable');
  this.downloads++;
  try{
   const result=await this.guarded(config.id,mcpRpc(this.endpoints.get(config.id)!,'resources/read',{uri,_meta:{'org.niwa/context':{scope,deadline:Date.now()+30000}}},undefined,90*1024*1024,this.sessions.get(config.id)));
   if(!Array.isArray(result.contents)||result.contents.length!==1)throw Error('Invalid MCP resource');
   const item=result.contents[0] as JsonObject;if(item.uri!==uri)throw Error('MCP resource URI mismatch');
   const data=typeof item.blob==='string'?Buffer.from(item.blob,'base64'):typeof item.text==='string'?Buffer.from(item.text):undefined;
   if(!data||data.length>64*1024*1024||(typeof item.blob==='string'&&data.toString('base64')!==item.blob))throw Error('MCP resource too large or invalid');
   return {data,mime:typeof item.mimeType==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)?item.mimeType:'application/octet-stream'};
  }finally{this.downloads--;}
 }
}
