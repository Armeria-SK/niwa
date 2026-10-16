import {createHash} from 'node:crypto';
import {check,DomainError} from './types.ts';

/** Text files only. The browser checks the same limits first; the server is authoritative. */
export const ATTACHMENT_LIMITS={count:5,bytes:256*1024,name:120,excerpt:20_000} as const;
export type AttachmentInput={name:string;content:string};
export type DecodedAttachment={name:string;size:number;sha256:string;body:string};
export type AttachmentInfo={id:string;message_id:string;name:string;size:number};
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Text may use tab, line breaks, form feed and ANSI escapes; other C0 controls and NUL indicate binary data.
const BINARY=/[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/u;

/** Keep only a display name: no directories, controls, reserved filename characters or unbounded length. */
export function attachmentName(value:unknown):string{
  check(typeof value==='string'&&value.length<=1000,'invalid','Invalid attachment name');
  const base=value.normalize('NFC').split(/[\\/]/u).at(-1)!.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,'').replace(/[<>:"|?*]/gu,'_').trim().replace(/^\.+/u,'');
  const name=[...base].slice(0,ATTACHMENT_LIMITS.name).join('').trim();
  check(name.length>0,'invalid','Invalid attachment name');
  return name;
}

/** Strict UTF-8 text decoding; invalid sequences, NUL and binary controls are rejected rather than replaced. */
export function decodeAttachmentText(bytes:Uint8Array):string{
  check(bytes.byteLength<=ATTACHMENT_LIMITS.bytes,'limit','Attachment is too large');
  let body:string;
  try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new DomainError('invalid','Attachment is not UTF-8 text');}
  check(!BINARY.test(body),'invalid','Attachment is not a text file');
  return body;
}

export function decodeAttachments(value:unknown):DecodedAttachment[]{
  if(value===undefined)return [];
  check(Array.isArray(value)&&value.length<=ATTACHMENT_LIMITS.count,'invalid','Too many attachments');
  return value.map((item:unknown)=>{
    check(!!item&&typeof item==='object'&&!Array.isArray(item),'invalid','Invalid attachment');
    const {name,content}=item as Record<string,unknown>;
    check(typeof content==='string'&&content.length<=Math.ceil(ATTACHMENT_LIMITS.bytes/3)*4&&BASE64.test(content),'invalid','Attachment content must be base64');
    const bytes=Buffer.from(content,'base64');
    return {name:attachmentName(name),size:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),body:decodeAttachmentText(bytes)};
  });
}

/** Divide one inline budget fairly: short files are shown whole and long files share what remains. */
export function excerptBudget(lengths:number[],budget:number=ATTACHMENT_LIMITS.excerpt):number[]{
  const result=lengths.map(()=>0);let remaining=budget,left=lengths.length;
  for(const index of lengths.map((_l,i)=>i).sort((a,b)=>lengths[a]!-lengths[b]!)){const share=Math.min(lengths[index]!,Math.floor(remaining/left--));result[index]=share;remaining-=share;}
  return result;
}
