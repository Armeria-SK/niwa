import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Type, type TSchema, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { summarySchema } from '../domain/summary.ts';
import { check, DomainError } from '../domain/types.ts';
import type { Task } from '../domain/task.ts';
import type { JsonObject } from '../contracts/model.ts';
import { transaction } from '../storage/database.ts';

const id = () => Type.String({ minLength: 1, maxLength: 100 });
const revision = () => Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 });
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const procedureSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }), conditions: Type.String({ minLength: 1, maxLength: 2000 }),
  steps: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 30 }),
  source_task_id: id(), sources: summarySchema.properties.sources,
}, { additionalProperties: false });
type Procedure = Static<typeof procedureSchema>;
export const procedureDefinitions = {
  procedure_save: { description: '自分の完了済み仕事から再利用する手順を保存する。条件とhistory_readで確認した出典の版を含める。新規はid=null、expected_revision=0。更新は最新の版を指定する。', schema: object({
    id: Type.Union([Type.Null(), id()]), expected_revision: Type.Integer({ minimum: 0 }), procedure: procedureSchema,
  }) },
  procedure_search: { description: '現在の会話で使える自分の有効な手順を文字列検索する。適用条件と版を確認してから採用する。', schema: object({ query: Type.String({ minLength: 1, maxLength: 200 }) }) },
  procedure_read: { description: '自分の手順の条件・出典・手順・利用結果を読む。revision=nullは最新版。disabledでも確認できる。', schema: object({ id: id(), revision: Type.Union([Type.Null(), revision()]) }) },
  procedure_restore: { description: '過去の手順を新しい版として復元する。出典が変更された版は復元できない。', schema: object({ id: id(), expected_revision: revision(), revision: revision() }) },
  procedure_set_enabled: { description: '不適切な手順を無効化する、または再び有効にする。無効な手順は採用できない。', schema: object({ id: id(), enabled: Type.Boolean() }) },
  procedure_apply: { description: '条件に合う理由を記録し、指定版の手順を現在の残作業へ設定する。権限や承認は付与しない。plan_revisionはwork_state.remaining_plan.revision。', schema: object({
    id: id(), revision: revision(), plan_revision: Type.Integer({ minimum: 0 }), applicability: Type.String({ minLength: 1, maxLength: 2000 }),
  }) },
};

export interface ProcedureContext {
  db: DatabaseSync; task: Task; rooms: string[];
  readSource(kind: string, id: string, revision: string | null): { revision: string };
  taskInfo(id: string): Task;
  updatePlan(revision: number, remaining: string[]): JsonObject;
}

