import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EnvironmentRegistry,type EnvironmentDefinition} from '../src/tools/environments/registry.ts';
import {PackageCatalog} from '../src/tools/packages/catalog.ts';
import {WorkareaStore} from '../src/tools/workareas/store.ts';
const base=`sha256:${'a'.repeat(64)}`,derived=`sha256:${'b'.repeat(64)}`;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function setup(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'niwa-env-'));mkdirSync(join(root,'catalog'),{mode:0o700});mkdirSync(join(root,'workareas'));
 writeFileSync(join(root,'catalog','catalog.json'),JSON.stringify([{name:'example',version:'1.0',file:'example.deb',sha256:sha('package')}]),{mode:0o600});
 const catalog=new PackageCatalog(join(root,'catalog'));let installs=0;
 const open=()=>new EnvironmentRegistry(join(root,'env.db'),base,catalog,async image=>{assert.equal(image,base);installs++;return {image:derived,installed:[{name:'example',version:'1.0'}]};},async()=>true);
 let registry=open();const epoch=randomUUID(),area=randomUUID(),other=randomUUID();
 const definition:EnvironmentDefinition={name:'人工環境',base_image:base,catalog_revision:catalog.revision,dependencies:[],lockfiles:[{path:'lock.json',sha256:sha('{}')}],workdir:'/workspace',prepare:[],run:['python','main.py'],verify:['python','-c','pass'],profile:'standard'};
 t.after(()=>{registry.close();rmSync(root,{recursive:true,force:true});});
 return {root,epoch,area,other,definition,get registry(){return registry;},get installs(){return installs;},reopen(){registry.close();registry=open();}};
}
test('area-local immutable definitions survive reopen without touching another area or reinstalling',async t=>{
 const f=setup(t);const a=await f.registry.prepare(f.area,f.epoch,f.definition,true),b=await f.registry.prepare(f.other,f.epoch,f.definition,true);
 assert.ok('id' in a&&'id' in b);assert.notEqual(a.id,b.id);
 f.registry.tested(f.area,f.epoch,a.id,'r1');f.registry.activate(f.area,f.epoch,a.id,null);
 f.registry.tested(f.other,f.epoch,b.id,'r1');f.registry.activate(f.other,f.epoch,b.id,null);
 const next=await f.registry.prepare(f.area,f.epoch,{...f.definition,dependencies:[{name:'example',version:'1.0'}]},true);assert.ok('id' in next);
 assert.throws(()=>f.registry.activate(f.area,f.epoch,next.id,a.id));
 f.registry.tested(f.area,f.epoch,next.id,'r2');assert.throws(()=>f.registry.activate(f.area,f.epoch,next.id,null));
 f.registry.activate(f.area,f.epoch,next.id,a.id);f.reopen();
 assert.equal((await f.registry.resolve(f.area,f.epoch)).image,derived);assert.equal((await f.registry.resolve(f.other,f.epoch)).image,base);
 assert.deepEqual((await f.registry.resolve(f.area,f.epoch)).definition.lockfiles,f.definition.lockfiles);
 assert.equal((await f.registry.prepare(f.area,f.epoch,{...f.definition,dependencies:[{name:'example',version:'1.0'}]},true) as {id:string}).id,next.id);assert.equal(f.installs,1);
 assert.throws(()=>f.registry.get(f.other,f.epoch,next.id));assert.throws(()=>f.registry.get(f.area,randomUUID(),next.id));
});
test('unknown dependencies wait explicitly, inputs cannot select mounts or foreign base images',async t=>{
 const f=setup(t);
 const missing=await f.registry.prepare(f.area,f.epoch,{...f.definition,dependencies:[{name:'missing',version:'9'}]},true);
 assert.deepEqual(missing,{state:'waiting_preparation',missing:[{name:'missing',version:'9'}],catalog_revision:f.definition.catalog_revision});assert.equal(f.installs,0);
 for(const definition of [{...f.definition,base_image:derived},{...f.definition,workdir:'/home/niwa'},{...f.definition,lockfiles:[{path:'../secrets',sha256:sha('')}]},{...f.definition,env:{TOKEN:'synthetic'}}])await assert.rejects(f.registry.prepare(f.area,f.epoch,definition,true));
 assert.deepEqual(await f.registry.prepare(f.area,f.epoch,f.definition,false),{error:'outcome_unknown'});
});
test('snapshot test and pinned runs check lockfiles, retain candidates and prevent silent overwrites',async t=>{
 const f=setup(t);let calls=0;const images:(string|undefined)[]=[];
 const store=new WorkareaStore(join(f.root,'workareas'),async(root,request,_signal,_name,image)=>{calls++;images.push(image);if(request.command[1]==='main.py')writeFileSync(join(root,'result.txt'),'synthetic output');return {code:0,stdout:'ok',stderr:''};},async()=>{},f.registry);t.after(()=>store.close());
 const scope={area:f.area,epoch:f.epoch};
 const write=()=>store.execute({...scope,operation:'write',operation_id:randomUUID(),allow_start:true,path:'lock.json',content:'{}',expected_revision:null});await write();
 const version=await store.execute({...scope,operation:'environment_prepare',definition:f.definition,allow_start:true});assert.ok(version.id);
 assert.equal((await store.execute({...scope,operation:'environment_activate',operation_id:randomUUID(),allow_start:true,environment:version.id as string,expected_environment:null})).error,'workarea_changed_retest_required');
 const tested=await store.execute({...scope,operation:'environment_test',environment:version.id as string,operation_id:randomUUID(),allow_start:true,seconds:5});assert.equal(tested.code,0);assert.equal(tested.candidate,undefined);
 await store.execute({...scope,operation:'environment_activate',operation_id:randomUUID(),allow_start:true,environment:version.id as string,expected_environment:null});
 const run={...scope,operation:'environment_run',operation_id:randomUUID(),allow_start:true,seconds:5};const result=await store.execute(run);assert.equal(result.image,base);assert.ok(result.candidate);
 assert.deepEqual(await store.execute(run),result);assert.equal(calls,3);assert.deepEqual(images,[base,base,base]);
 await store.execute({...scope,operation:'write',path:'parallel',content:'other Bot',expected_revision:null,allow_start:true,operation_id:randomUUID()});
 assert.equal((await store.execute({...scope,operation:'commit',candidate:result.candidate as string,expected_revision:result.base_revision as string})).error,'conflict');
 assert.equal((await store.execute({...scope,operation:'environment_activate',operation_id:randomUUID(),allow_start:true,environment:version.id as string,expected_environment:null})).error,'workarea_changed_retest_required');
 await store.execute({...scope,operation:'write',path:'lock.json',content:'changed',expected_revision:sha('{}'),allow_start:true,operation_id:randomUUID()});
 assert.equal((await store.execute({...run,operation_id:randomUUID()})).error,'conflict');assert.equal(calls,3);
});
test('preparation response loss is durable and does not trigger a new installation',async t=>{
 const f=setup(t);let calls=0;
 const registry=new EnvironmentRegistry(join(f.root,'failure.db'),base,new PackageCatalog(join(f.root,'catalog')),async()=>{calls++;throw Error('connection lost');},async()=>true);t.after(()=>registry.close());
 const def={...f.definition,dependencies:[{name:'example',version:'1.0'}]};
 const first=await registry.prepare(f.area,f.epoch,def,true);assert.equal('state' in first&&first.state,'outcome_unknown');
 assert.deepEqual(await registry.prepare(f.area,f.epoch,def,true),first);assert.equal(calls,1);
});

