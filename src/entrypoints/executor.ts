import {isolatedPreview} from '../sandbox/preview.ts';
import {ResourcePool,standardProfile,type ResourceConfig} from '../sandbox/resources.ts';
import {managedProgramRunner} from '../sandbox/managed.ts';
import {EnvironmentRegistry} from '../tools/environments/registry.ts';
import {verifyWorkareaLayout} from '../tools/workareas/layout.ts';
import {WorkareaStore} from '../tools/workareas/store.ts';
import { chmodSync, lstatSync, rmSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDirectoryPath } from '../config/paths.ts';
import { acquireProcessLock } from '../runtime/process-lock.ts';
import { recoverExecutorSocket } from '../runtime/executor-socket.ts';
import { configuredProgramRunner } from '../sandbox/program.ts';
import { ProgramLog } from '../sandbox/program-log.ts';
import { createProgramServer } from '../sandbox/server.ts';
import { configuredBrowserRunner } from '../sandbox/browser.ts';
import { createBrowserServer } from '../tools/browser/server.ts';
import { PackageCatalog } from '../tools/packages/catalog.ts';
import { PackageLog } from '../tools/packages/log.ts';
import { installPackages, packageVerificationName } from '../tools/packages/install.ts';

let broker: ReturnType<typeof createProgramServer> | undefined;
let browser: ReturnType<typeof createBrowserServer> | undefined;
let environments: EnvironmentRegistry | undefined;
let workareas: WorkareaStore | undefined;
let packages: PackageLog | undefined;
let log: ProgramLog | undefined; let unlock: (() => void) | undefined; let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => { await browser?.stop(); await broker?.stop(); if(!broker)await workareas?.stop(); await packages?.close(); log?.close(); workareas?.close(); environments?.close(); unlock?.(); })();
try {
  const { values } = parseArgs({ options: Object.fromEntries(['workspace', 'socket', 'state', 'home', 'runtime', 'image', 'browser-image', 'packages', 'workareas', 'environments', 'resources'].map(key => [key, { type: 'string' as const }])) });
  if (process.platform !== 'linux' || !process.getuid?.() || Object.values(values).some(value => typeof value !== 'string') ||
      !values.workspace || !values.socket || !values.state || !values.home || !values.runtime || !values.image) throw new Error('Executor configuration required');
  if (!isAbsolute(values.workspace as string)) throw new Error('Absolute workspace required');
  const workspace = resolve(values.workspace as string); const socket = values.socket as string; const state = values.state as string;
  for (const privatePath of [socket, state]) {
    if (!isAbsolute(privatePath)) throw new Error('Absolute executor path required');
    const rel = relative(workspace, resolve(privatePath));
    if (!rel || (!rel.startsWith('../') && rel !== '..')) throw new Error('Execution state must be outside the shared mount');
  }
  assertDirectoryPath(state); assertDirectoryPath(dirname(socket));
  const stateInfo = lstatSync(state); const socketInfo = lstatSync(dirname(socket));
  if (stateInfo.uid !== process.getuid() || (stateInfo.mode & 0o077) || socketInfo.uid !== process.getuid() || (socketInfo.mode & 0o007))
    throw new Error('Protected executor directories required');
  process.umask(0o077);
  const environment = { workspace, image: values.image as string, uid: process.getuid(), gid: process.getgid!(), home: values.home as string, runtime: values.runtime as string };
  const run = configuredProgramRunner(environment, () => packages?.currentImage() ?? environment.image);
  let pool:ResourcePool|undefined;
  if(values.resources){
    if(!values.environments)throw Error('Managed resources require environments');
    const path=resolve(values.resources),stat=lstatSync(path);assertDirectoryPath(dirname(path));
    if(!isAbsolute(values.resources)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o022)||stat.size>65536)throw Error('Protected resource configuration required');
    pool=new ResourcePool(JSON.parse(readFileSync(path,'utf8')) as ResourceConfig,required=>{
      try{return [workspace,environment.home].every(root=>{const fs=statfsSync(root,{bigint:true});return fs.bavail*fs.bsize>=BigInt(Math.ceil(required))*1048576n;});}catch{return false;}
    });
  }
  const limited:typeof run=(Object.assign(async(request:Parameters<typeof run>[0],signal?:AbortSignal,name?:string)=>{
    const release=await pool?.acquire(standardProfile,signal);try{return await run(request,signal,name);}finally{release?.();}
  },run));
  const install=async(image:string,stage:string,name:string,entries:Parameters<typeof installPackages>[3],signal?:AbortSignal)=>{
    const release=await pool?.acquire({memory_mib:1024,cpu:1,pids:128,disk_mib:1024,seconds:300},signal);
    try{return await installPackages(image,stage,name,entries,run.call,signal);}finally{release?.();}
  };
  await run.verify();
  unlock = acquireProcessLock(join(state, 'program-lock.db'));
  if (values.packages) {
    const catalogPath = resolve(values.packages as string); const relation = relative(workspace, catalogPath);
    if (!isAbsolute(values.packages as string) || !relation || (!relation.startsWith('../') && relation !== '..')) throw new Error('Package catalog must be outside workspace');
    const catalog = new PackageCatalog(catalogPath);
    const cleanup = async (name: string) => {
      if (!/^niwa-package-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid saved package container');
      for (const container of [name, packageVerificationName(name)]) {
        if ((await run.call(['rm', '--force', '--ignore', container], 15)).code !== 0) throw new Error('Package recovery failed');
      }
      const stage = resolve(state, name);
      if (dirname(stage) !== resolve(state)) throw new Error('Invalid package stage');
      rmSync(stage, { recursive: true, force: true });
    };
    packages = new PackageLog(join(state, 'packages.db'), environment.image, catalog, async (image, name, entries, signal) => {
      const stage = join(state, name);
      try { catalog.stage(entries.map(entry => entry.name), stage); return await install(image, stage, name, entries, signal); }
      finally { await cleanup(name); }
    });
    for (const name of packages.pending()) await cleanup(name);
    await run.verify();
  }
  log = new ProgramLog(join(state, 'programs.db'), JSON.stringify(environment), limited);
  // Recovery only terminates saved containers. It does not infer success or repeat their commands.
  for (const pending of log.pending()) await run.cleanup(pending.container);
  if(values.environments){
    if(values.environments!=='enabled'||!values.workareas||!values.packages)throw Error('Environments require workareas and offline catalog');
    const catalog=new PackageCatalog(resolve(values.packages));
    environments=new EnvironmentRegistry(join(state,'environments.db'),environment.image,catalog,async(image,name,entries,signal)=>{
      const stage=join(state,name);
      try{catalog.stage(entries.map(entry=>entry.name),stage);return await install(image,stage,name,entries,signal);}
      finally{rmSync(stage,{recursive:true,force:true});}
    },async image=>(await run.call(['image','exists',image],15)).code===0,pool?.config.profiles);
    for(const name of environments.pending()){
      for(const container of [name,packageVerificationName(name)])if((await run.call(['rm','--force','--ignore',container],15)).code!==0)throw Error('Environment recovery failed');
      rmSync(join(state,name),{recursive:true,force:true});
    }
    environments.recovered();
  }
  const browsers=values['browser-image']?configuredBrowserRunner({...environment,image:values['browser-image']}):undefined;
  if(browsers)await browsers.verify();
  if(values.workareas){
    const root=resolve(values.workareas as string);
    // Explicitly prepared sibling inside the bounded executor mount, never inside legacy workspace.
    verifyWorkareaLayout(root,state,workspace,environment.uid);
    workareas=new WorkareaStore(root,async(snapshot,request,signal,name,image)=>{
      const scoped=configuredProgramRunner({...environment,workspace:snapshot},()=>image??packages?.currentImage()??environment.image);
      const release=await pool?.acquire(standardProfile,signal);try{return await scoped(request,signal,name);}finally{release?.();}
    },run.cleanup,environments,pool?{pool,removeImage:async image=>{if([environment.image,packages?.currentImage(),values['browser-image']].includes(image))return false;return (await run.call(['rmi','--no-prune',image],30)).code===0;},runner:managedProgramRunner(environment,run.call),...(browsers?{preview:isolatedPreview(browsers)}:{})}:undefined);
    await workareas.recover();
  }
  broker = createProgramServer(log, packages, workareas);
  await recoverExecutorSocket(socket, environment.uid);
  await new Promise<void>((resolve, reject) => { broker!.server.once('error', reject); broker!.server.listen(socket, resolve); });
  chmodSync(socket, 0o660);
  if (browsers) {
    browser = createBrowserServer(browsers.create,pool?signal=>pool.acquire({memory_mib:1024,cpu:1,pids:256,disk_mib:320,seconds:900},signal):undefined);
    const browserSocket = join(dirname(socket), 'browser.sock');
    await recoverExecutorSocket(browserSocket, environment.uid);
    await new Promise<void>((resolve, reject) => { browser!.server.once('error', reject); browser!.server.listen(browserSocket, resolve); });
    chmodSync(browserSocket, 0o660);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
  process.stdout.write('Niwa program executor is listening on its protected local socket.\n');
} catch {
  await close();
  process.stderr.write('Program executor could not start. Check its dedicated identity, private state, protected socket and installed Podman environment.\n');
  process.exitCode = 1;
}
