import { createServer } from 'node:http';
import { Value } from '@sinclair/typebox/value';
import { browserOperationSchema } from './client.ts';
import type { BrowserSession } from './session.ts';

type Session = Pick<BrowserSession, 'navigate' | 'snapshot' | 'follow' | 'close'> & Partial<Pick<BrowserSession, 'prepareForm' | 'interact' | 'completeRequest'>>;
/** Bind to the protected executor Unix socket only. Caller identities come from the trusted runtime, not model arguments. */
export function createBrowserServer(create: () => Session) {
  const sessions = new Map<string, { session: Session; used: number; busy: boolean }>();
  const active = new Set<AbortController>(); const work = new Set<Promise<void>>(); let stopping = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    if (stopping || active.size >= 6) { response.writeHead(503).end('{}'); request.resume(); return; }
    if (request.method !== 'POST' || request.url !== '/browser' || request.headers['content-type'] !== 'application/json') {
      response.writeHead(400).end('{}'); request.resume(); return;
    }
    const controller = new AbortController(); active.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', disconnect);
    const pending = (async () => {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length;
          if (size > 128 * 1024) { response.writeHead(413).end('{}'); request.destroy(); return; } chunks.push(chunk); }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Value.Check(browserOperationSchema, input)) throw new Error('Invalid browser input');
        const key = JSON.stringify([input.agent_id, input.room_id]);
        let entry = sessions.get(key);
        if (!entry) {
          if (input.action.kind !== 'navigate' || sessions.size >= 16) throw new Error('Navigate again or wait for a browser slot');
          entry = { session: create(), used: Date.now(), busy: false }; sessions.set(key, entry);
        }
        if (entry.busy) throw new Error('Browser busy'); entry.busy = true;
        try {
          const action = input.action;
          const result = action.kind === 'navigate' ? await entry.session.navigate(action.url, controller.signal) :
            action.kind === 'complete' ? await entry.session.completeRequest?.(action.input, controller.signal) :
            action.kind === 'interact' ? await entry.session.interact?.(action.input, controller.signal) :
            action.kind === 'form' ? await entry.session.prepareForm?.(action.revision, action.ref, action.fields, controller.signal) :
            action.kind === 'follow' ? await entry.session.follow(action.revision, action.ref, controller.signal) : await entry.session.snapshot(controller.signal);
          if (!response.destroyed) response.end(JSON.stringify(result));
        } catch (error) { sessions.delete(key); await entry.session.close(); throw error; }
        finally { entry.busy = false; entry.used = Date.now(); }
      } catch { if (!response.destroyed) response.writeHead(400).end('{}'); }
      finally { active.delete(controller); response.off('close', disconnect); }
    })();
    work.add(pending); void pending.finally(() => work.delete(pending));
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  const expiry = setInterval(() => {
    for (const [key, entry] of sessions) if (!entry.busy && Date.now() - entry.used > 5 * 60_000) {
      sessions.delete(key); void entry.session.close().catch(() => {});
    }
  }, 30_000); expiry.unref();
  return { server, stop: async () => {
    stopping = true; clearInterval(expiry); for (const controller of active) controller.abort();
    server.close(); server.closeAllConnections(); await Promise.all(work);
    await Promise.all([...sessions.values()].map(entry => entry.session.close())); sessions.clear();
  } };
}
