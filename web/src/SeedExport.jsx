import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { DownloadIcon } from './icons.jsx';
import { privateNote, seedSummary } from './seed.js';

/** Botの「苗」を1つのJSONファイルに書き出す。保存する前に、保存する全文をそのまま見せる。 */
export function SeedExport({ member }) {
  const [options, setOptions] = useState(null), [error, setError] = useState('');
  const [procedures, setProcedures] = useState(new Set()), [memories, setMemories] = useState(new Set());
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api(`/agents/${member.id}/seed`).then(value => { if (active) { setOptions(value); setProcedures(new Set(value.procedures.map(item => item.id))); } }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [member.id]);
  // 選び直したら、前に見せた全文はもう保存するものと違うので消す。
  const toggle = (set, setter, id) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); setter(next); setPreview(null); };
  async function show() {
    setBusy(true); setError('');
    try { setPreview(await api(`/agents/${member.id}/seed`, 'POST', { procedures: [...procedures], memories: [...memories] })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function save() {
    const url = URL.createObjectURL(new Blob([preview.text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = preview.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (error && !options) return <p role="alert">{error}</p>;
  if (!options) return <p role="status">読み込んでいます…</p>;
  const note = privateNote(options.private_procedures, options.private_memories);
  return <section className="seed-export form-stack" aria-label={`${member.name}の苗の書き出し`}>
    <p className="field-hint"><Sentences>{`${member.name}の人格（名前・役割・人となり）と見た目、覚えた手順を、1つのファイル（JSON）に書き出します。会話・成果物・モデルの接続は入りません。秘密らしい文字は伏せます。保存する前に、保存する全文をここで見せます。`}</Sentences></p>
    <fieldset><legend>手順帳（{options.procedures.length}件）</legend>
      {options.procedures.length ? <ul className="seed-choices">{options.procedures.map(item => <li key={item.id}><label><input type="checkbox" checked={procedures.has(item.id)} onChange={() => toggle(procedures, setProcedures, item.id)} />{item.title || '題のない手順'}<small>{item.steps}手順{item.enabled ? '' : '・いまは使っていない'}</small></label></li>)}</ul> : <p className="field-hint">書き出せる手順はありません。</p>}
    </fieldset>
    <details className="seed-memories"><summary>記憶も入れる（既定では入れません）</summary>
      {options.memories.length ? <ul className="seed-choices">{options.memories.map(item => <li key={item.id}><label><input type="checkbox" checked={memories.has(item.id)} onChange={() => toggle(memories, setMemories, item.id)} />{item.body}</label></li>)}</ul> : <p className="field-hint">共有の会話から生まれた記憶はありません。</p>}
    </details>
    {note ? <p className="field-hint">{note}</p> : null}
    <div className="inline-actions"><button type="button" className="button secondary" disabled={busy} onClick={show}>{busy ? '作っています…' : '書き出す内容を見る'}</button><span className="muted">{seedSummary(procedures.size, memories.size)}</span></div>
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <div className="form-stack"><h3 className="small-heading">保存する全文（{preview.filename}）</h3><pre className="artifact-document seed-preview">{preview.text}</pre>
      <div className="inline-actions"><button type="button" className="button primary" onClick={save}><DownloadIcon size={17} />この内容で保存する</button></div></div> : null}
  </section>;
}
