import {createHash, randomUUID} from 'node:crypto';
import {Type, type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {openDatabase, transaction} from '../../storage/database.ts';
import {WorkspaceError} from '../files/workspace.ts';
import type {PackageCatalog, ApprovedPackage} from '../packages/catalog.ts';
import type {PackageResult} from '../packages/install.ts';

const object = <T extends Parameters<typeof Type.Object>[0]>(properties:T)=>Type.Object(properties,{additionalProperties:false});
const sha=Type.String({pattern:'^[a-f0-9]{64}$'});
const command=Type.Array(Type.String({maxLength:4096,pattern:'^[^\\u0000]*$'}),{minItems:1,maxItems:128});
export const environmentDefinitionSchema=object({
 name:Type.String({minLength:1,maxLength:100}),
 base_image:Type.String({pattern:'^sha256:[a-f0-9]{64}$'}),
 catalog_revision:sha,
 dependencies:Type.Array(object({name:Type.String({pattern:'^[a-z0-9][a-z0-9+.-]{1,127}$'}),version:Type.String({pattern:'^[A-Za-z0-9.+:~_-]{1,128}$'})}),{maxItems:64}),
 lockfiles:Type.Array(object({path:Type.String({minLength:1,maxLength:512}),sha256:sha}),{maxItems:16}),
 workdir:Type.Literal('/workspace'),
 prepare:Type.Array(command,{maxItems:8}),run:command,verify:command,
 profile:Type.Literal('standard'),
});
export type EnvironmentDefinition=Static<typeof environmentDefinitionSchema>;
export interface EnvironmentVersion {id:string;area:string;epoch:string;definition:EnvironmentDefinition;image:string|null;state:'preparing'|'ready'|'failed'|'outcome_unknown'|'retired';tested_revision:string|null}
type Installer=(image:string,name:string,entries:ApprovedPackage[],signal?:AbortSignal)=>Promise<PackageResult>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Executor-owned, immutable definitions and area-local adoption. Never updates PackageLog.currentImage. */
export class EnvironmentRegistry {
 private db;
 private busy=false;
 constructor(path:string,readonly baseImage:string,private catalog:PackageCatalog,private install:Installer,private exists:(image:string)=>Promise<boolean>){
  if(!/^sha256:[a-f0-9]{64}$/.test(baseImage))throw Error('Fixed base image required');
  this.db=openDatabase(path,`CREATE TABLE versions(id TEXT PRIMARY KEY,area TEXT NOT NULL,epoch TEXT NOT NULL,definition TEXT NOT NULL,image TEXT,state TEXT NOT NULL,container TEXT NOT NULL,tested_revision TEXT) STRICT;
   CREATE TABLE selections(area TEXT PRIMARY KEY,epoch TEXT NOT NULL,version TEXT NOT NULL REFERENCES versions(id)) STRICT;`);
  this.db.exec('PRAGMA synchronous=FULL');
 }
 close(){this.db.close();}
 pendingArea(area:string){return !!this.db.prepare("SELECT 1 FROM versions WHERE area=? AND state='preparing'").get(area);}
 purgeArea(area:string){transaction(this.db,()=>{
  this.db.prepare('DELETE FROM selections WHERE area=?').run(area);
  // Keep replay tombstones and image references, erase commands and dependency/lockfile metadata.
  this.db.prepare("UPDATE versions SET definition='{}',state='retired',tested_revision=NULL WHERE area=?").run(area);
 });}
 pending(){return this.db.prepare("SELECT container FROM versions WHERE state='preparing'").all().map(row=>String(row.container));}
 recovered(){this.db.prepare("UPDATE versions SET state='outcome_unknown' WHERE state='preparing'").run();}
 list(area:string,epoch:string){return {base_image:this.baseImage,catalog_revision:this.catalog.revision,catalog:this.catalog.list(),profiles:[{name:'standard',memory_mib:512,cpu:1,pids:64,seconds:300}],active:this.active(area,epoch),versions:this.db.prepare('SELECT id FROM versions WHERE area=? AND epoch=? ORDER BY rowid').all(area,epoch).map(row=>this.get(area,epoch,String(row.id)))};}
 get(area:string,epoch:string,id:string):EnvironmentVersion{
  const row=this.db.prepare('SELECT * FROM versions WHERE id=? AND area=? AND epoch=?').get(id,area,epoch);
  if(!row)throw new WorkspaceError('invalid_path');
  return {id,area,epoch,definition:JSON.parse(String(row.definition)),image:row.image as string|null,state:row.state as EnvironmentVersion['state'],tested_revision:row.tested_revision as string|null};
 }
 active(area:string,epoch:string){return this.db.prepare('SELECT version FROM selections WHERE area=? AND epoch=?').get(area,epoch)?.version as string??null;}
 async prepare(area:string,epoch:string,input:unknown,allowStart:boolean,signal?:AbortSignal){
  if(!Value.Check(environmentDefinitionSchema,input))throw new WorkspaceError('unsupported');
  const definition:EnvironmentDefinition={...input,dependencies:[...input.dependencies].sort((a,b)=>a.name.localeCompare(b.name)),lockfiles:[...input.lockfiles].sort((a,b)=>a.path.localeCompare(b.path))};
  if(definition.base_image!==this.baseImage||new Set(definition.dependencies.map(d=>d.name)).size!==definition.dependencies.length||new Set(definition.lockfiles.map(f=>f.path)).size!==definition.lockfiles.length||definition.lockfiles.some(f=>f.path.startsWith('/')||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f]/.test(f.path)))throw new WorkspaceError('invalid_path');
  const encoded=JSON.stringify({name:definition.name,base_image:definition.base_image,catalog_revision:definition.catalog_revision,dependencies:definition.dependencies.map(({name,version})=>({name,version})),lockfiles:definition.lockfiles.map(({path,sha256})=>({path,sha256})),workdir:definition.workdir,prepare:definition.prepare,run:definition.run,verify:definition.verify,profile:definition.profile}),id=hash(JSON.stringify([area,epoch,encoded]));
  const prior=this.db.prepare('SELECT id FROM versions WHERE id=?').get(id);
  if(prior)return this.get(area,epoch,id);
  if(!allowStart)return {error:'outcome_unknown'};
  const available=this.catalog.list();
  const missing=definition.dependencies.filter(d=>!available.some(e=>e.name===d.name&&e.version===d.version));
  if(missing.length||definition.catalog_revision!==this.catalog.revision)return {state:'waiting_preparation',missing,catalog_revision:this.catalog.revision};
  if(this.busy)return {error:'preparation_busy'};
  signal?.throwIfAborted();
  const entries=definition.dependencies.length?this.catalog.select(definition.dependencies.map(d=>d.name)):[];
  const name=`niwa-package-${randomUUID()}`;
  this.db.prepare("INSERT INTO versions VALUES (?,?,?,?,NULL,'preparing',?,NULL)").run(id,area,epoch,encoded,name);
  this.busy=true;
  try{
   if(!await this.exists(this.baseImage))throw Error('Base image missing');
   const result=entries.length?await this.install(this.baseImage,name,entries,signal):{image:this.baseImage,installed:[]};
   signal?.throwIfAborted();
   if('error' in result)this.db.prepare("UPDATE versions SET state='failed' WHERE id=?").run(id);
   else {
    if(!/^sha256:[a-f0-9]{64}$/.test(result.image)||!await this.exists(result.image))throw Error('Prepared image missing');
    this.db.prepare("UPDATE versions SET image=?,state='ready' WHERE id=?").run(result.image,id);
   }
  }catch{this.db.prepare("UPDATE versions SET state='outcome_unknown' WHERE id=?").run(id);}
  finally{this.busy=false;}
  return this.get(area,epoch,id);
 }
 async resolve(area:string,epoch:string,id?:string){
  const selected=id??this.active(area,epoch);
  if(!selected)throw new WorkspaceError('unsupported');
  const version=this.get(area,epoch,selected);
  if(version.state!=='ready'||!version.image||!await this.exists(version.image))throw new WorkspaceError('unsupported');
  return version as EnvironmentVersion & {image:string};
 }
 tested(area:string,epoch:string,id:string,revision:string){this.get(area,epoch,id);this.db.prepare('UPDATE versions SET tested_revision=? WHERE id=?').run(revision,id);}
 activate(area:string,epoch:string,id:string,expected:string|null){
  return transaction(this.db,()=>{
   const version=this.get(area,epoch,id);
   if(version.state!=='ready'||!version.tested_revision)throw new WorkspaceError('unsupported');
   if(this.active(area,epoch)===id)return {active:id};
   if(this.active(area,epoch)!==expected)throw new WorkspaceError('conflict');
   this.db.prepare('INSERT INTO selections VALUES (?,?,?) ON CONFLICT(area) DO UPDATE SET epoch=excluded.epoch,version=excluded.version').run(area,epoch,id);
   return {active:id};
  });
 }
}
