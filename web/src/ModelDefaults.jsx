import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ModelPicker } from './ModelPicker.jsx';
import { serverText, t } from './i18n.js';

const selection = value => ({ provider: value.provider, model: value.model, reasoning: value.reasoning });
function ModelChoice({ initial, endpoint, title, saveLabel, hint }) {
  const [saved, setSaved] = useState(() => selection(initial));
  const [draft, setDraft] = useState(() => selection(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const same = draft.provider === saved.provider && draft.model === saved.model && draft.reasoning === saved.reasoning;
  async function save() {
    setBusy(true); setError(''); setDone(false);
    try { const next = selection(await api(endpoint, 'PUT', draft)); setSaved(next); setDraft(next); setDone(true); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="model-choice">
    <ModelPicker label={title} value={draft} keep={[saved]} disabled={busy} onChange={next => { setDraft(next); setDone(false); }} />
    <p className="field-hint">{hint}</p>
    <div className="inline-actions"><button type="button" className="button primary" disabled={busy || same} onClick={save}>{busy ? t('settings.modelChecking') : saveLabel}</button><span className="saved-inline" role="status">{done ? t('settings.modelSaved') : ''}</span></div>
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
  </div>;
}

export function ModelDefaults() {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api('/state'), api('/model-settings/generated')]).then(([state, generated]) => {
      if (active) setData({ leader: state.agents.find(agent => agent.role === 'leader'), generated });
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  if (!data) return <p className="field-hint" role={error ? 'alert' : 'status'}>{error ? serverText(error) : t('settings.modelSettingsLoading')}</p>;
  return <>
    {data.leader ? <ModelChoice initial={data.leader} endpoint={`/agents/${data.leader.id}/model`} title={t('settings.leaderModelTitle')} saveLabel={t('settings.leaderModelSave')} hint={t('settings.leaderModelHint')} /> : null}
    <ModelChoice initial={data.generated} endpoint="/model-settings/generated" title={t('settings.newBotModelTitle')} saveLabel={t('settings.newBotModelSave')} hint={t('settings.newBotModelHint')} />
  </>;
}
