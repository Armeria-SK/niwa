import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, EmptyState, Modal, Segmented } from '../components.jsx';
import { CheckCircleIcon, FileIcon, SearchIcon, DownloadIcon, ChatIcon } from '../icons.jsx';
import { WorkspaceFiles } from '../WorkspaceFiles.jsx';

export function Recap({ updates, seen, onRead, members, onThread, onArtifact, onActivity }) {
  const [showRead, setShowRead] = useState(false);
  const unread = updates.filter(item => !seen[item.id]);
  const visible = showRead ? updates : unread;
  return <section className="recap-view">
    <div className="section-toolbar"><div><h2>前回からのできごと</h2><p className="muted">話し合いで決まったことを、ここで確認できます。</p></div><button className="button secondary" disabled={!unread.length} onClick={() => onRead(unread.map(item => item.id))}>すべて確認済みにする</button></div>
    <div className="recap-counts" aria-label="未確認のできごと">{[['decision', '未確認の決定事項']].map(([kind, label]) => <span key={kind}>{label}<strong>{unread.filter(item => item.kind === kind).length}</strong></span>)}</div>
    <label className="read-toggle"><input type="checkbox" checked={showRead} onChange={e => setShowRead(e.target.checked)} />確認済みも見る</label>
    {visible.length ? <div className="update-list">{visible.map(item => <article className={`update-item ${seen[item.id] ? 'is-read' : ''}`} key={item.id}><Avatar member={members[item.member]} size={36} /><div><div className="update-meta"><span>{({ done: '完成', decision: '決定', question: 'あなたへの質問' })[item.kind]}</span><time>{item.time}</time>{seen[item.id] ? <span>確認済み</span> : null}</div><h3>{item.title}</h3><p>{item.detail}</p><div className="inline-actions">{item.artifact ? <button className="text-button" onClick={() => onArtifact(item.artifact)}><FileIcon size={16} />成果物を見る</button> : null}{item.activity ? <button className="text-button" onClick={() => onActivity(item.activity)}>仕事を確認</button> : null}{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}><ChatIcon size={16} />元の会話</button> : null}{!seen[item.id] ? <button className="text-button" onClick={() => onRead([item.id])}>確認済みにする</button> : null}</div></div></article>)}</div> : <EmptyState icon={CheckCircleIcon} title="新しいできごとはありません">次の報告が届くと、ここに表示されます。</EmptyState>}
  </section>;
}

