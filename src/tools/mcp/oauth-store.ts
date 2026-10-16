import {constants,closeSync,fstatSync,fsyncSync,lstatSync,openSync,readdirSync,readSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {assertDirectoryPath} from '../../config/paths.ts';
import {mcpOAuthTokenSchema,mcpUrl,oauthUrl} from './client.ts';

const prefix='mcp-oauth-',limit=65536;
const idPart='([a-z][a-z0-9_]{0,19})',legacyName=new RegExp(`^mcp-oauth-${idPart}\\.json$`),namedFile=new RegExp(`^mcp-oauth-${idPart}-([0-9a-f]{16})\\.json$`),clientFile=new RegExp(`^mcp-oauth-${idPart}\\.client\\.json$`);
const method=Type.Union([Type.Literal('none'),Type.Literal('client_secret_post'),Type.Literal('client_secret_basic')]);
/** What a login leaves behind. Lives only in secrets/ (0600): tokens and the client secret never reach config, state, backups, logs or the browser. */
export const mcpOAuthSchema=Type.Object({version:Type.Literal(1),resource:Type.String({maxLength:500}),audience:Type.Optional(Type.String({maxLength:500})),redirect_uri:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]+$',maxLength:2048})),issuer:Type.String({maxLength:2048}),token_endpoint:Type.String({maxLength:2048}),
 client_id:Type.String({pattern:'^[\\x21-\\x7e]{1,512}$'}),client_secret:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]{1,4096}$'})),token_endpoint_auth_method:method,
 access_token:mcpOAuthTokenSchema,refresh_token:Type.Optional(mcpOAuthTokenSchema),expires_at:Type.Optional(Type.Integer({minimum:0,maximum:8_000_000_000_000_000})),lifetime:Type.Optional(Type.Integer({minimum:0,maximum:315_360_000})),
 scope:Type.Optional(Type.String({maxLength:2048,pattern:'^[\\x20-\\x7e]*$'})),revocation_endpoint:Type.Optional(Type.String({maxLength:2048}))},{additionalProperties:false});
export type McpOAuthCredential=Static<typeof mcpOAuthSchema>;
/** The client a login was made with, kept after logout so the next login needs neither a form nor a new registration. */
export const mcpOAuthClientSchema=Type.Object({version:Type.Literal(1),issuer:Type.String({maxLength:2048}),redirect_uri:Type.String({pattern:'^[\\x21-\\x7e]+$',maxLength:2048}),
 client_id:Type.String({pattern:'^[\\x21-\\x7e]{1,512}$'}),client_secret:Type.Optional(Type.String({pattern:'^[\\x21-\\x7e]{1,4096}$'})),token_endpoint_auth_method:method},{additionalProperties:false});
