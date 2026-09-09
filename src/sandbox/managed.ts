import {setTimeout as delay} from 'node:timers/promises';
import {mkdirSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {programArguments,type ProgramEnvironment,type ProgramOutput,type PodmanCall} from './program.ts';
import {Workspace} from '../tools/files/workspace.ts';
import type {ResourceProfile} from './resources.ts';

const supervisor=String.raw`
import os,sys,json,time,shutil,subprocess,threading
for name in os.listdir('/input'):
 source=os.path.join('/input',name);target=os.path.join('/workspace',name)
 if os.path.isdir(source):shutil.copytree(source,target)
 else:shutil.copy2(source,target)
commands=json.loads(sys.argv[1]); out={'code':0,'stdout':'','stderr':''}
def drain(pipe,key):
 while True:
  chunk=os.read(pipe.fileno(),4096)
  if not chunk: break
  out[key]=(out[key]+chunk.decode('utf8','replace'))[-16000:]
  publish(False)
def publish(done):
 data=dict(out);data['done']=done
 with open('/tmp/niwa-status','w') as f: json.dump(data,f)
publish(False)
for command in commands:
 p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd='/workspace',start_new_session=True)
 threads=[threading.Thread(target=drain,args=(p.stdout,'stdout')),threading.Thread(target=drain,args=(p.stderr,'stderr'))]
 for t in threads:t.start()
 out['code']=p.wait()
 for t in threads:t.join()
 if out['code']!=0:break
publish(True)
while True:time.sleep(1)
`;
// Output is untrusted. Both guest and host validate the bounded manifest; no archive extraction or host paths.
const collect=String.raw`
import os,stat,json,base64
items=[];total=0
for directory,dirs,files in os.walk('/workspace',followlinks=False):
 for name in dirs+files:
  path=os.path.join(directory,name);s=os.lstat(path);relative=os.path.relpath(path,'/workspace')
  assert len(items)<1000 and not stat.S_ISLNK(s.st_mode)
  if stat.S_ISDIR(s.st_mode):items.append({'path':relative,'directory':True});continue
  assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=8388608
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   current=os.fstat(fd);assert current.st_ino==s.st_ino and current.st_dev==s.st_dev and current.st_nlink==1
   with os.fdopen(fd,'rb',closefd=False) as f:data=f.read(8388609)
  finally:os.close(fd)
  total+=len(data);assert len(data)<=8388608 and total<=67108864
  items.append({'path':relative,'data':base64.b64encode(data).decode(),'executable':bool(s.st_mode&64)})
print(json.dumps(items))
`;
export function managedProgramRunner(environment:Omit<ProgramEnvironment,'workspace'|'image'>,call:PodmanCall){
 const startedContainers=new Set<string>();
 const status=async(name:string)=>{
  if(!/^niwa-program-[a-f0-9-]{36}$/.test(name))throw Error('Invalid container');
  if(!startedContainers.has(name))return null;
  // A lost read response is retryable; never restart the underlying execution.
  const result=await call(['exec',name,'python','-c',"import pathlib;print(pathlib.Path('/tmp/niwa-status').read_text())"],5).catch(()=>null);
  if(!result)return null;
  if(result.code!==0)return null;
  try{const value=JSON.parse(result.stdout);if(typeof value.done!=='boolean'||!Number.isInteger(value.code)||typeof value.stdout!=='string'||typeof value.stderr!=='string')return null;return {done:value.done,code:value.code,stdout:value.stdout.slice(-16000),stderr:value.stderr.slice(-16000)};}catch{return null;}
 };
 const cleanup=async(name:string)=>{if((await call(['rm','--force','--ignore',name],15)).code!==0)throw Error('Managed container cleanup failed');};
 const run=async(workspace:string,image:string,commands:string[][],profile:ResourceProfile,seconds:number,name:string,signal:AbortSignal):Promise<ProgramOutput>=>{
  // Reuse the existing identity, network, seccomp and mount validation.
  const args=programArguments({...environment,workspace,image},{command:['python','-c',supervisor,JSON.stringify(commands)],seconds:Math.min(300,seconds)},name);
  args.splice(1,0,'--detach');
  for(const [prefix,value] of [['--pids-limit=',String(profile.pids)],['--memory=',`${profile.memory_mib}m`],['--memory-swap=',`${profile.memory_mib}m`],['--cpus=',String(profile.cpu)],['--timeout=',String(seconds+10)]] as const){const index=args.findIndex(a=>a.startsWith(prefix));args[index]=prefix+value;}
  const mount=args.indexOf('--mount');args[mount+1]=`type=bind,source=${workspace},destination=/input,ro`;
  args.splice(mount,0,`--tmpfs=/workspace:rw,nosuid,nodev,size=${profile.disk_mib}m,mode=1777`);
  try{
   signal.throwIfAborted();const started=await call(args,15,signal);if(started.code!==0)throw Error(`Managed container start failed: ${started.stderr.slice(-1000)}`);startedContainers.add(name);
   let output:Awaited<ReturnType<typeof status>>;
   while(true){signal.throwIfAborted();output=await status(name);if(output?.done)break;
    const alive=await call(['inspect','--format={{.State.Running}}',name],5).catch(()=>null);if(alive&&(alive.code!==0||alive.stdout.trim()!=='true'))throw Error('Managed container exited without a result');
    await delay(250,undefined,{signal});
   }
   signal.throwIfAborted();const files=await call(['exec',name,'python','-c',collect],30,signal,96*1024*1024);
   if(files.code!==0)throw Error('Managed output rejected');
   const items:unknown=JSON.parse(files.stdout);if(!Array.isArray(items)||items.length>1000)throw Error('Invalid output manifest');
   let bytes=0;const names=new Set<string>();
   for(const item of items){if(!item||typeof item.path!=='string'||item.path.startsWith('/')||item.path.includes('\\')||/[\x00-\x1f]/.test(item.path)||item.path.split('/').some((p:string)=>!p||p==='.'||p==='..')||names.has(item.path))throw Error('Invalid output path');names.add(item.path);
    if(item.directory!==true){if(typeof item.data!=='string')throw Error('Invalid output bytes');const data=Buffer.from(item.data,'base64');bytes+=data.length;if(data.length>8*1024*1024||bytes>64*1024*1024||data.toString('base64')!==item.data)throw Error('Output quota exceeded');}
   }
   // The guest can only write tmpfs. The host snapshot has never been mounted writable.
   rmSync(workspace,{recursive:true});mkdirSync(workspace,{mode:0o711});
   const filespace=new Workspace(workspace);
   for(const item of items.filter(i=>i.directory===true).sort((a,b)=>a.path.length-b.path.length))mkdirSync(join(workspace,item.path),{recursive:true,mode:0o700});
   for(const item of items.filter(i=>i.directory!==true)){filespace.write(item.path,item.data,null,'base64');chmodSync(join(workspace,item.path),item.executable?0o700:0o600);}
   return {code:output.code,stdout:output.stdout,stderr:output.stderr};
  }finally{startedContainers.delete(name);await cleanup(name);}
 };
 const preview=async(name:string,path:string)=>{
  if(!/^niwa-program-[a-f0-9-]{36}$/.test(name)||!path.startsWith('/')||path.startsWith('//')||/[\x00-\x20\\]/.test(path)||path.length>2048)throw Error('Invalid preview path');
  // Only the container's loopback, fixed port 8080, GET, no redirects, cookies or forwarded headers.
  const code=String.raw`import http.client,sys,json,base64
c=http.client.HTTPConnection('127.0.0.1',8080,timeout=3);c.request('GET',sys.argv[1]);r=c.getresponse();b=r.read(524289);assert len(b)<=524288
print(json.dumps({'status':r.status,'content_type':r.getheader('Content-Type','application/octet-stream'),'data':base64.b64encode(b).decode()}))`;
  const result=await call(['exec',name,'python','-c',code,path],15,undefined,800000);if(result.code!==0)throw Error('Preview unavailable');return JSON.parse(result.stdout) as {status:number;content_type:string;data:string};
 };
 return {run,status,cleanup,preview};
}
export type ManagedRunner=ReturnType<typeof managedProgramRunner>;
