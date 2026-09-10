import {request} from 'node:http';
import {lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Type,type Static} from '@sinclair/typebox';
import {assertDirectoryPath} from '../../config/paths.ts';
import type {JsonObject,ModelToolDefinition} from '../../contracts/model.ts';

const name=Type.String({pattern:'^[a-z][a-z0-9_]{0,47}$'});
export const mcpServerSchema=Type.Object({id:Type.String({pattern:'^[a-z][a-z0-9_]{0,19}$'}),socket:Type.String({pattern:'^/',maxLength:100}),scope:Type.Union([Type.Literal('shared'),Type.Literal('conversation')]),tools:Type.Array(Type.Object({name,readOnly:Type.Boolean()},{additionalProperties:false}),{minItems:1,maxItems:32})},{additionalProperties:false});
export type McpServerConfig=Static<typeof mcpServerSchema>;
export interface McpContext {scope:string;execution_id?:string;allow_start?:boolean;deadline:number}
interface Registered {definition:ModelToolDefinition;server:McpServerConfig;remote:string;readOnly:boolean;replay:boolean;signature:string}
export const mcpScope=(epoch:string,room:string)=>createHash('sha256').update(JSON.stringify([epoch,room])).digest('hex');
export const mcpResourceUrl=(server:string,room:string,uri:string)=>`/api/mcp/${server}/resource?room=${encodeURIComponent(room)}&uri=${encodeURIComponent(uri)}`;

/** Local MCP JSON-RPC over private Unix HTTP sockets. No subprocesses or remote URLs. */
export async function mcpRpc(socket:string,method:string,params:JsonObject={},signal?:AbortSignal,maxBytes=512*1024):Promise<JsonObject>{
 assertDirectoryPath(dirname(socket));const dir=lstatSync(dirname(socket)),stat=lstatSync(socket);
 if(!stat.isSocket()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||dir.uid!==stat.uid||(dir.mode&0o077)||(stat.mode&0o077))throw Error('MCP socket is not private');
 const id=randomUUID(),notification=method.startsWith('notifications/');
 const body=JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params});
 if(Buffer.byteLength(body)>65536)throw Error('MCP request too large');
 const cancellation=AbortSignal.any([AbortSignal.timeout(method==='tools/call'?3600000:30000),...(signal?[signal]:[])]);
 try{return await new Promise<JsonObject>((resolve,reject)=>{
  const req=request({socketPath:socket,path:'/mcp',method:'POST',agent:false,signal:cancellation,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18','Content-Length':Buffer.byteLength(body)}},res=>{
   if(notification&&res.statusCode===202){res.resume();resolve({});return;}
   if(res.statusCode!==200||!res.headers['content-type']?.startsWith('application/json')){res.destroy();reject(Error('MCP transport failed'));return;}
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){res.destroy(Error('MCP response too large'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>{
    try{const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.jsonrpc!=='2.0'||response.id!==id||response.error||!response.result||typeof response.result!=='object'||Array.isArray(response.result))throw Error('Invalid MCP reply');resolve(response.result);}
    catch{reject(Error('MCP request failed'));}
   });
  });req.on('error',reject);req.end(body);
 });}catch(error){
  if(cancellation.aborted&&!notification)await mcpRpc(socket,'notifications/cancelled',{requestId:id},AbortSignal.timeout(5000)).catch(()=>{});
  throw error;
 }
}
export class McpConnector{
 private registered=new Map<string,Registered>();
 private servers=new Map<string,McpServerConfig>();
 private downloads=0;
 private constructor(){}
 static async connect(configs:McpServerConfig[]){
  const connector=new McpConnector();
  for(const config of configs){
   if(connector.servers.has(config.id))throw Error('Duplicate MCP server');
   const hello=await mcpRpc(config.socket,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'niwa',version:'0.1.0'}});
   if(hello.protocolVersion!=='2025-06-18')throw Error('Unsupported MCP protocol');
   await mcpRpc(config.socket,'notifications/initialized');
   const replay=(hello.capabilities as JsonObject|undefined)?.experimental as JsonObject|undefined;
   if(config.scope==='conversation'&&replay?.niwaContextV1!==true)throw Error('MCP server must isolate conversation context');
   const list=await mcpRpc(config.socket,'tools/list');
   if(!Array.isArray(list.tools)||list.tools.length>128||list.nextCursor)throw Error('Unsupported MCP tool listing');
   for(const allowed of config.tools){
    const matches=list.tools.filter((t:JsonObject)=>t.name===allowed.name);if(matches.length!==1)throw Error('Configured MCP tool missing');
    const tool=matches[0] as JsonObject;
    if(!tool.inputSchema||typeof tool.inputSchema!=='object'||Array.isArray(tool.inputSchema)||(tool.inputSchema as JsonObject).type!=='object')throw Error('Invalid MCP tool schema');
    const exposed=`mcp_${config.id}_${allowed.name}`;
    if(exposed.length>64)throw Error('MCP tool name exceeds model limit');
    if(connector.registered.has(exposed))throw Error('Duplicate MCP tool name');
    const definition={name:exposed,description:(typeof tool.description==='string'&&tool.description.trim()?tool.description:allowed.name).slice(0,6000),input_schema:tool.inputSchema as JsonObject};
    connector.registered.set(exposed,{definition,server:config,remote:allowed.name,readOnly:allowed.readOnly,replay:replay?.niwaContextV1===true,signature:createHash('sha256').update(JSON.stringify([config,definition])).digest('hex')});
   }
   connector.servers.set(config.id,config);
  }
  return connector;
 }
 tools(sharedRoom:boolean){return [...this.registered.values()].filter(t=>sharedRoom||t.server.scope==='conversation').map(t=>t.definition);}
 tool(name:string,sharedRoom:boolean){const tool=this.registered.get(name);return tool&&(sharedRoom||tool.server.scope==='conversation')?tool:undefined;}
 async call(name:string,args:JsonObject,context:McpContext,signal?:AbortSignal):Promise<JsonObject>{
  const tool=this.registered.get(name);if(!tool)throw Error('MCP tool unavailable');
  if(!tool.readOnly&&context.allow_start===false&&!tool.replay)return {error:'outcome_unknown'};
  const result=await mcpRpc(tool.server.socket,'tools/call',{name:tool.remote,arguments:args,_meta:{'org.niwa/context':context}},signal);
  if(!Array.isArray(result.content)||result.content.length>100)throw Error('Invalid MCP result');
  return {...result,untrusted:true};
 }
 async resource(server:string,uri:string,scope:string){
  const config=this.servers.get(server);if(!config||uri.length>2048||this.downloads>=2)throw Error('MCP resource unavailable');
  this.downloads++;
  try{
   const result=await mcpRpc(config.socket,'resources/read',{uri,_meta:{'org.niwa/context':{scope,deadline:Date.now()+30000}}},undefined,90*1024*1024);
   if(!Array.isArray(result.contents)||result.contents.length!==1)throw Error('Invalid MCP resource');
   const item=result.contents[0] as JsonObject;if(item.uri!==uri)throw Error('MCP resource URI mismatch');
   const data=typeof item.blob==='string'?Buffer.from(item.blob,'base64'):typeof item.text==='string'?Buffer.from(item.text):undefined;
   if(!data||data.length>64*1024*1024||(typeof item.blob==='string'&&data.toString('base64')!==item.blob))throw Error('MCP resource too large or invalid');
   return {data,mime:typeof item.mimeType==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mimeType)?item.mimeType:'application/octet-stream'};
  }finally{this.downloads--;}
 }
}
