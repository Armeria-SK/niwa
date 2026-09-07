import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { CdpPipe } from '../src/tools/browser/cdp.ts';
import { BrowserPage } from '../src/tools/browser/page.ts';
import { BrowserRequests } from '../src/tools/browser/requests.ts';

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
      <a href="/download" download>Download</a><button>Submit</button><input placeholder="Query">
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
    const refreshed = await page.snapshot();
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
