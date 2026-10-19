import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Modal, Sentences } from './components.jsx';
import { Markdown } from './Markdown.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { modelLabel, providerLabel } from './providers.js';
import { estimateLabel, failureText, usedLabel } from './second-opinion.js';
import { t, serverText } from './i18n.js';
import { rich } from './i18n-react.js';

// エラーは種類だけを持ち、文言は表示するときに今の言語で引く（言語を切り替えても古い言語の文が残らないように）。
const errorText = error => error.key ? t(error.key) : error.failure ? failureText(error.failure) : serverText(error.text);

/** Botの発言を、別のモデルならどう答えるかと見比べる脇の欄。押したときだけ1回モデルを呼び、答えは「残す」を押すまで会話に入れない。 */
export function SecondOpinion({ roomId, message, member, onClose, onKept }) {
  const [estimate, setEstimate] = useState(null), [ready, setReady] = useState(null), [loadError, setLoadError] = useState('');
  const [selection, setSelection] = useState(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(null), [kept, setKept] = useState(false);
  const asking = useRef(null);
  useEffect(() => {
    let active = true;
    Promise.all([api(`/rooms/${roomId}/messages/${message.id}/second-opinion`), api('/model-ready')])
      .then(([value, providers]) => { if (active) { setEstimate(value); setReady(providers.providers); } })
      .catch(failure => { if (active) setLoadError(failure.message); });
    return () => { active = false; asking.current?.abort(); };
  }, [roomId, message.id]);
  const own = estimate?.selection;
  const same = selection && own && selection.provider === own.provider && selection.model === own.model && (selection.reasoning || 'native') === own.reasoning;
  const name = member?.name || t('conversation.botFallback');
  async function ask() {
    if (!selection || busy) return;
    setBusy(true); setError(null); setResult(null); setKept(false);
    asking.current = new AbortController();
    try {
      const response = await fetch(`/api/rooms/${roomId}/messages/${message.id}/second-opinion`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: asking.current.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: selection.provider, model: selection.model, reasoning: selection.reasoning || 'native' }) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(String(value.error)), { key: value.error === 'invalid' ? 'conversation.opinionInvalid' : value.error === 'limit' ? 'conversation.opinionLimit' : 'conversation.opinionFailed' });
      if (value.failure) setError({ failure: value.failure });
      setResult(value);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.key ? { key: failure.key } : { text: failure.message }); }
    finally { setBusy(false); asking.current = null; }
  }
  async function keep() {
    setBusy(true); setError(null);
    try { await api(`/second-opinions/${result.id}/keep`, 'POST', {}); setKept(true); onKept?.(); }
    catch (failure) { setError(failure.status === 404 ? { key: 'conversation.opinionExpired' } : { text: failure.message }); }
    finally { setBusy(false); }
  }
  return <Modal drawer title={t('conversation.askAnotherModel')} onClose={onClose} className="opinion-modal">
    <div className="modal-body form-stack">
      <p className="field-hint"><Sentences>{t('conversation.opinionIntro', { name })}</Sentences></p>
      {loadError ? <p role="alert">{serverText(loadError)}</p> : !estimate ? <p role="status">{t('conversation.preparing')}</p> : <>
        <ModelPicker label={t('conversation.modelToAsk')} value={selection} onChange={setSelection} providers={ready?.length ? ready : undefined} emptyLabel={t('conversation.chooseModel')} disabled={busy} />
        {same ? <p className="field-error" role="alert">{t('conversation.sameModel')}</p> : null}
        <div className="opinion-estimate"><p>{estimateLabel(estimate)}</p><p className="field-hint">{rich('conversation.estimateHint', { br: <br /> })}</p></div>
        <div className="inline-actions"><button type="button" className="button primary" disabled={!selection || same || busy} onClick={ask}>{busy && !result ? t('conversation.asking') : t('conversation.askThisModel')}</button>{busy && !result ? <button type="button" className="button subtle" onClick={() => asking.current?.abort()}>{t('conversation.stop')}</button> : null}</div>
      </>}
      {error ? <p className="field-error" role="alert">{errorText(error)}</p> : null}
      {result?.answer ? <div className="opinion-compare">
        <section aria-labelledby="opinion-original"><h3 id="opinion-original">{t('conversation.currentAnswer')}</h3><p className="opinion-model">{own ? `${providerLabel(own.provider)} ${modelLabel(own)}` : ''}</p><div className="opinion-text"><Markdown text={message.text} /></div></section>
        <section aria-labelledby="opinion-other"><h3 id="opinion-other">{t('conversation.otherAnswer')}</h3><p className="opinion-model">{providerLabel(result.selection.provider)} {modelLabel(result.selection)} · {usedLabel(result.usage)}</p>{result.truncated ? <p className="field-hint">{t('conversation.truncatedAnswer')}</p> : null}<div className="opinion-text"><Markdown text={result.answer} /></div></section>
      </div> : result?.usage ? <p className="field-hint">{t('conversation.usedAmount', { used: usedLabel(result.usage) })}</p> : null}
    </div>
    {result?.answer ? <div className="form-actions">{kept ? <span className="saved-inline" role="status">{t('conversation.kept')}</span> : null}<button type="button" className="button subtle" onClick={onClose}>{t('common.close')}</button><button type="button" className="button primary" disabled={busy || kept} onClick={keep}>{t('conversation.keepAnswer')}</button></div> : null}
  </Modal>;
}
