import { useState } from 'react';
import { Avatar } from './components.jsx';
import { CheckCircleIcon } from './icons.jsx';

const ATTENTION_KINDS = { approval: ['承認', 'warn'], question: ['質問', 'info'], stopped: ['止まっている', 'danger'], decisions: ['決まったこと', 'ok'], conflicts: ['記憶の食い違い', 'warn'], trust: ['任せる提案', 'info'] };
/** あなたが動かないと進まないものを1本に並べ、その場で開く・答える・確認済みにできるようにする。 */
export function AttentionList({ items, members, onOpen, onThread, onRead, onRecap, onConflicts, onTrust }) {
  const [all, setAll] = useState(false); const shown = all ? items : items.slice(0, 3);
  const actions = item => item.kind === 'approval' ? <button className="button primary" onClick={() => onOpen(item.id)}>中身を見て決める</button>
    : item.kind === 'question' ? <><button className="button primary" onClick={() => onThread(item.thread)}>会話で答える</button><button className="button subtle" onClick={() => onRead([item.id])}>確認済みにする</button></>
    : item.kind === 'conflicts' ? <button className="button secondary" onClick={onConflicts}>見比べる</button>
    : item.kind === 'trust' ? <button className="button secondary" onClick={onTrust}>提案を見る</button>
    : item.kind === 'stopped' ? <button className="button secondary" onClick={() => onOpen(item.id)}>詳しく見て再開する</button>
    : <><button className="button secondary" onClick={onRecap}>できごとを見る</button><button className="button subtle" onClick={() => onRead(item.ids)}>すべて確認済みにする</button></>;
  return <section className="attention" aria-labelledby="attention-heading">
    <h2 id="attention-heading">あなたの番{items.length ? <span className="attention-count">{items.length}</span> : null}</h2>
    {items.length ? <ul className={`attention-list ${all ? 'expanded' : ''}`}>{shown.map(item => { const member = members[item.member]; const [label, tone] = ATTENTION_KINDS[item.kind];
      return <li key={`${item.kind}:${item.id}`} className={`attention-item ${item.kind === 'approval' || item.kind === 'stopped' ? 'urgent' : ''}`}>{member ? <Avatar member={member} size={32} /> : <span className="attention-dot" aria-hidden="true" />}
        <div className="attention-body"><div className="attention-top"><span className={`attention-chip ${tone}`}>{label}</span>{member ? <span>{member.name}</span> : null}</div><strong>{item.title}</strong>{item.detail ? <p>{item.detail}</p> : null}</div>
        <div className="attention-actions">{actions(item)}</div></li>; })}</ul>
      : <p className="attention-empty"><CheckCircleIcon size={22} />いま、あなたの判断を待っているものはありません。</p>}
    {items.length > 3 ? <button type="button" className="text-button attention-more" onClick={() => setAll(value => !value)}>{all ? '3件だけ表示する' : `ほか${items.length - 3}件も見る`}</button> : null}
  </section>;
}
