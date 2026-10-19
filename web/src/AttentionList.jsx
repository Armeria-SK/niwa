import { useState } from 'react';
import { Avatar } from './components.jsx';
import { serverText, t } from './i18n.js';
import { CheckCircleIcon } from './icons.jsx';

// 種類ごとの見出し（辞書のキー）と色。文言は描くときに引く。
const ATTENTION_KINDS = { approval: ['kindApproval', 'warn'], question: ['kindQuestion', 'info'], stopped: ['kindStopped', 'danger'], decisions: ['decided', 'ok'], conflicts: ['kindConflicts', 'warn'], trust: ['kindTrust', 'info'] };
/** あなたが動かないと進まないものを1本に並べ、その場で開く・答える・確認済みにできるようにする。 */
export function AttentionList({ items, members, onOpen, onThread, onRead, onRecap, onConflicts, onTrust }) {
  const [all, setAll] = useState(false); const shown = all ? items : items.slice(0, 3);
  const actions = item => item.kind === 'approval' ? <button className="button primary" onClick={() => onOpen(item.id)}>{t('today.reviewAndDecide')}</button>
    : item.kind === 'question' ? <><button className="button primary" onClick={() => onThread(item.thread)}>{t('today.answerInChat')}</button><button className="button subtle" onClick={() => onRead([item.id])}>{t('today.markRead')}</button></>
    : item.kind === 'conflicts' ? <button className="button secondary" onClick={onConflicts}>{t('today.compare')}</button>
    : item.kind === 'trust' ? <button className="button secondary" onClick={onTrust}>{t('today.seeSuggestion')}</button>
    : item.kind === 'stopped' ? <button className="button secondary" onClick={() => onOpen(item.id)}>{t('today.inspectAndResume')}</button>
    : <><button className="button secondary" onClick={onRecap}>{t('today.seeRecap')}</button><button className="button subtle" onClick={() => onRead(item.ids)}>{t('today.markAllRead')}</button></>;
  // 止まっている仕事の説明は、サーバーが書いた待っている理由なので今の言語に読み替える。
  const detail = item => item.kind === 'stopped' ? serverText(item.detail) : item.detail;
  return <section className="attention" aria-labelledby="attention-heading">
    <h2 id="attention-heading">{t('today.attentionHeading')}{items.length ? <span className="attention-count">{items.length}</span> : null}</h2>
    {items.length ? <ul className={`attention-list ${all ? 'expanded' : ''}`}>{shown.map(item => { const member = members[item.member]; const [label, tone] = ATTENTION_KINDS[item.kind];
      return <li key={`${item.kind}:${item.id}`} className={`attention-item ${item.kind === 'approval' || item.kind === 'stopped' ? 'urgent' : ''}`}>{member ? <Avatar member={member} size={32} /> : <span className="attention-dot" aria-hidden="true" />}
        <div className="attention-body"><div className="attention-top"><span className={`attention-chip ${tone}`}>{t(`today.${label}`)}</span>{member ? <span>{member.name}</span> : null}</div><strong>{item.title}</strong>{item.detail ? <p>{detail(item)}</p> : null}</div>
        <div className="attention-actions">{actions(item)}</div></li>; })}</ul>
      : <p className="attention-empty"><CheckCircleIcon size={22} />{t('today.attentionEmpty')}</p>}
    {items.length > 3 ? <button type="button" className="text-button attention-more" onClick={() => setAll(value => !value)}>{all ? t('today.showThree') : t('today.showMore', { count: items.length - 3 })}</button> : null}
  </section>;
}
