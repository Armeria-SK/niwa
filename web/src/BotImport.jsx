import { useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, Sentences } from './components.jsx';
import { appearanceText, BOT_FILE_MAX_LENGTH, hiddenNote, importPlan, limitNote, problemText } from './bot-file.js';

/** 書き出したファイルから、新しいBotを迎える。迎える前に、ファイルの全文と作られるものを見せ、押したときだけ迎える。 */
export function BotImport({ onImported }) {
  const [file, setFile] = useState(null), [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [include, setInclude] = useState({ procedures: true, memories: true });
  // 同じファイルと同じ選び方で押し直したときは、同じ依頼として送る（Botは1体だけ）。
  const request = useRef(null), input = useRef(null);
  function clear() { setFile(null); setPreview(null); setError(''); request.current = null; }
  // やめるときは、選んだファイルも外す。同じファイルを直してから選び直せる。
  function cancel() { clear(); if (input.current) input.current.value = ''; }
  async function choose(event) {
    const chosen = event.target.files?.[0];
    clear();
    if (!chosen) return;
    setBusy(true);
    try {
      const text = await chosen.text();
      if (text.length > BOT_FILE_MAX_LENGTH) { setPreview({ ok: false, problems: [{ kind: 'size', path: '' }] }); return; }
      const result = await api('/agents/import/preview', 'POST', { text });
      setFile({ name: chosen.name, text }); setPreview(result); setInclude({ procedures: true, memories: true });
    } catch { setError('ファイルを読めませんでした。Niwaで書き出したファイルか確かめてください。'); }
    finally { setBusy(false); }
  }
  async function welcome() {
    const key = JSON.stringify([file.text, include]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const made = await api('/agents/import', 'POST', { id: request.current.id, text: file.text, ...include });
      request.current = null;
      await onImported(made);
    } catch { setError('Botを迎えられませんでした。Botの数の上限と、ファイルの中身を確かめてください。'); }
    finally { setBusy(false); }
  }
  const atLimit = preview?.ok && Boolean(limitNote(preview.members, preview.limit));
  return <section className="bot-import form-stack" aria-label="Botの読み込み">
    <div><h2>Botの読み込み</h2><p className="field-hint"><Sentences>{'書き出したファイル（JSON）から、新しいBotを迎えます。迎える前に、ファイルの全文と、作られるものをここで見せます。今いるBotが書き換わることはありません。'}</Sentences></p></div>
    <label className="field"><span>Botのファイル（JSON）</span><input ref={input} type="file" accept="application/json,.json" disabled={busy} onChange={choose} /></label>
    {busy && !preview ? <p role="status">読み込んでいます…</p> : null}
    {error ? <p className="field-error" role="alert"><Sentences>{error}</Sentences></p> : null}
    {preview && !preview.ok ? <div role="alert"><p className="field-error">このファイルは読み込めません。</p><ul className="bot-import-list">{preview.problems.map(problem => <li key={`${problem.kind}${problem.path}`}>{problemText(problem)}</li>)}</ul></div> : null}
    {preview?.ok ? <>
      <h3 className="small-heading">作られるもの</h3>
      <div className="bot-import-who"><Avatar shape={preview.appearance.shape} color={preview.appearance.color} motion={preview.appearance.motion} size={64} /><div><strong>{preview.bot.name}</strong>{preview.bot.role ? <span className="muted">{preview.bot.role}</span> : null}<small>{appearanceText(preview.appearance)}</small></div></div>
      {preview.procedures.length || preview.memories ? <fieldset><legend>手順と記憶</legend><ul className="bot-file-choices">
        {preview.procedures.length ? <li><label><input type="checkbox" checked={include.procedures} disabled={busy} onChange={() => setInclude(current => ({ ...current, procedures: !current.procedures }))} />手順{preview.procedures.length}件も入れる<small>{preview.procedures.map(item => item.title).join('・')}</small></label></li> : null}
        {preview.memories ? <li><label><input type="checkbox" checked={include.memories} disabled={busy} onChange={() => setInclude(current => ({ ...current, memories: !current.memories }))} />記憶{preview.memories}件も入れる</label></li> : null}
      </ul></fieldset> : null}
      <ul className="bot-import-list">{importPlan(preview, include).map(line => <li key={line}>{line}</li>)}</ul>
      {hiddenNote(preview.hidden) ? <p className="field-hint"><Sentences>{hiddenNote(preview.hidden)}</Sentences></p> : null}
      {atLimit ? <p className="field-error" role="alert"><Sentences>{limitNote(preview.members, preview.limit)}</Sentences></p> : null}
      <h3 className="small-heading">ファイルの全文（{file.name}）</h3>
      <pre className="artifact-document bot-file-preview">{preview.text}</pre>
      <div className="form-actions"><button type="button" className="button subtle" disabled={busy} onClick={cancel}>やめる</button><button type="button" className="button primary" disabled={busy || atLimit} onClick={welcome}>{busy ? '迎えています…' : 'この内容で迎える'}</button></div>
    </> : null}
  </section>;
}
