import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Modal, Sentences } from './components.jsx';
import { Markdown } from './Markdown.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { modelLabel, providerLabel } from './providers.js';
import { estimateLabel, failureText, usedLabel } from './second-opinion.js';

/** Botの発言を、別のモデルならどう答えるかと見比べる脇の欄。押したときだけ1回モデルを呼び、答えは「残す」を押すまで会話に入れない。 */
export function SecondOpinion({ roomId, message, member, onClose, onKept }) {
  const [estimate, setEstimate] = useState(null), [ready, setReady] = useState(null), [loadError, setLoadError] = useState('');
  const [selection, setSelection] = useState(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(''), [kept, setKept] = useState(false);
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
  async function ask() {
    if (!selection || busy) return;
    setBusy(true); setError(''); setResult(null); setKept(false);
    asking.current = new AbortController();
    try {
      const response = await fetch(`/api/rooms/${roomId}/messages/${message.id}/second-opinion`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: asking.current.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: selection.provider, model: selection.model, reasoning: selection.reasoning || 'native' }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error === 'invalid' ? 'このBotと同じモデルは選べません。別のモデルを選んでください。' : value.error === 'limit' ? '会話が長すぎて、このモデルには渡せません。' : '聞けませんでした。会話がまだあるか確かめてください。');
      if (value.failure) setError(failureText(value.failure));
      setResult(value);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); asking.current = null; }
  }
  async function keep() {
    setBusy(true); setError('');
    try { await api(`/second-opinions/${result.id}/keep`, 'POST', {}); setKept(true); onKept?.(); }
    catch (failure) { setError(failure.status === 404 ? 'この答えはもう手元にありません（時間がたったか、サーバーを起動し直しました）。もう一度聞いてください。' : failure.message); }
    finally { setBusy(false); }
  }
  return <Modal drawer title="別のモデルでも聞く" onClose={onClose} className="opinion-modal">
    <div className="modal-body form-stack">
      <p className="field-hint"><Sentences>{`${member?.name || 'Bot'}のまま、同じ記憶の範囲と、この発言より前の会話だけを渡して、選んだモデルに1回だけ聞きます。道具は使わず、会話と記憶だけで答えます。答えは会話に残りません。残したいときだけ、下のボタンで${member?.name || 'Bot'}の返信として加えます。`}</Sentences></p>
      {loadError ? <p role="alert">{loadError}</p> : !estimate ? <p role="status">準備しています…</p> : <>
        <ModelPicker label="聞くモデル" value={selection} onChange={setSelection} providers={ready?.length ? ready : undefined} emptyLabel="モデルを選んでください" disabled={busy} />
        {same ? <p className="field-error" role="alert">このBotがいま使っているのと同じモデルです。別のモデルか、別の推論の強さを選んでください。</p> : null}
        <div className="opinion-estimate"><p>{estimateLabel(estimate)}</p><p className="field-hint">見積もりは文字数からの目安です。<br />押すと1回だけモデルを呼び、接続先によっては料金がかかります。<br />使った量は「きょう」の使用量に入ります。</p></div>
        <div className="inline-actions"><button type="button" className="button primary" disabled={!selection || same || busy} onClick={ask}>{busy && !result ? '聞いています…' : 'このモデルに聞く'}</button>{busy && !result ? <button type="button" className="button subtle" onClick={() => asking.current?.abort()}>やめる</button> : null}</div>
      </>}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {result?.answer ? <div className="opinion-compare">
        <section aria-labelledby="opinion-original"><h3 id="opinion-original">いまの答え</h3><p className="opinion-model">{own ? `${providerLabel(own.provider)} ${modelLabel(own)}` : ''}</p><div className="opinion-text"><Markdown text={message.text} /></div></section>
        <section aria-labelledby="opinion-other"><h3 id="opinion-other">別のモデルの答え</h3><p className="opinion-model">{providerLabel(result.selection.provider)} {modelLabel(result.selection)} · {usedLabel(result.usage)}</p>{result.truncated ? <p className="field-hint">長さの上限で途中までの答えです。</p> : null}<div className="opinion-text"><Markdown text={result.answer} /></div></section>
      </div> : result?.usage ? <p className="field-hint">使った量：{usedLabel(result.usage)}</p> : null}
    </div>
    {result?.answer ? <div className="form-actions">{kept ? <span className="saved-inline" role="status">会話に残しました。</span> : null}<button type="button" className="button subtle" onClick={onClose}>閉じる</button><button type="button" className="button primary" disabled={busy || kept} onClick={keep}>この答えを会話に残す</button></div> : null}
  </Modal>;
}
