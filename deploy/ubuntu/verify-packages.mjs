// Synthetic offline package; no upstream package scripts or host installation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configuredProgramRunner } from '../../dist/sandbox/program.js';
import { PackageCatalog } from '../../dist/tools/packages/catalog.js';
import { installPackages } from '../../dist/tools/packages/install.js';
assert.deepEqual(process.argv.slice(2), ['--apply']);
const root='/home/niwa/niwa', uid=Number(execFileSync('id',['-u','niwa-exec'],{encoding:'utf8'}).trim());
assert.ok(uid>0); assert.equal(process.getuid(),uid);
const home=`${root}/runtime/executor/home`, runtime=`/run/user/${uid}`;
assert.equal(process.env.HOME,home); assert.equal(process.env.XDG_RUNTIME_DIR,runtime);
const base=JSON.parse(readFileSync(`${root}/runtime/executor/state/program-acceptance.json`,'utf8')).image;
const stage=mkdtempSync(join(home,'package-verification-'));
try {
  const pkg=join(stage,'package'), catalogPath=join(stage,'catalog');
  mkdirSync(join(pkg,'DEBIAN'),{recursive:true}); mkdirSync(join(pkg,'usr/bin'),{recursive:true}); mkdirSync(catalogPath,{mode:0o700});
  writeFileSync(join(pkg,'DEBIAN/control'),'Package: niwa-acceptance\nVersion: 1.0\nArchitecture: all\nMaintainer: Niwa <example@example.invalid>\nDescription: Artificial offline installation probe\n');
  writeFileSync(join(pkg,'usr/bin/niwa-acceptance'),'#!/bin/sh\nprintf "niwa-package-ok\\n"\n',{mode:0o755});
  const deb=join(catalogPath,'niwa-acceptance.deb');
  execFileSync('/usr/bin/dpkg-deb',['--build','--root-owner-group',pkg,deb],{stdio:'inherit'});
  const entry={name:'niwa-acceptance',version:'1.0',file:'niwa-acceptance.deb',sha256:createHash('sha256').update(readFileSync(deb)).digest('hex')};
  writeFileSync(join(catalogPath,'catalog.json'),JSON.stringify([entry]),{mode:0o600});
  const catalog=new PackageCatalog(catalogPath), installation=join(stage,'install');
  const entries=catalog.stage(['niwa-acceptance'],installation);
  const environment={workspace:`${root}/workspace`,image:base,uid,gid:process.getgid(),home,runtime};
  const original=configuredProgramRunner(environment); await original.verify();
  // Only this synthetic acceptance fixture prints subprocess output; production
  // package operations retain their deliberately narrow public error response.
  const diagnosticCall=async (args,seconds,signal)=>{
    const step=args[0]==='run' ? (args.includes('--entrypoint=/usr/bin/dpkg-query') ? 'verify installed version' : 'offline apt install') : args[0];
    console.log(`Package step: ${step}`);
    const output=await original.call(args,seconds,signal);
    console.log(`Package step result: ${step}, exit=${output.code}`);
    if(output.stdout) console.log(output.stdout.slice(0,16384));
    if(output.stderr) console.error(output.stderr.slice(0,16384));
    return output;
  };
  const result=await installPackages(base,installation,`niwa-package-${randomUUID()}`,entries,diagnosticCall);
  assert.ok('image' in result, 'Offline installation or committed image validation failed');
  const next=configuredProgramRunner({...environment,image:result.image}); await next.verify();
  const output=await next({command:['niwa-acceptance'],seconds:10});
  assert.equal(output.code,0,output.stderr); assert.equal(output.stdout,'niwa-package-ok\n');
  const absence=await original({command:['sh','-c','! command -v niwa-acceptance'],seconds:10});
  assert.equal(absence.code,0,'Base image must remain unchanged');
  writeFileSync(join(stage,'receipt.json'),JSON.stringify({base,image:result.image,package:entry,verified_at:new Date().toISOString(),
    checks:['offline-install','committed-version','nonroot-program-execution','base-unchanged']},null,2)+'\n',{mode:0o600});
  renameSync(join(stage,'receipt.json'),`${root}/runtime/executor/state/package-acceptance.json`);
  console.log('PASS: offline package installed, committed, version-checked and executed nonroot; original image unchanged');
  console.log('Application settings were not changed by this acceptance run; verified derived image retained.');
} finally { rmSync(stage,{recursive:true,force:true}); }
