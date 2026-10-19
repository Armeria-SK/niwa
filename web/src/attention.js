import { t } from './i18n.js';

const at = value => Number(typeof value === 'string' ? Date.parse(value) : value) || 0;
const RANK = { approval: 0, question: 1, stopped: 2, decisions: 3 };

/** あなたが動かないと進まないものを、急ぐ順（承認 → 質問 → 止まった仕事 → 未確認の決まったこと）に1本に並べる。
 * 答え終わった質問（仕事がもう回答を待っていない）と、質問として出ている仕事の重複は出さない。 */
export function attentionItems({ activities = [], questions = [], decisions = [] }) {
  const items = [], tasks = new Map(activities.map(task => [task.id, task])), asked = new Set();
  for (const task of activities) if (task.status === 'approval') items.push({ kind: 'approval', id: task.id, title: task.title, member: task.member, thread: task.thread, at: at(task.updated_at) });
  for (const question of questions) {
    const task = question.activity ? tasks.get(question.activity) : undefined;
    // A task waiting on a question is that question, seen or not; a question whose task is gone or moved on was answered.
    if (task?.state === 'waiting_user') asked.add(task.id);
    if (question.seen || (question.activity && task?.state !== 'waiting_user')) continue;
    items.push({ kind: 'question', id: question.id, title: question.title, detail: question.detail && question.detail !== question.title ? question.detail : '', member: question.member, thread: question.thread, at: at(question.created_at) });
  }
  for (const task of activities) if (task.state === 'waiting_user' && task.status !== 'approval' && !task.paused && !asked.has(task.id))
    items.push({ kind: 'stopped', id: task.id, title: task.title, detail: task.reason || '', member: task.member, thread: task.thread, at: at(task.updated_at) });
  const unseen = decisions.filter(decision => !decision.seen);
  if (unseen.length) items.push({ kind: 'decisions', id: 'decisions', title: t('shell.unseenDecisions', { count: unseen.length }), detail: unseen.slice(0, 2).map(decision => decision.title).join(t('shell.decisionsSeparator')), ids: unseen.map(decision => decision.id), at: 0 });
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at);
}
