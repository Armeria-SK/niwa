import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { CdpPipe } from '../src/tools/browser/cdp.ts';
import { BrowserPage } from '../src/tools/browser/page.ts';
import { BrowserRequests } from '../src/tools/browser/requests.ts';
import { browserWorker } from '../src/tools/browser/worker.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';

const executable = [process.env.NIWA_TEST_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('dedicated browser renders broker resources, blocks unknown writes, and follows only current observed links', { skip: !executable, timeout: 30_000 }, async () => {
  const testRoot = resolve('.local/browser-tests'); mkdirSync(testRoot, { recursive: true });
  const profile = mkdtempSync(join(testRoot, 'profile-'));
  const child = spawn(executable!, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = new CdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable);
  let ownedSession = '';
  cdp.onEvent(event => { if (event.method === 'Page.loadEventFired') ownedSession = event.sessionId!; });
  const fetched: string[] = [];
  const page = new BrowserPage(cdp, url => new BrowserRequests(url, async address => {
    fetched.push(address);
    const body = address.endsWith('/next') ? '<title>Next</title><p>Second page</p>' :
      `<title>Fixture</title><p>Public document</p><a href="/next" onclick="throw Error('must not click')">Continue</a>
      <a href="/download" download>Download</a><button>Submit</button><input placeholder="Query" oninput="document.getElementById('echo').textContent=this.value"><p id="echo"></p>
      <button type="button" onclick="document.getElementById('detail').hidden=false;fetch('/click-write',{method:'POST'}).catch(()=>{});">Expand</button><p id="detail" hidden>Expanded locally</p>
      <input type="password" placeholder="Secret"><input type="file" aria-label="Upload">
      <iframe srcdoc='<p>Embedded text</p><input placeholder="Embedded query"><button type="button" onclick="this.textContent=String(43)">Embedded action</button>'></iframe><div id="component"></div><script>document.getElementById('component').attachShadow({mode:'open'}).innerHTML='<p>Component text</p><input placeholder="Component query"><button type="button" onclick="this.textContent=String(42)">Component action</button>';</script>
      <script>fetch('/write', {method:'POST',body:'forbidden'}).catch(()=>{});</script>`;
    return { url: address, content_type: 'text/html', body_base64: Buffer.from(body).toString('base64'), fetched_at: new Date().toISOString(), untrusted: true };
  }));
  try {
    await page.open();
    const first = await page.navigate('https://fixture.invalid/');
    assert.equal(first.title, 'Fixture'); assert.match(first.text, /Public document/);
    assert.equal(first.untrusted, true); assert.ok(first.blocked.includes('approval_required'));
    const button = first.elements.find(el => el.name === 'Submit')!;
    await assert.rejects(page.follow(first.revision, button.ref), /requires approval/);
    const download = first.elements.find(el => el.name === 'Download')!;
    await assert.rejects(page.follow(first.revision, download.ref), /requires approval/);
    await assert.rejects(page.follow('invented', 0), /stale/);
    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('a').href='/changed'" }, { sessionId: ownedSession });
    await assert.rejects(page.follow(first.revision, first.elements.find(el => el.name === 'Continue')!.ref), /changed/);
    await cdp.send('Runtime.evaluate', { expression: "document.querySelector('a').href='/next'" }, { sessionId: ownedSession });
    let interaction = await page.snapshot();
    assert.match(interaction.text, /Component text/);
    assert.match(interaction.text, /Embedded text/);
    interaction = await page.interact({ action: 'fill', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Embedded query')!.ref, value: 'frame value' });
    interaction = await page.interact({ action: 'click', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Embedded action')!.ref });
    assert.ok(interaction.elements.some(el => el.name === '43'));
    interaction = await page.interact({ action: 'fill', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Component query')!.ref, value: 'component value' });
    interaction = await page.interact({ action: 'click', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Component action')!.ref });
    assert.ok(interaction.elements.some(el => el.name === '42'));
    await assert.rejects(page.interact({ action: 'fill', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Secret')!.ref, value: 'not-a-real-secret' }));
    await assert.rejects(page.interact({ action: 'fill', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Upload')!.ref, value: 'file' }));
    await assert.rejects(page.interact({ action: 'click', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Submit')!.ref }));
    interaction = await page.interact({ action: 'fill', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Query')!.ref, value: 'Synthetic typed value' });
    assert.match(interaction.text, /Synthetic typed value/);
    interaction = await page.interact({ action: 'click', revision: interaction.revision, ref: interaction.elements.find(el => el.name === 'Expand')!.ref });
    assert.match(interaction.text, /Expanded locally/); assert.ok(interaction.blocked.includes('network_disabled_during_interaction'));
    assert.deepEqual(fetched, ['https://fixture.invalid/']);
    await assert.rejects(page.interact({ action: 'scroll', revision: first.revision, pixels: 100 }), /stale/);
    const refreshed = await page.interact({ action: 'scroll', revision: interaction.revision, pixels: 100 });
    await assert.rejects(page.follow(first.revision, 0), /stale/);
    const next = await page.follow(refreshed.revision, refreshed.elements.find(el => el.name === 'Continue')!.ref);
    assert.equal(next.title, 'Next'); assert.match(next.text, /Second page/);
    await assert.rejects(page.follow(first.revision, 0), /stale/);
    assert.deepEqual(fetched, ['https://fixture.invalid/', 'https://fixture.invalid/next']);
    await assert.rejects(page.navigate('file:///etc/passwd'), /Public HTTP/);
    await page.close(); await assert.rejects(page.navigate('https://fixture.invalid/'), /unavailable/);
  } finally {
    await page.close();
    try { await cdp.send('Browser.close', {}, { timeoutMs: 2_000 }); } catch {}
    cdp.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.ok(resolve(profile).startsWith(testRoot + '\\') || resolve(profile).startsWith(testRoot + '/'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('browser session and worker exchange bounded observations and resources through private pipes', { skip: !executable, timeout: 30_000 }, async () => {
  const testRoot = resolve('.local/browser-tests'); mkdirSync(testRoot, { recursive: true });
  const profile = mkdtempSync(join(testRoot, 'worker-'));
  const toWorker = new PassThrough(), toHost = new PassThrough();
  const worker = await browserWorker(toWorker, toHost, executable!, profile);
  const requests: string[] = [];
  const session = new BrowserSession(toHost, toWorker, worker.close, url => new BrowserRequests(url, async address => {
    requests.push(address);
    const body = address.endsWith('/next') ? '<title>Next</title>' :
      `<title>Worker</title><a href="/next">Next</a>
      <form action="https://forms.example.com/send" method="post" onsubmit="throw Error('must not submit')">
        <input name="message" placeholder="Message" value="original"><input type="hidden" name="token" value="artificial">
        <input type="checkbox" name="agree" value="yes" checked><button name="intent" value="send">Send</button>
      </form><script>fetch('/private',{method:'POST'}).catch(()=>{});</script>`;
    return { url: address, content_type: 'text/html', body_base64: Buffer.from(body).toString('base64'), fetched_at: new Date().toISOString(), untrusted: true };
  }));
  try {
    const first = await session.navigate('https://fixture.invalid/');
    assert.equal(first.title, 'Worker'); assert.ok(first.blocked.includes('approval_required'));
    await assert.rejects(async () => session.follow('forged', 0), /stale/);
    const prepared = await session.prepareForm(first.revision, first.elements.find(el => el.name === 'Send')!.ref,
      [{ ref: first.elements.find(el => el.name === 'Message')!.ref, value: 'hello & 日本語' }]);
    assert.deepEqual(prepared.form, { url: 'https://forms.example.com/send', method: 'POST', fields: [
      { name: 'message', value: 'hello & 日本語' }, { name: 'token', value: 'artificial' }, { name: 'agree', value: 'yes' }, { name: 'intent', value: 'send' },
    ] });
    assert.deepEqual(requests, ['https://fixture.invalid/']);
    const original = await session.prepareForm(prepared.revision, prepared.elements.find(el => el.name === 'Send')!.ref, []);
    assert.equal(original.form!.fields[0]!.value, 'original');
    const next = await session.follow(original.revision, original.elements[0]!.ref);
    assert.equal(next.title, 'Next');
    assert.deepEqual(requests, ['https://fixture.invalid/', 'https://fixture.invalid/next']);
    const refreshed = await session.snapshot(); assert.notEqual(refreshed.revision, next.revision);
  } finally {
    await session.close();
    assert.ok(resolve(profile).startsWith(testRoot + '\\') || resolve(profile).startsWith(testRoot + '/'));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('JSON SPA requests stay paused until an exact response arrives and expire on navigation', {skip:!executable,timeout:30_000}, async()=>{
  const testRoot=resolve('.local/browser-tests');mkdirSync(testRoot,{recursive:true});
  const profile=mkdtempSync(join(testRoot,'spa-')),toWorker=new PassThrough(),toHost=new PassThrough();
  const worker=await browserWorker(toWorker,toHost,executable!,profile);let reads=0;
  const session=new BrowserSession(toHost,toWorker,worker.close,url=>new BrowserRequests(url,async address=>{
    reads++;
    const html=`<p id="read">Reading paused</p><script>fetch('/read?value=one').then(r=>r.json()).then(v=>document.getElementById('read').textContent=v.message)</script><p id="result">Waiting</p><button type="button" onclick="fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:42})}).then(r=>r.json()).then(v=>document.getElementById('result').textContent=v.message)">Save</button>`;
    return {url:address,content_type:'text/html',body_base64:Buffer.from(html).toString('base64'),fetched_at:new Date().toISOString(),untrusted:true};
  }));
  try {
    let first=await session.navigate('https://fixture.example.com/');
    for(let i=0;i<10 && !first.requests?.length;i++) first=await session.snapshot();
    const initial=first.requests![0]!;
    assert.deepEqual(initial.form,{url:'https://fixture.example.com/read',method:'GET',fields:[{name:'value',value:'one'}]});
    first=await session.completeRequest({...initial,status:200,text:'{"message":"Approved initial read"}'});
    for(let i=0;i<10 && !first.text.includes('Approved initial read');i++) first=await session.snapshot();
    assert.match(first.text,/Approved initial read/);assert.equal(reads,1);
    let page=await session.interact({action:'click',revision:first.revision,ref:first.elements[0]!.ref});
    for(let i=0;i<10 && !page.requests?.length;i++) page=await session.snapshot();
    assert.equal(reads,1);assert.match(page.text,/Waiting/);assert.equal(page.requests?.length,1);
    const pending=page.requests![0]!;
    assert.deepEqual(pending.form,{url:'https://fixture.example.com/api',method:'POST',fields:[],json:'{"value":42}'});
    page=await session.completeRequest({...pending,status:200,text:'{"message":"Saved exactly once"}'});
    for(let i=0;i<10 && !page.text.includes('Saved exactly once');i++) page=await session.snapshot();
    assert.match(page.text,/Saved exactly once/);assert.equal(page.requests,undefined);assert.equal(reads,1);
    page=await session.interact({action:'click',revision:page.revision,ref:page.elements[0]!.ref});
    for(let i=0;i<10 && !page.requests?.length;i++) page=await session.snapshot();
    const expired=page.requests![0]!;
    await session.navigate('https://fixture.example.com/next');
    await assert.rejects(session.completeRequest({...expired,status:200,text:'{}'}),/rejected/);
  } finally {await session.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
