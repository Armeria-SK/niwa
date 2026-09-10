import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {Task} from '../domain/task.ts';

/** Conversation-visible provenance only; never read another Bot's memory or model history. */
export function requestBrief(db: DatabaseSync, task: Task) {
  const lineage: Task[] = [task];
  const seen = new Set([task.id]);
  let followupContext = false;
  while (lineage.length < 64) {
    const current = lineage.at(-1)!;
    if (current.conversation_reply) break;
    const related = db.prepare("SELECT related_task_id FROM task_context WHERE task_id=? AND kind='followup'").get(current.id);
    const id = current.parent_id ?? related?.related_task_id;
    if (!id || seen.has(String(id))) break;
    const parent = db.prepare('SELECT * FROM tasks WHERE id=? AND room_id=?').get(id, task.room_id) as unknown as Task | undefined;
    if (!parent) break;
    if (!current.parent_id) followupContext = true;
    lineage.push(parent); seen.add(parent.id);
  }
  const origin = lineage.at(-1)!;
  const owners = new Set(lineage.map(item => item.agent_id));
  const messages = db.prepare(`SELECT id AS message_id,body,reply_to,created_at FROM messages
    WHERE room_id=? AND author_id='administrator' AND created_at>=? ORDER BY created_at,rowid`)
    .all(task.room_id, new Date(origin.created_at).toISOString()).filter(message => {
      const links = db.prepare(`SELECT t.id,t.agent_id,c.kind,c.related_task_id FROM task_message_links l
        JOIN tasks t ON t.id=l.task_id LEFT JOIN task_context c ON c.task_id=t.id
        WHERE l.message_id=? AND t.room_id=?`).all(message.message_id!, task.room_id);
      if (links.some(link => seen.has(String(link.id)))) return true;
      // Untargeted room remarks are context, not automatic amendments or new assignments.
      if (!links.length) return String(message.created_at) > new Date(origin.created_at).toISOString() &&
        (!message.reply_to || !!db.prepare(`SELECT 1 FROM task_message_links
        WHERE message_id=? AND task_id IN (${lineage.map(() => '?').join(',')})`).get(message.reply_to, ...seen));
      return links.some(link => owners.has(String(link.agent_id)) && link.kind === 'followup' &&
        (!link.related_task_id || seen.has(String(link.related_task_id))));
    });
  const replies = db.prepare(`SELECT task_id,sequence,body,created_at FROM task_replies
    WHERE task_id IN (${lineage.map(() => '?').join(',')}) ORDER BY sequence`).all(...seen);
  const brief = {
    origin_request: {task_id: origin.id, requester_id: origin.requester_id, prompt: origin.prompt},
    origin_relation: followupContext ? 'followup_context' : task.id === origin.id ? 'current_request' : 'delegation',
    ancestry_truncated: lineage.length === 64,
    administrator_messages: messages,
    administrator_replies: replies,
  };
  return {...brief, revision: createHash('sha256').update(JSON.stringify(brief)).digest('hex')};
}
