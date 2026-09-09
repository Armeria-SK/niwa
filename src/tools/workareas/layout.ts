import {execFileSync} from 'node:child_process';
import {lstatSync,statfsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {assertDirectoryPath} from '../../config/paths.ts';

/** Deployment must opt in inside the existing bounded executor volume. */
export function verifyWorkareaLayout(root:string,state:string,legacy:string,uid:number){
 const volume=dirname(resolve(state));
 if(resolve(root)!==resolve(volume,'workareas'))throw Error('Unexpected workarea root');
 for(const path of [root,volume,legacy])assertDirectoryPath(path);
 const info=lstatSync(root),disk=statfsSync(root);
 if(info.uid!==uid||(info.mode&0o022)||info.dev!==lstatSync(volume).dev||info.dev===lstatSync(legacy).dev||disk.blocks*disk.bsize>16*1024**3)throw Error('Workarea ownership or capacity boundary missing');
 const mounts=JSON.parse(execFileSync('/usr/bin/findmnt',['--json','--mountpoint',volume,'--output','TARGET,FSTYPE,OPTIONS'],{encoding:'utf8'})).filesystems;
 if(!mounts?.length||mounts.some((m:{target:string;fstype:string;options:string})=>m.target!==volume||m.fstype!=='ext4'||!['nosuid','nodev'].every(o=>m.options.split(',').includes(o))))throw Error('Bounded executor mount required');
}
