import assert from 'node:assert/strict';
import { verifyApprovedForm } from './form-acceptance.mjs';
import { BrowserRequests } from '../../dist/tools/browser/requests.js';

// In-memory public-page fixtures; nothing is fetched or submitted to the named domains.
export async function verifyBrowserSession(create) {
  let requests = 0;
  const session = create(url => new BrowserRequests(url, async address => {
    requests++;
    const html = `<title>Niwa acceptance</title><p>Artificial page</p><a href="/next">Next</a>
      <form method="post" action="https://forms.example.com/send"><input name="message" placeholder="Message" value="original"><button>Send</button></form>
      <script>fetch('/forbidden',{method:'POST',body:'artificial'}).catch(()=>{});</script>`;
    return {url:address,content_type:'text/html',body_base64:Buffer.from(html).toString('base64'),fetched_at:new Date().toISOString(),untrusted:true};
  }));
  try {
    const cancel = AbortSignal.timeout(60_000);
    const page = await session.navigate('https://fixture.example.com/', cancel);
    assert.equal(page.title,'Niwa acceptance'); assert.ok(page.blocked.includes('approval_required'));
    const prepared = await session.prepareForm(page.revision,page.elements.find(el=>el.name==='Send').ref,
      [{ref:page.elements.find(el=>el.name==='Message').ref,value:'artificial & 日本語'}],cancel);
    assert.deepEqual(prepared.form, {url:'https://forms.example.com/send',method:'POST',fields:[{name:'message',value:'artificial & 日本語'}]});
    assert.equal(requests,1,'Form preparation must not submit or fetch');
    await verifyApprovedForm(prepared.form);
    const next = await session.follow(prepared.revision,prepared.elements.find(el=>el.name==='Next').ref,cancel);
    assert.match(next.url,/\/next$/); assert.equal(requests,2);
    assert.throws(()=>session.follow(page.revision,0,cancel),/stale/);
    return prepared.form;
  } finally { await session.close(); }
}
