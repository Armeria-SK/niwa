import {parse,type DefaultTreeAdapterTypes as Tree} from 'parse5';

const omitted=new Set(['script','style','template','noscript','svg','math','iframe','object','canvas','nav','footer','aside']);
const blocks=new Set(['address','article','blockquote','br','dd','div','dl','dt','figcaption','figure','h1','h2','h3','h4','h5','h6','header','hr','li','main','ol','p','pre','section','table','tr','ul']);
const verbatim=new Set(['pre','textarea','listing','xmp']);
const attribute=(node:Tree.Element,name:string)=>node.attrs.find(attr=>attr.name===name)?.value;
const hidden=(node:Tree.Element)=>omitted.has(node.tagName)||node.attrs.some(attr=>attr.name==='hidden'||attr.name==='inert')||
 attribute(node,'aria-hidden')?.trim().toLowerCase()==='true'||/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(attribute(node,'style')??'');

/** Parse inert HTML without executing scripts or fetching resources. Input is already byte bounded. */
export function htmlText(html:string,url:string) {
 const document=parse(html),nodes:Tree.Node[]=[document];let body:Tree.Element|undefined,main:Tree.Element|undefined,title='';
 while(nodes.length){
  const node=nodes.pop()!;
  if('tagName' in node){
   if(hidden(node))continue;
   if(node.tagName==='body')body=node;
   if(node.tagName==='main'&&!main)main=node;
   if(node.tagName==='title')title=node.childNodes.filter((child):child is Tree.TextNode=>'value' in child).map(child=>child.value).join('').trim().slice(0,300);
  }
  if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)nodes.push(node.childNodes[i]!);
 }
 const root=main??body,parts:string[]=[],links:{url:string;text:string}[]=[],seen=new Set<string>(),literal:string[]=[];let linkBytes=2,pre=0;
 // Preformatted text keeps its whitespace: it is stored aside behind a private-use marker so the final whitespace cleanup cannot touch it.
 const restore=(text:string,flat:boolean)=>text.replace(/\uE000(\d+)\uE001/g,(_,i:string)=>flat?literal[+i]!.replace(/\s+/g,' '):literal[+i]!);
 // Enter/exit frames keep text boundaries without recursion on adversarial deep trees.
 const stack:{node:Tree.Node;end?:boolean;link?:string;start?:number}[]=root?[{node:root}]:[];
 while(stack.length){
  const frame=stack.pop()!,node=frame.node;
  if(frame.end){
   if(frame.link&&!seen.has(frame.link)&&links.length<30){
    const link={url:frame.link,text:restore(parts.slice(frame.start).join(''),true).replace(/\s+/g,' ').trim().slice(0,200)},bytes=Buffer.byteLength(JSON.stringify(link))+(links.length?1:0);
    if(linkBytes+bytes<=8192){links.push(link);linkBytes+=bytes;}seen.add(frame.link);
   }
   if('tagName' in node){if(verbatim.has(node.tagName)){pre--;const last=/^\uE000(\d+)\uE001$/.exec(parts.at(-1)??'');if(last)literal[+last[1]!]=literal[+last[1]!]!.replace(/\n$/,'');}if(blocks.has(node.tagName))parts.push('\n');}
   continue;
  }
  if('value' in node){
   const value=node.value.replace(/[\uE000\uE001]/g,'');
   if(pre){literal.push(value.replace(/\r\n?/g,'\n'));parts.push('\uE000'+(literal.length-1)+'\uE001');}else parts.push(value.replace(/\s+/g,' '));
   continue;
  }
  if(!('tagName' in node)||hidden(node))continue;
  if(blocks.has(node.tagName))parts.push('\n');
  if(verbatim.has(node.tagName))pre++;
  if(node.tagName==='td'||node.tagName==='th')parts.push(' | ');
  let link:string|undefined;
  const href=node.tagName==='a'?attribute(node,'href'):undefined;
  if(href&&links.length<30){
   try{const target=new URL(href,url);if(['http:','https:'].includes(target.protocol)&&!target.username&&!target.password&&target.href.length<=4096)link=target.href;}catch{/* Malformed links are just text. */}
  }
  stack.push({node,end:true,...(link?{link,start:parts.length}:{})});
  for(let i=node.childNodes.length-1;i>=0;i--)stack.push({node:node.childNodes[i]!});
 }
 return {title,text:restore(parts.join('').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim(),false),links};
}
