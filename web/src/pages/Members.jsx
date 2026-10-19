import { DeleteMember } from '../DeleteMember.jsx';
import { useState } from 'react';
import { ModelPicker } from '../ModelPicker.jsx';
import { SHAPES } from '../data.js';
import { MemoryHistory } from '../MemoryHistory.jsx';
import { useMemoryPage } from '../useMemoryPage.js';
import { memorySource } from '../memory-source.js';
import { ProcedureBook } from '../ProcedureBook.jsx';
import { EveryoneMemory } from '../EveryoneMemory.jsx';
import { MemoryDeleteModal, MemoryEditModal, MemorySourceLine } from '../MemoryDialogs.jsx';
import { BotExport } from '../BotExport.jsx';
import { BotImport } from '../BotImport.jsx';
import { Avatar, AppearanceFields, MotionPicker, EmptyState, IconButton, Modal, Segmented, Sentences, StatusLabel } from '../components.jsx';
import { ChatIcon, EditIcon, LockIcon, MemoryIcon, SearchIcon, TrashIcon, CloseIcon, CheckIcon, PlusIcon, UsersIcon } from '../icons.jsx';
import { t } from '../i18n.js';
import { rich } from '../i18n-react.js';

/** Botの一覧と、選んだBotのプロフィール・記憶・手順帳。どのBotのどの欄を見ているかはURL（#bots/ID/欄）で決まる。 */
export function Members({ members, memberMap, selected, tab = 'profile', onSelect, onClose, onTab, onOpenBot, onUpdate, onSaveMemory, onDeleteMemory, onDM, paused, onAdd, maxMembers, onDelete, onOpenThread, onDormant, onImported }) {
  const [adding, setAdding] = useState(false);
  const atLimit = members.filter(item => item.authority !== 'leader').length >= maxMembers;
  // 「みんなの記憶」（#bots/everyone）は、Botを1体選ぶ代わりに、すべてのBotの記憶をまとめて見る。
  const everyone = selected === 'everyone';
  // 「Botの読み込み」（#bots/import）は、書き出したファイルから新しいBotを迎える。
  const importing = selected === 'import';
  // 一覧はいつもカードで並べ、選んだBot（#bots/ID）の詳しいことは右の脇の欄に出す。
  const member = members.find(item => item.id === selected);
  return <main className="work-area members-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">{t('bots.pageEyebrow')}</span><h1>{t('bots.pageTitle')}</h1><p>{rich('bots.pageLead', { br: <br /> })}</p></div><div className="member-heading-actions"><span className="quiet-count">{t('bots.botCount', { count: members.length })}</span><button className="button secondary" onClick={() => onSelect('import')} aria-pressed={importing}>{t('bots.importBot')}</button><button className="button primary" onClick={() => setAdding(true)}><PlusIcon size={17} />{t('bots.addBot')}</button></div></div>
    <div className="members-grid-scroll"><div className="members-grid">
      {members.map(item => <button key={item.id} type="button" className={`bot-card ${item.status === 'sleeping' ? 'sleeping' : ''} ${item.id === member?.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)} aria-pressed={item.id === member?.id}>
        <span className="bot-card-top"><span className="bot-card-avatar"><Avatar member={item} size={48} /></span><span className="bot-card-text"><strong className="bot-card-name">{item.name}{item.authority === 'leader' ? <span className="role-label">{t('bots.leader')}</span> : null}</strong><small>{item.role}</small></span></span>
        <StatusLabel member={item} paused={paused} showDescription={false} />
      </button>)}
      <button type="button" className={`bot-card utility ${everyone ? 'selected' : ''}`} onClick={() => onSelect('everyone')} aria-pressed={everyone}><span className="everyone-icon"><UsersIcon size={24} /></span><strong>{t('bots.everyoneMemory')}</strong><small>{t('bots.everyoneMemoryHint')}</small></button>
    </div></div>
    {importing ? <Modal drawer title={t('bots.importTitle')} className="bot-drawer" onClose={onClose}><div className="member-detail-scroll"><BotImport onImported={onImported} /></div></Modal> : null}
    {everyone ? <Modal drawer title={t('bots.everyoneMemory')} className="bot-drawer" onClose={onClose}><EveryoneMemory tab={tab === 'conflicts' ? 'conflicts' : 'search'} onTab={onTab} members={memberMap} onSaveMemory={onSaveMemory} onDeleteMemory={onDeleteMemory} onOpenThread={onOpenThread} onOpenBot={onOpenBot} /></Modal> : null}
    {member ? <BotDrawer key={member.id} member={member} tab={tab} onTab={onTab} onClose={onClose} onUpdate={onUpdate} onSaveMemory={onSaveMemory} onDeleteMemory={onDeleteMemory} onDM={onDM} onOpenThread={onOpenThread} onDormant={onDormant} onDelete={onDelete} /> : null}
    {adding ? <AddMemberModal atLimit={atLimit} maxMembers={maxMembers} onClose={() => setAdding(false)} onAdd={async draft => { const error = await onAdd(draft); if (!error) setAdding(false); return error; }} /> : null}
  </main>;
}

/** 1体のBotの脇の欄（プロフィール・記憶・手順帳・書き出し）。Botの画面のほか、会話の上にも重ねて開く。閉じると開く前の画面に戻る。 */
export function BotDrawer({ member, tab = 'profile', onTab, onClose, onUpdate, onSaveMemory, onDeleteMemory, onDM, onOpenThread, onDormant, onDelete }) {
  const [deleting, setDeleting] = useState(null);
  const [resting, setResting] = useState(null);
  return <><Modal drawer className="bot-drawer" onClose={onClose} title={<span className="bot-drawer-title"><span><Avatar member={member} size={36} /></span><span>{member.name}<small>{member.role}</small></span></span>}>
    <div className="bot-drawer-actions"><button className="button secondary" onClick={() => onDM(member.id)}><ChatIcon size={18} />{t('bots.talkPrivately')}</button>{member.authority !== 'leader' ? member.status === 'sleeping' ? <button className="button secondary" onClick={() => onDormant(member.id, false)}>{t('bots.bringBack')}</button> : <button className="button subtle" onClick={() => setResting(member)}>{t('bots.letRest')}</button> : null}</div>
    <Segmented underline label={t('bots.detailTabs')} className="detail-tabs" options={[{ value: 'profile', label: t('bots.tabProfile') }, { value: 'memory', label: t('bots.tabMemory') }, { value: 'procedures', label: t('bots.tabProcedures') }, { value: 'export', label: t('bots.tabExport') }]} value={tab} onChange={onTab} />
    <div className="member-detail-scroll" key={`${member.id}-${tab}`}>
      {tab === 'profile' ? <Profile key={member.id} member={member} onSave={patch => onUpdate(member.id, patch)} /> : null}
      {tab === 'procedures' ? <ProcedureBook key={member.id} member={member} /> : null}
      {tab === 'export' ? <BotExport key={member.id} member={member} /> : null}
      {tab === 'memory' ? <MemoryList key={member.id} member={member} onSave={onSaveMemory} onDelete={onDeleteMemory} onOpenThread={onOpenThread} /> : null}
      {tab === 'profile' && member.authority !== 'leader' ? <button className="button subtle" onClick={() => setDeleting(member)}>{t('bots.deleteBot')}</button> : null}
    </div>
  </Modal>
  {deleting ? <DeleteMember member={deleting} onClose={() => setDeleting(null)} onDelete={onDelete} /> : null}
  {resting ? <Modal title={t('bots.restTitle', { name: resting.name })} onClose={() => setResting(null)}><div className="modal-body"><p className="muted">{rich('bots.restBody', { br: <br /> })}</p></div><div className="form-actions"><button type="button" className="button subtle" onClick={() => setResting(null)}>{t('bots.cancel')}</button><button type="button" className="button primary" onClick={async () => { if (await onDormant(resting.id, true)) setResting(null); }}>{t('bots.letRest')}</button></div></Modal> : null}</>;
}

function Profile({ member, onSave }) {
  const [draft, setDraft] = useState(member);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const validColor = /^#[0-9a-f]{6}$/i.test(draft.color);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); };
  return <form className="profile-form form-stack" onSubmit={async e => { e.preventDefault(); if (!saving && draft.name.trim() && validColor) { setSaving(true); try { const ok = await onSave({ profile_version: draft.profile_version, name: draft.name.trim(), role: draft.role.trim(), persona: draft.persona, model: draft.model, effort: draft.effort, provider: draft.provider, shape: draft.shape, color: draft.color, motion: draft.motion || 'auto' }); setSaved(Boolean(ok)); if (ok) setDraft(current => ({ ...current, profile_version: ok })); } finally { setSaving(false); } } }}>
    <fieldset className="profile-layout" disabled={saving}>
    <section className="profile-basics form-stack" aria-label={t('bots.profileSection')}>
    <div className="field-pair"><label className="field"><span>{t('bots.name')}</span><input value={draft.name} onChange={e => change('name', e.target.value)} maxLength={20} required /></label><label className="field"><span>{t('bots.role')}</span><input value={draft.role} onChange={e => change('role', e.target.value)} maxLength={40} /></label></div>
    <label className="field"><span>{t('bots.persona')}</span><textarea rows={5} value={draft.persona} onChange={e => change('persona', e.target.value)} /></label>
    {member.interests.some(interest=>interest.trim())?<div className="interest-block"><span className="field-label">{t('bots.interests')}</span><div className="interest-tags">{member.interests.map(interest => <span key={interest}>{interest}</span>)}</div></div>:null}
    <div className="form-section-label">{t('bots.thisBotModel')}</div>
    <ModelPicker label={t('bots.model')} value={{ provider: draft.provider, model: draft.model, reasoning: draft.effort }} keep={[{ provider: member.provider, model: member.model, reasoning: member.effort }]} onChange={next => { setDraft(current => ({ ...current, provider: next.provider, model: next.model, effort: next.reasoning })); setSaved(false); }} />
    <p className="field-hint">{t('bots.modelHint')}</p>
    </section>
    <section className="profile-appearance" aria-label={t('bots.appearance')}><h3>{t('bots.appearance')}</h3><AppearanceFields draft={draft} onChange={change} /></section>
    </fieldset>
    <div className="form-actions"><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />{t('common.saved')}</> : null}</span><button type="button" className="button subtle" disabled={saving} onClick={() => { setDraft(member); setSaved(false); }}>{t('bots.reloadLatest')}</button><button className="button primary" disabled={saving || !draft.name.trim() || !validColor}>{saving ? t('bots.saving') : t('bots.saveChanges')}</button></div>
  </form>;
}

function MemoryList({ member, onSave, onDelete, onOpenThread }) {
  const [query, setQuery] = useState('');
  const page = useMemoryPage(member, query);
  const memories = page.items.map(item => ({ ...item, member: member.id, text: item.body, kind: t('bots.memoryKind'), source: memorySource(item) }));
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [history, setHistory] = useState(null);
  const selectedHistory = memories.find(item => item.id === history);
  // 一覧はタブの中にそのまま置き、訂正・削除・履歴だけを1段の窓で重ねる。窓を閉じても一覧の位置は動かない。
  return <div className="memory-view" aria-busy={page.loading}>
    <div className="privacy-note"><LockIcon size={20} /><div><strong>{t('bots.privateMemoryTitle', { name: member.name })}</strong><p>{t('bots.privateMemoryBody', { name: member.name })}</p></div></div>
    <div className="memory-search"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label={t('bots.searchMemoryOf', { name: member.name })} placeholder={t('bots.searchMemory')} maxLength={200} value={query} onChange={e => setQuery(e.target.value)} />{query ? <IconButton label={t('bots.clearMemorySearch')} onClick={() => setQuery('')}><CloseIcon size={16} /></IconButton> : null}</div>
      <div className="memory-count" role="status">{page.loading ? t('bots.loadingShort') : t('bots.memoryCount', { total: page.total, shown: memories.length })}</div></div>
    {page.error ? <p role="alert">{page.error}<button className="text-button" onClick={page.reload}>{t('bots.reload')}</button></p> : null}
    {memories.length ? <div className="memory-list">{memories.map(item => <article key={item.id} className="memory-item"><div className="memory-item-meta"><span>{item.kind}</span><time dateTime={item.created_at}>{item.source.created}</time></div><p>{item.text}</p><MemorySourceLine memory={item} onOpenThread={onOpenThread} /><div className="memory-item-bottom">{item.revision > 1 ? <button className="text-button revision-link" onClick={() => setHistory(item.id)}>{t('bots.correctionsByYou', { count: item.revision - 1 })}</button> : <span />}
      <div className="memory-actions"><IconButton disabled={page.loading} label={t('bots.correctMemoryLabel', { text: item.text.slice(0, 16) })} onClick={() => setEditing(item)}><EditIcon size={18} /></IconButton><IconButton disabled={page.loading} label={t('bots.deleteMemoryLabel', { text: item.text.slice(0, 16) })} onClick={() => setDeleting(item)}><TrashIcon size={18} /></IconButton></div></div></article>)}</div> : page.loading || page.error ? null : <EmptyState icon={MemoryIcon} title={query ? t('bots.noMatchingMemories') : t('bots.noMemoriesYet')}>{query ? t('bots.tryOtherWords') : t('bots.memoriesGrow')}</EmptyState>}
    {page.next !== null ? <button className="button secondary" disabled={page.loading} onClick={page.loadMore}>{t('bots.loadMore', { count: 50 })}</button> : null}
    {editing ? <MemoryEditModal memory={editing} member={member} onClose={() => setEditing(null)} onSave={async (text, keep) => { if (await onSave(editing, text, keep)) setEditing(null); }} /> : null}
    {deleting ? <MemoryDeleteModal memory={deleting} member={member} onClose={() => setDeleting(null)} onDelete={async () => { if (await onDelete(deleting)) setDeleting(null); }} /> : null}
    {selectedHistory ? <MemoryHistory member={member} memory={selectedHistory} onClose={() => setHistory(null)} /> : null}
  </div>;
}

function AddMemberModal({ onClose, onAdd, atLimit, maxMembers }) {
  const [draft, setDraft] = useState({ name: '', role: '', persona: '', motion: 'none', shape: 'pebble', color: '#61B8A5' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setError(''); };
  return <Modal title={t('bots.addBot')} onClose={() => { if (!busy) onClose(); }}><form onSubmit={async e => { e.preventDefault(); if (busy || atLimit || !draft.name.trim()) return; setBusy(true); try { setError(await onAdd({ ...draft, name: draft.name.trim(), persona: draft.persona.trim() }) || ''); } finally { setBusy(false); } }}>
    <fieldset className="modal-body form-stack" disabled={busy} style={{ border: 0, margin: 0 }}>
      <p className="field-hint">{rich('bots.addIntro', { br: <br /> })}</p>
      {atLimit ? <p className="field-error" role="alert"><Sentences>{t('bots.limitReached', { limit: maxMembers })}</Sentences></p> : null}
      <div className="field-pair"><label className="field"><span>{t('bots.name')}</span><input autoFocus required maxLength={20} value={draft.name} onChange={e => change('name', e.target.value)} placeholder={t('bots.newBotName')} /></label><label className="field"><span>{t('bots.role')}</span><input maxLength={40} value={draft.role} onChange={e => change('role', e.target.value)} placeholder={t('bots.rolePlaceholder')} /></label></div>
      <label className="field"><span>{t('bots.persona')}</span><textarea rows={3} maxLength={2000} value={draft.persona} onChange={e => change('persona', e.target.value)} placeholder={t('bots.personaPlaceholder')} /></label>
      <div className="new-member-appearance"><Avatar shape={draft.shape} color={draft.color} motion={draft.motion} size={54} /><label className="field"><span>{t('bots.shape')}</span><select value={draft.shape} onChange={e => change('shape', e.target.value)}>{SHAPES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>{t('bots.color')}</span><input type="color" value={draft.color} onChange={e => change('color', e.target.value)} /></label></div>
      <fieldset><legend>{t('bots.motion')}</legend><MotionPicker value={draft.motion} onChange={value => change('motion', value)} /></fieldset>
      <p className="field-hint">{rich('bots.addModelHint', { br: <br /> })}</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </fieldset>
    <div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{t('bots.cancel')}</button><button className="button primary" disabled={busy || atLimit || !draft.name.trim()}>{busy ? t('bots.welcoming') : t('bots.welcome')}</button></div>
  </form></Modal>;
}
