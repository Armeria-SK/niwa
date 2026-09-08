import { createServer } from 'node:http';
import { Workspace, WorkspaceError } from './workspace.ts';
import type { WorkspaceWriteLog } from './write-log.ts';

/** Only bind this broker to the protected niwa-exec Unix socket; never expose it as a network service. */
export function createWorkspaceServer(workspace: Workspace, writes?: WorkspaceWriteLog) {
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/files' || request.headers['content-type'] !== 'application/json') {
      response.writeHead(400).end('{"error":"invalid_request"}'); request.resume(); return;
    }
    if (active >= 2) { response.writeHead(503).end('{"error":"busy"}'); request.resume(); return; }
    active++;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) { response.writeHead(413).end('{"error":"too_large"}'); request.destroy(); return; }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceError('unsupported');
      const args = body as Record<string, unknown>;
      if (typeof args.path !== 'string' || Object.keys(args).some(key => !['operation', 'operation_id', 'path', 'content', 'expected_revision', 'encoding'].includes(key))) throw new WorkspaceError('unsupported');
      const result = args.operation === 'list' ? workspace.list(args.path) : args.operation === 'read' ? workspace.read(args.path)
        : args.operation === 'download' ? workspace.download(args.path)
        : args.operation === 'write' && writes && typeof args.operation_id === 'string' && typeof args.content === 'string' && (typeof args.expected_revision === 'string' || args.expected_revision === null)
          ? writes.write({ operation_id: args.operation_id, path: args.path, content: args.content, expected_revision: args.expected_revision, ...(args.encoding !== undefined ? { encoding: args.encoding as 'utf8' | 'base64' } : {}) }) : undefined;
      if (!result) throw new WorkspaceError('unsupported');
      response.end(JSON.stringify(result));
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unavailable';
      response.writeHead(code === 'conflict' ? 409 : 400).end(JSON.stringify({ error: code }));
    } finally { active--; }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.setTimeout(10_000, socket => socket.destroy());
  return server;
}
