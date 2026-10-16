import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {DomainError} from '../../domain/types.ts';
import {readInstallation,saveMcpInstallation,mcpConfigRevision} from '../../config/installation.ts';
import {McpConnector,mcpServerSchema,type McpServerConfig} from './client.ts';

export const mcpUpdateSchema=Type.Object({revision:Type.String({pattern:'^[a-f0-9]{64}$'}),servers:Type.Array(mcpServerSchema,{maxItems:8})},{additionalProperties:false});
export const mcpProbeSchema=Type.Pick(mcpServerSchema,['socket']);
const connectionMessage='接続できませんでした。サービスの起動、ソケットのパスと権限、対応する会話範囲・ツールを確認してください。';

/** Immutable connectors make configuration changes take effect at the next model step. Servers that failed to connect are retried with backoff while open. */
export class McpSettings{
 private busy=false;
 private closed=false;
 private applied='';
 private built='';
 private delay:number;
 private timer:NodeJS.Timeout|undefined;
 private last?:ReturnType<McpSettings['read']>;
 private constructor(private root:string,public connector:McpConnector,private saved:(servers:McpServerConfig[])=>void,private retry:{initial:number;max:number}){this.delay=retry.initial;}
 static async open(root:string,saved:(servers:McpServerConfig[])=>void=()=>{},retry={initial:5000,max:300000}){
  const settings=new McpSettings(root,await McpConnector.connect([]),saved,retry);
  const servers=readInstallation(root).mcpServers??[];
  settings.connector=await McpConnector.connect(servers,undefined,true);settings.adopt(servers);
  return settings;
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
 read(){
  const servers=readInstallation(this.root).mcpServers??[],revision=mcpConfigRevision(servers),failed=this.connector.failed().map(({id,reason})=>({id,reason}));
  return {available:true,revision,servers,connected:this.connector.connections(),failed,applied:revision===this.applied,error:failed.length?connectionMessage:null,busy:this.busy,tools:this.connector.tools(true).map(t=>({name:t.name,description:t.description}))};
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
  if(!Value.Check(mcpProbeSchema,input))throw new DomainError('invalid','Invalid MCP address');
  if(this.busy||this.closed)throw new DomainError('conflict','MCP connection in progress');
  this.busy=true;
  try{return {ok:true,...await McpConnector.discover(input.socket,AbortSignal.timeout(10000))};}
  catch{return {ok:false,message:connectionMessage};}
  finally{this.busy=false;}
 }
 async save(input:Static<typeof mcpUpdateSchema>){
  if(!Value.Check(mcpUpdateSchema,input))throw new DomainError('invalid','Invalid MCP settings');
  if(this.busy||this.closed||this.status().revision!==input.revision)throw new DomainError('conflict','MCP settings changed');
  const ids=new Set<string>();
  for(const server of input.servers){
   if(ids.has(server.id)||new Set(server.tools.map(t=>t.name)).size!==server.tools.length||server.tools.some(t=>`mcp_${server.id}_${t.name}`.length>64)||(server.enabled!==false&&!server.tools.length))throw new DomainError('invalid','Choose unique IDs and tools');
   ids.add(server.id);
  }
  this.busy=true;
  try{
   let next:McpConnector;
   try{next=await McpConnector.connect(input.servers,undefined,true);}
   catch{return {ok:false,message:connectionMessage};}
   // Servers already known to be down and unchanged do not block saving the rest.
   const known=this.connector.failed(),bad=next.failed().filter(f=>!known.some(k=>k.id===f.id&&JSON.stringify(k.config)===JSON.stringify(f.config)));
   if(bad.length){next.retire();return {ok:false,message:`${connectionMessage}（${bad.map(f=>`${f.id}: ${f.reason}`).join(' / ').slice(0,300)}）`};}
   if(this.closed){next.retire();throw new DomainError('conflict','MCP service closing');}
   let servers:McpServerConfig[];
   try{servers=saveMcpInstallation(this.root,input.servers,input.revision);}
   catch(error){
    next.retire();
    if(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException).code??''))return {ok:false,message:'MCP設定を保存できませんでした。Niwaの保存先の書き込み権限と空き容量を確認してください。'};
    throw error;
   }
   this.connector.retire();this.connector=next;this.adopt(servers);this.saved(servers);
   return {ok:true,...this.status(),busy:false};
  }finally{this.busy=false;}
 }
 close(){this.closed=true;clearTimeout(this.timer);this.timer=undefined;this.connector.retire();}
}
