import type {WorkareaStore,WorkareaRequest} from '../tools/workareas/store.ts';
import { createServer } from 'node:http';
import type { ProgramLog, ProgramOperation } from './program-log.ts';
import type { PackageLog, PackageOperation } from '../tools/packages/log.ts';

/** Composition root must bind only to a protected Unix socket shared with the trusted Niwa service. */
export function createProgramServer(log: Pick<ProgramLog, 'execute'>, packages?: Pick<PackageLog, 'execute' | 'list'>, workareas?: WorkareaStore) {
  const active = new Set<AbortController>();
  const work = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    if (stopping || active.size >= 4) { response.writeHead(503).end('{"error":"unavailable"}'); request.resume(); return; }
    if (request.method === 'GET' && request.url === '/packages' && packages) { response.end(JSON.stringify(packages.list())); request.resume(); return; }
    const isWorkarea = request.url === '/workareas' && workareas;
    const isPackage = request.url === '/packages' && packages;
    if (request.method !== 'POST' || (request.url !== '/programs' && !isPackage && !isWorkarea) || request.headers['content-type'] !== 'application/json') {
      response.writeHead(400).end('{"error":"invalid_request"}'); request.resume(); return;
    }
    const controller = new AbortController(); active.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const pending = (async () => {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > (isWorkarea ? 12 * 1024 * 1024 : 128 * 1024)) { response.writeHead(413).end('{"error":"too_large"}'); request.destroy(); return; }
          chunks.push(chunk);
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(isWorkarea){
          if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid workarea operation');
          const operation=input as WorkareaRequest;
          const result=operation.operation==='published'?workareas!.published(operation.artifact!):await workareas!.execute(operation,controller.signal);
          if(!response.destroyed)response.end(JSON.stringify(result));return;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['operation_id', 'agent_id', 'room_id', 'task_id', 'allow_start', ...(isPackage ? ['names'] : ['command', 'seconds'])].includes(key))) {
          response.writeHead(400).end('{"error":"invalid_request"}'); return;
        }
        const result = isPackage ? await packages!.execute(input as PackageOperation, controller.signal) : await log.execute(input as ProgramOperation, controller.signal);
        if (!response.destroyed) response.end(JSON.stringify({ operation_id: (input as ProgramOperation).operation_id, result }));
      } catch { if (!response.destroyed) response.writeHead(400).end('{"error":"request_failed"}'); }
      finally { active.delete(controller); response.off('close', disconnect); }
    })();
    work.add(pending); void pending.finally(() => work.delete(pending));
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  return { server, stop: async () => {
    stopping = true; for (const controller of active) controller.abort();
    server.close(); server.closeAllConnections(); await Promise.all(work); await workareas?.stop();
  } };
}
