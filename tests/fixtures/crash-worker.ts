import { randomUUID } from 'node:crypto';
import { startService } from '../../src/runtime/service.ts';
import { initializeInstallation } from '../../src/config/installation.ts';
import { existsSync } from 'node:fs';
import { openAISubscriptionAdapterCapabilities } from '../../src/providers/codex/adapter.ts';
import type { ModelEvent } from '../../src/contracts/model.ts';
const [root, mode] = process.argv.slice(2);
if (!root || !process.send) throw Error('Isolated worker requires a root and IPC');
if (!existsSync(`${root}/config/niwa.json`)) initializeInstallation(root, { version: 1, origin: 'http://127.0.0.1:3210', port: 3210 });
const tool = (name: string, args: Record<string, unknown>): ModelEvent[] => [{ type: 'tool_call', name, tool_call_id: name, arguments: args }, { type: 'completed', finish_reason: 'tool_calls' }];
const service = await startService(root, async () => ({ adapter_id: 'artificial-crash-fixture', capabilities: openAISubscriptionAdapterCapabilities,
  async *run(request, options) {
    const phase = request.tools.length === 1 ? request.tools[0]?.name : '';
    if (phase === 'memory_review') { yield* tool('memory_review', { memories: [] }); return; }
    if (phase === 'task_summary_save') {
      const state = JSON.parse(request.messages.at(-1)!.content!).work_state;
      yield* tool('task_summary_save', { conclusion: 'Artificial completion', reason: 'Committed output', unresolved: [], next_steps: [], sources: state.summary_sources.slice(0, 1).map(({ kind, source_id, revision }: { kind: string; source_id: string; revision: string }) => ({ kind, source_id, revision })) }); return;
    }
    if (!request.messages.some(m => m.role === 'tool' && m.name === 'artifact_create')) {
      yield* tool('artifact_create', { name: 'crash-proof.txt', kind: 'text', description: 'Artificial output', content: 'Written once' }); return;
    }
    if (mode === 'before') await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    else { yield { type: 'text_delta', text: 'Recovered' }; yield { type: 'completed', finish_reason: 'stop' }; }
  },
}), 0);
const r = service.runtime, admin = r.administrator();
process.on('message', async (message: { id: number; action: string }) => {
  try {
    if (message.action === 'seed') {
      const leader = r.agents(admin)[0]!, room = r.createRoom(admin, 'Artificial crash acceptance');
      const source = r.post(admin, room.id, 'Artificial source');
      r.remember(r.agentSession(leader.id), source.id, 'Artificial memory');
      const schedule = r.schedules.create(admin, { id: randomUUID(), agent_id: leader.id, room_id: room.id, prompt: 'Artificial scheduled work', interval_ms: 60_000, next_at: Date.now() + 60_000, max_runs: 3, timeout_ms: 600_000 });
      r.updateSettings(admin, { paused: false }); r.schedules.dispatch(admin, schedule.next_at);
    }
    if (message.action === 'pause') r.updateSettings(admin, { paused: true });
    if (message.action === 'resume') r.updateSettings(admin, { paused: false });
    if (message.action === 'close') { await service.close(); process.send!({ id: message.id, ok: true }); process.disconnect(); return; }
    process.send!({ id: message.id, state: { paused: r.settings(admin).paused, tasks: r.tasks.list(admin).map(t => ({ id: t.id, state: t.state })), artifacts: r.artifacts(admin).length, schedules: r.schedules.list(admin).map(s => ({ id: s.id, run_count: s.run_count })), messages: r.rooms(admin).flatMap(room => r.messages(admin, room.id)).length, memories: r.agents(admin).reduce((n, a) => n + r.memories(admin, a.id).length, 0) } });
  } catch (error) { process.send!({ id: message.id, error: error instanceof Error ? error.message : 'Worker failed' }); }
});
process.send({ ready: true });