/** Private-bot data only. The caller supplies the active lease's context; no code is executed here. */
export function executeProcedure(context: ProcedureContext, name: string, args: JsonObject, operationId: string): JsonObject {
  const { db, task, rooms } = context;
  const definition = procedureDefinitions[name as keyof typeof procedureDefinitions];
  check(definition && Value.Check(definition.schema, args), 'invalid', 'Invalid procedure request');
  const head = (id: string) => {
    const row = db.prepare('SELECT room_id,revision,enabled FROM procedures WHERE id=?').get(id);
    check(row && rooms.includes(String(row.room_id)), 'not_found', 'Procedure unavailable in this conversation');
    return row;
  };
  const read = (id: string, revision: number | null = null) => {
    const row = db.prepare(`SELECT p.id,p.room_id,p.revision AS latest_revision,p.enabled,v.revision,v.body FROM procedures p
      JOIN procedure_versions v ON v.procedure_id=p.id AND v.revision=coalesce(?,p.revision) WHERE p.id=?`).get(revision, id);
    check(row && rooms.includes(String(row.room_id)), 'not_found', 'Procedure unavailable in this conversation');
    const body = JSON.parse(String(row.body)) as unknown;
    check(Value.Check(procedureSchema, body), 'invalid', 'Stored procedure is invalid');
    try { for (const source of body.sources) context.readSource(source.kind, source.source_id, source.revision); }
    catch { db.prepare('UPDATE procedures SET enabled=0 WHERE id=?').run(id); throw new DomainError('conflict', 'Procedure source changed; the procedure cannot be used'); }
    return { id, room_id: String(row.room_id), revision: Number(row.revision), latest_revision: Number(row.latest_revision), enabled: row.enabled === 1, ...body };
  };
  if (name === 'procedure_search') {
    const candidates = db.prepare(`SELECT p.id FROM procedures p JOIN procedure_versions v ON v.procedure_id=p.id AND v.revision=p.revision
      WHERE p.enabled=1 AND p.room_id IN (SELECT value FROM json_each(?)) AND instr(lower(v.body),lower(?))>0 ORDER BY p.id`).all(JSON.stringify(rooms), String(args.query));
    const results: JsonObject[] = [];
    for (const candidate of candidates) {
      try { const item = read(String(candidate.id)); results.push({ id: item.id, revision: item.revision, title: item.title, conditions: item.conditions }); } catch { /* Invalid sources are never offered. */ }
      if (results.length === 20) break;
    }
    return { results };
  }
  if (name === 'procedure_read') {
    const item = read(String(args.id), args.revision as number | null);
    const uses = db.prepare(`SELECT task_id,revision,applicability FROM procedure_uses WHERE procedure_id=?
      AND room_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT 20`).all(item.id, JSON.stringify(rooms)).map(use => {
      const usedTask = context.taskInfo(String(use.task_id));
      return { task_id: usedTask.id, revision: use.revision, applicability: use.applicability, state: usedTask.state, result: usedTask.result?.slice(0, 1000) ?? null };
    });
    return { ...item, uses, versions: db.prepare('SELECT revision FROM procedure_versions WHERE procedure_id=? ORDER BY revision DESC').all(item.id).map(row => row.revision) };
  }
  const hash = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
  return transaction(db, () => {
    const receipt = db.prepare('SELECT input_hash,output FROM procedure_receipts WHERE task_id=? AND operation_id=?').get(task.id, operationId);
    if (receipt) { check(receipt.input_hash === hash, 'conflict', 'Procedure operation changed'); return JSON.parse(String(receipt.output)) as JsonObject; }
    let output: JsonObject;
    if (name === 'procedure_save' || name === 'procedure_restore') {
      let body: Procedure;
      if (name === 'procedure_restore') {
        const { title, conditions, steps, source_task_id, sources } = read(String(args.id), Number(args.revision));
        body = { title, conditions, steps, source_task_id, sources };
      } else {
        body = args.procedure as Procedure;
        const sourceTask = context.taskInfo(body.source_task_id);
        check(sourceTask.agent_id === task.agent_id && sourceTask.state === 'completed', 'invalid', 'A completed task of this bot is required');
        const source = context.readSource('task', sourceTask.id, null);
        body = { ...body, sources: [...body.sources.filter(item => item.kind !== 'task' || item.source_id !== sourceTask.id),
          { kind: 'task', source_id: sourceTask.id, revision: source.revision }] };
      }
      check(Value.Check(procedureSchema, body) && JSON.stringify(body).length <= 16_000, 'invalid', 'Procedure is too large or invalid');
      for (const source of body.sources) context.readSource(source.kind, source.source_id, source.revision);
      const id = args.id === null ? createHash('sha256').update(`${task.id}:${operationId}`).digest('hex') : String(args.id);
      const existing = args.id === null ? null : head(id);
      check(existing === null || existing.room_id === task.room_id, 'forbidden', 'Update a procedure in its original conversation');
      const previous = Number(existing?.revision ?? 0);
      check(previous === args.expected_revision && previous < Number.MAX_SAFE_INTEGER - 1, 'conflict', 'Procedure revision changed');
      if (args.id === null) db.prepare('INSERT INTO procedures VALUES (?,?,0,1)').run(id, task.room_id);
      db.prepare('INSERT INTO procedure_versions VALUES (?,?,?,?)').run(id, previous + 1, JSON.stringify(body), Date.now());
      db.prepare('UPDATE procedures SET revision=? WHERE id=?').run(previous + 1, id);
      output = { id, revision: previous + 1 };
    } else if (name === 'procedure_set_enabled') {
      const id = String(args.id); head(id);
      if (args.enabled) read(id);
      db.prepare('UPDATE procedures SET enabled=? WHERE id=?').run(args.enabled ? 1 : 0, id);
      output = { id, enabled: args.enabled };
    } else {
      const item = read(String(args.id), Number(args.revision));
      check(item.enabled && item.revision === item.latest_revision, 'conflict', 'Use the current enabled procedure revision');
      const plan = context.updatePlan(Number(args.plan_revision), item.steps);
      db.prepare('INSERT INTO procedure_uses VALUES (?,?,?,?,?,?,?)').run(task.id, operationId, task.room_id, item.id, item.revision, String(args.applicability), Date.now());
      output = { id: item.id, revision: item.revision, plan_revision: plan.revision };
    }
    db.prepare('INSERT INTO procedure_receipts VALUES (?,?,?,?)').run(task.id, operationId, hash, JSON.stringify(output));
    return output;
  });
}
