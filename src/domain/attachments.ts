import {createHash} from 'node:crypto';
import {check,DomainError} from './types.ts';
import {pdfText} from './pdf-text.ts';

/** Text files, images and PDFs. The kind is decided from the bytes, never the file name. The browser checks the same limits first; the server is authoritative. */
export const ATTACHMENT_LIMITS={count:5,bytes:256*1024,imageBytes:3*1024*1024,pdfBytes:4*1024*1024,totalBytes:8*1024*1024,name:120,excerpt:20_000} as const;
export type MediaType='text/plain'|'image/png'|'image/jpeg'|'image/gif'|'image/webp'|'application/pdf';
export type AttachmentInput={name:string;content:string};
/** body is the text a model reads: the file itself, the text taken from a PDF, or nothing for an image. data keeps an image's or PDF's bytes. */
export type DecodedAttachment={name:string;size:number;sha256:string;body:string;media_type:MediaType;data:Buffer|null};
export type AttachmentInfo={id:string;message_id:string;name:string;size:number;media_type?:MediaType;unseen_by?:string[]};
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Text may use tab, line breaks, form feed and ANSI escapes; other C0 controls and NUL indicate binary data.
const BINARY=/[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/u;
export const isImage=(type:string|undefined):type is Extract<MediaType,`image/${string}`>=>!!type&&type.startsWith('image/');

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

/** The image kind and its pixel size, read from the header. A header that cannot be read is not treated as an image. */
export function imageInfo(bytes:Uint8Array):{media_type:Extract<MediaType,`image/${string}`>;width:number;height:number}|null{
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const ok=(width:number,height:number)=>width>0&&height>0&&width<=20_000&&height<=20_000;
  if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))&&b.toString('latin1',12,16)==='IHDR'){
    const width=b.readUInt32BE(16),height=b.readUInt32BE(20);return ok(width,height)?{media_type:'image/png',width,height}:null;
  }
  if(b.length>=10&&/^GIF8[79]a$/.test(b.toString('latin1',0,6))){const width=b.readUInt16LE(6),height=b.readUInt16LE(8);return ok(width,height)?{media_type:'image/gif',width,height}:null;}
  if(b.length>=30&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'){
    const chunk=b.toString('latin1',12,16);let width=0,height=0;
    if(chunk==='VP8X'){width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(chunk==='VP8 '){width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if(chunk==='VP8L'&&b[20]===0x2f){const bits=b.readUInt32LE(21);width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);}
    return ok(width,height)?{media_type:'image/webp',width,height}:null;
  }
  if(b.length>=4&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff){
    // Walk the markers to the frame header that carries the size.
    for(let at=2;at+9<b.length;){
      if(b[at]!==0xff){at++;continue;}
      const marker=b[at+1]!;
      if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){at+=2;continue;}
      if(marker===0xff){at++;continue;}
      const length=b.readUInt16BE(at+2);
      if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)){const height=b.readUInt16BE(at+5),width=b.readUInt16BE(at+7);return ok(width,height)?{media_type:'image/jpeg',width,height}:null;}
      if(length<2)return null;
      at+=2+length;
    }
  }
  return null;
}

function decodeOne(name:string,bytes:Buffer):DecodedAttachment{
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const image=imageInfo(bytes);
  if(image){check(bytes.byteLength<=ATTACHMENT_LIMITS.imageBytes,'limit','Image is too large');return {name,size:bytes.byteLength,sha256,body:'',media_type:image.media_type,data:bytes};}
  if(bytes.subarray(0,5).toString('latin1')==='%PDF-'){
    check(bytes.byteLength<=ATTACHMENT_LIMITS.pdfBytes,'limit','PDF is too large');
    const read=pdfText(bytes);
    return {name,size:bytes.byteLength,sha256,body:read.ok?read.text:'',media_type:'application/pdf',data:bytes};
  }
  return {name,size:bytes.byteLength,sha256,body:decodeAttachmentText(bytes),media_type:'text/plain',data:null};
}

export function decodeAttachments(value:unknown):DecodedAttachment[]{
  if(value===undefined)return [];
  check(Array.isArray(value)&&value.length<=ATTACHMENT_LIMITS.count,'invalid','Too many attachments');
  let total=0;
  return value.map((item:unknown)=>{
    check(!!item&&typeof item==='object'&&!Array.isArray(item),'invalid','Invalid attachment');
    const {name,content}=item as Record<string,unknown>;
    check(typeof content==='string'&&content.length<=Math.ceil(ATTACHMENT_LIMITS.pdfBytes/3)*4&&BASE64.test(content),'invalid','Attachment content must be base64');
    const bytes=Buffer.from(content,'base64');
    total+=bytes.byteLength;check(total<=ATTACHMENT_LIMITS.totalBytes,'limit','Attachments are too large together');
    return decodeOne(attachmentName(name),bytes);
  });
}

/** Divide one inline budget fairly: short files are shown whole and long files share what remains. */
export function excerptBudget(lengths:number[],budget:number=ATTACHMENT_LIMITS.excerpt):number[]{
  const result=lengths.map(()=>0);let remaining=budget,left=lengths.length;
  for(const index of lengths.map((_l,i)=>i).sort((a,b)=>lengths[a]!-lengths[b]!)){const share=Math.min(lengths[index]!,Math.floor(remaining/left--));result[index]=share;remaining-=share;}
  return result;
}
