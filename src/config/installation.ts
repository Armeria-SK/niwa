import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { initializeProduct, productPaths, type ProductPaths } from './paths.ts';
import { WebAuth } from '../web/auth.ts';
import {mcpServerSchema,type McpServerConfig} from '../tools/mcp/client.ts';
import {DomainError} from '../domain/types.ts';

const schema = Type.Object({ version: Type.Literal(1), origin: Type.String({ maxLength: 2048 }),
  mcpServers:Type.Optional(Type.Array(mcpServerSchema,{maxItems:8})),
  reasoningSummary: Type.Optional(Type.Boolean()),
  promptVersion: Type.Optional(Type.Union([Type.Literal('legacy-v4'),Type.Literal('structured-v5')])),
  port: Type.Integer({ minimum: 1, maximum: 65535 }), workspaceExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })),
  programExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })), browserExecutorUid: Type.Optional(Type.Integer({ minimum: 1 })),
  workareasEnabled: Type.Optional(Type.Boolean()), packagesEnabled: Type.Optional(Type.Boolean()), xAccountId: Type.Optional(Type.String({ pattern: '^[0-9]{1,19}$' })) }, { additionalProperties: false });
export type Installation = Static<typeof schema>;
function validate(value: unknown): Installation {
  if (!Value.Check(schema, value)) throw new Error('Invalid config/niwa.json');
  const config = value as Installation;
  const ids=new Set<string>();
  for(const server of config.mcpServers??[]){
    if(ids.has(server.id)||new Set(server.tools.map(t=>t.name)).size!==server.tools.length||server.tools.some(t=>`mcp_${server.id}_${t.name}`.length>64)||(server.enabled!==false&&!server.tools.length))throw new Error('Invalid MCP configuration');
    ids.add(server.id);
  }
  if(config.workareasEnabled&&!config.programExecutorUid)throw new Error('Workareas require the program executor');
  if (config.packagesEnabled && !config.programExecutorUid) throw new Error('Packages require the program executor');
  new WebAuth(config.origin, 'a'.repeat(43)); // Same origin rules as the HTTP service.
  return config;
}
export function initializeInstallation(root: string, config: Installation): ProductPaths {
  validate(config);
  const paths = initializeProduct(root);
  writeFileSync(join(paths.config, 'niwa.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return paths;
}
export function readInstallation(root: string): Installation {
  const file = join(productPaths(root).config, 'niwa.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size > 65_536) throw new Error('Invalid config/niwa.json');
  return validate(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}
export const mcpConfigRevision=(servers:McpServerConfig[])=>createHash('sha256').update(JSON.stringify(servers)).digest('hex');
/** The service lock serializes writers; re-read to preserve unrelated installation settings. */
export function saveMcpInstallation(root:string,servers:McpServerConfig[],expected:string){
  const current=readInstallation(root);
  if(mcpConfigRevision(current.mcpServers??[])!==expected)throw new DomainError('conflict','MCP settings changed');
  const next={...current,mcpServers:servers};
  try{validate(next);}catch{throw new DomainError('invalid','Invalid MCP settings');}
  const text=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(text)>65_536)throw new DomainError('limit','Installation too large');
  const dir=productPaths(root).config,temp=join(dir,`.mcp-${randomUUID()}.tmp`);
  const fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,text);fsyncSync(fd);}catch(error){unlinkSync(temp);throw error;}finally{closeSync(fd);}
  try{renameSync(temp,join(dir,'niwa.json'));}catch(error){unlinkSync(temp);throw error;}
  if(process.platform!=='win32'){const directory=openSync(dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  return servers;
}
/** Invoke under the product process lock. No key is sent to logs or model context. */
export function adminKey(paths: ProductPaths): string {
  const file = join(paths.secrets, 'admin-key');
  try {
    const descriptor = openSync(file, 'wx', 0o600);
    try { writeFileSync(descriptor, randomBytes(32).toString('base64url')); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 43
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unsafe admin key file');
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const key = readFileSync(descriptor, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid admin key file');
    return key;
  } finally { closeSync(descriptor); }
}