test('two Bot leases share only the selected project environment and retain private/independent boundaries',async t=>{
 const {Runtime}=await import('../src/runtime/runtime.ts');const {executeAsyncTurnTool}=await import('../src/runtime/turn-tools.ts');
 const f=setup(t),r=new Runtime(join(f.root,'state')),admin=r.administrator(),a=r.bootstrap(admin),aa=r.agentSession(a.id),b=r.createAgent(aa,'B'),ba=r.agentSession(b.id),room=r.createRoom(admin,'人工案件');
 const store=new WorkareaStore(join(f.root,'workareas'),async()=>({code:0,stdout:'verified',stderr:''}),async()=>{},f.registry);
 t.after(()=>{store.close();r.close();});r.workareas.enable(admin,true);
 r.tasks.create(admin,a.id,room.id,'A');const al=r.tasks.claim(admin)!;r.tasks.create(admin,b.id,room.id,'B');const bl=r.tasks.claim(admin)!;
 const project=await r.workareas.project(admin,{name:'共同案件',room_id:room.id,members:[a.id,b.id]});
 r.workareas.select(aa,al,project.id);r.workareas.select(ba,bl,project.id);
 const external={workareas:(input:import('../src/tools/workareas/store.ts').WorkareaRequest,signal?:AbortSignal)=>store.execute(input,signal)};
 const call=(actor:typeof aa,lease:typeof al,name:string,args:Record<string,unknown>={})=>executeAsyncTurnTool(r,actor,lease,{name,arguments:args,tool_call_id:randomUUID()},randomUUID(),undefined,external);
 const prepared=await call(aa,al,'environment_prepare',{definition:{...f.definition,lockfiles:[]}});assert.equal(prepared.state,'ready');
 assert.equal((await call(ba,bl,'environment_test',{environment:prepared.id,seconds:5})).code,0);
 assert.equal((await call(ba,bl,'environment_activate',{environment:prepared.id,expected_environment:null})).active,prepared.id);
 assert.equal((await call(aa,al,'environment_run',{seconds:5})).image,base);
 const personal=r.workareas.personal(aa,al).area_id!;
 assert.equal((await call(aa,al,'environment_list')).active,null);
 assert.ok((await call(aa,al,'environment_test',{environment:prepared.id,seconds:5})).error);
 await r.workareas.project(admin,{id:project.id,name:'共同案件',room_id:room.id,members:[a.id],expected_revision:1});
 assert.ok((await call(ba,bl,'environment_list')).error);
 assert.throws(()=>r.workareas.select(ba,bl,personal));
 r.workareas.enable(admin,false);assert.ok((await call(aa,al,'environment_list')).error);
});

