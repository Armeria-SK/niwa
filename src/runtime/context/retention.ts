// Derived from Carried 1b68bb7c96b97e0c5cfac2dbfdddae8e47c196aa, core/harness/src/context-compaction.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import type { ModelMessage } from '../../contracts/index.ts';

/** Select complete exchanges without changing the stored transcript. Input must be scoped by the caller. */
export function retainCompleteExchanges(messages: readonly ModelMessage[], keep: number): ModelMessage[] {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('Invalid retained exchange count.');
  const groups: ModelMessage[][] = [];
  let pending: ModelMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'tool') throw new Error('Context contains an orphan tool result.');
    pending.push(message);
    if (message.role !== 'assistant') continue;
    const calls = message.tool_calls ?? [];
    const identifiers = new Map(calls.map(call => [call.tool_call_id, call.name]));
    if (identifiers.size !== calls.length) throw new Error('Context contains duplicate tool calls.');
    for (let count = 0; count < calls.length; count += 1) {
      const tool = messages[++index];
      if (tool?.role !== 'tool' || identifiers.get(tool.tool_call_id) !== tool.name) {
        throw new Error('Context tool results are incomplete or mismatched.');
      }
      identifiers.delete(tool.tool_call_id);
      pending.push(tool);
    }
    groups.push(pending); pending = [];
  }
  const retained = keep === 0 ? [] : groups.slice(-keep).flat();
  const mandatory = [messages.find(message => message.role === 'user'), messages.findLast(message => message.role === 'user')];
  const selected = new Set([...retained, ...pending, ...mandatory]);
  return messages.filter(message => selected.has(message));
}
