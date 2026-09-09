import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,cpSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const [root,image,compiled,mode,browserBase]=process.argv.slice(2);
if(!root?.includes('/.execution-test-')||!compiled?.startsWith('/'))throw Error('Artificial execution test root required');
const load=p=>import(pathToFileURL(join(compiled,p)).href);
const {WorkareaStore}=await load('tools/workareas/store.js'),{EnvironmentRegistry}=await load('tools/environments/registry.js'),{PackageCatalog}=await load('tools/packages/catalog.js'),{ResourcePool,standardProfile}=await load('sandbox/resources.js'),{managedProgramRunner}=await load('sandbox/managed.js'),{configuredProgramRunner}=await load('sandbox/program.js'),{configuredBrowserRunner}=await load('sandbox/browser.js'),{isolatedPreview}=await load('sandbox/preview.js');
const uid=process.getuid(),gid=process.getgid(),home='/home/niwa/niwa/runtime/executor/home',runtime=`/run/user/${uid}`;
const env={workspace:root,image,uid,gid,home,runtime},clean=configuredProgramRunner(env),managed=managedProgramRunner(env,async(...args)=>{const time=Date.now();try{return await clean.call(...args);}catch(error){console.error('Artificial Podman call failed',args[0][0],args[1],Date.now()-time);throw error;}});
const actualRun=managed.run;managed.run=async(...args)=>{try{return await actualRun(...args);}catch(error){console.error('Artificial managed run:',error.message);throw error;}};
const config={capacity:{memory_mib:3072,cpu:4,pids:768,disk_mib:2048},reserve:{memory_mib:512,cpu:1,pids:128,disk_mib:128},profiles:{standard:standardProfile}};
let store,registry,browserImage;
const pool=new ResourcePool(config),epochFile=join(root,'epoch');
if(mode!=='crash-child'){mkdirSync(join(root,'catalog'),{mode:0o700});writeFileSync(join(root,'catalog','catalog.json'),'[]',{mode:0o600});writeFileSync(epochFile,JSON.stringify({epoch:randomUUID(),area:randomUUID(),task:randomUUID()}));}
const {epoch,area,task}=JSON.parse(readFileSync(epochFile,'utf8')),catalog=new PackageCatalog(join(root,'catalog'));
function open(){registry=new EnvironmentRegistry(join(root,'environments.db'),image,catalog,async()=>{throw Error('unused');},async id=>(await clean.call(['image','exists',id],15)).code===0);
 const storage=join(root,'workareas');mkdirSync(storage,{recursive:true,mode:0o711});chmodSync(storage,0o711);
 store=new WorkareaStore(storage,(workspace,request,signal,name,pinned)=>configuredProgramRunner({...env,workspace,image:pinned??image})(request,signal,name),clean.cleanup,registry,{pool,runner:managed,...(browserImage?{preview:async(read,...args)=>isolatedPreview(configuredBrowserRunner({...env,image:browserImage}))(async path=>{const response=await read(path);console.log('Artificial preview resource',path,response.status,response.data.length);return response;},...args)}:{})});}
const invoke=(operation,args={})=>store.execute({area,epoch,operation,...args});
const wait=async(id,state)=>{for(let n=0;n<120;n++){const status=await invoke('execution_status',{execution_id:id});await invoke('execution_heartbeat',{execution_id:id});if(status.state===state)return status;if(!['queued','running'].includes(status.state))throw Error(JSON.stringify(status));await delay(100);}throw Error('Timed out');};
async function prepare(code){const definition={name:'人工長時間実行',base_image:image,catalog_revision:catalog.revision,dependencies:[],lockfiles:[],workdir:'/workspace',prepare:[],run:['python','-c',code],verify:['python','-c','pass'],profile:'standard'};
 const v=await invoke('environment_prepare',{definition,allow_start:true});assert.equal(v.state,'ready');assert.equal((await invoke('environment_test',{environment:v.id,operation_id:randomUUID(),allow_start:true,seconds:5})).code,0);
 const current=await invoke('environment_list');await invoke('environment_activate',{environment:v.id,expected_environment:current.active,operation_id:randomUUID(),allow_start:true});return v;}
