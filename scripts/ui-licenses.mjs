import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
/** Ship the license texts of bundled dependencies alongside the UI. */
export function uiLicenses() {
 return {name:'niwa-ui-licenses',generateBundle(_options,bundle){
  const roots=new Set();
  for(const output of Object.values(bundle))if(output.type==='chunk')for(const id of Object.keys(output.modules)){
   const match=id.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);if(match)roots.add(match[1]);
  }
  const notices=[...roots].sort().flatMap(root=>{
   if(!existsSync(resolve(root,'package.json')))return [];
   const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
   const files=readdirSync(root).filter(name=>/^(licen[sc]e|copying|notice|ofl)(\.|$)/i.test(name));
   return files.map(name=>`${pkg.name} ${pkg.version} — ${name}\n${readFileSync(resolve(root,name),'utf8')}`);
  });
  this.emitFile({type:'asset',fileName:'THIRD-PARTY-LICENSES.txt',source:notices.join('\n\n---\n\n')});
 }};
}
