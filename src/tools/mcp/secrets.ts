import {constants,closeSync,fstatSync,fsyncSync,lstatSync,openSync,readdirSync,readSync,renameSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertDirectoryPath} from '../../config/paths.ts';
import {mcpTokenSchema} from './client.ts';

const prefix='mcp-token-',token=new RegExp(mcpTokenSchema.pattern!),fileName=/^mcp-token-([a-z][a-z0-9_]{0,19})$/;
const path=(secrets:string,id:string)=>{if(!fileName.test(prefix+id))throw Error('Invalid MCP server id');return join(secrets,prefix+id);};
function read(file:string){
 if(lstatSync(file).isSymbolicLink())throw Error('Unsafe MCP credential');
 const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>4096||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid!())))throw Error('Unsafe MCP credential');
  const bytes=Buffer.alloc(4097),length=readSync(fd,bytes,0,bytes.length,0),value=bytes.subarray(0,length).toString('utf8');
  if(length>4096||!token.test(value))throw Error('Invalid MCP credential');
  return value;
 }finally{closeSync(fd);}
}
/** Remote MCP credentials live beside other product secrets (0600, never in config/state or backups), one file per server id.
 * A bad file only loses its own server's credential: with `bad` the id is reported there and reading goes on, without it the error is thrown. */
export function readMcpTokens(secrets:string,bad?:string[]){
 assertDirectoryPath(secrets);const tokens:Record<string,string>={};
 let names:string[];try{names=readdirSync(secrets);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return tokens;throw error;}
 for(const name of names){
  const id=fileName.exec(name)?.[1];if(!id)continue;
  try{tokens[id]=read(join(secrets,name));}catch(error){if(!bad)throw error;bad.push(id);}
 }
 return tokens;
}
/** Atomically replaces (or with undefined removes) one server's credential. */
export function writeMcpToken(secrets:string,id:string,value:string|undefined){
 assertDirectoryPath(secrets);const file=path(secrets,id);
 if(value===undefined){rmSync(file,{force:true});}
 else{
  if(!token.test(value))throw Error('Invalid MCP credential');
  const temp=join(secrets,`.${prefix}${randomUUID()}.tmp`),fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,value);fsyncSync(fd);}catch(error){closeSync(fd);unlinkSync(temp);throw error;}
  closeSync(fd);
  try{renameSync(temp,file);}catch(error){unlinkSync(temp);throw error;}
 }
 if(process.platform!=='win32'){const dir=openSync(secrets,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
}
