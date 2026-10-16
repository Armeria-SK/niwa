import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,rmSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { networkFor, publicIPv4, readPublicPage, readPublicResource, type PageNetwork } from '../src/tools/web/public-page.ts';

test('public page destination policy rejects private, reserved and alternate IP forms', async () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.3', '203.0.113.3',
    '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '0177.0.0.1']) assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1']) assert.equal(publicIPv4(ip), true, ip);
  let gets = 0;
  const transport: PageNetwork = { resolve: async host => [host], get: async () => { gets++; throw new Error('Must not connect'); } };
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'http://user:password@example.com/', 'http://example.com:11434/',
    'http://localhost/', 'http://service.local/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f000001/',
    'http://127.1/', 'http://169.254.169.254/latest/']) await assert.rejects(readPublicPage(url, undefined, transport));
  assert.equal(gets, 0);
});

test('browser resources preserve binary bytes while retaining public destination, type and size restrictions', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 255, 0, 192, 128]);
  const transport: PageNetwork = {
    resolve: async () => ['8.8.8.8'],
    get: async () => ({ status: 200, contentType: 'image/png', body: bytes }),
  };
  const resource = await readPublicResource('https://public.example.com/image.png', undefined, transport);
  assert.deepEqual(Buffer.from(resource.body_base64, 'base64'), bytes);
  await assert.rejects(readPublicPage('https://public.example.com/image.png', undefined, transport));
  transport.get = async () => ({ status: 200, contentType: 'text/javascript', body: 'const value = 1;' });
  assert.equal(Buffer.from((await readPublicResource('https://public.example.com/app.js', undefined, transport)).body_base64, 'base64').toString(), 'const value = 1;');
  transport.get = async () => ({ status: 200, contentType: 'application/octet-stream', body: bytes });
  await assert.rejects(readPublicResource('https://public.example.com/file', undefined, transport));
  transport.get = async () => ({ status: 200, contentType: 'image/png\r\nSet-Cookie: forged', body: bytes });
  await assert.rejects(readPublicResource('https://public.example.com/image', undefined, transport));
  transport.get = async () => ({ status: 200, contentType: 'image/png', body: Buffer.alloc(256 * 1024 + 1) });
  await assert.rejects(readPublicResource('https://public.example.com/large', undefined, transport));
  let gets = 0;
  transport.resolve = async () => ['127.0.0.1'];
  transport.get = async () => { gets++; throw new Error('Must not connect'); };
  await assert.rejects(readPublicResource('https://public.example.com/private', undefined, transport));
  assert.equal(gets, 0);
});

test('public page checks every DNS answer and every redirect and pins the selected address', async () => {
  const requests: string[] = [];
  const transport: PageNetwork = {
    resolve: async host => host === 'mixed.example.com' ? ['8.8.8.8', '10.0.0.1'] : host === 'private.example.com' ? ['127.0.0.1'] : ['8.8.8.8'],
    get: async (url, address) => {
      requests.push(url.href); assert.equal(address, '8.8.8.8');
      return { status: 302, location: 'https://private.example.com/', contentType: '', body: '' };
    },
  };
  await assert.rejects(readPublicPage('https://mixed.example.com', undefined, transport));
  assert.equal(requests.length, 0);
  await assert.rejects(readPublicPage('https://public.example.com', undefined, transport));
  assert.deepEqual(requests, ['https://public.example.com/']);
  transport.get = async () => ({ status: 302, location: 'http://public.example.com/', contentType: '', body: '' });
  await assert.rejects(readPublicPage('https://public.example.com', undefined, transport), /downgrade/);
});

