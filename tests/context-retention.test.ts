import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from '../src/contracts/index.ts';
import { retainCompleteExchanges } from '../src/runtime/context/retention.ts';

const user = (content: string): ModelMessage => ({ role: 'user', content });
const answer = (content: string): ModelMessage => ({ role: 'assistant', content });
const call: ModelMessage = { role: 'assistant', tool_calls: [
  { tool_call_id: 'a', name: 'history_search', arguments: {} },
  { tool_call_id: 'b', name: 'history_read', arguments: {} },
] };
const results: ModelMessage[] = [
  { role: 'tool', tool_call_id: 'b', name: 'history_read', content: 'source' },
  { role: 'tool', tool_call_id: 'a', name: 'history_search', content: 'reference' },
];

test('retention pins initial and latest instructions, keeps entire parallel exchange and leaves storage intact', () => {
  const initial = user('original request'), latest = user('changed requirement');
  const messages = [initial, answer('old'), latest, answer('old reply'), call, ...results];
  const original = structuredClone(messages);
  assert.deepEqual(retainCompleteExchanges(messages, 1), [initial, latest, call, ...results]);
  assert.deepEqual(messages, original);
  assert.deepEqual(retainCompleteExchanges(messages, 0), [initial, latest]);
  assert.deepEqual(retainCompleteExchanges(messages, 100), messages);
  assert.deepEqual(retainCompleteExchanges([...messages, user('pending')], 1), [initial, call, ...results, user('pending')]);
});

test('retention rejects incomplete or corrupt exchanges even when they would be discarded', () => {
  const invalid: ModelMessage[][] = [
    [results[0]!], [call], [call, results[0]!], [call, results[0]!, results[0]!],
    [call, { ...results[0]!, name: 'wrong' } as ModelMessage, results[1]!],
    [{ role: 'assistant', tool_calls: [{ tool_call_id: 'a', name: 'history_search', arguments: {} },
      { tool_call_id: 'a', name: 'history_read', arguments: {} }] }],
    [call, user('interrupted'), ...results],
  ];
  for (const messages of invalid) assert.throws(() => retainCompleteExchanges([...messages, answer('new')], 0));
  for (const keep of [-1, NaN, Infinity, 0.5]) assert.throws(() => retainCompleteExchanges([], keep));
  assert.deepEqual(retainCompleteExchanges([], 0), []);
});
