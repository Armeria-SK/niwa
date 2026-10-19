import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { assertDirectoryPath, initializeProduct, productPaths, type ProductPaths } from './paths.ts';
import { WebAuth } from '../web/auth.ts';
import {mcpServerSchema,mcpEndpointValid,type McpServerConfig} from '../tools/mcp/client.ts';
import {DomainError} from '../domain/types.ts';

const schema = Type.Object({ version: Type.Literal(1), origin: Type.String({ maxLength: 2048 }),
  mcpServers:Type.Optional(Type.Array(mcpServerSchema,{maxItems:8})),
  reasoningSummary: Type.Optional(Type.Boolean()),
  tailscaleLogins: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
  promptVersion: Type.Optional(Type.Union([Type.Literal('legacy-v4'),Type.Literal('structured-v5')])),
  /** How Bots read a long conversation: every message (full), every message while a 会話のまとめ is kept on the side (shadow), or the digest in place of older messages (digest). */
  roomContext: Type.Optional(Type.Union([Type.Literal('full'),Type.Literal('shadow'),Type.Literal('digest')])),
  port: Type.Integer({ minimum: 1, maximum: 65535 }), workspaceExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })),
  programExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })), browserExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })),
  workareasEnabled: Type.Optional(Type.Boolean()), packagesEnabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export type Installation = Static<typeof schema>;
const savedMcpSchema=Type.Object({version:Type.Literal(1),servers:Type.Array(mcpServerSchema,{maxItems:8})},{additionalProperties:false});
const ignoredLogged=new Set<string>();
/** Settings of removed features stay in older configs and backups; drop unknown top-level keys so they still load. Known keys stay strict. */
function withoutUnknownKeys(value: unknown, source: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const unknown = Object.keys(value).filter(key => !Object.hasOwn(schema.properties, key));
  if (!unknown.length) return value;
  const note = `${source}: ${unknown.sort().join(', ')}`;
  if (!ignoredLogged.has(note)) { ignoredLogged.add(note); console.error(`Ignoring unknown settings in ${note}`); }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !unknown.includes(key)));
}
function validate(input: unknown, source = 'config/niwa.json'): Installation {
  const value = withoutUnknownKeys(input, source);
  if (!Value.Check(schema, value)) throw new Error(`Invalid ${source}`);
  const config = value as Installation;
  const ids=new Set<string>();
  for(const server of config.mcpServers??[]){
    if(ids.has(server.id)||!mcpEndpointValid(server)||new Set(server.tools.map(t=>t.name)).size!==server.tools.length||server.tools.some(t=>`mcp_${server.id}_${t.name}`.length>64)||(server.enabled!==false&&!server.tools.length))throw new Error('Invalid MCP configuration');
    ids.add(server.id);
  }
  if(config.workareasEnabled&&!config.programExecutorUid)throw new Error('Workareas require the program executor');
  if (config.packagesEnabled && !config.programExecutorUid) throw new Error('Packages require the program executor');
  new WebAuth(config.origin, config.tailscaleLogins); // Same origin and account rules as the HTTP service.
  return config;
}
export function initializeInstallation(root: string, input: Installation): ProductPaths {
  const config = validate(input);
  const paths = initializeProduct(root);
  writeFileSync(join(paths.config, 'niwa.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return paths;
}
export function readInstallation(root: string): Installation {
  const paths=productPaths(root),file = join(paths.config, 'niwa.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size > 65_536) throw new Error('Invalid config/niwa.json');
  let raw:unknown;try{raw=JSON.parse(readFileSync(file, 'utf8'));}catch{throw new Error('Invalid config/niwa.json');}
  const config=validate(raw);
  // Fixed deployment settings stay read-only under systemd. UI-managed MCP settings
  // take precedence, including an empty list; legacy config is only the initial seed.
  assertDirectoryPath(paths.state);
  let fd:number;
  try{fd=openSync(join(paths.state,'mcp.json'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return config;throw error;}
  try{
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||info.size>65_536||(process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid!())))throw new Error('Unsafe state/mcp.json');
    let saved:unknown;try{saved=JSON.parse(readFileSync(fd,'utf8'));}catch{throw new Error('Invalid state/mcp.json');}
    if(!Value.Check(savedMcpSchema,saved))throw new Error('Invalid state/mcp.json');
    return validate({...config,mcpServers:saved.servers},'state/mcp.json');
  }finally{closeSync(fd);}
}
export const mcpConfigRevision=(servers:McpServerConfig[])=>createHash('sha256').update(JSON.stringify(servers)).digest('hex');
/** The service lock serializes writers; re-read to preserve unrelated installation settings. */
export function saveMcpInstallation(root:string,servers:McpServerConfig[],expected:string){
  const current=readInstallation(root);
  if(mcpConfigRevision(current.mcpServers??[])!==expected)throw new DomainError('conflict','MCP settings changed');
  const next={...current,mcpServers:servers};
  try{validate(next);}catch{throw new DomainError('invalid','Invalid MCP settings');}
  const text=JSON.stringify({version:1,servers},null,2)+'\n';if(Buffer.byteLength(text)>65_536)throw new DomainError('limit','MCP settings too large');
  const dir=productPaths(root).state,temp=join(dir,`.mcp-${randomUUID()}.tmp`);assertDirectoryPath(dir);
  const fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}catch(error){unlinkSync(temp);throw error;}finally{closeSync(fd);}
  try{renameSync(temp,join(dir,'mcp.json'));}catch(error){unlinkSync(temp);throw error;}
  if(process.platform!=='win32'){const directory=openSync(dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  return servers;
}
