import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './components.jsx';
import { LockIcon } from './icons.jsx';
import { t } from './i18n.js';

export function MemorySourceLine({ memory, onOpenThread }) {
  const source = memory.source;
  return <div className="memory-source">{source.excerpt ? <q>{source.excerpt}</q> : null}<span>{[source.author, source.room, source.said].filter(Boolean).join(' · ')}</span>
    {source.private ? <span className="memory-private"><LockIcon size={13} />{t('bots.privateOrigin')}</span> : null}
    {source.openable ? <button type="button" className="text-button" onClick={() => onOpenThread(memory.source_room_id)}>{t('bots.openSource')}</button> : null}</div>;
}

/** 訂正・削除の前に、何が変わるかを読む。読めなくても操作は止めない。 */
function useMemoryImpact(memberId, memoryId) {
  const [impact, setImpact] = useState(null);
  useEffect(() => {
    let active = true; setImpact(null);
    api(`/agents/${memberId}/memories/${memoryId}/impact`).then(result => { if (active) setImpact(result); }).catch(() => { if (active) setImpact({ error: true }); });
    return () => { active = false; };
  }, [memberId, memoryId]);
  return impact;
}

function MemoryImpactNote({ impact, name, deleting }) {
  if (!impact) return <p className="muted" role="status">{t('bots.checkingImpact')}</p>;
  if (impact.error) return null;
  const titles = impact.procedures.map(item => t('bots.quoted', { text: item.title || t('bots.untitledProcedure') })).join(t('bots.quotedJoiner'));
  const lines = deleting
    ? [impact.procedure_count ? t('bots.impactProceduresGone', { name, count: impact.procedure_count }) : null, t('bots.impactHistoryGone')]
    : [impact.procedures.length ? t('bots.impactStops', { titles }) : t('bots.impactNoProcedures')];
  if (impact.open_tasks) lines.push(t(deleting ? 'bots.impactTasksRemaining' : 'bots.impactTasksCorrected', { count: impact.open_tasks }));
  return <ul className="memory-impact" aria-label={t('bots.impactLabel')}>{lines.filter(Boolean).map(line => <li key={line}>{line}</li>)}</ul>;
}

export function MemoryEditModal({ memory, member, onSave, onClose }) {
  const [text, setText] = useState(memory.text);
  const [keep, setKeep] = useState(true);
  const impact = useMemoryImpact(member.id, memory.id);
  return <Modal title={t('bots.correctMemory')} onClose={onClose}><form onSubmit={e => { e.preventDefault(); if (text.trim()) onSave(text.trim(), keep); }}><div className="modal-body form-stack"><p className="muted">{t('bots.correctIntro', { name: member.name })}</p><label className="field"><span>{t('bots.memoryText')}</span><textarea rows={6} value={text} onChange={e => setText(e.target.value)} autoFocus required /></label>
    <label className="keep-previous"><input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} /><span>{t('bots.keepPrevious')}<small>{t('bots.keepPreviousHint')}</small></span></label>
    <MemoryImpactNote impact={impact} name={member.name} /></div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>{t('bots.cancel')}</button><button className="button primary" disabled={!text.trim()}>{t('bots.saveCorrection')}</button></div></form></Modal>;
}

export function MemoryDeleteModal({ memory, member, onDelete, onClose }) {
  const impact = useMemoryImpact(member.id, memory.id);
  return <Modal title={t('bots.deleteMemoryTitle')} onClose={onClose}><div className="modal-body"><p className="muted">{t('bots.deleteMemoryIntro', { name: member.name })}</p><blockquote className="delete-preview">{memory.text}</blockquote><MemoryImpactNote impact={impact} name={member.name} deleting /></div><div className="form-actions"><button className="button subtle" onClick={onClose}>{t('bots.cancel')}</button><button className="button danger" onClick={onDelete}>{t('bots.deleteMemory')}</button></div></Modal>;
}
