import { useState } from 'react';
import { api } from '../api.js';
import { SHAPES } from '../data.js';
import { MemoryHistory } from '../MemoryHistory.jsx';
import { Avatar, AppearanceEditor, MotionPicker, EmptyState, IconButton, Modal, Segmented, StatusLabel } from '../components.jsx';
import { ChatIcon, ChevronRightIcon, EditIcon, LockIcon, MemoryIcon, SearchIcon, TrashIcon, CloseIcon, CheckIcon, PlusIcon } from '../icons.jsx';

export function Members({ members, selected, onSelect, onUpdate, memories, onSaveMemory, onDeleteMemory, onDM, paused, onAdd, maxMembers }) {
  const [tab, setTab] = useState('profile');
  const [adding, setAdding] = useState(false);
  const atLimit = members.filter(item => item.authority !== 'leader').length >= maxMembers;
  const member = members.find(item => item.id === selected) || members[0];
  return <main className="work-area members-page" id="main-content" tabIndex={-1}>
    <div className="page-heading"><div><span className="eyebrow">それぞれの個性を、大切に。</span><h1>メンバー</h1><p>話し方、記憶、見た目。ひとりずつ、少しずつ。</p></div><div className="member-heading-actions"><span className="quiet-count">{members.length}人の仲間</span><button className="button primary" onClick={() => setAdding(true)}><PlusIcon size={17} />メンバー追加</button></div></div>
    <div className="members-layout"><div className="member-list" aria-label="メンバー一覧">{members.map(item => <button key={item.id} className={`member-list-row ${item.id === member.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)} aria-pressed={item.id === member.id}><Avatar member={item} size={64} /><span><strong>{item.name}{item.authority === 'leader' ? <span className="role-label">リーダー</span> : null}</strong><small>{item.role}</small><StatusLabel member={item} paused={paused} showDescription={false} /></span><ChevronRightIcon size={17} /></button>)}</div>
      <section className="member-detail" aria-label={`${member.name}の詳細`}><div className="member-detail-top"><Avatar member={member} size={76} /><div><h2>{member.name}</h2><span className="muted">{member.role}</span></div><button className="button secondary" onClick={() => onDM(member.id)}><ChatIcon size={18} />個別に話す</button></div>
        <Segmented label="メンバーの情報" className="detail-tabs" options={[{ value: 'profile', label: 'プロフィール' }, { value: 'memory', label: '記憶' }, { value: 'appearance', label: '見た目' }]} value={tab} onChange={setTab} />
        <div className="member-detail-scroll" key={`${member.id}-${tab}`}>
        {tab === 'profile' ? <Profile key={member.id} member={member} onSave={patch => onUpdate(member.id, patch)} /> : null}
        {tab === 'memory' ? <MemoryList key={member.id} member={member} memories={memories.filter(item => item.member === member.id)} onSave={onSaveMemory} onDelete={onDeleteMemory} /> : null}
        {tab === 'appearance' ? <AppearanceEditor key={member.id} member={member} onSave={patch => onUpdate(member.id, patch)} /> : null}
        </div>
      </section>
    </div>
    {adding ? <AddMemberModal atLimit={atLimit} maxMembers={maxMembers} onClose={() => setAdding(false)} onAdd={async draft => { const error = await onAdd(draft); if (!error) { setAdding(false); setTab('profile'); } return error; }} /> : null}
  </main>;
}

function Profile({ member, onSave }) {
  const [draft, setDraft] = useState(member);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState([]); const [modelError, setModelError] = useState('');
  const key = item => `${item.provider}:${item.model}`;
  const choices = [{ ...member, supported_efforts: [member.effort] }, ...models.filter(item => key(item) !== key(member))];
  const efforts = draft.provider === 'ollama' ? ['native'] : models.find(item => key(item) === key(draft))?.supported_efforts || [draft.effort];
  async function load(provider) {
    try {
      const values = await api(provider === 'ollama' ? '/models' : '/subscription/models');
      setModels(current => [...current.filter(item => item.provider !== provider), ...values.map(item => ({ ...item, provider, model: item.model || item.model_id }))]); setModelError('');
    } catch (error) { setModelError(error.message); }
  }
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); };
  return <form className="profile-form form-stack" onSubmit={async e => { e.preventDefault(); if (draft.name.trim()) { const ok = await onSave({ name: draft.name.trim(), role: draft.role.trim(), persona: draft.persona, model: draft.model, effort: draft.effort, provider: draft.provider }); setSaved(ok); } }}>
    <div className="field-pair"><label className="field"><span>名前</span><input value={draft.name} onChange={e => change('name', e.target.value)} maxLength={20} required /></label><label className="field"><span>役割</span><input value={draft.role} onChange={e => change('role', e.target.value)} maxLength={40} /></label></div>
    <label className="field"><span>性格と話し方</span><textarea rows={5} value={draft.persona} onChange={e => change('persona', e.target.value)} /></label>
    <div className="interest-block"><span className="field-label">気になっていること</span><div className="interest-tags">{member.interests.map(interest => <span key={interest}>{interest}</span>)}</div></div>
    <div className="form-section-label">このBotのモデル</div>
    <div className="field-pair"><label className="field"><span>モデル</span><select aria-label="モデル" value={key(draft)} onChange={e => { const model = choices.find(item => key(item) === e.target.value); setDraft(current => ({ ...current, provider: model.provider, model: model.model, effort: model.provider === 'ollama' ? 'native' : model.default_effort || model.supported_efforts?.[0] || member.effort })); setSaved(false); }}>{choices.map(item => <option key={key(item)} value={key(item)}>{item.model} · {item.provider === 'ollama' ? 'Ollama' : 'Codex'}</option>)}</select></label><label className="field"><span>推論の強さ</span><select aria-label="推論の強さ" value={draft.effort} disabled={draft.provider === 'ollama'} onChange={e => change('effort', e.target.value)}>{efforts.map(value => <option key={value}>{value}</option>)}</select></label></div>
    <div className="inline-actions"><button type="button" className="button subtle" onClick={() => load('ollama')}>Ollamaのモデル一覧を取得</button><button type="button" className="button subtle" onClick={() => load('openai_subscription')}>Codexのモデル一覧を取得</button></div>{modelError ? <p role="alert">{modelError}</p> : null}
    <p className="field-hint">モデルを変えても、人格と記憶は引き継ぎます。</p>
    <div className="form-actions"><span className="saved-inline" role="status">{saved ? <><CheckIcon size={16} />保存しました</> : null}</span><button className="button primary" disabled={!draft.name.trim()}>変更を保存</button></div>
  </form>;
}

function MemoryList({ member, memories, onSave, onDelete }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [history, setHistory] = useState(null);
  const selectedHistory = memories.find(item => item.id === history);
  const visible = memories.filter(item => `${item.kind} ${item.text}`.includes(query));
  return <div className="memory-view">
    <div className="privacy-note"><LockIcon size={20} /><div><strong>{member.name}だけの記憶</strong><p>この記憶を見られるのは、{member.name}とあなたです。</p></div></div>
    <div className="search-field"><SearchIcon size={18} /><input type="search" aria-label={`${member.name}の記憶を検索`} placeholder="記憶を検索" value={query} onChange={e => setQuery(e.target.value)} />{query ? <IconButton label="記憶の検索をクリア" onClick={() => setQuery('')}><CloseIcon size={16} /></IconButton> : null}</div>
    <div className="memory-count">{visible.length}件の記憶</div>
    {visible.length ? <div className="memory-list">{visible.map(item => <article key={item.id} className="memory-item"><div className="memory-item-meta"><span>{item.kind}</span><time>{item.date}</time></div><p>{item.text}</p><div className="memory-item-bottom">{item.revision > 1 ? <button className="text-button revision-link" onClick={() => setHistory(item.id)}>あなたによる訂正 · {item.revision - 1}回</button> : <span />}
      <div className="memory-actions"><IconButton label={`記憶を訂正：${item.text.slice(0, 16)}`} onClick={() => setEditing(item)}><EditIcon size={18} /></IconButton><IconButton label={`記憶を削除：${item.text.slice(0, 16)}`} onClick={() => setDeleting(item)}><TrashIcon size={18} /></IconButton></div></div></article>)}</div> : <EmptyState icon={MemoryIcon} title={query ? '一致する記憶がありません' : 'まだ記憶がありません'}>{query ? '別の言葉で探してみてください。' : '会話や経験を通じて、少しずつ増えていきます。'}</EmptyState>}
    {editing ? <MemoryEditModal memory={editing} member={member} onClose={() => setEditing(null)} onSave={async text => { if (await onSave(editing.id, text)) setEditing(null); }} /> : null}
    {deleting ? <Modal title="この記憶を削除しますか？" onClose={() => setDeleting(null)}><div className="modal-body"><p className="muted">{member.name}の記憶から、この内容を取り除きます。</p><blockquote className="delete-preview">{deleting.text}</blockquote></div><div className="form-actions"><button className="button subtle" onClick={() => setDeleting(null)}>キャンセル</button><button className="button danger" onClick={async () => { if (await onDelete(deleting.id)) setDeleting(null); }}>記憶を削除</button></div></Modal> : null}
    {selectedHistory ? <MemoryHistory member={member} memory={selectedHistory} onClose={() => setHistory(null)} /> : null}
  </div>;
}

function MemoryEditModal({ memory, member, onSave, onClose }) {
  const [text, setText] = useState(memory.text);
  return <Modal title="記憶を訂正" onClose={onClose}><form onSubmit={e => { e.preventDefault(); if (text.trim()) onSave(text.trim()); }}><div className="modal-body form-stack"><p className="muted">{member.name}の記憶に、あなたによる訂正として記録します。</p><label className="field"><span>記憶の内容</span><textarea rows={6} value={text} onChange={e => setText(e.target.value)} autoFocus required /></label></div><div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>キャンセル</button><button className="button primary" disabled={!text.trim()}>訂正を保存</button></div></form></Modal>;
}


function AddMemberModal({ onClose, onAdd, atLimit, maxMembers }) {
  const [draft, setDraft] = useState({ name: '', role: '', persona: '', motion: 'none', shape: 'pebble', color: '#61B8A5' });
  const [error, setError] = useState('');
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setError(''); };
  return <Modal title="メンバーを追加" onClose={onClose}><form onSubmit={async e => { e.preventDefault(); if (!atLimit && draft.name.trim()) setError(await onAdd({ ...draft, persona: draft.persona.trim() }) || ''); }}>
    <div className="modal-body form-stack">
      <p className="field-hint">指定内容をもとにリーダーへ追加を依頼します。生成結果は会話で確認できます。</p>
      {atLimit ? <p className="field-error" role="alert">生成メンバーの上限（{maxMembers}体）に達しています。休眠中も数に含みます。設定の「活動と人数」を確認してください。</p> : null}
      <div className="field-pair"><label className="field"><span>名前</span><input autoFocus required maxLength={20} value={draft.name} onChange={e => change('name', e.target.value)} placeholder="新しい仲間の名前" /></label><label className="field"><span>役割</span><input maxLength={40} value={draft.role} onChange={e => change('role', e.target.value)} placeholder="例：調べる・まとめる" /></label></div>
      <label className="field"><span>性格と話し方</span><textarea rows={3} maxLength={2000} value={draft.persona} onChange={e => change('persona', e.target.value)} placeholder="どんな仲間にしたいですか？" /></label>
      <div className="new-member-appearance"><Avatar shape={draft.shape} color={draft.color} motion={draft.motion} size={54} /><label className="field"><span>かたち</span><select value={draft.shape} onChange={e => change('shape', e.target.value)}>{SHAPES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>カラー</span><input type="color" value={draft.color} onChange={e => change('color', e.target.value)} /></label></div>
      <fieldset><legend>動き</legend><MotionPicker value={draft.motion} onChange={value => change('motion', value)} /></fieldset>
      <p className="field-hint">モデルは「新しいBotの標準モデル」を使用します。見た目やプロフィールは追加後も変更できます。</p>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
    <div className="form-actions"><button type="button" className="button subtle" onClick={onClose}>キャンセル</button><button className="button primary" disabled={atLimit || !draft.name.trim()}>追加する</button></div>
  </form></Modal>;
}
