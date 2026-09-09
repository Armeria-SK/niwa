import {BrowserRequests} from '../tools/browser/requests.ts';
import type {configuredBrowserRunner} from './browser.ts';
/** Generated code runs in a fresh network-none browser. Only raster bytes cross into the administrator UI. */
export function isolatedPreview(browser:ReturnType<typeof configuredBrowserRunner>){
 return async(read:(path:string)=>Promise<{status:number;content_type:string;data:string}>,path:string,mobile:boolean,signal?:AbortSignal)=>{
  // A preview execution reserves one browser alongside the program before starting.
  const origin='https://preview.niwa.invalid',target=new URL(path,origin);
  if(target.origin!==origin) {throw Error('Invalid preview URL');}
  const session=browser.create(url=>new BrowserRequests(url,async(input,cancellation)=>{
   cancellation?.throwIfAborted();const url=new URL(input);if(url.origin!==origin)throw Error('Preview cannot access another origin');
   const result=await read(url.pathname+url.search);if(result.status!==200)throw Error('Preview resource unavailable');
   return {url:url.href,content_type:result.content_type,body_base64:result.data,fetched_at:new Date().toISOString(),untrusted:true as const};
  }));
  let phase='navigation';
  try{const observation=await session.navigate(target.href,signal);phase='capture';const image=await session.capture(mobile,signal);return {...image,title:observation.title,blocked:observation.blocked,origin};}
  catch{throw Error(`Isolated preview ${phase} failed`);}
  finally{await session.close();}
 };
}
