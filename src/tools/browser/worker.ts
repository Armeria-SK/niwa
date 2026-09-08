import { interactionSchema } from './interaction.ts';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { BrowserPage } from './page.ts';
import { CdpPipe } from './cdp.ts';
import { BrowserWire } from './wire.ts';
import type { readPublicResource } from '../web/public-page.ts';
import { formPreparationSchema } from './client.ts';

const navigateSchema = Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
const followSchema = Type.Object({ revision: Type.String({ minLength: 1, maxLength: 64 }), ref: Type.Integer({ minimum: 0, maximum: 99 }) }, { additionalProperties: false });

/** Runs only trusted operations; production entrypoint is inside the network-none container. */
export async function browserWorker(input: Readable, output: Writable, executable: string, profile: string) {
  const child = spawn(executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: profile, LANG: 'C.UTF-8',
    ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows' } : {}) } });
  const cdp = new CdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable);
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  const page: BrowserPage = new BrowserPage(cdp, () => ({ get: async (request, signal) =>
    await wire.request('resource.read', { url: request.url, method: request.method, resourceType: request.resourceType }, signal) as Awaited<ReturnType<typeof readPublicResource>> }));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    wire.close(); await page.close();
    try { await cdp.send('Browser.close', {}, { timeoutMs: 2_000 }); } catch {}
    cdp.close(); if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  })();
  let busy = false;
  const ready = page.open(); void ready.catch(() => close());
  const wire: BrowserWire = new BrowserWire(input, output, async (method, args, signal) => {
    if (busy || closing) throw new Error('Browser worker busy');
    busy = true;
    try {
      await ready;
      if (method === 'browser.navigate' && Value.Check(navigateSchema, args)) return await page.navigate(args.url, signal);
      if (method === 'browser.follow' && Value.Check(followSchema, args)) return await page.follow(args.revision, args.ref, signal);
      if (method === 'browser.interact' && Value.Check(interactionSchema, args)) return await page.interact(args, signal);
      if (method === 'browser.form' && Value.Check(formPreparationSchema, args)) return await page.prepareForm(args.revision, args.ref, args.fields, signal);
      if (method === 'browser.snapshot' && args && typeof args === 'object' && !Array.isArray(args) && !Object.keys(args).length)
        return await page.snapshot(signal);
      throw new Error('Invalid browser operation');
    } finally { busy = false; }
  });
  input.once('close', () => { void close(); }); input.once('end', () => { void close(); });
  child.once('error', () => { void close(); }); child.once('exit', () => { void close(); });
  return { close };
}
