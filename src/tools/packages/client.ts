import { request } from 'node:http';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { verifyExecutorEndpoint } from '../../config/executor-endpoint.ts';
import type { PackageOperation, PackageOutcome } from './log.ts';

const item = Type.Object({ name: Type.String({ maxLength: 128 }), version: Type.String({ maxLength: 128 }) }, { additionalProperties: false });
const listSchema = Type.Object({ available: Type.Array(item, { maxItems: 256 }), installed: Type.Array(item, { maxItems: 256 }) }, { additionalProperties: false });
const resultSchema = Type.Object({ operation_id: Type.String(), result: Type.Union([
  Type.Object({ image: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }), installed: Type.Array(item, { maxItems: 64 }) }, { additionalProperties: false }),
  Type.Object({ error: Type.Union([Type.Literal('outcome_unknown'), Type.Literal('installation_failed')]) }, { additionalProperties: false }),
]) }, { additionalProperties: false });

export function packageExecutor(socketPath: string, verifySocket: () => void) {
  const send = async (input?: PackageOperation, signal?: AbortSignal): Promise<unknown> => {
    verifySocket(); const body = input ? JSON.stringify(input) : '';
    if (Buffer.byteLength(body) > 65536) throw new Error('Package request too large');
    const cancellation = AbortSignal.any([AbortSignal.timeout(780_000), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, method: input ? 'POST' : 'GET', path: '/packages', agent: false, signal: cancellation,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
          response.destroy(); reject(new Error('Package request failed; outcome unknown')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 128 * 1024) response.destroy(new Error('Package response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid package response')); } });
      });
      req.on('error', reject); req.end(body);
    });
  };
  return {
    list: async (signal?: AbortSignal) => { const result = await send(undefined, signal); if (!Value.Check(listSchema, result)) throw new Error('Invalid package catalog response'); return result; },
    execute: async (input: PackageOperation, signal?: AbortSignal): Promise<PackageOutcome> => {
      const result = await send(input, signal);
      if (!Value.Check(resultSchema, result) || result.operation_id !== input.operation_id) throw new Error('Invalid package result');
      return result.result;
    },
  };
}
export type PackageExecutor = ReturnType<typeof packageExecutor>;
export const configuredPackageExecutor = (socket: string, uid: number): PackageExecutor => packageExecutor(socket, verifyExecutorEndpoint(socket, uid));
