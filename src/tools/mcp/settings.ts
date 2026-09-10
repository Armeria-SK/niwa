import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {DomainError} from '../../domain/types.ts';
import {readInstallation,saveMcpInstallation,mcpConfigRevision} from '../../config/installation.ts';
import {McpConnector,mcpServerSchema,type McpServerConfig} from './client.ts';

export const mcpUpdateSchema=Type.Object({revision:Type.String({pattern:'^[a-f0-9]{64}$'}),servers:Type.Array(mcpServerSchema,{maxItems:8})},{additionalProperties:false});
export const mcpProbeSchema=Type.Pick(mcpServerSchema,['socket']);
const connectionMessage='接続できませんでした。サービスの起動、ソケットのパスと権限、対応する会話範囲・ツールを確認してください。';

/** Immutable connectors make configuration changes take effect at the next model step. */
export class McpSettings{
 private busy=false;
 private closed=false;
 private failure:string|null=null;
 private applied='';
 private constructor(private root:string,public connector:McpConnector,private saved:(servers:McpServerConfig[])=>void){}
 static async open(root:string,saved:(servers:McpServerConfig[])=>void=()=>{}){
  const settings=new McpSettings(root,await McpConnector.connect([]),saved);
  const servers=readInstallation(root).mcpServers??[];
  try{settings.connector=await McpConnector.connect(servers,AbortSignal.timeout(10000));settings.applied=mcpConfigRevision(servers);}
  catch{settings.failure=connectionMessage;}
  return settings;
 }
 status(){
  const servers=readInstallation(this.root).mcpServers??[],revision=mcpConfigRevision(servers);
  return {available:true,revision,servers,connected:this.connector.connections(),applied:revision===this.applied,error:this.failure,busy:this.busy,tools:this.connector.tools(true).map(t=>({name:t.name,description:t.description}))};
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
   try{next=await McpConnector.connect(input.servers,AbortSignal.timeout(10000));}
   catch{return {ok:false,message:connectionMessage};}
   if(this.closed)throw new DomainError('conflict','MCP service closing');
   let servers:McpServerConfig[];
   try{servers=saveMcpInstallation(this.root,input.servers,input.revision);}
   catch(error){
    next.retire();
    if(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException).code??''))return {ok:false,message:'MCP設定を保存できませんでした。Niwaの保存先の書き込み権限と空き容量を確認してください。'};
    throw error;
   }
   this.connector.retire();this.connector=next;this.applied=mcpConfigRevision(servers);this.failure=null;this.saved(servers);
   return {ok:true,...this.status(),busy:false};
  }finally{this.busy=false;}
 }
 close(){this.closed=true;this.connector.retire();}
}
