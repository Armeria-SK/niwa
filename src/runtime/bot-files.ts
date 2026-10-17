import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from '@sinclair/typebox';
import { Value, ValueErrorType } from '@sinclair/typebox/value';
import type { Actor, Runtime } from './runtime.ts';
import { check } from '../domain/types.ts';
import { profileSchema } from '../domain/profile.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { transaction } from '../storage/database.ts';
import { procedureContentSchema, PROCEDURE_MAX_LENGTH } from './procedures.ts';

const FORMAT = 'niwa-bot';
const NOTE = 'NiwaのBotの書き出し：人格・見た目・手順帳（選んだときだけ記憶も）。会話・成果物・モデルの接続は含みません。秘密らしい文字は伏せてあります。';
/** The longest file read, in characters. A file Niwa writes stays far below it. */
export const BOT_FILE_MAX_LENGTH = 6_000_000;
/** What Niwa writes, checked strictly when a file is read back: no unknown keys, and the look uses only values Niwa has. */
const fileSchema = Type.Object({
  format: Type.Literal(FORMAT), version: Type.Literal(1), exported_at: Type.String({ maxLength: 100 }), note: Type.String({ maxLength: 2000 }),
  bot: Type.Required(Type.Pick(profileSchema, ['name', 'role', 'persona']), { additionalProperties: false }),
  appearance: Type.Required(Type.Pick(profileSchema, ['shape', 'color', 'motion']), { additionalProperties: false }),
  procedures: Type.Array(procedureContentSchema, { maxItems: 200 }),
  memories: Type.Array(Type.Object({ body: Type.String({ minLength: 1, maxLength: 20_000 }) }, { additionalProperties: false }), { maxItems: 500 }),
}, { additionalProperties: false });
type BotFile = Static<typeof fileSchema>;
/** Why a file cannot be read, by place in the file. The screen says each in words. */
export type FileProblem = { kind: 'size' | 'json' | 'format' | 'version' | 'missing' | 'unknown' | 'value' | 'blank' | 'too_long'; path: string };
// A procedure brought in also carries its origin and one source; the stored size limit counts those too.
const IMPORTED_EXTRA = JSON.stringify({ origin: 'imported', sources: [{ kind: 'message', source_id: '0'.repeat(36), revision: '0'.repeat(64) }] }).length;

/** Every string in the file, with secret-looking text hidden. Keys are Niwa's own and stay as they are. */
function hidden<T>(value: T, count = { strings: 0 }): T {
  if (typeof value === 'string') { const text = redactSecrets(value); if (text !== value) count.strings++; return text as T; }
  if (Array.isArray(value)) return value.map(item => hidden(item, count)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hidden(item, count)])) as T;
  return value;
}
function problems(value: unknown): FileProblem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ kind: 'format', path: '' }];
  const record = value as Record<string, unknown>;
  if (record.format !== FORMAT) return [{ kind: 'format', path: '/format' }];
  if (record.version !== 1) return [{ kind: 'version', path: '/version' }];
  const found = new Map<string, FileProblem>();
  for (const error of Value.Errors(fileSchema, value)) if (!found.has(error.path)) found.set(error.path, { path: error.path,
    kind: error.type === ValueErrorType.ObjectAdditionalProperties ? 'unknown' : error.type === ValueErrorType.ObjectRequiredProperty ? 'missing' : 'value' });
  if (!found.size) {
    // Text that is only spaces is refused, as the screens that make Bots, procedures and memories refuse it.
    const file = value as BotFile, blank = (path: string, text: string) => { if (!text.trim()) found.set(path, { kind: 'blank', path }); };
    blank('/bot/name', file.bot.name);
    file.procedures.forEach((item, index) => {
      blank(`/procedures/${index}/title`, item.title); blank(`/procedures/${index}/conditions`, item.conditions);
      item.steps.forEach((step, at) => blank(`/procedures/${index}/steps/${at}`, step));
      if (JSON.stringify(item).length + IMPORTED_EXTRA > PROCEDURE_MAX_LENGTH) found.set(`/procedures/${index}`, { kind: 'too_long', path: `/procedures/${index}` });
    });
    file.memories.forEach((item, index) => blank(`/memories/${index}/body`, item.body));
  }
  return [...found.values()].slice(0, 10);
}
/** The file as Niwa will use it: checked, then with secret-looking text hidden, then checked again because hiding changes lengths. */
function readFile(text: string): { file: BotFile; hidden: number } | { problems: FileProblem[] } {
  if (typeof text !== 'string' || text.length > BOT_FILE_MAX_LENGTH) return { problems: [{ kind: 'size', path: '' }] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { problems: [{ kind: 'json', path: '' }] }; }
  const before = problems(value);
  if (before.length) return { problems: before };
  const count = { strings: 0 }, file = hidden(value as BotFile, count), after = problems(file);
  return after.length ? { problems: after } : { file, hidden: count.strings };
}
const roomTitle = (name: string) => `ファイルから迎えた${name}の手順と記憶`;
const introText = (name: string, procedures: number, memories: number) => [`ファイルから${name}を迎えました。`,
  `このあとの発言は、ファイルにあった手順${procedures}件と記憶${memories}件です。`, '「手順：」で始まる発言が手順で、ほかは記憶です。', `${name}は、それぞれの発言を出所として覚えます。`].join('\n');
