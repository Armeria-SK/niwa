import { useEffect, useRef, useState } from 'react';
import { Modal } from './components.jsx';
import { FileIcon, DownloadIcon } from './icons.jsx';
import { api } from './api.js';

export function WorkspaceFiles({ onClose }) {
  const [path, setPath] = useState(''); const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null); const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const request = useRef(0);
  async function load() {
    const id = ++request.current; setBusy(true); setError(''); setFile(null);
    try { const result = await api(`/workspace/files?path=${encodeURIComponent(path)}`); if (id === request.current) setListing(result); }
    catch (error) { if (id === request.current) { setListing(null); setError(error.message); } }
    finally { if (id === request.current) setBusy(false); }
  }
  useEffect(() => { setListing(null); setQuery(''); void load(); return () => { request.current++; }; }, [path]);
  async function open(name) {
    const id = ++request.current; setBusy(true); setError('');
    try {
      const result = await api(`/workspace/file?path=${encodeURIComponent([path, name].filter(Boolean).join('/'))}`);
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      let content = null;
      if (bytes.length <= 65536) {
        try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!decoded.includes('\0')) content = decoded; } catch { /* Binary files remain downloadable. */ }
      }
      if (id === request.current) setFile({ name, bytes, content });
    } catch (error) { if (id === request.current) setError(`${error.message} ダウンロードは8MBまでです。`); }
    finally { if (id === request.current) setBusy(false); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const entries = [...(listing?.entries || [])].filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ja') : a.kind === 'directory' ? -1 : 1));
  return <Modal title="共有フォルダー" onClose={onClose} className="artifact-modal"><div className="modal-body">
    <div className="inline-actions"><button className="button secondary" disabled={busy || (!path && !file)} onClick={() => file ? setFile(null) : setPath(path.split('/').slice(0, -1).join('/'))}>戻る</button><button className="button subtle" disabled={busy} onClick={load}>再読み込み</button></div>
    <p className="muted">共有フォルダー{path ? ` / ${path}` : ''}{file ? ` / ${file.name}` : ''}</p>
    {busy ? <p role="status">ファイルを確認しています…</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {listing?.available === false ? <p>共有ファイルサービスは未接続です。本体の接続設定を確認してください。</p> : file ? <>
      <p className="field-hint">{file.bytes.length.toLocaleString()}バイト</p>
      {file.content === null ? <p>この形式・サイズのプレビューには対応していません。ダウンロードして確認できます。</p> : <pre className="artifact-document">{file.content}</pre>}
    </> : listing?.available ? <><label className="field"><span>このフォルダーを検索</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="artifact-grid">{entries.map(entry => <article className="artifact-card" key={entry.name}><div className="artifact-card-meta"><FileIcon size={24} /><span>{entry.kind === 'directory' ? 'フォルダー' : 'ファイル'}</span></div><button className="artifact-title" disabled={busy} onClick={() => entry.kind === 'directory' ? setPath([path, entry.name].filter(Boolean).join('/')) : open(entry.name)}>{entry.name}</button></article>)}</div>
      {!entries.length ? <p>表示するファイルがありません。</p> : null}
      {listing.truncated ? <p className="field-hint">件数が多いため一覧を一部に制限しています。</p> : null}
    </> : null}
    <p className="field-hint">全Botの共有作業ファイルです。ダウンロードは8MBまで、本文プレビューはUTF-8の64KBまでです。</p>
  </div><div className="form-actions"><button className="button subtle" onClick={onClose}>閉じる</button>{file ? <button className="button primary" disabled={busy} onClick={download}><DownloadIcon size={17} />ダウンロード</button> : null}</div></Modal>;
}