export function ArtifactLibrary({ onDelete, artifacts, members, onOpen, onThread }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [query, setQuery] = useState(''); const [kind, setKind] = useState('all'); const [owner, setOwner] = useState('all');
  const search = query.trim(); const revision = artifacts.map(item => item.id).join(',');
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!search) return;
    let active = true;
    const timer = setTimeout(() => {
      api(`/artifacts?query=${encodeURIComponent(search)}`).then(items => {
        if (active) setResult({ search, revision, ids: new Set(items.map(item => item.id)) });
      }).catch(error => { if (active) setResult({ search, revision, error: error.message }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search, revision]);
  const current = result?.search === search && result?.revision === revision ? result : null;
  const pending = !!search && !current;
  const visible = artifacts.filter(item => (kind === 'all' || item.kind === kind) && (owner === 'all' || item.member === owner) && (!search || current?.ids?.has(item.id) || `${item.name} ${item.description} ${members[item.member]?.name}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => b.created_at - a.created_at);
  return <section>{workspaceOpen ? <WorkspaceFiles onClose={() => setWorkspaceOpen(false)} /> : null}<div className="section-toolbar"><div><h2>成果物</h2><p className="muted">みんなが作ったものを、ここから。</p></div><div className="inline-actions"><span className="muted">{visible.length}件</span><button className="button secondary" onClick={() => setWorkspaceOpen(true)}>共有フォルダー</button></div></div>
    <div className="artifact-filters"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label="成果物を検索" placeholder="名前や内容で検索" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} /></div><label className="field"><span>作成者</span><select aria-label="作成者" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">全員</option>{Object.values(members).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <Segmented label="成果物の種類" value={kind} onChange={setKind} options={[{ value: 'all', label: 'すべて' }, ...[...new Set(artifacts.map(item => item.kind))].map(value => ({ value, label: value }))]} />
    {pending ? <p role="status">検索中…</p> : current?.error ? <p role="alert">本文検索に失敗しました。{current.error}</p> : null}
    {visible.length ? <div className="artifact-grid">{visible.map(item => <article className="artifact-card" key={item.id}><div className="artifact-card-meta"><FileIcon size={25} /><span>{item.kind} · {item.scope === 'shared' ? '共有' : '個別'}</span></div><button className="artifact-title" onClick={() => onOpen(item.id)}>{item.name}</button><p>{item.description}</p><div className="artifact-owner"><Avatar member={members[item.member]} size={24} /><span>{members[item.member]?.name}</span><time>{item.updated}</time></div><div className="inline-actions"><button className="button secondary" onClick={() => onOpen(item.id)}>開く</button><button className="text-button" onClick={() => onThread(item.thread)}>関連する会話</button><button className="text-button" onClick={() => onDelete(item.id)} aria-label={`${item.name}を削除`}>削除</button></div></article>)}</div> : pending || current?.error ? null : <EmptyState icon={SearchIcon} title="一致する成果物がありません" action={<button className="text-button" onClick={() => { setQuery(''); setKind('all'); setOwner('all'); }}>条件をクリア</button>}>検索する言葉や作成者を変えてみてください。</EmptyState>}
  </section>;
}

export function ArtifactPreview({ onDelete, artifact, members, onClose, onThread, onOpen }) {
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function record(action,verdict) {
    if(busy)return;setBusy(true);setError('');
    try {await api(`/artifacts/${artifact.id}/${action}`,'POST',{expected_sha256:artifact.sha256,...(action==='review'?{verdict,note}: {})});await onOpen(artifact.id);setNote('');}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function download() {
    setBusy(true);setError('');
    try{const result=artifact.file?await api(`/artifacts/${artifact.id}/file`):null;
      const content=result?Uint8Array.from(atob(result.data),c=>c.charCodeAt(0)):artifact.content;
      const url=URL.createObjectURL(new Blob([content],{type:artifact.file?'application/octet-stream':'text/plain;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=artifact.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <Modal title={artifact.name} onClose={onClose} className="artifact-modal"><div className="modal-body"><p className="muted">{members[artifact.member || artifact.author_id]?.name} · 更新 {artifact.updated || new Date(artifact.created_at).toLocaleString('ja-JP')} · {artifact.scope === 'shared' ? '共有' : '個別'}</p>
    {artifact.sha256 ? <div className="form-stack artifact-version-info"><p>第{artifact.version}版 · {artifact.frozen?'凍結済み':'未凍結'} · 参照する依頼 {artifact.referenced_by.length}件</p>
      <details><summary>版・確認記録</summary><p>固定ID：{artifact.id}<br/>SHA-256：{artifact.sha256}</p>
        {artifact.versions.map(version=><p key={version.id}><button className="text-button" disabled={version.id===artifact.id} onClick={()=>onOpen(version.id)}>第{version.version}版{version.id===artifact.id?'（表示中）':''}</button> · {new Date(version.created_at).toLocaleString('ja-JP')}{version.frozen?' · 凍結済み':''}</p>)}
        {artifact.reviews.length ? artifact.reviews.map(review=><p key={review.reviewer_id}>{review.reviewer_id==='administrator'?'管理者':members[review.reviewer_id]?.name || '削除済みBot'}：{review.verdict==='approved'?'確認済み':'要修正'} · {new Date(review.created_at).toLocaleString('ja-JP')}<br/>{review.note}</p>) : <p>内容の確認記録はありません。</p>}
        <form className="form-stack" onSubmit={e=>{e.preventDefault();void record('review','approved');}}><label className="field"><span>この版の確認メモ</span><textarea value={note} onChange={e=>setNote(e.target.value)} required maxLength={1000} rows={2}/></label><div className="inline-actions"><button className="button secondary" disabled={busy || !note.trim()}>確認済みとして記録</button><button type="button" className="button subtle" disabled={busy || !note.trim()} onClick={()=>record('review','changes_requested')}>要修正として記録</button></div></form>
        <p className="muted">内容の確認記録です。外部操作の実行を承認するものではありません。凍結すると、この版からの改訂はできません。</p>
        {!artifact.frozen ? <button className="button secondary" disabled={busy || !artifact.reviews.some(item=>item.verdict==='approved') || artifact.reviews.some(item=>item.verdict==='changes_requested')} onClick={()=>record('freeze')}>確認済みの版を凍結</button> : null}
      </details>{error ? <p role="alert">{error}</p> : null}
    </div> : null}{artifact.file?<p>固定ファイル · {artifact.file.size.toLocaleString()}バイト。ファイル本体は通常バックアップに含まれません。{!artifact.file.available?'復元後のため取得できません。':''}</p>:<pre className="artifact-document">{artifact.content}</pre>}</div><div className="form-actions"><button className="button subtle" onClick={() => { onClose(); onThread(artifact.thread || artifact.room_id); }}>関連する会話</button><button className="button subtle" onClick={onDelete}>この版を削除</button><button className="button primary" disabled={busy||artifact.file?.available===0} onClick={download}><DownloadIcon size={17} />ダウンロード</button></div></Modal>;
}
