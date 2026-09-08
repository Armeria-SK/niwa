import assert from 'node:assert/strict';
import { verifyApprovedForm } from './form-acceptance.mjs';
import { verifyApprovedScript } from './script-acceptance.mjs';
import { BrowserRequests } from '../../dist/tools/browser/requests.js';

// In-memory public-page fixtures; nothing is fetched or submitted to the named domains.
export async function verifyBrowserSession(create) {
  let requests = 0;
  const session = create(url => new BrowserRequests(url, async address => {
    requests++;
    const html = `<title>Niwa acceptance</title><iframe srcdoc='<p>Embedded acceptance</p><button type="button" onclick="this.textContent=String(44)">Frame action</button>'></iframe><div id="component"></div><script>document.getElementById('component').attachShadow({mode:'open'}).innerHTML='<p>Shadow acceptance</p><button type="button" onclick="this.textContent=String(45)">Shadow action</button>';</script><p>Artificial page</p><button type="button" onclick="document.getElementById('detail').hidden=false;fetch('/click-send',{method:'POST'}).catch(()=>{});">Expand</button><p id="detail" hidden>Expanded locally</p><a href="/next">Next</a>
      <form method="post" action="https://forms.example.com/send"><input name="message" placeholder="Message" value="original"><button>Send</button></form>
      <button type="button" onclick="fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:42})}).then(r=>r.json()).then(v=>document.getElementById('json-result').textContent=v.message)">JSON API</button><p id="json-result">Waiting for approval</p>
      <script>fetch('/forbidden',{method:'POST',body:'artificial'}).catch(()=>{});</script>`;
    return {url:address,content_type:'text/html',body_base64:Buffer.from(html).toString('base64'),fetched_at:new Date().toISOString(),untrusted:true};
  }));
  try {
    const cancel = AbortSignal.timeout(60_000);
    let page = await session.navigate('https://fixture.example.com/', cancel);
    for(let i=0;i<20 && !page.blocked.includes('approval_required');i++) page=await session.snapshot(cancel);
    assert.equal(page.title,'Niwa acceptance'); assert.ok(page.blocked.includes('approval_required'));
    assert.match(page.text,/Embedded acceptance/); assert.match(page.text,/Shadow acceptance/);
    for (const [name, expected] of [['Frame action','44'],['Shadow action','45']]) {
      page = await session.interact({action:'click',revision:page.revision,ref:page.elements.find(el=>el.name===name).ref},cancel);
      assert.ok(page.elements.some(el=>el.name===expected));
    }
    page = await session.interact({action:'click',revision:page.revision,ref:page.elements.find(el=>el.name==='Expand').ref},cancel);
    assert.match(page.text,/Expanded locally/); assert.equal(requests,1);
    page = await session.interact({action:'fill',revision:page.revision,ref:page.elements.find(el=>el.name==='Message').ref,value:'local value'},cancel);
    page = await session.interact({action:'scroll',revision:page.revision,pixels:100},cancel);
    const prepared = await session.prepareForm(page.revision,page.elements.find(el=>el.name==='Send').ref,
      [{ref:page.elements.find(el=>el.name==='Message').ref,value:'artificial & 日本語'}],cancel);
    assert.deepEqual(prepared.form, {url:'https://forms.example.com/send',method:'POST',fields:[{name:'message',value:'artificial & 日本語'}]});
    assert.equal(requests,1,'Form preparation must not submit or fetch');
    await verifyApprovedForm(prepared.form);
    page=await session.interact({action:'click',revision:prepared.revision,ref:prepared.elements.find(el=>el.name==='JSON API').ref},cancel);
    for(let i=0;i<10 && !page.requests?.length;i++) page=await session.snapshot(cancel);
    assert.equal(page.requests?.length,1);assert.equal(requests,1);
    page=await verifyApprovedScript(session,page.requests[0]);
    const next = await session.follow(page.revision,page.elements.find(el=>el.name==='Next').ref,cancel);
    assert.match(next.url,/\/next$/); assert.equal(requests,2);
    assert.throws(()=>session.follow(page.revision,0,cancel),/stale/);
    return prepared.form;
  } finally { await session.close(); }
}
