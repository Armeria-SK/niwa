import {Markdown} from '../Markdown.jsx';
import {artifactGroups,documentName,kindLabel,qualityLabel} from '../artifact-display.js';
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
    {visible.length ? <div className="update-list">{visible.map(({item,latest,versions,matches}) => <article className={`update-item ${seen[item.id] ? 'is-read' : ''}`} key={item.id}><Avatar member={members[item.member]} size={36} /><div><div className="update-meta"><span>{({ done: '完成', decision: '決定', question: 'あなたへの質問' })[item.kind]}</span><time>{item.time}</time>{seen[item.id] ? <span>確認済み</span> : null}</div><h3>{item.title}</h3><p>{item.detail}</p><div className="inline-actions">{item.artifact ? <button className="text-button" onClick={() => onArtifact(item.artifact)}><FileIcon size={16} />成果物を見る</button> : null}{item.activity ? <button className="text-button" onClick={() => onActivity(item.activity)}>仕事を確認</button> : null}{item.thread ? <button className="text-button" onClick={() => onThread(item.thread)}><ChatIcon size={16} />元の会話</button> : null}{!seen[item.id] ? <button className="text-button" onClick={() => onRead([item.id])}>確認済みにする</button> : null}</div></div></article>)}</div> : <EmptyState icon={CheckCircleIcon} title="新しいできごとはありません">次の報告が届くと、ここに表示されます。</EmptyState>}
  </section>;
}

export function ArtifactLibrary({ onDelete, artifacts, members, onOpen, onThread }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [quality,setQuality]=useState(null),[qualityError,setQualityError]=useState(''),[qualityBusy,setQualityBusy]=useState(false);
  useEffect(()=>{let active=true;api('/quality').then(data=>{if(active)setQuality(data);}).catch(e=>{if(active)setQualityError(e.message);});return()=>{active=false;};},[]);
  async function changeQuality(enabled){setQualityBusy(true);try{await api('/quality','PATCH',{enabled});setQuality({enabled});setQualityError('');}catch(e){setQualityError(e.message);}finally{setQualityBusy(false);}}
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
  const groups=artifactGroups(artifacts);
  const matches=item=>(kind==='all'||item.kind===kind)&&(owner==='all'||item.member===owner)&&(!search||current?.ids?.has(item.id)||`${item.name} ${item.description} ${members[item.member]?.name}`.toLowerCase().includes(search.toLowerCase()));
  const visible=groups.map(group=>({...group,matches:(search?group.versions:[group.latest]).filter(matches)})).filter(group=>group.matches.length).map(group=>({...group,item:search?group.matches[0]:group.latest}));
  return <section>
    <details className="artifact-quality-setting"><summary>成果物の品質確認</summary>{quality?<label className="read-toggle"><input type="checkbox" checked={quality.enabled} disabled={qualityBusy} onChange={e=>changeQuality(e.target.checked)}/>重要な成果物に完成条件と証拠を付ける</label>:null}<p className="muted">新しい仕事から利用します。軽い会話にはレビュー待ちを追加しません。</p>{qualityError?<p role="status">{qualityError}</p>:null}</details>{workspaceOpen ? <WorkspaceFiles onClose={() => setWorkspaceOpen(false)} /> : null}<div className="section-toolbar"><div><h2>成果物</h2><p className="muted">みんなが作ったものを、ここから。</p></div><div className="inline-actions"><span className="muted">{visible.length}件</span><button className="button secondary" onClick={() => setWorkspaceOpen(true)}>共有フォルダー</button></div></div>
    <div className="artifact-filters"><div className="search-field"><SearchIcon size={18} /><input type="search" aria-label="成果物を検索" placeholder="名前や内容で検索" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} /></div><label className="field"><span>作成者</span><select aria-label="作成者" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">全員</option>{Object.values(members).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <Segmented label="成果物の種類" value={kind} onChange={setKind} options={[{ value: 'all', label: 'すべて' }, ...[...new Set(artifacts.map(item => item.kind))].map(value => ({ value, label: kindLabel(value) }))]} />
    {pending ? <p role="status">検索中…</p> : current?.error ? <p role="alert">本文検索に失敗しました。{current.error}</p> : null}
    {visible.length ? <div className="artifact-grid">{visible.map(({item,latest,versions,matches}) => <article className="artifact-card" key={item.id}><div className="artifact-card-meta"><FileIcon size={25} /><span>{kindLabel(item.kind)} · {item.scope === 'shared' ? '共有' : '個別'}</span></div><button className="artifact-title" onClick={() => onOpen(item.id)}>{documentName(item.name)}</button><div className="artifact-version-badges"><span>第{item.version||1}版{item.id===latest.id?' · 最新版':' · 過去版の検索一致'}</span><span>{qualityLabel(item.quality_status)}</span></div><p>{item.description}</p><details><summary>版の履歴（{versions.length}版）</summary>{versions.map(version=><p key={version.id}><button className="text-button" onClick={()=>onOpen(version.id)}>第{version.version||1}版{version.id===latest.id?'（最新版）':''} · {qualityLabel(version.quality_status)}{search&&matches.some(m=>m.id===version.id)?' · 検索一致':''}</button></p>)}</details><div className="artifact-owner"><Avatar member={members[item.member]} size={24} /><span>{members[item.member]?.name}</span><time>{item.updated}</time></div><div className="inline-actions"><button className="button secondary" onClick={() => onOpen(item.id)}>開く</button><button className="text-button" onClick={() => onThread(item.thread)}>関連する会話</button><button className="text-button" onClick={() => onDelete(item.id)} aria-label={`${item.name}を削除`}>削除</button></div></article>)}</div> : pending || current?.error ? null : <EmptyState icon={SearchIcon} title="一致する成果物がありません" action={<button className="text-button" onClick={() => { setQuery(''); setKind('all'); setOwner('all'); }}>条件をクリア</button>}>検索する言葉や作成者を変えてみてください。</EmptyState>}
  </section>;
}

