import {taskStatus} from '../productivity.js';
import './ThreadWorkList.css';
const label=(task,paused)=>paused&&!['done','canceled','failed'].includes(task.status)?'全体の再開待ち':task.progress?.label||taskStatus[task.status];
const recent=task=>({Cancelled:'中止しました。','Task deadline exceeded':'期限に達したため終了しました。'}[task.result]||task.result||task.progress?.label||task.detail||'').slice(0,180);
export function ThreadWorkList({groups,members,paused,onOpen,onThread}) {
 const purpose=p=><section className="work-purpose" key={p.id}><h3>{p.title}</h3><p className="muted">担当：{p.members.map(id=>members[id]?.name||'削除したBot').join('・')}</p>
  {p.active.map(task=>assignment(task))}
  {!p.active.length?p.history.map(assignment):!!p.history.length&&<details className="work-history"><summary>完了・中止・失敗の履歴（{p.history.length}作業）</summary>{p.history.map(task=>assignment(task))}</details>}
 </section>;
 const assignment=task=><div className="work-assignment" key={task.id}><div><span className="muted">{members[task.member]?.name||'削除したBot'} · {label(task,paused)}</span><p>{task.title}</p><p className="muted">{recent(task)}</p>{task.reason&&<p className="task-reason">{task.reason}</p>}</div><button className="button secondary" onClick={()=>onOpen(task.id)}>詳細・操作</button></div>;
 return <div className="activity-list work-threads">{groups.map(group=><details className="work-thread" key={group.id}>
  <summary><div><h2>{group.title}</h2><p>目的：{group.purposes.slice(0,2).map(p=>p.title).join(' ／ ')}{group.purposes.length>2?` ほか${group.purposes.length-2}件`:''}</p><p className="muted">担当：{group.members.map(id=>members[id]?.name||'削除したBot').join('・')}</p><p className="muted">{group.active.length?`進行・待機中 ${group.active.length}件の仕事`:'終了した仕事の履歴'} · {group.active.length?[...new Set(group.active.flatMap(p=>p.active).map(t=>label(t,paused)))].slice(0,3).join('・'):label(group.latest,paused)}</p><p className="muted">直近：{members[group.latest.member]?.name} · {recent(group.latest)}</p></div></summary>
  <div className="work-thread-content"><button className="text-button" onClick={()=>onThread(group.id)}>会話を見る</button>{group.active.map(purpose)}{!group.active.length?group.history.map(purpose):!!group.history.length&&<details className="work-history"><summary>終了した仕事（{group.history.length}件）</summary>{group.history.map(purpose)}</details>}</div>
 </details>)}</div>;
}
