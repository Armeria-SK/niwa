import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Avatar, EmptyState, IconButton, Segmented } from './components.jsx';
import { MemoryDeleteModal, MemoryEditModal, MemorySourceLine } from './MemoryDialogs.jsx';
import { memorySource } from './memory-source.js';
import { CheckCircleIcon, CloseIcon, EditIcon, MemoryIcon, SearchIcon, TrashIcon } from './icons.jsx';
import { serverText, t } from './i18n.js';
import { rich } from './i18n-react.js';

const asMemory = (item, agentId) => ({ ...item, member: agentId, text: item.body, source: memorySource(item) });

/** すべてのBotの記憶をまとめて見る欄。「誰が知っている？」で探し、「食い違い」で見比べて直す。 */
export function EveryoneMemory({ tab = 'search', onTab, members, onSaveMemory, onDeleteMemory, onOpenThread, onOpenBot }) {
  const [conflicts, setConflicts] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    api('/memories/conflicts').then(items => { if (active) setConflicts(items); }).catch(failure => { if (active) setConflicts({ error: failure.message }); });
    return () => { active = false; };
  }, [version]);
  // 直した・消したあとは、検索の結果も食い違いの組も読み直す。
  const changed = work => async (...args) => { const ok = await work(...args); if (ok) setVersion(value => value + 1); return ok; };
  const editing = { onSave: changed(onSaveMemory), onDelete: changed(onDeleteMemory) };
  const count = Array.isArray(conflicts) ? conflicts.length : null;
  return <div className="everyone-memory">
    <Segmented underline label={t('bots.everyoneMemory')} className="detail-tabs" value={tab} onChange={onTab} options={[{ value: 'search', label: t('bots.whoKnows') }, { value: 'conflicts', label: t('bots.possibleConflicts'), count }]} />
    <div className="member-detail-scroll">
      {tab === 'conflicts' ? <Conflicts conflicts={conflicts} members={members} editing={editing} onOpenThread={onOpenThread} onDismiss={async pair => { await api('/memories/conflicts/dismiss', 'POST', { pair }); setVersion(value => value + 1); }} />
        : <WhoKnows version={version} members={members} editing={editing} onOpenThread={onOpenThread} onOpenBot={onOpenBot} />}
    </div>
  </div>;
}

function WhoKnows({ version, members, editing, onOpenThread, onOpenBot }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const words = query.trim();
  useEffect(() => {
    if (!words) { setResult(null); return undefined; }
    let active = true;
    const timer = setTimeout(() => api(`/memories/search?q=${encodeURIComponent(words)}`).then(groups => { if (active) setResult({ words, groups }); }).catch(failure => { if (active) setResult({ words, error: failure.message }); }), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [words, version]);
  const current = result?.words === words ? result : null;
  return <div className="memory-view">
    <p className="field-hint">{rich('bots.whoKnowsIntro', { br: <br /> })}</p>
    <div className="memory-search"><div className="search-field"><SearchIcon size={18} /><input type="search" autoFocus aria-label={t('bots.searchAllMemories')} placeholder={t('bots.whoKnowsPlaceholder')} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />{query ? <IconButton label={t('bots.clearSearch')} onClick={() => setQuery('')}><CloseIcon size={16} /></IconButton> : null}</div></div>
    {!words ? <EmptyState icon={MemoryIcon} title={t('bots.whoKnowsEmptyTitle')}>{t('bots.whoKnowsEmptyBody')}</EmptyState>
      : !current ? <p className="memory-count" role="status">{t('bots.searching')}</p>
      : current.error ? <p role="alert">{current.error}</p>
      : !current.groups.length ? <EmptyState icon={SearchIcon} title={t('bots.nobodyKnows')}>{t('bots.tryOtherWords')}</EmptyState>
      : current.groups.map(group => <section key={group.agent_id} className="who-knows-group">
        <button type="button" className="who-knows-bot" onClick={() => onOpenBot(group.agent_id)}><Avatar member={members[group.agent_id]} size={32} /><strong>{group.name}</strong><span>{group.total > group.items.length ? t('bots.groupCountNewest', { count: group.total, shown: group.items.length }) : t('bots.groupCount', { count: group.total })}</span></button>
        <MemoryRows items={group.items.map(item => asMemory(item, group.agent_id))} members={members} editing={editing} onOpenThread={onOpenThread} />
      </section>)}
  </div>;
}

function Conflicts({ conflicts, members, editing, onOpenThread, onDismiss }) {
  const [busy, setBusy] = useState('');
  if (!conflicts) return <p className="memory-count" role="status">{t('bots.comparing')}</p>;
  if (conflicts.error) return <p role="alert">{conflicts.error}</p>;
  return <div className="memory-view">
    <p className="field-hint">{rich('bots.conflictsIntro', { br: <br /> })}</p>
    {!conflicts.length ? <EmptyState icon={CheckCircleIcon} title={t('bots.noConflicts')}>{t('bots.noConflictsBody')}</EmptyState>
      : conflicts.map(conflict => <article key={conflict.pair} className="conflict-card">
        <div className="conflict-top"><span className="attention-chip warn">{conflict.same_bot ? t('bots.sameBot') : t('bots.betweenBots')}</span><ul>{conflict.differences.map(text => <li key={text}>{serverText(text)}</li>)}</ul></div>
        <MemoryRows items={conflict.memories.map(item => asMemory(item, item.agent_id))} members={members} editing={editing} onOpenThread={onOpenThread} showOwner />
        <div className="inline-actions"><button type="button" className="button subtle" disabled={busy === conflict.pair} onClick={async () => { setBusy(conflict.pair); try { await onDismiss(conflict.pair); } finally { setBusy(''); } }}>{t('bots.notConflict')}</button></div>
      </article>)}
  </div>;
}

function MemoryRows({ items, members, editing, onOpenThread, showOwner = false }) {
  const [edit, setEdit] = useState(null), [remove, setRemove] = useState(null);
  return <div className="memory-list">
    {items.map(item => { const owner = members[item.member];
      return <div key={`${item.member}:${item.id}`} className="memory-item">
        <div className="memory-item-meta">{showOwner ? <span className="memory-owner"><Avatar member={owner} size={20} />{owner?.name}</span> : <span>{t('bots.memoryKind')}</span>}<time dateTime={item.created_at}>{item.source.created}</time></div>
        <p>{item.text}</p><MemorySourceLine memory={item} onOpenThread={onOpenThread} />
        <div className="memory-item-bottom"><span /><div className="memory-actions"><IconButton label={t('bots.correctMemoryLabel', { text: item.text.slice(0, 16) })} onClick={() => setEdit(item)}><EditIcon size={18} /></IconButton><IconButton label={t('bots.deleteMemoryLabel', { text: item.text.slice(0, 16) })} onClick={() => setRemove(item)}><TrashIcon size={18} /></IconButton></div></div>
      </div>; })}
    {edit ? <MemoryEditModal memory={edit} member={members[edit.member]} onClose={() => setEdit(null)} onSave={async (text, keep) => { if (await editing.onSave(edit, text, keep)) setEdit(null); }} /> : null}
    {remove ? <MemoryDeleteModal memory={remove} member={members[remove.member]} onClose={() => setRemove(null)} onDelete={async () => { if (await editing.onDelete(remove)) setRemove(null); }} /> : null}
  </div>;
}
