import type { Actor, Runtime } from './runtime.ts';
import { check } from '../domain/types.ts';
import { redactSecrets } from '../shared/redaction.ts';

const NOTE = 'Niwaの苗：Botの人格・見た目・手順帳（選んだときだけ記憶も）。会話・成果物・モデルの接続は含みません。秘密らしい文字は伏せてあります。';
/** Every string in the seed, with secret-looking text hidden. Keys are Niwa's own and stay as they are. */
function hidden<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(hidden) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hidden(item)])) as T;
  return value;
}

/** A Bot's "seed": who it is, how it looks and the procedures it learned, in one JSON file for the administrator to keep or move.
 * Memories go in only when chosen, and only those from shared conversations; nothing born in a private conversation can be chosen. */
export class Seeds {
  constructor(private runtime: Runtime, private admin: (actor: Actor) => void) {}

  /** What can go in. Procedures and memories from private conversations are counted but not listed, so they cannot be picked. */
  options(actor: Actor, agentId: string) {
    this.admin(actor);
    const agent = this.runtime.agents(actor).find(item => item.id === agentId);
    check(agent, 'not_found', 'Agent not found');
    const shared = new Set(this.runtime.rooms(actor).filter(room => room.visibility === 'shared').map(room => room.id));
    const procedures = this.runtime.procedureBook(actor, agentId);
    const memories = this.runtime.memories(actor, agentId);
    const open = procedures.filter(item => !item.private && item.room_title !== null);
    const sharedMemories = memories.filter(memory => shared.has(memory.source_room_id));
    return { agent: { id: agent.id, name: agent.name },
      procedures: open.map(item => ({ id: item.id, title: item.title, steps: item.steps.length, enabled: item.enabled })), private_procedures: procedures.length - open.length,
      memories: sharedMemories.slice(-500).map(memory => ({ id: memory.id, body: memory.body })), private_memories: memories.length - sharedMemories.length };
  }

  /** The exact text of the file. The screen shows this text in full before it is saved, and saves this text as it is. */
  build(actor: Actor, agentId: string, selection: { procedures: string[]; memories: string[] }, now = Date.now()) {
    const options = this.options(actor, agentId);
    const procedureIds = new Set(options.procedures.map(item => item.id)), memoryIds = new Set(options.memories.map(item => item.id));
    check(selection.procedures.every(id => procedureIds.has(id)), 'forbidden', 'Only procedures from shared conversations can be exported');
    check(selection.memories.every(id => memoryIds.has(id)), 'forbidden', 'Only memories from shared conversations can be exported');
    const profile = this.runtime.profile(actor, agentId);
    const book = this.runtime.procedureBook(actor, agentId).filter(item => selection.procedures.includes(item.id));
    const memories = this.runtime.memories(actor, agentId).filter(memory => selection.memories.includes(memory.id));
    const seed = hidden({
      format: 'niwa-seed', version: 1, exported_at: new Date(now).toISOString(), note: NOTE,
      bot: { name: options.agent.name, role: profile.role ?? '', persona: profile.persona ?? '' },
      appearance: { shape: profile.shape ?? 'pebble', color: profile.color ?? '#61B8A5', motion: profile.motion ?? 'auto' },
      procedures: book.map(item => ({ title: item.title, conditions: item.conditions, steps: item.steps })),
      memories: memories.map(memory => ({ body: memory.body })),
    });
    const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll('-', '');
    const name = options.agent.name.replace(/[\\/:*?"<>|\s\p{Cc}]/gu, '_').slice(0, 60) || 'bot';
    return { filename: `niwa-seed-${name}-${day}.json`, text: `${JSON.stringify(seed, null, 2)}\n` };
  }
}
