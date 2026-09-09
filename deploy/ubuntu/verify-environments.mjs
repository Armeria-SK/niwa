import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [root,image,compiled]=process.argv.slice(2);
if(!compiled?.startsWith('/')||!root?.includes('/.environment-test-'))throw Error('Artificial stage required');
const load=path=>import(pathToFileURL(join(compiled,path)).href);
const {WorkareaStore}=await load('tools/workareas/store.js');
const {EnvironmentRegistry}=await load('tools/environments/registry.js');
const {PackageCatalog}=await load('tools/packages/catalog.js');
const {installPackages}=await load('tools/packages/install.js');
const {configuredProgramRunner}=await load('sandbox/program.js');
const uid=process.getuid(),gid=process.getgid(),home='/home/niwa/niwa/runtime/executor/home',runtime=`/run/user/${uid}`;
const clean=configuredProgramRunner({workspace:root,image,uid,gid,home,runtime});
const sha=b=>createHash('sha256').update(b).digest('hex');
mkdirSync(join(root,'catalog'),{mode:0o700});mkdirSync(join(root,'package','DEBIAN'),{recursive:true});
const version=`1.0-${Date.now()}`;
writeFileSync(join(root,'package','DEBIAN','control'),`Package: niwa-environment-acceptance\nVersion: ${version}\nArchitecture: all\nMaintainer: Niwa acceptance\nDescription: Artificial environment isolation test\n`);
execFileSync('/usr/bin/dpkg-deb',['--build',join(root,'package'),join(root,'catalog','test.deb')],{stdio:'ignore'});
writeFileSync(join(root,'catalog','catalog.json'),JSON.stringify([{name:'niwa-environment-acceptance',version,file:'test.deb',sha256:sha(readFileSync(join(root,'catalog','test.deb')))}]),{mode:0o600});
const catalog=new PackageCatalog(join(root,'catalog'));let adopted=null,installs=0,registry,store;
const open=()=>{
 registry=new EnvironmentRegistry(join(root,'environments.db'),image,catalog,async(base,name,entries,signal)=>{
  installs++;const stage=join(root,name);try{catalog.stage(entries.map(p=>p.name),stage);const result=await installPackages(base,stage,name,entries,clean.call,signal);if('image'in result)adopted=result.image;return result;}finally{rmSync(stage,{recursive:true,force:true});}
 },async id=>(await clean.call(['image','exists',id],15)).code===0);
 const storage=join(root,'workareas');mkdirSync(storage,{recursive:true,mode:0o711});chmodSync(storage,0o711);
 store=new WorkareaStore(storage,(workspace,request,signal,name,pinned)=>configuredProgramRunner({workspace,image:pinned??image,uid,gid,home,runtime})(request,signal,name),clean.cleanup,registry);
};
const epoch=randomUUID(),a=randomUUID(),b=randomUUID();
const invoke=(area,operation,args={})=>store.execute({area,epoch,operation,...args});
const operation=()=>({operation_id:randomUUID(),allow_start:true,seconds:20});
try{
 open();
 const definition={name:'人工の固定環境',base_image:image,catalog_revision:catalog.revision,dependencies:[],lockfiles:[{path:'lock.json',sha256:sha('{}')}],workdir:'/workspace',prepare:[],run:['python','-c',"import pathlib; assert pathlib.Path('/workspace/lock.json').read_text()=='{}'; print('locked version')"],verify:['python','-c','print("verified")'],profile:'standard'};
 const ids=[];
 for(const area of [a,b]){
  await invoke(area,'write',{...operation(),path:'lock.json',content:'{}'});
  const prepared=await invoke(area,'environment_prepare',{definition,allow_start:true});assert.equal(prepared.state,'ready');ids.push(prepared.id);
  assert.equal((await invoke(area,'environment_test',{...operation(),environment:prepared.id})).code,0);
  await invoke(area,'environment_activate',{environment:prepared.id,expected_environment:null});
 }
 const upgraded=await invoke(a,'environment_prepare',{definition:{...definition,dependencies:[{name:'niwa-environment-acceptance',version}]},allow_start:true});assert.equal(upgraded.state,'ready',JSON.stringify(upgraded));assert.notEqual(upgraded.image,image);
 assert.equal((await invoke(a,'environment_test',{...operation(),environment:upgraded.id})).code,0);
 await invoke(a,'environment_activate',{environment:upgraded.id,expected_environment:ids[0]});
 const request=operation(),first=await invoke(a,'environment_run',request);assert.equal(first.code,0);assert.equal(first.image,upgraded.image);
 store.close();registry.close();open();
 assert.deepEqual(await invoke(a,'environment_run',request),first);assert.equal(installs,1);
 const next=await invoke(a,'environment_run',operation());assert.equal(next.image,upgraded.image);assert.equal(next.stdout,first.stdout);
 const unchanged=await invoke(b,'environment_run',operation());assert.equal(unchanged.image,image);assert.equal(unchanged.code,0);
 const original=await clean.call(['image','exists',image],15);assert.equal(original.code,0);
 console.log('PASS: real offline preparation, project A/B image separation, fixed lockfile, new containers, reopen and receipt reuse; production adoption unchanged');
}finally{
 store?.close();registry?.close();
 if(adopted&&adopted!==image)assert.equal((await clean.call(['rmi',adopted],30)).code,0,'Remove only artificial derived image');
}