export type McpOAuthClient=Static<typeof mcpOAuthClientSchema>;
/** One file per connection ID and URL: a login made for another URL never replaces the one the saved connection uses. */
export const mcpOAuthFile=(id:string,resource:string)=>`${prefix}${id}-${createHash('sha256').update(resource).digest('hex').slice(0,16)}.json`;
const checked=(secrets:string,name:string)=>{if(!namedFile.test(name)&&!legacyName.test(name)&&!clientFile.test(name))throw Error('Invalid MCP server id');assertDirectoryPath(secrets);return join(secrets,name);};
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
function read(file:string):unknown{
 if(lstatSync(file).isSymbolicLink())throw Error('Unsafe MCP OAuth credential');
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>limit||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid!())))throw Error('Unsafe MCP OAuth credential');
  const bytes=Buffer.alloc(limit+1),length=readSync(fd,bytes,0,bytes.length,0);
  if(length>limit)throw Error('Invalid MCP OAuth credential');
  try{return JSON.parse(bytes.subarray(0,length).toString('utf8'));}catch{throw Error('Invalid MCP OAuth credential');}
 }finally{closeSync(fd);}
}
const readCredential=(file:string)=>{const value=read(file);check(value);return value;};
function replace(secrets:string,file:string,text:string|undefined){
 if(text===undefined)rmSync(file,{force:true});
 else{
  if(Buffer.byteLength(text)>limit)throw Error('Invalid MCP OAuth credential');
  const temp=join(secrets,`.${prefix}${randomUUID()}.tmp`),fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}catch(error){closeSync(fd);unlinkSync(temp);throw error;}
  closeSync(fd);
  try{renameSync(temp,file);}catch(error){unlinkSync(temp);throw error;}
 }
 if(process.platform!=='win32'){const dir=openSync(secrets,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
/** The login of one server for one URL, or undefined when there is none. An unsafe or invalid file throws: the caller treats it as "not logged in". A file from before logins were kept per URL counts for the URL it records. */
export function readMcpOAuth(secrets:string,id:string,resource:string){
 const file=checked(secrets,mcpOAuthFile(id,resource));
 try{const value=readCredential(file);if(value.resource!==resource)throw Error('Invalid MCP OAuth credential');return value;}catch(error){if(!missing(error))throw error;}
 try{const value=readCredential(checked(secrets,`${prefix}${id}.json`));return value.resource===resource?value:undefined;}catch(error){if(missing(error))return undefined;throw error;}
}
/** Every login file (valid or not): which server it belongs to and, when readable, what it holds. */
export function listMcpOAuth(secrets:string){
 assertDirectoryPath(secrets);
 let names:string[];try{names=readdirSync(secrets);}catch(error){if(missing(error))return [];throw error;}
 return names.flatMap(file=>{
  const id=namedFile.exec(file)?.[1]??legacyName.exec(file)?.[1];if(!id)return [];
  let credential:McpOAuthCredential|undefined;try{credential=readCredential(join(secrets,file));}catch{}
  return [{id,file,...(credential?{credential}:{})}];
 });
}
/** Atomically writes one login, for the URL it records. */
export function writeMcpOAuth(secrets:string,id:string,value:McpOAuthCredential){
 check(value);const file=checked(secrets,mcpOAuthFile(id,value.resource));
 replace(secrets,file,JSON.stringify(value));
 // A file of the old, per-server kind that held this same login is superseded.
 try{if(readMcpOAuthLegacy(secrets,id)?.resource===value.resource)replace(secrets,checked(secrets,`${prefix}${id}.json`),undefined);}catch{}
}
function readMcpOAuthLegacy(secrets:string,id:string){try{return readCredential(checked(secrets,`${prefix}${id}.json`));}catch{return undefined;}}
/** Removes the login of one server for one URL. */
export function removeMcpOAuth(secrets:string,id:string,resource:string){
 replace(secrets,checked(secrets,mcpOAuthFile(id,resource)),undefined);
 if(readMcpOAuthLegacy(secrets,id)?.resource===resource)replace(secrets,checked(secrets,`${prefix}${id}.json`),undefined);
}
/** Removes a login file by name, readable or not. */
export function removeMcpOAuthFile(secrets:string,file:string){replace(secrets,checked(secrets,file),undefined);}
export function readMcpOAuthClient(secrets:string,id:string){
 try{const value=read(checked(secrets,`${prefix}${id}.client.json`));if(!Value.Check(mcpOAuthClientSchema,value)||(value.token_endpoint_auth_method==='none')!==(value.client_secret===undefined))throw Error('Invalid MCP OAuth credential');return value;}
 catch(error){if(missing(error))return undefined;throw error;}
}
export function writeMcpOAuthClient(secrets:string,id:string,value:McpOAuthClient|undefined){
 const file=checked(secrets,`${prefix}${id}.client.json`);
 if(value===undefined)return replace(secrets,file,undefined);
 if(!Value.Check(mcpOAuthClientSchema,value)||(value.token_endpoint_auth_method==='none')!==(value.client_secret===undefined))throw Error('Invalid MCP OAuth credential');
 replace(secrets,file,JSON.stringify(value));
}
export function listMcpOAuthClients(secrets:string){
 assertDirectoryPath(secrets);
 try{return readdirSync(secrets).flatMap(name=>clientFile.exec(name)?.[1]??[]);}catch(error){if(missing(error))return [];throw error;}
}
