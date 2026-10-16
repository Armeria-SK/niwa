import {request} from 'node:http';
import {lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Type,type Static} from '@sinclair/typebox';
import {assertDirectoryPath} from '../../config/paths.ts';
import type {JsonObject,ModelToolDefinition} from '../../contracts/model.ts';

const name=Type.String({pattern:'^[a-z][a-z0-9_]{0,47}$'});
export const mcpServerSchema=Type.Object({id:Type.String({pattern:'^[a-z][a-z0-9_]{0,19}$'}),socket:Type.String({pattern:'^/',maxLength:100}),scope:Type.Union([Type.Literal('shared'),Type.Literal('conversation')]),enabled:Type.Optional(Type.Boolean()),tools:Type.Array(Type.Object({name,readOnly:Type.Boolean()},{additionalProperties:false}),{maxItems:32})},{additionalProperties:false});
export type McpServerConfig=Static<typeof mcpServerSchema>;
export interface McpContext {scope:string;execution_id?:string;allow_start?:boolean;deadline:number}
interface Registered {definition:ModelToolDefinition;server:McpServerConfig;remote:string;readOnly:boolean;replay:boolean;signature:string}
export const mcpScope=(epoch:string,room:string)=>createHash('sha256').update(JSON.stringify([epoch,room])).digest('hex');
export const mcpResourceUrl=(server:string,room:string,uri:string)=>`/api/mcp/${server}/resource?room=${encodeURIComponent(room)}&uri=${encodeURIComponent(uri)}`;

export interface McpSession {id?:string|undefined}
/** Bounded text safe to show to the model and the administrator. */
export const mcpText=(value:unknown,max=200)=>String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,' ').trim().slice(0,max);
class McpHttpError extends Error{constructor(message:string,readonly status=0){super(message);}}
const initializeParams={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'niwa',version:'0.1.0'}};
const failure=(response:JsonObject)=>{const e=response.error as JsonObject|undefined;return Error(`MCP error ${typeof e?.code==='number'?e.code:'?'}: ${mcpText(e?.message??'unknown')}`.slice(0,200));};