test('canonical definitions deduplicate reordered keys; deleted areas erase definitions but retain no-replay tombstones',async t=>{
 const f=setup(t);const first=await f.registry.prepare(f.area,f.epoch,f.definition,true);assert.ok('id' in first);
 const reordered=Object.fromEntries(Object.entries(f.definition).reverse());
 assert.equal((await f.registry.prepare(f.area,f.epoch,reordered,true) as {id:string}).id,first.id);
 f.registry.purgeArea(f.area);assert.equal(f.registry.active(f.area,f.epoch),null);
 const retired=f.registry.get(f.area,f.epoch,first.id);assert.equal(retired.state,'retired');assert.deepEqual(retired.definition,{});
 await assert.rejects(f.registry.resolve(f.area,f.epoch,first.id));
 assert.equal((await f.registry.prepare(f.area,f.epoch,f.definition,true) as {state:string}).state,'retired');assert.equal(f.installs,0);
});

test('adoption receipts never roll back a newer selection or execute an unrecorded retry',async t=>{
 const f=setup(t),a=await f.registry.prepare(f.area,f.epoch,f.definition,true),b=await f.registry.prepare(f.area,f.epoch,{...f.definition,name:'new version'},true);assert.ok('id' in a&&'id' in b);
 f.registry.tested(f.area,f.epoch,a.id,'revision');f.registry.tested(f.area,f.epoch,b.id,'revision');
 const op=randomUUID();assert.deepEqual(f.registry.activate(f.area,f.epoch,a.id,null,op,false),{error:'outcome_unknown'});assert.equal(f.registry.active(f.area,f.epoch),null);
 assert.deepEqual(f.registry.activate(f.area,f.epoch,a.id,null,op,true),{active:a.id});
 f.registry.activate(f.area,f.epoch,b.id,a.id);f.reopen();
 assert.deepEqual(f.registry.activate(f.area,f.epoch,a.id,null,op,false),{active:a.id});assert.equal(f.registry.active(f.area,f.epoch),b.id);
 assert.throws(()=>f.registry.activate(f.area,f.epoch,b.id,null,op,false));
});

test('collection keeps shared images until every version is retired, old and unreferenced',async t=>{
 const f=setup(t),definition={...f.definition,dependencies:[{name:'example',version:'1.0'}]};
 const a=await f.registry.prepare(f.area,f.epoch,definition,true),b=await f.registry.prepare(f.other,f.epoch,definition,true);assert.ok('id' in a&&'id' in b);
 f.registry.retire(f.area,f.epoch,a.id);let removed=0;const remove=async(image:string)=>{assert.equal(image,derived);removed++;return true;};
 await f.registry.collect(remove,()=>false,Date.now()+90000000);assert.equal(removed,0);
 f.registry.retire(f.other,f.epoch,b.id);await f.registry.collect(remove,()=>false);assert.equal(removed,0);
 await f.registry.collect(remove,id=>id===b.id,Date.now()+90000000);assert.equal(removed,0);
 await f.registry.collect(remove,()=>false,Date.now()+90000000);assert.equal(removed,1);
});
