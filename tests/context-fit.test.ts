import assert from 'node:assert/strict';
import test from 'node:test';
import { fitContext, ContextLimit } from '../src/runtime/context/fit.ts';
import type { ModelMessage } from '../src/contracts/model.ts';
import { request } from './fixtures/model.ts';

test('context fitting keeps instructions and newest complete exchange without changing budgets or original history', () => {
  const history: ModelMessage[] = ['old', 'new'].flatMap(id => [
    { role: 'assistant', tool_calls: [{ tool_call_id: id, name: 'history_read', arguments: {} }] },
    { role: 'tool', tool_call_id: id, name: 'history_read', content: id.repeat(15_000) },
  ] as ModelMessage[]);
  const pinned: ModelMessage = { role: 'user', content: 'Original request and all administrator instructions' };
  const state: ModelMessage = { role: 'user', content: 'Canonical work state' };
  const input = { ...request, messages: [pinned, ...history, state] };
  const unchanged = structuredClone(input);
  const fitted = fitContext(input, history, 25_000);
  assert.equal(fitted.removed_messages, 2);
  assert.deepEqual(fitted.request.messages, [pinned, ...history.slice(2), state]);
  assert.deepEqual(input, unchanged);
  assert.equal(fitted.request.budget, input.budget);
  assert.equal(fitted.request.system_instructions, input.system_instructions);
  assert.ok(fitted.estimated_input_tokens + input.budget.max_output_tokens <= 25_000);
  assert.equal(fitContext(input, history, 100_000).request, input);
});

test('unknown capacity is not inferred from budget; oversized pinned context waits without dropping it', () => {
  assert.equal(fitContext(request, []).removed_messages, 0);
  const large = { ...request, messages: [{ role: 'user' as const, content: '日本語'.repeat(20_000) }] };
  assert.throws(() => fitContext(large, []), /容量が不明/);
  assert.throws(() => fitContext(large, [], 8_000), /収まりません/);
  for (const value of [0, -1, NaN, Infinity, 2.5]) assert.throws(() => fitContext(request, [], value), ContextLimit);
  const orphan: ModelMessage = { role: 'tool', tool_call_id: 'missing', name: 'read', content: 'bad' };
  assert.throws(() => fitContext({ ...request, messages: [orphan] }, [orphan], 1_000_000), /orphan/);
});
