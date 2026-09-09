import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
const object=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const quantity=object({memory_mib:Type.Integer({minimum:64,maximum:1048576}),cpu:Type.Number({minimum:0.1,maximum:1024}),pids:Type.Integer({minimum:16,maximum:1048576}),disk_mib:Type.Integer({minimum:16,maximum:16384})});
export const resourceProfileSchema=object({...quantity.properties,seconds:Type.Integer({minimum:1,maximum:86400})});
export const resourceConfigSchema=object({capacity:quantity,reserve:quantity,profiles:Type.Record(Type.String({pattern:'^[a-z][a-z0-9_-]{0,31}$'}),resourceProfileSchema)});
export type ResourceProfile=Static<typeof resourceProfileSchema>;
export type ResourceConfig=Static<typeof resourceConfigSchema>;
type Quantity=Static<typeof quantity>;
const keys=['memory_mib','cpu','pids','disk_mib'] as const;
export const standardProfile:ResourceProfile={memory_mib:512,cpu:1,pids:64,disk_mib:64,seconds:300};
/** All callers share one executor-owned pool; reserve covers the application/browser/model, not task concurrency. */
export class ResourcePool {
 private used:Quantity={memory_mib:0,cpu:0,pids:0,disk_mib:0};
 private retry:ReturnType<typeof setTimeout>|undefined;
 private waiting:{profile:ResourceProfile;signal?:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void}[]=[];
 constructor(readonly config:ResourceConfig,private diskAvailable?:(requiredMiB:number)=>boolean){
  if(!Value.Check(resourceConfigSchema,config)||!config.profiles.standard||keys.some(k=>config.profiles.standard![k]!==standardProfile[k])||config.profiles.standard.seconds!==300)throw Error('Valid resource config and compatible standard profile required');
  if(keys.some(k=>config.capacity[k]<=config.reserve[k]))throw Error('Capacity must exceed application/browser/model reserve');
  for(const profile of Object.values(config.profiles))if(keys.some(k=>profile[k]>config.capacity[k]-config.reserve[k]))throw Error('Profile cannot fit resource capacity');
 }
 profile(name:string){const profile=this.config.profiles[name];if(!profile)throw Error('Unknown administrator resource profile');return {...profile};}
 fits(profile:ResourceProfile){return Value.Check(resourceProfileSchema,profile)&&keys.every(k=>profile[k]<=this.config.capacity[k]-this.config.reserve[k]);}
 status(){return {capacity:this.config.capacity,reserve:this.config.reserve,used:{...this.used},waiting:this.waiting.length};}
 acquire(profile:ResourceProfile,signal?:AbortSignal):Promise<()=>void>{
  if(!this.fits(profile))return Promise.reject(Error('Profile exceeds capacity'));
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const entry={profile,resolve,reject,...(signal?{signal}:{}),abort:()=>{const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);reject(Error('Resource wait cancelled'));this.dispatch();}};
   this.waiting.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});this.dispatch();
  });
 }
 private dispatch(){
  if(this.retry){clearTimeout(this.retry);this.retry=undefined;}
  while(this.waiting.length){const next=this.waiting[0]!;
   if(keys.some(k=>this.used[k]+next.profile[k]>this.config.capacity[k]-this.config.reserve[k]))break;
   if(this.diskAvailable&&!this.diskAvailable(this.config.reserve.disk_mib+this.used.disk_mib+next.profile.disk_mib)){
    this.retry=setTimeout(()=>{this.retry=undefined;this.dispatch();},1000);this.retry.unref();break;
   }
   this.waiting.shift();next.signal?.removeEventListener('abort',next.abort);
   for(const k of keys)this.used[k]+=next.profile[k];let released=false;
   next.resolve(()=>{if(released)return;released=true;for(const k of keys)this.used[k]-=next.profile[k];this.dispatch();});
  }
 }
}