test('public page returns source and bounded untrusted text, caps redirects and aborts DNS waits', async () => {
  const transport: PageNetwork = {
    resolve: async () => ['8.8.8.8'],
    get: async () => ({ status: 200, contentType: 'text/plain', body: 'あ'.repeat(25_000) }),
  };
  const page = await readPublicPage('https://public.example.com/a#ignored', undefined, transport);
  assert.equal(page.url, 'https://public.example.com/a');
  assert.equal(page.text.length, 20_000); assert.equal(page.truncated, true); assert.equal(page.untrusted, true);
  transport.get = async () => ({ status: 200, contentType: 'text/plain', body: 'あ'.repeat(100_000) });
  await assert.rejects(readPublicPage('https://public.example.com/', undefined, transport), /could not be read/);
  let requests = 0;
  transport.get = async () => { requests++; return { status: 302, contentType: '', body: '', location: '/again' }; };
  await assert.rejects(readPublicPage('https://public.example.com/', undefined, transport), /redirects/);
  assert.equal(requests, 6);
  transport.resolve = () => new Promise(() => {});
  const abort = new AbortController();
  const pending = readPublicPage('https://public.example.com/', abort.signal, transport);
  abort.abort(); await assert.rejects(pending, /cancelled/);
});

test('HTML reading reaches article text after a large head and preserves safe source links without scripts',async()=>{
 const transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:`<!doctype html><html><head><title>人工 &amp; 資料</title><style>${'x'.repeat(24000)}</style><script>forbiddenHead()</script></head><body><nav>メニューだけ</nav><main><h1>調査結果</h1><p>価格は100円 &lt; 200円。</p><p hidden>hidden secret</p><p aria-hidden="true">aria secret</p><script>forbiddenBody()</script><a href="/source">根拠</a><a href="javascript:bad()">無効リンク</a></main></body></html>`})};
 const page=await readPublicPage('https://example.com/article',undefined,transport);
 assert.match(page.text,/調査結果/);assert.match(page.text,/100円 < 200円/);assert.doesNotMatch(page.text,/forbidden|secret|メニューだけ|<script|xxx/);assert.equal(page.truncated,false);
 assert.ok(JSON.stringify(page).includes('https://example.com/source'));assert.ok(!JSON.stringify(page).includes('javascript:'));
});

test('empty dynamic HTML is a classified retrieval failure, while plain text and JSON remain literal',async()=>{
 const transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:'<title>App</title><script>document.write("unexecuted")</script><body><div id="app"></div></body>'})};
 await assert.rejects(readPublicPage('https://example.com/',undefined,transport),(error:unknown)=>(error as {code?:string}).code==='empty_content');
 for(const contentType of ['text/plain','application/json']){
  transport.get=async()=>({status:200,contentType,body:'{"example":"<script>literal</script>"}'});
  assert.equal((await readPublicPage('https://example.com/',undefined,transport)).text,'{"example":"<script>literal</script>"}');
 }
});

test('HTML limits apply to extracted text and hidden containers cannot nominate the article',async()=>{
 const transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:'<body><div style="display: none!important"><main>隠された本文</main></div><article><p>'+ '本文'.repeat(12000)+'</p><template>非表示テンプレート</template></article></body>'})};
 const page=await readPublicPage('https://example.com/',undefined,transport);
 assert.equal(page.text,'本文'.repeat(10000));assert.equal(page.truncated,true);assert.doesNotMatch(page.text,/隠された|テンプレート/);
});

test('many long HTML links cannot inflate the model result beyond the reference budget',async()=>{
 const transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:'<main>本文'+Array.from({length:45},(_,i)=>`<a href="https://example.com/${i}?q=${'a'.repeat(3900)}">出所</a>`).join('')+'</main>'})};
 const page=await readPublicPage('https://example.com/',undefined,transport);
 assert.match(page.text,/本文/);assert.ok(page.links!.length>0);assert.ok(Buffer.byteLength(JSON.stringify(page))<10_000);
});

