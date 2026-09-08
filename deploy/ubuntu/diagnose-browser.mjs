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
let stderr='',frame='',ready=false;
child.stderr.on('data',chunk=>{if(stderr.length<16384) stderr+=chunk.toString().slice(0,16384-stderr.length)});
child.stdio[3].on('error',()=>{}); child.stdio[4].on('error',()=>{});
const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
child.stdio[4].on('data',chunk=>{
 frame+=chunk.toString();
 for(let end=frame.indexOf('\0');end!==-1;end=frame.indexOf('\0')) {
  const raw=frame.slice(0,end); frame=frame.slice(end+1);
  try {const value=JSON.parse(raw); if(value.id===1 && value.result) {
    ready=true; console.log('PASS: Chromium CDP '+value.result.product);
    child.stdio[3].write(JSON.stringify({id:2,method:'Browser.close'})+'\0');
  }} catch{}
 }
 if(frame.length>65536) child.kill('SIGKILL');
});
child.once('error',error=>{clearTimeout(timer); console.error('Chromium spawn failed: '+error.code);process.exitCode=1});
child.once('exit',(code,signal)=>{
 clearTimeout(timer); console.log('Chromium exit '+JSON.stringify({code,signal,ready}));
 if(!ready) {console.error(stderr);process.exitCode=1;}
});
child.stdio[3].write(JSON.stringify({id:1,method:'Browser.getVersion'})+'\0');
`);
try {
 const result=spawnSync('/usr/bin/podman',args,{cwd:home,env,stdio:'inherit',timeout:25000});
 if(result.error) throw result.error;
 process.exitCode=result.status===0?0:1;
} finally {
 execFileSync('/usr/bin/podman',['rm','--force','--ignore',name],{cwd:home,env,timeout:15000,stdio:'ignore'});
}
