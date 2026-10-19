import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useAnthropicModels } from './anthropicModels.js';
import { ModelPicker } from './ModelPicker.jsx';
import { serverText, t } from './i18n.js';

const PROVIDERS = ['local_llm', 'openai_compatible', 'anthropic'];
const SUGGESTED_CLAUDE = 'claude-opus-5-5';
const choiceOf = settings => settings?.fallbackModel ? { provider: settings.fallbackProvider, model: settings.fallbackModel } : null;

/** ChatGPTのサブスクの利用上限に達したときだけ使う切替先。推論の強さはモデルの既定で動く。 */
export function FallbackConnection() {
  const [settings, setSettings] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  // Claudeのモデルはキーを保存すると自動で取得する（新しい順・表示名つき）。候補選びと選択の部品で同じ一覧を使う。
  const claude = useAnthropicModels();
  function apply(next) { setSettings(next); setSelected(choiceOf(next)); }
  useEffect(() => {
    let active = true;
    api('/model-settings').then(next => { if (active) apply(next); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  // 保存済みの切替先がなければ、一覧にある場合だけClaude Opus 5.5を候補として選んでおく（保存は押したときだけ）。
  const suggested = useRef(false);
  useEffect(() => {
    if (suggested.current || !settings || settings.fallbackModel || selected || !claude.models.some(item => item.model === SUGGESTED_CLAUDE)) return;
    suggested.current = true; setSelected({ provider: 'anthropic', model: SUGGESTED_CLAUDE });
  }, [settings, selected, claude.models]);
  async function save(choice) {
    setBusy(true); setError(''); setMessage('');
    try {
      apply(await api('/model-settings/fallback', 'PUT', choice ? { model: choice.model, provider: choice.provider } : { model: null, provider: settings.fallbackProvider }));
      setMessage(t(choice ? 'connections.fallbackSaved' : 'connections.fallbackCleared'));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const saved = choiceOf(settings);
  const same = selected?.provider === saved?.provider && selected?.model === saved?.model;
  return <div className="connection-subgroup" role="group" aria-label={t('connections.fallbackGroup')}>
    <div className="form-section-label">{t('connections.fallbackHeading')}</div>
    <p className="field-hint">{t('connections.fallbackHint1')}<br />{t('connections.fallbackHint2')}</p>
    <ModelPicker label={t('connections.fallbackModel')} value={selected} keep={saved ? [saved] : []} providers={PROVIDERS} reasoning={false} emptyLabel={t('connections.fallbackEmpty')} claude={claude} disabled={busy || !settings} onChange={next => { setSelected(next); setMessage(''); }} />
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || !settings || !selected || same} onClick={() => save(selected)}>{t('connections.fallbackSave')}</button>
      <button type="button" className="button subtle" disabled={busy || !settings?.fallbackModel} onClick={() => save(null)}>{t('connections.fallbackClear')}</button>
      <span className="saved-inline" role="status">{busy ? t('connections.checking') : message}</span>
    </div>
    <p className="field-hint">{t('connections.fallbackNote1')}<br />{t('connections.fallbackNote2')}<br />{t('connections.fallbackNote3')}<br />{t('connections.fallbackNote4')}</p>
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
  </div>;
}