/** Local MCP JSON-RPC over private Unix HTTP sockets. No subprocesses or remote URLs. */
export async function mcpRpc(socket:string,method:string,params:JsonObject={},signal?:AbortSignal,maxBytes=512*1024,session?:McpSession,reinitialize=true):Promise<JsonObject>{
 assertDirectoryPath(dirname(socket));const dir=lstatSync(dirname(socket)),stat=lstatSync(socket);
 if(!stat.isSocket()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||dir.uid!==stat.uid||(dir.mode&0o077)||(stat.mode&0o077))throw Error('MCP socket is not private');
 const id=randomUUID(),notification=method.startsWith('notifications/'),sent=session?.id;
 const body=JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params});
 if(Buffer.byteLength(body)>65536)throw Error('MCP request too large');
 const cancellation=AbortSignal.any([AbortSignal.timeout(method==='tools/call'?3600000:30000),...(signal?[signal]:[])]);
 try{return await new Promise<JsonObject>((resolve,reject)=>{
  const req=request({socketPath:socket,path:'/mcp',method:'POST',agent:false,signal:cancellation,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18',...(sent?{'Mcp-Session-Id':sent}:{}),'Content-Length':Buffer.byteLength(body)}},res=>{
   const type=res.headers['content-type']??'';
   if(notification&&(res.statusCode===200||res.statusCode===202)){res.destroy();resolve({});return;}
   if(res.statusCode!==200||!(type.startsWith('application/json')||type.startsWith('text/event-stream'))){res.destroy();reject(new McpHttpError('MCP transport failed',res.statusCode));return;}
   const header=res.headers['mcp-session-id'];if(method==='initialize'&&session&&typeof header==='string'&&/^[\x21-\x7e]{1,256}$/.test(header))session.id=header;
   let size=0,done=false;
   const finish=(response:JsonObject|undefined)=>{
    if(done||!response||response.jsonrpc!=='2.0'||(response.id!==id&&!(response.id===null&&response.error)))return false;
    done=true;res.destroy();
    if(response.error&&typeof response.error==='object')reject(failure(response));
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
   // The server dropped the session before running anything: start a new one and retry once.
   if(session.id===sent){session.id=undefined;await mcpInitialize(socket,session,signal);}
   return mcpRpc(socket,method,params,signal,maxBytes,session,false);
  }
  if(cancellation.aborted&&!notification)await mcpRpc(socket,'notifications/cancelled',{requestId:id},AbortSignal.timeout(5000),undefined,session,false).catch(()=>{});
  throw error;
 }
}
export async function mcpInitialize(socket:string,session:McpSession,signal?:AbortSignal){
 session.id=undefined;
 const hello=await mcpRpc(socket,'initialize',initializeParams,signal,undefined,session);
 if(hello.protocolVersion!=='2025-06-18')throw Error('Unsupported MCP protocol');
 await mcpRpc(socket,'notifications/initialized',{},signal,undefined,session,false);
 return hello;
}
export class McpConnector{
 private registered=new Map<string,Registered>();
 private servers=new Map<string,McpServerConfig>();
 private sessions=new Map<string,McpSession>();
 private failures=new Map<string,{config:McpServerConfig;reason:string}>();
 private downloads=0;
 private retired=false;
 private retrying=false;
 private constructor(){}
 static async discover(socket:string,signal?:AbortSignal,session:McpSession={}){
   const hello=await mcpInitialize(socket,session,signal);
   const capabilities=(hello.capabilities as JsonObject|undefined)?.experimental as JsonObject|undefined;
   const list=await mcpRpc(socket,'tools/list',{},signal,undefined,session);
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
 /** Servers are checked independently (10s each). Strict mode rejects on the first failure; otherwise failures are recorded and can be retried. */
 static async connect(configs:McpServerConfig[],signal?:AbortSignal,tolerant=false){
  const connector=new McpConnector();
  const ids=new Set<string>();
  for(const config of configs){
   if(ids.has(config.id))throw Error('Duplicate MCP server');ids.add(config.id);
   if(config.enabled!==false&&!config.tools.length)throw Error('No MCP tools selected');
  }
  const active=configs.filter(c=>c.enabled!==false);
  const results=await Promise.allSettled(active.map(config=>connector.prepare(config,signal)));
  results.forEach((result,i)=>{
   if(result.status==='fulfilled')result.value();
   else if(!tolerant)throw result.reason;
   else connector.failures.set(active[i]!.id,{config:active[i]!,reason:McpConnector.reason(result.reason)});
  });
  return connector;
 }
 static reason(error:unknown){const e=error as NodeJS.ErrnoException|undefined;return mcpText(typeof e?.code==='string'?e.code:e?.message??'unknown');}
 /** Discovers and validates one server without touching the registry; the returned function publishes it. */
 private async prepare(config:McpServerConfig,signal?:AbortSignal){
  const session:McpSession={},list=await McpConnector.discover(config.socket,AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]),session);
  if(config.scope==='conversation'&&!list.conversationIsolation)throw Error('MCP server must isolate conversation context');
  const entries:[string,Registered][]=[];
  for(const allowed of config.tools){
   const tool=list.tools.find(t=>t.name===allowed.name);if(!tool)throw Error('Configured MCP tool missing');
   const exposed=`mcp_${config.id}_${allowed.name}`;
   if(exposed.length>64)throw Error('MCP tool name exceeds model limit');
   if(this.registered.has(exposed)||entries.some(([n])=>n===exposed))throw Error('Duplicate MCP tool name');
   const definition={name:exposed,description:tool.description,input_schema:tool.inputSchema};
   entries.push([exposed,{definition,server:config,remote:allowed.name,readOnly:allowed.readOnly,replay:list.conversationIsolation,signature:createHash('sha256').update(JSON.stringify([config,definition])).digest('hex')}]);
  }
  return()=>{entries.forEach(([n,r])=>this.registered.set(n,r));this.servers.set(config.id,config);this.sessions.set(config.id,session);this.failures.delete(config.id);};
 }
 failed(){return [...this.failures].map(([id,f])=>({id,reason:f.reason,config:f.config}));}
 /** Re-checks servers that failed to connect; returns true while any is still failing. */
 async retryFailed(signal?:AbortSignal){
  if(this.retired||this.retrying)return this.failures.size>0;
  this.retrying=true;
  try{await Promise.all([...this.failures.values()].map(async f=>{
   try{const publish=await this.prepare(f.config,signal);if(!this.retired)publish();}
   catch(error){const current=this.failures.get(f.config.id);if(current)current.reason=McpConnector.reason(error);}
  }));}finally{this.retrying=false;}
  return this.failures.size>0;
 }
 retire(){this.retired=true;}
 connections(){return this.retired?[]:[...this.servers.keys()];}
 tools(sharedRoom:boolean){return this.retired?[]:[...this.registered.values()].filter(t=>sharedRoom||t.server.scope==='conversation').map(t=>t.definition);}
 tool(name:string,sharedRoom:boolean){const tool=this.registered.get(name);return !this.retired&&tool&&(sharedRoom||tool.server.scope==='conversation')?tool:undefined;}
 async call(name:string,args:JsonObject,context:McpContext,signal?:AbortSignal):Promise<JsonObject>{
  const tool=this.registered.get(name);if(this.retired||!tool)throw Error('MCP tool unavailable');
  if(!tool.readOnly&&context.allow_start===false&&!tool.replay)return {error:'outcome_unknown'};
  const result=await mcpRpc(tool.server.socket,'tools/call',{name:tool.remote,arguments:args,_meta:{'org.niwa/context':context}},signal,undefined,this.sessions.get(tool.server.id));
  if(!Array.isArray(result.content)||result.content.length>100)throw Error('Invalid MCP result');
  return {...result,untrusted:true};
 }
 async resource(server:string,uri:string,scope:string){
  const config=this.servers.get(server);if(this.retired||!config||uri.length>2048||this.downloads>=2)throw Error('MCP resource unavailable');
  this.downloads++;
  try{
   const result=await mcpRpc(config.socket,'resources/read',{uri,_meta:{'org.niwa/context':{scope,deadline:Date.now()+30000}}},undefined,90*1024*1024,this.sessions.get(config.id));
   if(!Array.isArray(result.contents)||result.contents.length!==1)throw Error('Invalid MCP resource');
   const item=result.contents[0] as JsonObject;if(item.uri!==uri)throw Error('MCP resource URI mismatch');
   const data=typeof item.blob==='string'?Buffer.from(item.blob,'base64'):typeof item.text==='string'?Buffer.from(item.text):undefined;
   if(!data||data.length>64*1024*1024||(typeof item.blob==='string'&&data.toString('base64')!==item.blob))throw Error('MCP resource too large or invalid');
   return {data,mime:typeof item.mimeType==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)?item.mimeType:'application/octet-stream'};
  }finally{this.downloads--;}
 }
}
