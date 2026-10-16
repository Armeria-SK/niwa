import {constants,closeSync,fstatSync,fsyncSync,lstatSync,openSync,readdirSync,readSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {assertDirectoryPath} from '../../config/paths.ts';
import {mcpOAuthTokenSchema,mcpUrl,oauthUrl} from './client.ts';

const prefix='mcp-oauth-',suffix='.json',limit=65536,fileName=/^mcp-oauth-([a-z][a-z0-9_]{0,19})\.json$/;
const method=Type.Union([Type.Literal('none'),Type.Literal('client_secret_post'),Type.Literal('client_secret_basic')]);
/** What a login leaves behind. Lives only in secrets/ (0600): tokens and the client secret never reach config, state, backups, logs or the browser. */
export const mcpOAuthSchema=Type.Object({version:Type.Literal(1),resource:Type.String({maxLength:500}),audience:Type.Optional(Type.String({maxLength:500})),redirect_uri:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]+$',maxLength:2048})),issuer:Type.String({maxLength:2048}),token_endpoint:Type.String({maxLength:2048}),
 client_id:Type.String({pattern:'^[\\x21-\\x7e]{1,512}$'}),client_secret:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]{1,4096}$'})),token_endpoint_auth_method:method,
 access_token:mcpOAuthTokenSchema,refresh_token:Type.Optional(mcpOAuthTokenSchema),expires_at:Type.Optional(Type.Integer({minimum:0,maximum:8_000_000_000_000_000})),
 scope:Type.Optional(Type.String({maxLength:2048,pattern:'^[\\x20-\\x7e]*$'})),revocation_endpoint:Type.Optional(Type.String({maxLength:2048}))},{additionalProperties:false});
export type McpOAuthCredential=Static<typeof mcpOAuthSchema>;
const path=(secrets:string,id:string)=>{if(!fileName.test(prefix+id+suffix))throw Error('Invalid MCP server id');return join(secrets,prefix+id+suffix);};
/** Structure plus the rules the rest of the code relies on: canonical resource, safe endpoints, a secret exactly when the method needs one. */
function check(value:unknown):asserts value is McpOAuthCredential{
 if(!Value.Check(mcpOAuthSchema,value))throw Error('Invalid MCP OAuth credential');
 const resource=mcpUrl(value.resource);
 if(!resource||resource.href!==value.resource)throw Error('Invalid MCP OAuth credential');
 const local=resource.protocol==='http:';
 // The audience sent as `resource` is the MCP URL itself, only the lone trailing slash may differ.
 if(value.audience!==undefined&&value.audience.replace(/\/$/,'')!==value.resource.replace(/\/$/,''))throw Error('Invalid MCP OAuth credential');
 for(const endpoint of [value.token_endpoint,value.revocation_endpoint,value.issuer])if(endpoint!==undefined&&!oauthUrl(endpoint,local))throw Error('Invalid MCP OAuth credential');
 if((value.token_endpoint_auth_method==='none')!==(value.client_secret===undefined))throw Error('Invalid MCP OAuth credential');
}
function read(file:string){
 if(lstatSync(file).isSymbolicLink())throw Error('Unsafe MCP OAuth credential');
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid!())))throw Error('Unsafe MCP OAuth credential');
  const bytes=Buffer.alloc(limit+1),length=readSync(fd,bytes,0,bytes.length,0);
  if(length>limit)throw Error('Invalid MCP OAuth credential');
  let value:unknown;try{value=JSON.parse(bytes.subarray(0,length).toString('utf8'));}catch{throw Error('Invalid MCP OAuth credential');}
  check(value);return value;
 }finally{closeSync(fd);}
}
/** The credential of one server, or undefined when there is none. An unsafe or invalid file throws: the caller treats it as "not logged in". */
export function readMcpOAuth(secrets:string,id:string){
 assertDirectoryPath(secrets);
 try{return read(path(secrets,id));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
/** Ids that have a credential file, valid or not. */
export function listMcpOAuth(secrets:string){
 assertDirectoryPath(secrets);
 try{return readdirSync(secrets).flatMap(name=>fileName.exec(name)?.[1]??[]);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
/** Atomically replaces (or with undefined removes) one server's credential. */
export function writeMcpOAuth(secrets:string,id:string,value:McpOAuthCredential|undefined){
 assertDirectoryPath(secrets);const file=path(secrets,id);
 if(value===undefined)rmSync(file,{force:true});
 else{
  check(value);const text=JSON.stringify(value);if(Buffer.byteLength(text)>limit)throw Error('Invalid MCP OAuth credential');
  const temp=join(secrets,`.${prefix}${randomUUID()}.tmp`),fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}catch(error){closeSync(fd);unlinkSync(temp);throw error;}
  closeSync(fd);
  try{renameSync(temp,file);}catch(error){unlinkSync(temp);throw error;}
 }
 if(process.platform!=='win32'){const dir=openSync(secrets,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
}