test('the browser resource module works without the host-only HTML parser in its image',async()=>{
 const root=mkdtempSync('/tmp/niwa-browser-resource-');
 try{
  writeFileSync(root+'/package.json','{"type":"module"}');
  copyFileSync(new URL('../src/tools/web/public-page.js',import.meta.url),root+'/public-page.js');
  const isolated=await import(pathToFileURL(root+'/public-page.js').href);
  const raw='<script>resourceBytes()</script>',transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:raw})};
  const result=await isolated.readPublicResource('https://example.com/',undefined,transport);
  assert.equal(Buffer.from(result.body_base64,'base64').toString(),raw);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('pages are decoded by Content-Type charset or an early meta declaration, falling back to UTF-8',async()=>{
 const text='日本語の文章',sjis=Buffer.from('93fa967b','hex'),eucjp=Buffer.from('c6fccbdc','hex');
 const read=async(contentType:string,body:Buffer)=>(await readPublicPage('https://example.com/',undefined,{resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType,body})})).text;
 assert.equal(await read('text/plain; charset=Shift_JIS',sjis),'日本');
 assert.equal(await read('text/html',Buffer.concat([Buffer.from('<html><head><meta charset="Shift_JIS"></head><body><p>'),sjis,Buffer.from('</p>')])),'日本');
 assert.equal(await read('text/html',Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP"><p>'),eucjp,Buffer.from('</p>')])),'日本');
 assert.equal(await read('text/plain; charset=nonsense-label',Buffer.from(text)),text);
 assert.equal(await read('text/html; charset=utf-8',Buffer.from(`<meta charset=shift_jis><p>${text}</p>`)),text);
});

test('code blocks keep their line breaks and indentation while prose whitespace still collapses',async()=>{
 const html='<main><p>前置き   の\n文章</p><pre><code>def f():\n    return 1\n\n\nprint(f())\n</code></pre><p>次の   段落</p><ul><li>a <a href="/x">リ<pre>  q\n  r</pre>ンク</a></li></ul></main>';
 const page=await readPublicPage('https://example.com/',undefined,{resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/html',body:html})});
 assert.match(page.text,/前置き の 文章\n/);
 assert.ok(page.text.includes('def f():\n    return 1\n\n\nprint(f())\n\n次の 段落'),page.text);
 assert.ok(page.links!.every(link=>!/[]/.test(link.text)));
});

test('large text pages are truncated at the byte cap with paging offsets instead of rejected',async()=>{
 const server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});response.write('a'.repeat(200*1024));response.end('あ'.repeat(100*1024));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const port=(server.address() as {port:number}).port,transport=networkFor('text/plain',/^text\/plain/,256*1024,true);
  const response=await transport.get(new URL(`http://page.example.com:${port}/`),'127.0.0.1',AbortSignal.timeout(5000));
  assert.equal(response.truncated,true);assert.equal(Buffer.byteLength(response.body),256*1024);
  await assert.rejects(networkFor('text/plain',/^text\/plain/,256*1024).get(new URL(`http://page.example.com:${port}/`),'127.0.0.1',AbortSignal.timeout(5000)),/exceeds/);
  const page=await readPublicPage('https://example.com/',undefined,{resolve:async()=>['8.8.8.8'],get:async()=>response});
  assert.equal(page.truncated,true);assert.equal(page.source_truncated,true);assert.equal(page.next_offset,20_000);assert.ok(!page.text.includes('�'));
 }finally{server.closeAllConnections();server.close();}
});

test('offset continues a long page and the last page reports no further offset',async()=>{
 const body=Array.from({length:30_000},(_,i)=>String.fromCharCode(97+i%26)).join('');
 const transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'text/plain',body})};
 const first=await readPublicPage('https://example.com/',undefined,transport);
 assert.equal(first.text,body.slice(0,20_000));assert.equal(first.truncated,true);assert.equal(first.next_offset,20_000);
 const second=await readPublicPage('https://example.com/',undefined,transport,first.next_offset);
 assert.equal(second.text,body.slice(20_000));assert.equal(second.truncated,false);assert.equal(second.offset,20_000);assert.equal('next_offset' in second,false);
 assert.equal((await readPublicPage('https://example.com/',undefined,transport,99_999)).text,'');
});

test('feeds, XML, Markdown and CSV are readable as plain text',async()=>{
 for(const contentType of ['application/rss+xml; charset=utf-8','application/atom+xml','application/xml','text/xml','text/markdown','text/csv']){
  const body='<rss><item>1</item></rss>',transport:PageNetwork={resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType,body})};
  assert.equal((await readPublicPage('https://example.com/',undefined,transport)).text,body,contentType);
 }
 await assert.rejects(readPublicPage('https://example.com/',undefined,{resolve:async()=>['8.8.8.8'],get:async()=>({status:200,contentType:'application/zip',body:'x'})}));
});
