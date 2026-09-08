import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { JsonObject } from '../../contracts/model.ts';
import { verifyExecutorEndpoint as verifyEndpoint } from '../../config/executor-endpoint.ts';
import type { WorkspaceWrite } from './write-log.ts';

export type WorkspaceRead = (operation: 'list' | 'read', path: string, signal?: AbortSignal) => Promise<JsonObject>;
export type WorkspaceWriter = (input: WorkspaceWrite, signal?: AbortSignal) => Promise<JsonObject>;
export type WorkspaceDownload = (path: string, signal?: AbortSignal) => Promise<JsonObject>;
const downloadSchema = Type.Object({ path: Type.String(), data: Type.String({ maxLength: 11_184_812 }),
  revision: Type.String({ pattern: '^[a-f0-9]{64}$' }), shared: Type.Literal(true) }, { additionalProperties: false });
const writeSchema = Type.Union([
  Type.Object({ path: Type.String(), revision: Type.String({ pattern: '^[a-f0-9]{64}$' }), shared: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ error: Type.Union(['invalid_path', 'not_found', 'conflict', 'unsupported', 'outcome_unknown'].map(value => Type.Literal(value))) }, { additionalProperties: false }),
]);
const readSchema = Type.Object({ path: Type.String(), content: Type.String({ maxLength: 65536 }), revision: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  shared: Type.Literal(true), untrusted: Type.Literal(true) }, { additionalProperties: false });
const listSchema = Type.Object({ path: Type.String(), entries: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\\u0000]+$' }),
  kind: Type.Union([Type.Literal('directory'), Type.Literal('file')]) }, { additionalProperties: false }), { maxItems: 200 }),
  truncated: Type.Boolean() }, { additionalProperties: false });

/** Transport only. The composition root supplies a protected endpoint and validates its ownership on every call. */
async function callWorkspace(socketPath: string, verifySocket: () => void, input: JsonObject, signal?: AbortSignal, maxResponse = 512 * 1024): Promise<unknown> {
    verifySocket();
    const cancellation = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('Workspace request too large');
    const output = await new Promise<unknown>((resolve, reject) => {
      const req = request({ socketPath, method: 'POST', path: '/files', agent: false, signal: cancellation,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
          response.destroy(); reject(new Error('Workspace request failed')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponse) { response.destroy(new Error('Workspace response too large')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid workspace response')); }
        });
      });
      req.on('error', reject); req.end(body);
    });
    cancellation.throwIfAborted();
    return output;
}

export function workspaceReader(socketPath: string, verifySocket: () => void): WorkspaceRead {
  return async (operation, path, signal) => {
    if (!['list', 'read'].includes(operation) || typeof path !== 'string' || path.length > 512) throw new Error('Invalid workspace request');
    const output = await callWorkspace(socketPath, verifySocket, { operation, path }, signal);
    if (!Value.Check(operation === 'read' ? readSchema : listSchema, output)) throw new Error('Invalid workspace response');
    const result = output as JsonObject;
    if (result.path !== path) throw new Error('Workspace response scope mismatch');
    if (operation === 'read' && (Buffer.byteLength(result.content as string) > 65536 || (result.content as string).includes('\0') ||
      createHash('sha256').update(result.content as string).digest('hex') !== result.revision)) throw new Error('Workspace revision mismatch');
    return result;
  };
}

export function workspaceDownloader(socketPath: string, verifySocket: () => void): WorkspaceDownload {
  return async (path, signal) => {
    if (typeof path !== 'string' || !path || path.length > 512) throw new Error('Invalid workspace request');
    const output = await callWorkspace(socketPath, verifySocket, { operation: 'download', path }, signal, 12 * 1024 * 1024);
    if (!Value.Check(downloadSchema, output)) throw new Error('Invalid workspace download');
    const bytes = Buffer.from(output.data, 'base64');
    if (output.path !== path || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== output.data ||
      createHash('sha256').update(bytes).digest('hex') !== output.revision) throw new Error('Workspace download mismatch');
    return output;
  };
}
export function workspaceWriter(socketPath: string, verifySocket: () => void): WorkspaceWriter {
  return async (input, signal) => {
    const output = await callWorkspace(socketPath, verifySocket, { ...input, operation: 'write' }, signal);
    if (!Value.Check(writeSchema, output)) throw new Error('Invalid workspace write response');
    const result = output as JsonObject;
    if (!result.error && (result.path !== input.path || result.revision !== createHash('sha256').update(Buffer.from(input.content, input.encoding ?? 'utf8')).digest('hex'))) {
      throw new Error('Workspace write response mismatch');
    }
    return result;
  };
}

export function configuredWorkspaceReader(socketPath: string, executionUid: number): WorkspaceRead {
  return workspaceReader(socketPath, verifyEndpoint(socketPath, executionUid));
}
export function configuredWorkspaceDownloader(socketPath: string, executionUid: number): WorkspaceDownload {
  return workspaceDownloader(socketPath, verifyEndpoint(socketPath, executionUid));
}
export function configuredWorkspaceWriter(socketPath: string, executionUid: number): WorkspaceWriter {
  return workspaceWriter(socketPath, verifyEndpoint(socketPath, executionUid));
}