export function ArtifactPreview({ onDelete, artifact, members, onClose, onThread, onOpen }) {
  const [checks,setChecks]=useState({});const [raw,setRaw]=useState(false);
  useEffect(()=>setChecks({}),[artifact.id]);
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function record(action,verdict) {
    if(busy)return;setBusy(true);setError('');
    try {await api(`/artifacts/${artifact.id}/${action}`,'POST',{expected_sha256:artifact.sha256,...(action==='review'?{verdict,note,...(artifact.quality?{checks:artifact.quality.plan.criteria.map(c=>({criterion:c.id,verdict:checks[c.id]?.verdict||'unknown',note:checks[c.id]?.note||''}))}:{})}: {})});await onOpen(artifact.id);setNote('');}
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
  return <Modal title={`${documentName(artifact.name)} · 第${artifact.version||1}版`} onClose={onClose} className="artifact-modal"><div className="modal-body"><p className="muted">{members[artifact.member || artifact.author_id]?.name} · 更新 {artifact.updated || new Date(artifact.created_at).toLocaleString('ja-JP')} · {artifact.scope === 'shared' ? '共有' : '個別'}</p>
    {artifact.sha256 ? <div className="form-stack artifact-version-info"><p>第{artifact.version}版{artifact.versions[0]?.id===artifact.id?'（最新版）':'（過去版）'} · {qualityLabel(artifact.quality_status)} · {artifact.frozen?'凍結済み':'未凍結'} · 参照する依頼 {artifact.referenced_by.length}件</p>
      {artifact.quality?<div className="artifact-quality-summary"><p>{artifact.quality.verified?'この版の証拠と内容の確認が揃っています':'未確認・未解決の条件があります'}</p><details><summary>完成条件（{artifact.quality.plan.criteria.length}件）</summary>{artifact.quality.plan.criteria.map(c=><p key={c.id}>{c.condition} · {({source:'出所との照合',execution:'実行結果',review:'内容の判断'})[c.kind]}</p>)}</details><details><summary>何を確認したか・未確認点</summary>{artifact.quality.evidence.length?artifact.quality.evidence.map(e=><div key={e.id}><p>{({execution:'実行サービスの結果',source:'資料取得と原文照合',self_report:'自己申告',unverified_result:'未検証の結果'})[e.kind]}：{({passed:'実行成功',failed:'失敗',retrieved:'取得済み（主張の正しさは別）',wrong_version:'対象の版が一致しません',not_executed:'未実行',unknown:'結果不明',unavailable:'検証不能',unverifiable:'固定環境の証拠なし'})[e.result]||e.result}</p><p>方法：{e.method}</p>{e.claim?<p>主張：{e.claim}</p>:null}{e.excerpt?<blockquote>{e.excerpt}</blockquote>:null}<p>内容の判断：{({supports:'支持すると判断',contradicts:'矛盾あり',uncertain:'未確認'})[e.assessment]} · 限界：{e.limits||'未記載'}</p><details><summary>出所・実行環境の詳細</summary><p>{e.url||''}</p>{e.source?<p>保存済み出所：{e.source.kind} · {e.source.source_id}<br/>出所の版：{e.source.revision}</p>:null}{e.command_sha256?<p>実行コマンドの照合値：{e.command_sha256}</p>:null}<p>{e.executed_at||e.fetched_at||new Date(e.created_at).toLocaleString('ja-JP')}</p>{e.image?<p>image：{e.image}<br/>環境版：{e.environment||'基本環境'}</p>:null}<p>対象SHA-256：{e.sha256}</p></details></div>):<p>証拠はまだ登録されていません。</p>}<p>レビューの終了条件：{artifact.quality.plan.stop_condition}</p></details></div>:null}
      <details><summary>版・確認記録</summary><p>保存名：{artifact.name}（名前内のv表記は手入力です。正式な版番号は上記表示を参照してください。）</p><p>固定ID：{artifact.id}<br/>SHA-256：{artifact.sha256}</p>
        {artifact.versions.map(version=><p key={version.id}><button className="text-button" disabled={version.id===artifact.id} onClick={()=>onOpen(version.id)}>第{version.version}版{version.id===artifact.id?'（表示中）':''}</button> · {new Date(version.created_at).toLocaleString('ja-JP')}{version.frozen?' · 凍結済み':''} · {qualityLabel(version.quality_status)}</p>)}
        {artifact.reviews.length ? artifact.reviews.map(review=><p key={review.reviewer_id}>{review.reviewer_id==='administrator'?'管理者':members[review.reviewer_id]?.name || '削除済みBot'}：{review.verdict==='approved'?(artifact.quality&&review.evidence_revision!==artifact.quality.revision?'旧証拠への内容判断':'内容の確認済み'):'要修正'} · {new Date(review.created_at).toLocaleString('ja-JP')}<br/>{review.review_model&&review.review_model!=='administrator'?`モデルによる内容判断（${review.review_model}）`:'確認者による内容判断'}<br/>{review.note}{review.checks?JSON.parse(review.checks).map(check=><span key={check.criterion}><br/>{artifact.quality?.plan.criteria.find(c=>c.id===check.criterion)?.condition||'完成条件'}：{({pass:'条件を満たす',fail:'要修正',unknown:'未確認'})[check.verdict]} — {check.note}</span>):null}</p>) : <p>内容の確認記録はありません。</p>}
        <form className="form-stack" onSubmit={e=>{e.preventDefault();void record('review','approved');}}><label className="field"><span>この版の確認メモ</span><textarea value={note} onChange={e=>setNote(e.target.value)} required maxLength={1000} rows={2}/></label>{artifact.quality?.plan.criteria.map(c=><fieldset className="form-stack" key={c.id}><legend>{c.condition}</legend><label className="field"><span>判断</span><select value={checks[c.id]?.verdict||'unknown'} onChange={e=>setChecks(v=>({...v,[c.id]:{...v[c.id],verdict:e.target.value}}))}><option value="unknown">未確認</option><option value="pass">条件を満たす</option><option value="fail">要修正</option></select></label><label className="field"><span>確認した内容・具体的な欠陥</span><textarea rows={2} required minLength={12} maxLength={1000} value={checks[c.id]?.note||''} onChange={e=>setChecks(v=>({...v,[c.id]:{...v[c.id],note:e.target.value}}))}/></label></fieldset>)}<div className="inline-actions"><button className="button secondary" disabled={busy || !note.trim()}>確認済みとして記録</button><button type="button" className="button subtle" disabled={busy || !note.trim()} onClick={()=>record('review','changes_requested')}>要修正として記録</button></div></form>
        <p className="muted">内容の確認記録です。外部操作の実行を承認するものではありません。凍結すると、この版からの改訂はできません。</p>
        {!artifact.frozen ? <button className="button secondary" disabled={busy || (artifact.quality&&!artifact.quality.verified) || !artifact.reviews.some(item=>item.verdict==='approved') || artifact.reviews.some(item=>item.verdict==='changes_requested')} onClick={()=>record('freeze')}>確認済みの版を凍結</button> : null}
      </details>{error ? <p role="alert">{error}</p> : null}
    </div> : null}{artifact.file?<p>固定ファイル · {artifact.file.size.toLocaleString()}バイト。ファイル本体は通常バックアップに含まれません。{!artifact.file.available?'復元後のため取得できません。':''}</p>:<div className="artifact-document-view"><label className="read-toggle"><input type="checkbox" checked={raw} onChange={e=>setRaw(e.target.checked)}/>原文を表示</label>{raw||['code','csv','json'].includes(artifact.kind)?<pre className="artifact-document">{artifact.content}</pre>:<Markdown text={artifact.content}/>}</div>}</div><div className="form-actions"><button className="button subtle" onClick={() => { onClose(); onThread(artifact.thread || artifact.room_id); }}>関連する会話</button><button className="button subtle" onClick={onDelete}>この版を削除</button><button className="button primary" disabled={busy||artifact.file?.available===0} onClick={download}><DownloadIcon size={17} />ダウンロード</button></div></Modal>;
}
