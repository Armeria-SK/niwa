import { useEffect, useRef, useState } from 'react';
import { Modal } from './components.jsx';
import { FileIcon, DownloadIcon } from './icons.jsx';
import { WorkareaSettings } from './WorkareaSettings.jsx';
import { api } from './api.js';

export function WorkspaceFiles({ onClose }) {
  const [path, setPath] = useState(''); const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null); const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [areas,setAreas]=useState(null),[area,setArea]=useState(''),[editing,setEditing]=useState(false),[draft,setDraft]=useState('');
  const endpoint=area?`/workareas/${area}`:'/workspace';
  const selected=areas?.areas.find(item=>item.id===area);
  const request = useRef(0);
  useEffect(()=>{let alive=true;api('/workareas').then(value=>{if(alive)setAreas(value);}).catch(()=>{});return()=>{alive=false;};},[]);
  async function load() {
    const id = ++request.current; setBusy(true); setError(''); setFile(null); setEditing(false);
    try { const result = await api(`${endpoint}/files?path=${encodeURIComponent(path)}`); if (id === request.current) setListing({...result,available:result.available!==false}); }
    catch (error) { if (id === request.current) { setListing(null); setError(error.message); } }
    finally { if (id === request.current) setBusy(false); }
  }
  useEffect(() => { setListing(null); setQuery(''); void load(); return () => { request.current++; }; }, [path,area]);
  async function open(name) {
    const id = ++request.current; setBusy(true); setError('');
    try {
      const result = await api(`${endpoint}/file?path=${encodeURIComponent([path, name].filter(Boolean).join('/'))}`);
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      const header = String.fromCharCode(...bytes.slice(0, 12));
      const mime = header.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
        : header.startsWith('\xff\xd8\xff') ? 'image/jpeg'
        : /^GIF8[79]a/.test(header) ? 'image/gif'
        : header.startsWith('RIFF') && header.slice(8) === 'WEBP' ? 'image/webp' : null;
      let content = null;
      if (bytes.length <= 65536) {
        try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!decoded.includes('\0')) content = decoded; } catch { /* Binary files remain downloadable. */ }
      }
      if (id === request.current) setFile({ name, bytes, content, revision:result.revision, image: mime ? `data:${mime};base64,${result.data}` : null });
    } catch (error) { if (id === request.current) setError(`${error.message} ダウンロードは8MBまでです。`); }
    finally { if (id === request.current) setBusy(false); }
  }
  async function save() {
    setBusy(true);setError('');
    try{const result=await api(`${endpoint}/file`,'PUT',{path:[path,file.name].filter(Boolean).join('/'),content:draft,expected_revision:file.revision});
      if(result.error)throw Error(result.error==='conflict'?'別の更新があります。入力内容を控え、再読み込みして確認してください。':'保存できませんでした。');
      setEditing(false);await open(file.name);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  function download() {
    const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const entries = [...(listing?.entries || [])].filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ja') : a.kind === 'directory' ? -1 : 1));
  return <Modal title="共有フォルダー" onClose={onClose} className="artifact-modal"><div className="modal-body form-stack">
    {areas?.available ? <WorkareaSettings value={areas} onChange={setAreas} area={area} onSelect={id=>{setPath('');setArea(id);}}/>:null}
    <div className="inline-actions"><button className="button secondary" disabled={busy || (!path && !file)} onClick={() => file ? setFile(null) : setPath(path.split('/').slice(0, -1).join('/'))}>戻る</button><button className="button subtle" disabled={busy} onClick={load}>再読み込み</button></div>
    <p className="muted">{selected?.name||'全員共有'}{path ? ` / ${path}` : ''}{file ? ` / ${file.name}` : ''}</p>
    {busy ? <p role="status">ファイルを確認しています…</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {listing?.available === false ? <p>共有ファイルサービスは未接続です。本体の接続設定を確認してください。</p> : file ? <>
      <p className="field-hint">{file.bytes.length.toLocaleString()}バイト</p>
      {editing ? <label className="field"><span>本文を編集</span><textarea rows={14} maxLength={20000} value={draft} onChange={e=>setDraft(e.target.value)}/></label> : file.image ? <img src={file.image} alt={file.name} style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh', margin: '0 auto', objectFit: 'contain' }} onError={() => setFile(current => current === file ? { ...current, image: null, content: null } : current)} />
        : file.content === null ? <p>この形式・サイズのプレビューには対応していません。ダウンロードして確認できます。</p> : <pre className="artifact-document">{file.content}</pre>}
    </> : listing?.available ? <><label className="field"><span>このフォルダーを検索</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="artifact-grid">{entries.map(entry => <button className="artifact-card workspace-entry" key={entry.name} disabled={busy} onClick={() => entry.kind === 'directory' ? setPath([path, entry.name].filter(Boolean).join('/')) : open(entry.name)}><span className="artifact-card-meta"><FileIcon size={24} /><span>{entry.kind === 'directory' ? 'フォルダー' : 'ファイル'}</span></span><span className="artifact-title">{entry.name}</span></button>)}</div>
      {!entries.length ? <p>表示するファイルがありません。</p> : null}
      {listing.truncated ? <p className="field-hint">件数が多いため一覧を一部に制限しています。</p> : null}
    </> : null}
    <p className="field-hint">{area?'選択した作業場所のファイルです。':'全Botの共有作業ファイルです。'}画像（PNG・JPEG・GIF・WebP）の表示とダウンロードは8MBまで、本文プレビューはUTF-8の64KBまでです。</p>
  <p className="field-hint">作業ファイル本体は通常バックアップの対象外です。必要なファイルは別途保管してください。個人領域は休眠・再招集で保持し、Bot削除時に削除します。案件と共有済み版は残します。</p>
  </div><div className="form-actions">{area&&file?.content!==null&&file ? editing?<button className="button primary" disabled={busy} onClick={save}>保存</button>:<button className="button secondary" disabled={busy||file.content.length>20000} onClick={()=>{setDraft(file.content);setEditing(true);}}>編集</button>:null}<button className="button subtle" onClick={onClose}>閉じる</button>{file ? <button className="button primary" disabled={busy} onClick={download}><DownloadIcon size={17} />ダウンロード</button> : null}</div></Modal>;
}
