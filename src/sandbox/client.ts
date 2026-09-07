import { request } from 'node:http';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { verifyExecutorEndpoint } from '../config/executor-endpoint.ts';
import type { ProgramOperation, ProgramResult } from './program-log.ts';

export type ProgramExecutor = (input: ProgramOperation, signal?: AbortSignal) => Promise<ProgramResult>;
const responseSchema = Type.Object({ operation_id: Type.String(), result: Type.Union([
  Type.Object({ code: Type.Integer(), stdout: Type.String(), stderr: Type.String() }, { additionalProperties: false }),
  Type.Object({ error: Type.Literal('outcome_unknown') }, { additionalProperties: false }),
]) }, { additionalProperties: false });

/** No automatic retry: losing an IPC reply cannot prove that the program did not change files. */
export function programExecutor(socketPath: string, verifySocket: () => void): ProgramExecutor {
  return async (input, signal) => {
    verifySocket();
    if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 300) throw new Error('Invalid execution timeout');
    const body = JSON.stringify(input); const operationId = input.operation_id;
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Program request too large');
    const cancellation = AbortSignal.any([AbortSignal.timeout((input.seconds + 30) * 1000), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    const output: unknown = await new Promise((resolve, reject) => {
      const req = request({ socketPath, method: 'POST', path: '/programs', agent: false, signal: cancellation,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
          response.destroy(); reject(new Error('Program request failed; outcome unknown')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) { response.destroy(new Error('Program response too large')); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid program response')); } });
      });
      req.on('error', reject); req.end(body);
    });
    cancellation.throwIfAborted();
    if (!Value.Check(responseSchema, output) || output.operation_id !== operationId || (!('error' in output.result) &&
        (Buffer.byteLength(output.result.stdout) > 65536 || Buffer.byteLength(output.result.stderr) > 65536))) throw new Error('Invalid program response');
    return output.result;
  };
}

export const configuredProgramExecutor = (socketPath: string, executionUid: number): ProgramExecutor =>
  programExecutor(socketPath, verifyExecutorEndpoint(socketPath, executionUid));
