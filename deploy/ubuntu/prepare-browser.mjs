import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { browserArguments, BROWSER_PID_LIMIT } from '../../dist/sandbox/browser.js';
import { configuredProgramRunner } from '../../dist/sandbox/program.js';
import { BrowserSession } from '../../dist/tools/browser/session.js';
import { verifyBrowserSession } from './browser-acceptance.mjs';
assert.equal(process.argv[2], '--apply');
assert.ok(process.argv.length === 3 || process.argv.length === 4);
let image = process.argv[3];
const suppliedImage = Boolean(image);
if (image) assert.match(image, /^sha256:[a-f0-9]{64}$/);
const root = '/home/niwa/niwa', uid = Number(execFileSync('id',['-u','niwa-exec'],{encoding:'utf8'}).trim());
assert.equal(process.getuid(),uid); assert.ok(uid > 0);
const home = `${root}/runtime/executor/home`, runtime = `/run/user/${uid}`;
assert.equal(process.env.HOME,home); assert.equal(process.env.XDG_RUNTIME_DIR,runtime);
execFileSync('mountpoint',['-q',`${root}/runtime/executor`]);
const stage = mkdtempSync(join(home,'browser-preparation-'));
const env = {PATH:'/usr/bin:/bin',HOME:home,XDG_RUNTIME_DIR:runtime,TMPDIR:stage};
const podman = (...args) => execFileSync('/usr/bin/podman',args,{cwd:home,env,encoding:'utf8',timeout:1200_000,maxBuffer:2*1024*1024});
let session, name;
try {
  const lock = JSON.parse(readFileSync(`${root}/deploy/ubuntu/browser-image.json`,'utf8'));
  assert.match(lock.reference,/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
  if (!image) {
    // Only the worker's required build inputs enter the context; never send the product root.
    const context = join(stage,'context'); mkdirSync(context);
    for (const path of ['package.json','node_modules/@sinclair/typebox','dist/tools/browser',
      'dist/tools/web/public-page.js','dist/entrypoints/browser-worker.js','dist/config/executor-endpoint.js','dist/config/paths.js']) {
      const destination = join(context,path); mkdirSync(join(destination,'..'),{recursive:true});
      cpSync(join(root,path),destination,{recursive:true});
    }
    cpSync(`${root}/deploy/ubuntu/Containerfile.browser`,join(context,'Containerfile'));
    console.log(`Building browser image from ${lock.reference}`);
    execFileSync('/usr/bin/podman',['build','--pull=missing','--iidfile',join(stage,'image.id'),'--build-arg',`NIWA_BROWSER_BASE=${lock.reference}`,context],
      {cwd:home,env,stdio:'inherit',timeout:1200_000});
    image = readFileSync(join(stage,'image.id'),'utf8').trim(); assert.match(image,/^sha256:[a-f0-9]{64}$/);
  } else { console.log(`Reusing browser image: ${image}`); }
  const environment = {workspace:`${root}/workspace`,image,uid,gid:process.getgid(),home,runtime};
  await configuredProgramRunner(environment).verify();
  // Same production browser flags, with a trusted Node probe in place of the worker.
  const probe = browserArguments(environment,`niwa-browser-${randomUUID()}`); probe.splice(-1,1,'-e',`
    const fs=require('node:fs'),assert=require('node:assert/strict');
    assert.equal(process.getuid(),${uid});
    assert.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);
    assert.match(fs.readFileSync('/proc/self/status','utf8'),/Seccomp:\\s+2/);
    assert.equal(fs.existsSync('/workspace'),false); assert.equal(fs.existsSync('/home/niwa/niwa/config'),false);
    assert.throws(()=>fs.writeFileSync('/niwa-boundary','forbidden'));
    for(const [file,value] of [['memory.max','1073741824'],['memory.swap.max','0'],['pids.max','${BROWSER_PID_LIMIT}'],['cpu.max','100000 100000']])
      assert.equal(fs.readFileSync('/sys/fs/cgroup/'+file,'utf8').trim(),value);
    fetch('http://127.0.0.1:3210/',{signal:AbortSignal.timeout(1000)}).then(()=>{process.exitCode=1},()=>console.log('PASS: browser container boundaries'));
  `);
  console.log(podman(...probe).trim());
  name = `niwa-browser-${randomUUID()}`;
  const child = spawn('/usr/bin/podman',browserArguments(environment,name),{cwd:home,env,stdio:['pipe','pipe','inherit']});
  await verifyBrowserSession(broker => {
    session = new BrowserSession(child.stdout,child.stdin,async()=>{podman('rm','--force','--ignore',name);},broker);
    const activeSession = session;
    child.once('error',()=>void activeSession.close().catch(()=>{}));
    child.once('exit',()=>void activeSession.close().catch(()=>{}));
    return session;
  });
  session = undefined;
  assert.equal(podman('ps','-aq','--filter',`name=${name}`).trim(),'');
  const receipt = {image,reference:suppliedImage ? image : lock.reference,verified_at:new Date().toISOString(),
    checks:['browser-chroot-seccomp','container-boundaries','sandbox-render','broker-only-resources','form-prepare-no-send','exact-approval-synthetic-send-reopen','stale-reference','cleanup']};
  writeFileSync(join(stage,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  renameSync(join(stage,'receipt.json'),`${root}/runtime/executor/state/browser-acceptance.json`);
  console.log('PASS: browser rendering, resource policy, form preparation and cleanup; acceptance receipt saved');
  console.log('Browser is not enabled in the application yet; no external form was sent.');
} catch (error) {
  if (name) {
    console.error('Browser acceptance failed; collecting startup diagnostics from the same image.');
    if (session) { await session.close(); session = undefined; }
    try {
      execFileSync(process.execPath,[`${root}/deploy/ubuntu/diagnose-browser.mjs`,image],
        {cwd:home,env,stdio:'inherit',timeout:70000});
    } catch { console.error('Startup diagnosis did not pass; see the CDP stage and Chromium error above.'); }
  }
  throw error;
} finally {
  if(session) await session.close();
  if(name) podman('rm','--force','--ignore',name);
  rmSync(stage,{recursive:true,force:true});
}
