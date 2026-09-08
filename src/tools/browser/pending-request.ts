import {Type} from '@sinclair/typebox';
import {normalizeForm,formSchema} from './form.ts';

export const requestApprovalSchema = Type.Object({
  request_id: Type.String({pattern:'^[a-f0-9-]{36}$'}), form: formSchema,
},{additionalProperties:false});
export const requestCompletionSchema = Type.Object({
  ...requestApprovalSchema.properties,
  status: Type.Integer({minimum:200,maximum:299}),
  text: Type.String({maxLength:20000}),
},{additionalProperties:false});

/** Anonymous same-origin JSON APIs only. Unsupported headers/bodies never leave the container. */
export function pendingRequest(page: string, request: {url:string;method:string;headers:Record<string,string>;postData?:string}, type:string) {
  if (!['Fetch','XHR'].includes(type) || new URL(request.url).origin !== new URL(page).origin) throw new Error('Unsupported script request');
  if (Object.keys(request.headers).some(name=>! /^(accept|accept-language|content-type|origin|referer|user-agent|sec-[a-z-]+)$/i.test(name))) throw new Error('Unsupported request headers');
  const bounded = (form: ReturnType<typeof normalizeForm>) => {
    if (JSON.stringify({request_id:'0'.repeat(36),form},null,2).length>2000) throw new Error('Script request exceeds approval display limit');
    return form;
  };
  if (request.method==='GET' && !request.postData) return bounded(normalizeForm({url:request.url,method:'GET',fields:Array.from(new URL(request.url).searchParams,([name,value])=>({name,value}))}));
  const typeHeader=Object.entries(request.headers).find(([name])=>name.toLowerCase()==='content-type')?.[1];
  if(request.method!=='POST' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(typeHeader ?? '') || request.postData===undefined) throw new Error('Unsupported script request');
  return bounded(normalizeForm({url:request.url,method:'POST',fields:[],json:request.postData}));
}
