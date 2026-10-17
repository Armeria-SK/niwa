import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { InfoIcon } from './icons.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { providerLabel } from './providers.js';
import { checkProviders, estimateLabel, failureText, modelCheckView, usedLabel } from './second-opinion.js';

/** 成果物の脇の欄に置く、別の会社のモデルによる点検。結果はモデルの意見として分けて見せ、凍結や品質の判定には使わない。 */
export function ModelCheck({ artifact, authorName, onChanged }) {
  const [estimate, setEstimate] = useState(null), [ready, setReady] = useState(null), [loadError, setLoadError] = useState('');
  const [selection, setSelection] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [used, setUsed] = useState(null);
  const asking = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || estimate) return undefined;
    let active = true;
    Promise.all([api(`/artifacts/${artifact.id}/model-check`), api('/model-ready')])
      .then(([value, providers]) => { if (active) { setEstimate(value); setReady(providers.providers); } })
      .catch(failure => { if (active) setLoadError(failure.message); });
    return () => { active = false; };
  }, [open, estimate, artifact.id]);
  useEffect(() => () => asking.current?.abort(), []);
  const criteria = artifact.quality?.plan.criteria || [];
  const checks = (artifact.model_checks || []).map(row => modelCheckView(row, criteria));
  const providers = estimate ? checkProviders(estimate.providers, ready || []) : [];
  async function run() {
    if (!selection || busy) return;
    setBusy(true); setError(''); setUsed(null);
    asking.current = new AbortController();
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}/model-check`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: asking.current.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_sha256: artifact.sha256, provider: selection.provider, model: selection.model, reasoning: selection.reasoning || 'native' }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error === 'conflict' ? 'この版は変わりました。最新の版を開き直してください。' : value.error === 'invalid' ? '作ったBotと同じ接続先のモデルは選べません。' : '点検を頼めませんでした。');
      setUsed(value.usage || null);
      if (value.failure) setError(failureText(value.failure)); else await onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); asking.current = null; }
  }
  return <section className="model-checks" aria-labelledby={`model-checks-${artifact.id}`}>
    <h3 id={`model-checks-${artifact.id}`}>モデルによる判断（証拠ではありません）</h3>
    <p className="model-check-note"><InfoIcon size={16} /><span><Sentences>別の会社のモデルが本文を読んで述べた意見です。実行や出典の照合はしていません。凍結や品質の判定には入りません。</Sentences></span></p>
    {checks.length ? checks.map(check => <div className="model-check" key={check.model + check.at}>
      <p><strong>{check.model}</strong> · {new Date(check.at).toLocaleString('ja-JP')}</p>
      {check.summary ? <p>{check.summary}</p> : null}
      <ul>{check.checks.map(item => <li key={item.criterion}>{item.condition}：<strong>{item.label}</strong> — {item.note}</li>)}</ul>
    </div>) : <p className="field-hint">まだ点検してもらっていません。</p>}
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>別の会社のモデルに点検してもらう</summary>
      <div className="form-stack">
        {loadError ? <p role="alert">{loadError}</p> : !estimate ? <p role="status">準備しています…</p> : <>
          <p className="field-hint"><Sentences>{`${authorName || '作ったBot'}が使う接続先（${estimate.author_provider ? providerLabel(estimate.author_provider) : '不明'}）とは別の接続先のモデルだけを選べます。完成条件${estimate.criteria}件ごとに、条件を満たすかを答えてもらいます。`}</Sentences></p>
          {providers.length ? <ModelPicker label="点検するモデル" value={selection} onChange={setSelection} providers={providers} emptyLabel="モデルを選んでください" disabled={busy} />
            : <p className="field-hint">別の接続先がつながっていません。<br />「設定」の「モデルと接続」で、ほかの接続先をつないでください。</p>}
          <div className="opinion-estimate"><p>{estimateLabel(estimate)}</p><p className="field-hint">押すと1回だけモデルを呼び、接続先によっては料金がかかります。<br />使った量は「きょう」の使用量に入ります。</p></div>
          <div className="inline-actions"><button type="button" className="button secondary" disabled={!selection || busy || !providers.includes(selection?.provider)} onClick={run}>{busy ? '点検してもらっています…' : '点検してもらう'}</button>{busy ? <button type="button" className="button subtle" onClick={() => asking.current?.abort()}>やめる</button> : null}</div>
        </>}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {used ? <p className="field-hint">使った量：{usedLabel(used)}</p> : null}
      </div>
    </details>
  </section>;
}
