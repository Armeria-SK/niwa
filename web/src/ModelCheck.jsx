import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Sentences } from './components.jsx';
import { InfoIcon } from './icons.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { providerLabel } from './providers.js';
import { checkProviders, estimateLabel, failureText, modelCheckView, usedLabel } from './second-opinion.js';
import { locale, t } from './i18n.js';
import { rich } from './i18n-react.js';

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
      if (!response.ok) throw new Error(value.error === 'conflict' ? t('artifacts.checkConflict') : value.error === 'invalid' ? t('artifacts.checkSameProvider') : t('artifacts.checkFailed'));
      setUsed(value.usage || null);
      if (value.failure) setError(failureText(value.failure)); else await onChanged?.();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); asking.current = null; }
  }
  return <section className="model-checks" aria-labelledby={`model-checks-${artifact.id}`}>
    <h3 id={`model-checks-${artifact.id}`}>{t('artifacts.modelChecksTitle')}</h3>
    <p className="model-check-note"><InfoIcon size={16} /><span><Sentences>{t('artifacts.modelChecksNote')}</Sentences></span></p>
    {checks.length ? checks.map(check => <div className="model-check" key={check.model + check.at}>
      <p><strong>{check.model}</strong> · {new Date(check.at).toLocaleString(locale())}</p>
      {check.summary ? <p>{check.summary}</p> : null}
      <ul>{check.checks.map(item => <li key={item.criterion}>{rich('artifacts.checkLine', { condition: item.condition, verdict: <strong>{item.label}</strong>, note: item.note })}</li>)}</ul>
    </div>) : <p className="field-hint">{t('artifacts.noModelChecks')}</p>}
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('artifacts.askOtherModel')}</summary>
      <div className="form-stack">
        {loadError ? <p role="alert">{loadError}</p> : !estimate ? <p role="status">{t('artifacts.preparing')}</p> : <>
          <p className="field-hint"><Sentences>{t('artifacts.checkProvidersHint', { author: authorName || t('artifacts.authorFallback'), provider: estimate.author_provider ? providerLabel(estimate.author_provider) : t('artifacts.unknownProvider'), count: estimate.criteria })}</Sentences></p>
          {providers.length ? <ModelPicker label={t('artifacts.checkModel')} value={selection} onChange={setSelection} providers={providers} emptyLabel={t('artifacts.chooseModel')} disabled={busy} />
            : <p className="field-hint">{t('artifacts.noOtherProvider')}<br />{t('artifacts.connectOtherProvider')}</p>}
          <div className="opinion-estimate"><p>{estimateLabel(estimate)}</p><p className="field-hint">{t('artifacts.costNote')}<br />{t('artifacts.usageNote')}</p></div>
          <div className="inline-actions"><button type="button" className="button secondary" disabled={!selection || busy || !providers.includes(selection?.provider)} onClick={run}>{busy ? t('artifacts.checking') : t('artifacts.askCheck')}</button>{busy ? <button type="button" className="button subtle" onClick={() => asking.current?.abort()}>{t('artifacts.stop')}</button> : null}</div>
        </>}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {used ? <p className="field-hint">{t('artifacts.usedAmount', { amount: usedLabel(used) })}</p> : null}
      </div>
    </details>
  </section>;
}
