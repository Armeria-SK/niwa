import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {managedProgramRunner,managedScripts} from '../src/sandbox/managed.ts';
import {standardProfile} from '../src/sandbox/resources.ts';
import {WorkspaceError} from '../src/tools/files/workspace.ts';
const image=`sha256:${'a'.repeat(64)}`;
const python=spawnSync('python3',['--version']).status===0;
// The guest scripts hardcode container paths; run them against a scratch directory instead.
const local=(script:string,paths:Record<string,string>)=>Object.entries(paths).reduce((text,[from,to])=>text.replaceAll(from,to),script);

test('guest supervisor decodes UTF-8 split across 4096-byte reads',{skip:!python},async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-supervisor-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ['input','workspace'])mkdirSync(join(root,name));
 const status=join(root,'status.json');
 const script=local(managedScripts.supervisor,{'/input':join(root,'input'),'/workspace':join(root,'workspace'),'/tmp/niwa-status':status});
 // 4095 ASCII bytes then a 3-byte character: a 4096-byte read ends in the middle of it.
 const emit="import sys;sys.stdout.buffer.write(b'a'*4095+'あいう'.encode()+b'end');sys.stderr.buffer.write(b'b'*4095+'🙂'.encode());sys.stdout.flush();sys.stderr.flush()";
 const child=spawn('python3',['-c',script,JSON.stringify([['python3','-c',emit]])],{stdio:'ignore'});t.after(()=>{child.kill('SIGKILL');});
 let result:{done?:boolean;stdout?:string;stderr?:string}={};
 for(let i=0;i<100&&!result.done;i++){await delay(100);try{result=JSON.parse(readFileSync(status,'utf8'));}catch{}}
 assert.equal(result.done,true);assert.ok(result.stdout!.endsWith('あいうend'),'stdout kept the split character');assert.ok(result.stderr!.endsWith('🙂'));
 assert.ok(!result.stdout!.includes('�')&&!result.stderr!.includes('�'));
});

test('guest output collector names the violated rule and path instead of failing opaquely',{skip:!python},t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-collect-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const collect=(workspace:string)=>{const run=spawnSync('python3',['-c',local(managedScripts.collect,{'/workspace':workspace})],{encoding:'utf8',maxBuffer:64*1024*1024});assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);};
 const make=(name:string)=>{const dir=join(root,name);mkdirSync(dir);return dir;};
 const fine=make('fine');mkdirSync(join(fine,'src'));writeFileSync(join(fine,'src','a.txt'),'ok');
 assert.deepEqual(collect(fine).map((item:{path:string})=>item.path).sort(),['src','src/a.txt']);
 const links=make('links');mkdirSync(join(links,'node_modules','.bin'),{recursive:true});symlinkSync('../x/cli.js',join(links,'node_modules','.bin','cli'));
 assert.deepEqual(collect(links),{rejected:{rule:'symlink',path:'node_modules/.bin/cli'}});
 const hard=make('hard');writeFileSync(join(hard,'one'),'x');linkSync(join(hard,'one'),join(hard,'two'));
 assert.equal(collect(hard).rejected.rule,'hardlink');
 const big=make('big');mkdirSync(join(big,'data'));writeFileSync(join(big,'data','huge.bin'),Buffer.alloc(8*1024*1024+1));
 assert.deepEqual(collect(big),{rejected:{rule:'file_too_large',path:'data/huge.bin'}});
 const many=make('many');for(let i=0;i<1001;i++)writeFileSync(join(many,`f${i}`),'');
 assert.equal(collect(many).rejected.rule,'too_many_entries');
 const total=make('total');for(let i=0;i<10;i++)writeFileSync(join(total,`part${i}`),Buffer.alloc(7*1024*1024+1));
 assert.equal(collect(total).rejected.rule,'total_too_large');
 assert.ok(existsSync(root));
});

const fake=(files:()=>string,status:()=>object|null)=>{
 const calls:string[][]=[];
 const call=async(args:string[])=>{calls.push(args);
  if(args[0]==='run')return {code:0,stdout:'container',stderr:''};
  if(args[0]==='inspect')return {code:0,stdout:'true\n',stderr:''};
  if(args[0]==='rm')return {code:0,stdout:'',stderr:''};
  if(args.includes("import pathlib;print(pathlib.Path('/tmp/niwa-status').read_text())")){const value=status();return value?{code:0,stdout:JSON.stringify(value),stderr:''}:{code:1,stdout:'',stderr:''};}
  return {code:0,stdout:files(),stderr:''};
 };
 return {calls,runner:managedProgramRunner({uid:1001,gid:1001,home:'/tmp',runtime:'/run/user/1001'},call)};
};

test('a rejected managed output carries the rule, bounded path and the run output, and leaves the workarea alone',async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-managed-reject-'));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'keep'),'kept');
 const f=fake(()=>JSON.stringify({rejected:{rule:'symlink',path:'bad\nname/'+'x'.repeat(300)}}),()=>({done:true,code:2,stdout:'installed',stderr:'warning'}));
 const error=await f.runner.run(root,image,[['true']],standardProfile,10,`niwa-program-${randomUUID()}`,AbortSignal.timeout(5000)).catch(e=>e);
 assert.ok(error instanceof WorkspaceError);assert.equal(error.code,'output_rejected');assert.equal(error.detail?.rule,'symlink');
 assert.ok(error.detail!.path.startsWith('bad?name/'));assert.ok(error.detail!.path.length<=200);assert.deepEqual(error.detail?.output,{code:2,stdout:'installed',stderr:'warning'});
 assert.equal(readFileSync(join(root,'keep'),'utf8'),'kept');assert.equal(f.calls.filter(c=>c[0]==='rm').length,1);
 const unknown=fake(()=>JSON.stringify({rejected:{rule:'made_up',path:'x'}}),()=>({done:true,code:0,stdout:'',stderr:''}));
 await assert.rejects(unknown.runner.run(root,image,[['true']],standardProfile,10,`niwa-program-${randomUUID()}`,AbortSignal.timeout(5000)),/Invalid output manifest/);
});

test('hitting the time limit reports the last logs as timed out, while other cancellation stays an error',async t=>{
 const root=mkdtempSync(join(tmpdir(),'niwa-managed-timeout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const f=fake(()=>'[]',()=>({done:false,code:0,stdout:'progress 41',stderr:'slow'}));
 const result=await f.runner.run(root,image,[['sleep','99']],standardProfile,10,`niwa-program-${randomUUID()}`,AbortSignal.timeout(600));
 assert.deepEqual(result,{code:124,stdout:'progress 41',stderr:'slow',timed_out:true});assert.equal(f.calls.filter(c=>c[0]==='rm').length,1);
 const stop=new AbortController();setTimeout(()=>stop.abort(),300);
 await assert.rejects(fake(()=>'[]',()=>({done:false,code:0,stdout:'',stderr:''})).runner.run(root,image,[['sleep','99']],standardProfile,10,`niwa-program-${randomUUID()}`,stop.signal));
});
