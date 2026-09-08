import { interactionSchema } from './interaction.ts';
import { request } from 'node:http';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { verifyExecutorEndpoint } from '../../config/executor-endpoint.ts';
import { snapshotSchema } from './session.ts';
import { requestCompletionSchema } from './pending-request.ts';

const identity = Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' });
export const formPreparationSchema = Type.Object({ revision: Type.String({ minLength: 1, maxLength: 64 }), ref: Type.Integer({ minimum: 0, maximum: 99 }),
  fields: Type.Array(Type.Object({ ref: Type.Integer({ minimum: 0, maximum: 99 }), value: Type.String({ maxLength: 1000 }) }, { additionalProperties: false }), { maxItems: 32 }),
}, { additionalProperties: false });
export const browserOperationSchema = Type.Object({ agent_id: identity, room_id: identity, task_id: identity,
  action: Type.Union([
    Type.Object({ kind: Type.Literal('navigate'), url: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('snapshot') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('follow'), revision: Type.String({ minLength: 1, maxLength: 64 }), ref: Type.Integer({ minimum: 0, maximum: 99 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('form'), ...formPreparationSchema.properties }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('interact'), input: interactionSchema }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('complete'), input: requestCompletionSchema }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type BrowserOperation = Static<typeof browserOperationSchema>;
export type BrowserExecutor = (input: BrowserOperation, signal?: AbortSignal) => Promise<Static<typeof snapshotSchema>>;

export function browserExecutor(socketPath: string, verifySocket: () => void): BrowserExecutor {
  return async (input, signal) => {
    if (!Value.Check(browserOperationSchema, input)) throw new Error('Invalid browser operation');
    verifySocket(); const body = JSON.stringify(input);
    const cancellation = AbortSignal.any([AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]);
    const result: unknown = await new Promise((resolve, reject) => {
      const req = request({ socketPath, method: 'POST', path: '/browser', agent: false, signal: cancellation,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
          response.destroy(); reject(new Error('Browser service unavailable or reference expired')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length;
          if (size > 512 * 1024) { response.destroy(new Error('Browser observation too large')); return; } chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid browser response')); } });
      });
      req.on('error', reject); req.end(body);
    });
    cancellation.throwIfAborted();
    if (!Value.Check(snapshotSchema, result)) throw new Error('Invalid browser observation');
    return result;
  };
}
export const configuredBrowserExecutor = (path: string, uid: number) => browserExecutor(path, verifyExecutorEndpoint(path, uid));
