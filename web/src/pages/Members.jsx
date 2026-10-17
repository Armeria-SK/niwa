import { DeleteMember } from '../DeleteMember.jsx';
import { MemberScroll } from '../MemberScroll.jsx';
import { useState } from 'react';
import { ModelPicker } from '../ModelPicker.jsx';
import { SHAPES } from '../data.js';
import { MemoryHistory } from '../MemoryHistory.jsx';
import { useMemoryPage } from '../useMemoryPage.js';
import { memorySource } from '../memory-source.js';
import { ProcedureBook } from '../ProcedureBook.jsx';
import { EveryoneMemory } from '../EveryoneMemory.jsx';
import { MemoryDeleteModal, MemoryEditModal, MemorySourceLine } from '../MemoryDialogs.jsx';
import { SeedExport } from '../SeedExport.jsx';
import { Avatar, AppearanceFields, MotionPicker, EmptyState, IconButton, Modal, Segmented, StatusLabel } from '../components.jsx';
import { ChatIcon, ChevronRightIcon, EditIcon, LockIcon, MemoryIcon, SearchIcon, TrashIcon, CloseIcon, CheckIcon, PlusIcon, UsersIcon } from '../icons.jsx';

/** Botの一覧と、選んだBotのプロフィール・記憶・手順帳。どのBotのどの欄を見ているかはURL（#bots/ID/欄）で決まる。 */
export function Members({ members, memberMap, selected, tab = 'profile', onSelect, onTab, onOpenBot, onUpdate, onSaveMemory, onDeleteMemory, onDM, paused, onAdd, maxMembers, onDelete, onOpenThread, onDormant }) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [resting, setResting] = useState(null);
  const atLimit = members.filter(item => item.authority !== 'leader').length >= maxMembers;
  // 「みんなの記憶」（#bots/everyone）は、Botを1体選ぶ代わりに、すべてのBotの記憶をまとめて見る。
  const everyone = selected === 'everyone';
  const member = members.find(item => item.id === selected) || members[0];
  return <main className="work-area members-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">それぞれの個性を、大切に。</span><h1>Bot</h1><p>話し方、記憶、見た目。<br />ひとりずつ、少しずつ。</p></div><div className="member-heading-actions"><span className="quiet-count">{members.length}体のBot</span><button className="button primary" onClick={() => setAdding(true)}><PlusIcon size={17} />Botを迎える</button></div></div>
    <div className="members-layout"><MemberScroll><button className={`member-list-row everyone-row ${everyone ? 'selected' : ''}`} onClick={() => onSelect('everyone')} aria-pressed={everyone}><span className="everyone-icon"><UsersIcon size={26} /></span><span><strong>みんなの記憶</strong><small>探す・見比べる</small></span><ChevronRightIcon size={17} /></button>{members.map(item => <button key={item.id} className={`member-list-row ${!everyone && item.id === member.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)} aria-pressed={!everyone && item.id === member.id}><Avatar member={item} size={64} /><span><strong>{item.name}{item.authority === 'leader' ? <span className="role-label">リーダー</span> : null}</strong><small>{item.role}</small><StatusLabel member={item} paused={paused} showDescription={false} /></span><ChevronRightIcon size={17} /></button>)}</MemberScroll>
      {everyone ? <section className="member-detail" aria-label="みんなの記憶"><EveryoneMemory tab={tab === 'conflicts' ? 'conflicts' : 'search'} onTab={onTab} members={memberMap} onSaveMemory={onSaveMemory} onDeleteMemory={onDeleteMemory} onOpenThread={onOpenThread} onOpenBot={onOpenBot} /></section> : <section className="member-detail" aria-label={`${member.name}の詳細`}><div className="member-detail-top"><Avatar member={member} size={76} /><div><h2>{member.name}</h2><span className="muted">{member.role}</span></div>{member.authority !== 'leader' ? member.status === 'sleeping' ? <button className="button secondary" onClick={() => onDormant(member.id, false)}>呼び戻す</button> : <button className="button subtle" onClick={() => setResting(member)}>休ませる</button> : null}<button className="button secondary" onClick={() => onDM(member.id)}><ChatIcon size={18} />個別に話す</button></div>
        <Segmented label="Botの情報" className="detail-tabs" options={[{ value: 'profile', label: 'プロフィール' }, { value: 'memory', label: '記憶' }, { value: 'procedures', label: '手順帳' }, { value: 'seed', label: '苗の書き出し' }]} value={tab} onChange={onTab} />
        <div className="member-detail-scroll" key={`${member.id}-${tab}`}>
        {tab === 'profile' ? <Profile key={member.id} member={member} onSave={patch => onUpdate(member.id, patch)} /> : null}
        {tab === 'procedures' ? <ProcedureBook key={member.id} member={member} /> : null}
        {tab === 'seed' ? <SeedExport key={member.id} member={member} /> : null}
        {tab === 'memory' ? <MemoryList key={member.id} member={member} onSave={onSaveMemory} onDelete={onDeleteMemory} onOpenThread={onOpenThread} /> : null}
        {tab === 'profile' && member.authority !== 'leader' ? <button className="button subtle" onClick={() => setDeleting(member)}>このBotを削除</button> : null}
        </div>
      </section>}
    </div>
    {deleting ? <DeleteMember member={deleting} onClose={() => setDeleting(null)} onDelete={onDelete} /> : null}
    {resting ? <Modal title={`${resting.name}を休ませますか？`} onClose={() => setResting(null)}><div className="modal-body"><p className="muted">進めている仕事は止まり、自分から動く活動もしなくなります。<br />記憶と会話はそのまま残り、いつでも呼び戻せます。</p></div><div className="form-actions"><button type="button" className="button subtle" onClick={() => setResting(null)}>やめる</button><button type="button" className="button primary" onClick={async () => { if (await onDormant(resting.id, true)) setResting(null); }}>休ませる</button></div></Modal> : null}
    {adding ? <AddMemberModal atLimit={atLimit} maxMembers={maxMembers} onClose={() => setAdding(false)} onAdd={async draft => { const error = await onAdd(draft); if (!error) setAdding(false); return error; }} /> : null}
  </main>;
}

function Profile({ member, onSave }) {
  const [draft, setDraft] = useState(member);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const validColor = /^#[0-9a-f]{6}$/i.test(draft.color);
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); };
  return <form className="profile-form form-stack" onSubmit={async e => { e.preventDefault(); if (!saving && draft.name.trim() && validColor) { setSaving(true); try { const ok = await onSave({ profile_version: draft.profile_version, name: draft.name.trim(), role: draft.role.trim(), persona: draft.persona, model: draft.model, effort: draft.effort, provider: draft.provider, shape: draft.shape, color: draft.color, motion: draft.motion || 'auto' }); setSaved(Boolean(ok)); if (ok) setDraft(current => ({ ...current, profile_version: ok })); } finally { setSaving(false); } } }}>
    <fieldset className="profile-layout" disabled={saving}>
    <section className="profile-basics form-stack" aria-label="プロフィールとモデル">
    <div className="field-pair"><label className="field"><span>名前</span><input value={draft.name} onChange={e => change('name', e.target.value)} maxLength={20} required /></label><label className="field"><span>役割</span><input value={draft.role} onChange={e => change('role', e.target.value)} maxLength={40} /></label></div>
    <label className="field"><span>性格と話し方</span><textarea rows={5} value={draft.persona} onChange={e => change('persona', e.target.value)} /></label>
    {member.interests.some(interest=>interest.trim())?<div className="interest-block"><span className="field-label">気になっていること</span><div className="interest-tags">{member.interests.map(interest => <span key={interest}>{interest}</span>)}</div></div>:null}
    <div className="form-section-label">このBotのモデル</div>
    <ModelPicker label="モデル" value={{ provider: draft.provider, model: draft.model, reasoning: draft.effort }} keep={[{ provider: member.provider, model: member.model, reasoning: member.effort }]} onChange={next => { setDraft(current => ({ ...current, provider: next.provider, model: next.model, effort: next.reasoning })); setSaved(false); }} />
    <p className="field-hint">モデルを変えても、人格と記憶は引き継ぎます。</p>
    </section>
    <section className="profile-appearance" aria-label="見た目"><h3>見た目</h3><AppearanceFields draft={draft} onChange={change} /></section>
    </fieldset>
    <div className="form-actions"><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />保存しました</> : null}</span><button type="button" className="button subtle" disabled={saving} onClick={() => { setDraft(member); setSaved(false); }}>最新の内容を読み込む</button><button className="button primary" disabled={saving || !draft.name.trim() || !validColor}>{saving ? '保存中…' : '変更を保存'}</button></div>
  </form>;
}

function MemoryList({ member, onSave, onDelete, onOpenThread }) {
  const [query, setQuery] = useState('');
  const page = useMemoryPage(member, query);
  const memories = page.items.map(item => ({ ...item, member: member.id, text: item.body, kind: '記憶', source: memorySource(item) }));
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [history, setHistory] = useState(null);
  const selectedHistory = memories.find(item => item.id === history);
  // 一覧はタブの中にそのまま置き、訂正・削除・履歴だけを1段の窓で重ねる。窓を閉じても一覧の位置は動かない。
  return <div className="memory-view" aria-busy={page.loading}>
    <div className="privacy-note"><LockIcon size={20} /><div><strong>{member.name}だけの記憶</strong><p>この記憶を見られるのは、{member.name}とあなたです。</p></div></div>
    <div className="memory-search"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label={`${member.name}の記憶を検索`} placeholder="記憶を検索" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} />{query ? <IconButton label="記憶の検索をクリア" onClick={() => setQuery('')}><CloseIcon size={16} /></IconButton> : null}</div>
      <div className="memory-count" role="status">{page.loading ? '読み込み中…' : `${page.total}件の記憶（${memories.length}件を表示）`}</div></div>
    {page.error ? <p role="alert">{page.error}<button className="text-button" onClick={page.reload}>再読み込み</button></p> : null}
    {memories.length ? <div className="memory-list">{memories.map(item => <article key={item.id} className="memory-item"><div className="memory-item-meta"><span>{item.kind}</span><time dateTime={item.created_at}>{item.source.created}</time></div><p>{item.text}</p><MemorySourceLine memory={item} onOpenThread={onOpenThread} /><div className="memory-item-bottom">{item.revision > 1 ? <button className="text-button revision-link" onClick={() => setHistory(item.id)}>あなたによる訂正 · {item.revision - 1}回</button> : <span />}
      <div className="memory-actions"><IconButton disabled={page.loading} label={`記憶を訂正：${item.text.slice(0, 16)}`} onClick={() => setEditing(item)}><EditIcon size={18} /></IconButton><IconButton disabled={page.loading} label={`記憶を削除：${item.text.slice(0, 16)}`} onClick={() => setDeleting(item)}><TrashIcon size={18} /></IconButton></div></div></article>)}</div> : page.loading || page.error ? null : <EmptyState icon={MemoryIcon} title={query ? '一致する記憶がありません' : 'まだ記憶がありません'}>{query ? '別の言葉で探してみてください。' : '会話や経験を通じて、少しずつ増えていきます。'}</EmptyState>}
    {page.next !== null ? <button className="button secondary" disabled={page.loading} onClick={page.loadMore}>さらに50件読み込む</button> : null}
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
  return <Modal title="Botを迎える" onClose={() => { if (!busy) onClose(); }}><form onSubmit={async e => { e.preventDefault(); if (busy || atLimit || !draft.name.trim()) return; setBusy(true); try { setError(await onAdd({ ...draft, name: draft.name.trim(), persona: draft.persona.trim() }) || ''); } finally { setBusy(false); } }}>
    <fieldset className="modal-body form-stack" disabled={busy} style={{ border: 0, margin: 0 }}>
      <p className="field-hint">指定した内容でBotを迎えます。<br />迎えたあとは、この一覧で確かめられます。</p>
      {atLimit ? <p className="field-error" role="alert">迎えられるBotの上限（{maxMembers}体）に達しています。<br />休ませているBotも数に入ります。<br />設定の「活動と人数」で上限を変えられます。</p> : null}
      <div className="field-pair"><label className="field"><span>名前</span><input autoFocus required maxLength={20} value={draft.name} onChange={e => change('name', e.target.value)} placeholder="新しいBotの名前" /></label><label className="field"><span>役割</span><input maxLength={40} value={draft.role} onChange={e => change('role', e.target.value)} placeholder="例：調べる・まとめる" /></label></div>
      <label className="field"><span>性格と話し方</span><textarea rows={3} maxLength={2000} value={draft.persona} onChange={e => change('persona', e.target.value)} placeholder="どんなBotにしたいですか？" /></label>
      <div className="new-member-appearance"><Avatar shape={draft.shape} color={draft.color} motion={draft.motion} size={54} /><label className="field"><span>かたち</span><select value={draft.shape} onChange={e => change('shape', e.target.value)}>{SHAPES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>カラー</span><input type="color" value={draft.color} onChange={e => change('color', e.target.value)} /></label></div>
      <fieldset><legend>動き</legend><MotionPicker value={draft.motion} onChange={value => change('motion', value)} /></fieldset>
      <p className="field-hint">モデルは「新しいBotの標準モデル」を使用します。<br />見た目やプロフィールは追加後も変更できます。</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </fieldset>
    <div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={onClose}>やめる</button><button className="button primary" disabled={busy || atLimit || !draft.name.trim()}>{busy ? '迎えています…' : '迎える'}</button></div>
  </form></Modal>;
}
