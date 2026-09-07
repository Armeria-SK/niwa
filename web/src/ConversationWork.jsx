import { taskStatus } from './productivity.js';

export function ConversationWork({ tasks, members, onOpen }) {
  const pending = tasks.filter(task => !['done', 'canceled'].includes(task.status)).sort((a, b) => b.created_at - a.created_at);
  if (!pending.length) return null;
  return <section className="first-reply-hint" aria-label="この会話の仕事">
    {pending.slice(0, 3).map(task => <div key={task.id}><strong>{members[task.member]?.name} · {taskStatus[task.status]}</strong><p>{task.detail}</p></div>)}
    <button className="text-button" onClick={onOpen}>仕事を確認（{pending.length}件）</button>
  </section>;
}
