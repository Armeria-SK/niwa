// Administrative startup-only diagnosis: fixed about:blank, no user pages or profiles.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { browserArguments } from '../../dist/sandbox/browser.js';
const image = process.argv[2];
assert.equal(process.argv.length,3); assert.match(image,/^sha256:[a-f0-9]{64}$/);
const uid = Number(execFileSync('id',['-u','niwa-exec'],{encoding:'utf8'}).trim());
assert.ok(uid>0); assert.equal(process.getuid(),uid);
const home='/home/niwa/niwa/runtime/executor/home', runtime=`/run/user/${uid}`;
assert.equal(process.env.HOME,home); assert.equal(process.env.XDG_RUNTIME_DIR,runtime);
const env={PATH:'/usr/bin:/bin',HOME:home,XDG_RUNTIME_DIR:runtime};
const name=`niwa-browser-${randomUUID()}`;
const args=browserArguments({image,uid,gid:process.getgid()},name);
args.splice(-1,1,'-e',String.raw`
const {spawn,spawnSync}=require('node:child_process');
console.log('Node '+process.version+' uid='+process.getuid());
// Probe nested namespaces under exactly the same container security settings.
for(const flag of ['--user','--user --map-root-user --pid --fork','--user --map-root-user --net']) {
  const result=spawnSync('/usr/bin/unshare',[...flag.split(' '),'/bin/true'],{encoding:'utf8',timeout:3000});
  console.log('Namespace probe '+flag+': '+JSON.stringify({status:result.status,error:result.error?.code,stderr:result.stderr}));
}
const profile='/tmp/niwa-browser';
const child=spawn('/usr/bin/chromium',['--headless=new','--remote-debugging-pipe','--user-data-dir='+profile,'--no-first-run',
 '--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],
 {stdio:['ignore','ignore','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:profile,LANG:'C.UTF-8'}});
let stderr='',ready=false,lastMethod='spawn',reported=false;
const report=()=>{
 if(reported) return; reported=true;
 const fs=require('node:fs');
 for(const name of ['pids.current','pids.max','pids.peak','pids.events','memory.events']) {
  try {console.log('cgroup '+name+': '+fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim())} catch{}
 }
 console.error(stderr);
};
child.stderr.on('data',chunk=>{if(stderr.length<16384) stderr+=chunk.toString().slice(0,16384-stderr.length)});
const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
child.once('error',error=>{clearTimeout(timer); console.error('Chromium spawn failed: '+error.code);process.exitCode=1});
child.once('exit',(code,signal)=>{
 clearTimeout(timer); console.log('Chromium exit '+JSON.stringify({code,signal,ready,lastMethod}));
 if(!ready) {report();process.exitCode=1;}
});
(async()=>{
 const {CdpPipe}=await import('/app/dist/tools/browser/cdp.js');
 const {BrowserPage}=await import('/app/dist/tools/browser/page.js');
 const {BrowserRequests}=await import('/app/dist/tools/browser/requests.js');
 const cdp=new CdpPipe(child.stdio[4],child.stdio[3]);
 const originalSend=cdp.send.bind(cdp);
 cdp.send=async(method,params,options)=>{
  lastMethod=method; console.log('CDP begin '+method);
  const value=await originalSend(method,params,{...options,timeoutMs:5000});
  console.log('CDP ready '+method); return value;
 };
 const page=new BrowserPage(cdp,url=>new BrowserRequests(url,async address=>({url:address,content_type:'text/html',
  body_base64:Buffer.from('<title>Diagnostic</title><p>Local fixture</p>').toString('base64'),fetched_at:new Date().toISOString(),untrusted:true})));
 try {
  const version=await cdp.send('Browser.getVersion'); console.log('Chromium '+version.product);
  await page.open();
  const snapshot=await page.navigate('https://fixture.example.com/',AbortSignal.timeout(10000));
  if(snapshot.title!=='Diagnostic') throw Error('Unexpected artificial page');
  ready=true; console.log('PASS: Chromium CDP, production page initialization and artificial-page rendering');
 } catch(error) {
  console.error('Startup failed: '+error.message);report();process.exitCode=1;
 } finally {
  await page.close();
  try {await cdp.send('Browser.close')} catch{}
  cdp.close(); if(child.exitCode===null && child.signalCode===null) child.kill();
 }
})().catch(error=>{console.error(error.message); child.kill('SIGKILL');process.exitCode=1});

`);
try {
 const result=spawnSync('/usr/bin/podman',args,{cwd:home,env,stdio:'inherit',timeout:55000});
 if(result.error) throw result.error;
 process.exitCode=result.status===0?0:1;
} finally {
 execFileSync('/usr/bin/podman',['rm','--force','--ignore',name],{cwd:home,env,timeout:15000,stdio:'ignore'});
}
