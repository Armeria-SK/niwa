import { useState } from 'react';
import { Avatar, EmptyState, Modal, Segmented } from '../components.jsx';
import { CheckCircleIcon, FileIcon, SearchIcon, DownloadIcon, ChatIcon } from '../icons.jsx';

export function Recap({ updates, seen, onRead, members, onThread, onArtifact, onActivity }) {
  const [showRead, setShowRead] = useState(false);
  const unread = updates.filter(item => !seen[item.id]);
  const visible = showRead ? updates : unread;
  return <section className="recap-view">
    <div className="section-toolbar"><div><h2>前回からのできごと</h2><p className="muted">完成したもの、決まったこと、あなたへの質問。</p></div><button className="button secondary" disabled={!unread.length} onClick={() => onRead(unread.map(item => item.id))}>すべて確認済みにする</button></div>
    <div className="recap-counts" aria-label="未確認のできごと">{[['done', '完成'], ['decision', '決定'], ['question', 'あなたへの質問']].map(([kind, label]) => <span key={kind}>{label}<strong>{unread.filter(item => item.kind === kind).length}</strong></span>)}</div>
    <label className="read-toggle"><input type="checkbox" checked={showRead} onChange={e => setShowRead(e.target.checked)} />確認済みも見る</label>
    {visible.length ? <div className="update-list">{visible.map(item => <article className={`update-item ${seen[item.id] ? 'is-read' : ''}`} key={item.id}><Avatar member={members[item.member]} size={36} /><div><div className="update-meta"><span>{({ done: '完成', decision: '決定', question: 'あなたへの質問' })[item.kind]}</span><time>{item.time}</time>{seen[item.id] ? <span>確認済み</span> : null}</div><h3>{item.title}</h3><p>{item.detail}</p><div className="inline-actions">{item.artifact ? <button className="text-button" onClick={() => onArtifact(item.artifact)}><FileIcon size={16} />成果物を見る</button> : null}{item.activity ? <button className="text-button" onClick={() => onActivity(item.activity)}>仕事を確認</button> : null}{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}><ChatIcon size={16} />元の会話</button> : null}{!seen[item.id] ? <button className="text-button" onClick={() => onRead([item.id])}>確認済みにする</button> : null}</div></div></article>)}</div> : <EmptyState icon={CheckCircleIcon} title="新しいできごとはありません">次の報告が届くと、ここに表示されます。</EmptyState>}
  </section>;
}

export function ArtifactLibrary({ artifacts, members, onOpen, onThread }) {
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('all'); const [owner, setOwner] = useState('all');
  const visible = artifacts.filter(item => (kind === 'all' || item.kind === kind) && (owner === 'all' || item.member === owner) && `${item.name} ${item.description} ${members[item.member]?.name}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.created_at - a.created_at);
  return <section><div className="section-toolbar"><div><h2>成果物</h2><p className="muted">みんなが作ったものを、ここから。</p></div><span className="muted">{visible.length}件</span></div>
    <div className="artifact-filters"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label="成果物を検索" placeholder="名前や内容で検索" value={query} onChange={e => setQuery(e.target.value)} /></div><label className="field"><span>作成者</span><select aria-label="作成者" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">全員</option>{Object.values(members).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <Segmented label="成果物の種類" value={kind} onChange={setKind} options={[{ value: 'all', label: 'すべて' }, ...[...new Set(artifacts.map(item => item.kind))].map(value => ({ value, label: value }))]} />
    {visible.length ? <div className="artifact-grid">{visible.map(item => <article className="artifact-card" key={item.id}><div className="artifact-card-meta"><FileIcon size={25} /><span>{item.kind} · {item.scope === 'shared' ? '共有' : '個別'}</span></div><button className="artifact-title" onClick={() => onOpen(item.id)}>{item.name}</button><p>{item.description}</p><div className="artifact-owner"><Avatar member={members[item.member]} size={24} /><span>{members[item.member]?.name}</span><time>{item.updated}</time></div><div className="inline-actions"><button className="button secondary" onClick={() => onOpen(item.id)}>開く</button><button className="text-button" onClick={() => onThread(item.thread)}>関連する会話</button></div></article>)}</div> : <EmptyState icon={SearchIcon} title="一致する成果物がありません" action={<button className="text-button" onClick={() => { setQuery(''); setKind('all'); setOwner('all'); }}>条件をクリア</button>}>検索する言葉や作成者を変えてみてください。</EmptyState>}
  </section>;
}

export function ArtifactPreview({ artifact, members, onClose, onThread }) {
  function download() { const url = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = artifact.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <Modal title={artifact.name} onClose={onClose} className="artifact-modal"><div className="modal-body"><p className="muted">{members[artifact.member]?.name} · 更新 {artifact.updated} · {artifact.scope === 'shared' ? '共有' : '個別'}</p><pre className="artifact-document">{artifact.content}</pre></div><div className="form-actions"><button className="button subtle" onClick={() => { onClose(); onThread(artifact.thread); }}>関連する会話</button><button className="button primary" onClick={download}><DownloadIcon size={17} />ダウンロード</button></div></Modal>;
}