const procedureText = (item: BotFile['procedures'][number]) => [`手順：${item.title}`, `使うとき：${item.conditions}`, ...item.steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A Bot written out as one JSON file: who it is, how it looks and the procedures it learned, for the administrator to keep or move.
 * Memories go in only when chosen, and only those from shared conversations; nothing born in a private conversation can be chosen.
 * Reading a file back always makes a new Bot; no Bot that exists is changed. */
export class BotFiles {
  constructor(private db: DatabaseSync, private runtime: Runtime, private admin: (actor: Actor) => void) {}

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
    const file = hidden({
      format: FORMAT, version: 1, exported_at: new Date(now).toISOString(), note: NOTE,
      bot: { name: options.agent.name, role: profile.role ?? '', persona: profile.persona ?? '' },
      appearance: { shape: profile.shape ?? 'pebble', color: profile.color ?? '#61B8A5', motion: profile.motion ?? 'auto' },
      procedures: book.map(item => ({ title: item.title, conditions: item.conditions, steps: item.steps })),
      memories: memories.map(memory => ({ body: memory.body })),
    });
    const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll('-', '');
    const name = options.agent.name.replace(/[\\/:*?"<>|\s\p{Cc}]/gu, '_').slice(0, 60) || 'bot';
    return { filename: `niwa-bot-${name}-${day}.json`, text: `${JSON.stringify(file, null, 2)}\n` };
  }

  /** What reading this file would make, and the full text Niwa would use, before anything is made. A file that cannot be read says why. */
  preview(actor: Actor, text: string) {
    this.admin(actor);
    const read = readFile(text);
    if ('problems' in read) return { ok: false as const, problems: read.problems };
    const { file } = read;
    return { ok: true as const, text: `${JSON.stringify(file, null, 2)}\n`, hidden: read.hidden, bot: file.bot, appearance: file.appearance,
      procedures: file.procedures.map(item => ({ title: item.title, steps: item.steps.length })), memories: file.memories.length,
      room_title: roomTitle(file.bot.name), members: this.#members(), limit: this.runtime.settings(actor).generatedLimit };
  }

  /** Makes a new Bot from the file, once per request id, by the same path as welcoming a Bot by hand (and within the same limit).
   * Chosen procedures and memories need a source: a shared conversation is made with one administrator message for each, which they cite. */
  import(actor: Actor, id: string, text: string, include: { procedures: boolean; memories: boolean }) {
    this.admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid import request id');
    check(typeof include?.procedures === 'boolean' && typeof include.memories === 'boolean', 'invalid', 'Choose what to bring in');
    const read = readFile(text);
    check(!('problems' in read), 'invalid', 'This is not a Bot file Niwa can read');
    const { file } = read as { file: BotFile };
    const procedures = include.procedures ? file.procedures : [], memories = include.memories ? file.memories : [];
    const hash = sha256(JSON.stringify([file, procedures.length > 0, memories.length > 0]));
    const record = transaction(this.db, () => {
      const prior = this.db.prepare('SELECT agent_id,room_id,message_ids,input_hash,completed_at FROM bot_imports WHERE id=?').get(id);
      if (prior) { check(prior.input_hash === hash, 'conflict', 'Import request id was reused with different input'); return prior; }
      const { name, ...bot } = file.bot;
      const agent = this.runtime.requestMember(actor, id, name, { ...bot, ...file.appearance });
      let roomId: string | null = null, messages: string[] = [];
      if (procedures.length || memories.length) {
        roomId = this.runtime.createRoom(actor, roomTitle(name)).id;
        this.runtime.post(actor, roomId, introText(name, procedures.length, memories.length));
        messages = [...procedures.map(procedureText), ...memories.map(item => item.body)].map(body => this.runtime.post(actor, roomId!, body).id);
      }
      const row = { agent_id: agent.id, room_id: roomId, message_ids: JSON.stringify(messages), input_hash: hash, completed_at: roomId ? null : Date.now() };
      this.db.prepare('INSERT INTO bot_imports VALUES (?,?,?,?,?,?)').run(id, hash, row.agent_id, row.room_id, row.message_ids, row.completed_at);
      return row;
    });
    if (record.completed_at === null) {
      // Ids are fixed by the request, so writing again after an interruption adds nothing twice.
      const cited = JSON.parse(String(record.message_ids)) as string[];
      this.runtime.importKnowledge(actor, String(record.agent_id), String(record.room_id), {
        procedures: procedures.map((item, index) => ({ ...item, id: sha256(`bot-import:${id}:procedure:${index}`), message_id: cited[index]! })),
        memories: memories.map((item, index) => ({ body: item.body, id: sha256(`bot-import:${id}:memory:${index}`), message_id: cited[procedures.length + index]! })),
      });
      this.db.prepare('UPDATE bot_imports SET completed_at=? WHERE id=?').run(Date.now(), id);
    }
    return { agent_id: String(record.agent_id), room_id: record.room_id === null ? null : String(record.room_id), procedures: procedures.length, memories: memories.length };
  }

  /** Bots counted against the limit, as welcoming a Bot counts them: every member, resting or not, that was not deleted. */
  #members(): number {
    return Number(this.db.prepare("SELECT count(*) AS count FROM agents WHERE role = 'member' AND id NOT IN (SELECT id FROM deleted_agents)").get()!.count);
  }
}