const start=(args={})=>invoke('execution_start',{operation_id:randomUUID(),allow_start:true,task_id:task,seconds:10,deadline:Date.now()+10000,preview:false,...args});
async function close(){await store?.stop();store?.close();registry?.close();store=undefined;registry=undefined;}
try{
 open();await store.recover();
 if(mode==='crash-child'){
  const id=readFileSync(join(root,'crash-id'),'utf8');await start({operation_id:id,seconds:60,deadline:Date.now()+60000});
  for(let n=0;n<100;n++){const s=await invoke('execution_status',{execution_id:id});if(s.logs?.stdout?.includes('started')){console.log('CRASH_READY');break;}await delay(100);}
  await delay(60000);throw Error('Parent did not kill child');
 }
 if(mode!=='preview-only'){
 await prepare("import pathlib;print('started',flush=True);pathlib.Path('/workspace/result').write_text('saved')");
 const hold=await pool.acquire({...standardProfile,memory_mib:2560,cpu:3,pids:640,disk_mib:1920});
 const queued=await start();assert.equal(queued.state,'queued');assert.equal((await invoke('execution_stop',{execution_id:queued.id})).state,'cancelled');hold();
 const first=await start(),done=await wait(first.id,'completed');assert.equal(done.result.code,0,JSON.stringify(done));
 assert.equal((await invoke('read',{path:'result',revision:done.result.candidate})).content,'saved');
 assert.equal((await invoke('execution_status',{execution_id:first.id})).result.image,image);
 // A result was deliberately not acknowledged. Its ID still returns the same result after reopening.
 await close();open();await store.recover();assert.deepEqual((await invoke('execution_status',{execution_id:first.id})).result,done.result);
 console.log('PASS: real queued cancellation, async completion, immutable result and reopen reconciliation');
 await prepare("import time;print('started',flush=True);time.sleep(60)");
 const stopped=await start();await wait(stopped.id,'running');assert.equal((await invoke('execution_stop',{execution_id:stopped.id})).state,'cancelled');
 const expired=await start({deadline:Date.now()+700});const expiredResult=await wait(expired.id,'cancelled');assert.equal(expiredResult.result.error,'deadline');
 await close();
 const crashId=randomUUID();writeFileSync(join(root,'crash-id'),crashId);
 const child=spawn(process.execPath,[new URL(import.meta.url).pathname,root,image,compiled,'crash-child'],{stdio:['ignore','pipe','inherit']});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Child not ready'));},15000);child.stdout.on('data',chunk=>{if(String(chunk).includes('CRASH_READY')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);if(code!==null)reject(Error('Child exited'));});});
 child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));open();await store.recover();assert.equal((await invoke('execution_status',{execution_id:crashId})).state,'outcome_unknown');
 console.log('PASS: live cancellation, deadline and SIGKILL recovery without replay');
 await prepare("import pathlib,errno; p=pathlib.Path('/workspace/large'); f=p.open('wb'); ok=False\ntry:\n for i in range(80): f.write(b'x'*1048576)\n f.flush()\nexcept OSError as e: ok=e.errno==errno.ENOSPC\nf.close();p.unlink();assert ok;print('quota enforced')");
 const quota=await start(),quotaResult=await wait(quota.id,'completed');assert.equal(quotaResult.result.code,0,JSON.stringify(quotaResult));assert.match(quotaResult.result.stdout,/quota enforced/);
 }
 // Reuse the accepted browser OS layers; only trusted worker JS is replaced in an artificial image.
 const previous=browserBase||JSON.parse(readFileSync('/home/niwa/niwa/runtime/executor/state/browser-acceptance.json','utf8')).image;
 assert.match(previous,/^sha256:[a-f0-9]{64}$/);const context=join(root,'browser-context');mkdirSync(context);cpSync(join(compiled,'tools/browser'),join(context,'browser'),{recursive:true});
 writeFileSync(join(context,'Containerfile'),`FROM ${previous}\nCOPY browser /app/dist/tools/browser\n`);
 execFileSync('/usr/bin/podman',['build','--pull=never','--iidfile',join(root,'browser.id'),context],{env:{PATH:'/usr/bin:/bin',HOME:home,XDG_RUNTIME_DIR:runtime,TMPDIR:root},cwd:home,stdio:'inherit',timeout:120000});
 browserImage=readFileSync(join(root,'browser.id'),'utf8').trim();await close();open();await store.recover();
 const html='<html><style>body{background:#eee;font:24px sans-serif}</style><h1>Isolated preview</h1><div id="result"></div><script>document.querySelector("#result").textContent="JavaScript rendered";fetch("https://example.com/forbidden").catch(()=>{});</script></html>';
 await invoke('write',{path:'index.html',content:html,operation_id:randomUUID(),allow_start:true});
 await prepare("import http.server,socketserver;socketserver.TCPServer.allow_reuse_address=True;http.server.ThreadingHTTPServer(('127.0.0.1',8080),http.server.SimpleHTTPRequestHandler).serve_forever()");
 const preview=await start({preview:true,seconds:60,deadline:Date.now()+60000});await wait(preview.id,'running');for(let n=0;n<100;n++){const status=await invoke('execution_status',{execution_id:preview.id});await invoke('execution_heartbeat',{execution_id:preview.id});if(status.logs)break;if(!['queued','running'].includes(status.state))throw Error(JSON.stringify(status));await delay(200);}await delay(300);
 const heartbeat=setInterval(()=>{void invoke('execution_heartbeat',{execution_id:preview.id}).catch(()=>{});},1000);
 let screen;try{screen=await invoke('execution_preview',{execution_id:preview.id,mobile:false});const mobile=await invoke('execution_preview',{execution_id:preview.id,mobile:true});assert.equal(mobile.width,390);assert.equal(mobile.height,844);}finally{clearInterval(heartbeat);}assert.ok(screen.data,JSON.stringify(screen));assert.equal(screen.origin,'https://preview.niwa.invalid');
 writeFileSync('/tmp/niwa-execution-preview.jpg',Buffer.from(screen.data,'base64'));
 await invoke('execution_stop',{execution_id:preview.id});await assert.rejects(invoke('execution_preview',{execution_id:preview.id}));
 console.log('PASS: isolated browser desktop/mobile preview on synthetic origin, stopped preview unavailable; no host port or external send');
}finally{await close();if(browserImage)assert.equal((await clean.call(['rmi','--no-prune',browserImage],30)).code,0);}
