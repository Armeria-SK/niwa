import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Switch } from './components.jsx';
import { documentName, qualityLabel } from './artifact-display.js';
import { usageLine } from './work-display.js';
import { MoonIcon } from './icons.jsx';

const at = value => Number(typeof value === 'string' ? Date.parse(value) : value) || 0;
const nightLabel = key => { const [, month, day] = key.split('-').map(Number); return `${month}月${day}日の夜`; };

/** 夜の自発活動の状態を読む。決めたあとは返ってきた状態をそのまま使う。 */
export function useNight() {
  const [state, setState] = useState(null);
  const reload = () => api('/night').then(setState).catch(() => setState(null));
  useEffect(() => { void reload(); }, []);
  return [state, setState, reload];
}

/** 夕方から夜の間に出す「今夜の計画」。やること・使ってよい量・やらないことを見て、許可するか休ませるかを決める。 */
export function NightPreview({ state, onChange }) {
  const [limit, setLimit] = useState(state.decision?.call_limit ?? state.default_calls);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [again, setAgain] = useState(false);
  async function run(work) { setBusy(true); setError(''); try { onChange(await work()); setAgain(false); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }
  const decide = approved => run(() => api('/night/decision', 'POST', { night: state.night.key, approved, call_limit: Number(limit) }));
  if (!state.preview || !state.preview_open || !state.plan.active) return null;
  const decided = state.decision && !again;
  return <section className="today-card night-card" aria-labelledby="night-heading">
    <h2 id="night-heading"><MoonIcon size={18} />今夜の計画（{nightLabel(state.night.key)}・22時〜7時）</h2>
    {decided ? <><p className="night-status">{state.decision.decision === 'approved' ? `許可しました。上限はモデル呼び出し${state.decision.call_limit}回で、いま${state.used.calls}回使っています。` : '今夜は休ませます。朝まで、自分から動く活動は始めません。'}</p>
      <button type="button" className="text-button" onClick={() => setAgain(true)}>決め直す</button></>
      : <>
      <p className="field-hint">Botたちが夜のあいだ自分で進める予定です。<br />許可するまで、夜の自発活動は始まりません。</p>
      <h3 className="small-heading">やること</h3>
      <ul className="night-list">{state.plan.items.map(item => <li key={item.agent_id}><strong>{item.name}</strong>{item.doing.length ? item.doing.join('／') : '自分で役立つことを選んで進める'}</li>)}</ul>
      <label className="field narrow-field"><span>使ってよい量（モデル呼び出しの回数）</span><div className="input-with-unit"><input type="number" min="1" max="500" value={limit} disabled={busy} onChange={event => setLimit(event.target.value)} /><span>回</span></div><small>この回数に達したら、その夜はもう新しく始めません。</small></label>
      <h3 className="small-heading">やらないこと</h3>
      <ul className="night-list never">{state.plan.never.map(text => <li key={text}>{text}</li>)}</ul>
      <div className="inline-actions"><button type="button" className="button primary" disabled={busy || !(Number(limit) >= 1 && Number(limit) <= 500)} onClick={() => decide(true)}>この計画で許可する</button><button type="button" className="button subtle" disabled={busy} onClick={() => decide(false)}>今夜は休ませる</button></div>
    </>}
    {state.streak >= 3 ? <div className="night-suggest"><p>{state.streak}晩続けて許可しています。<br />下見を省いて、毎晩この形で進めますか？</p><button type="button" className="button secondary" disabled={busy} onClick={() => run(async () => { await api('/night/preview', 'POST', { enabled: false }); return api('/night'); })}>下見を省く</button></div> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
  </section>;
}

/** 朝の「きょう」に出す、ゆうべの自発活動の結果。できたこと・判断してほしいこと・止まったこと・使った量。 */
export function MorningBasket({ state, artifacts, memberMap, onOpenTask, onArtifact }) {
  const harvest = state.harvest;
  if (state.in_night) return null;
  const made = artifacts.filter(item => at(item.created_at) >= harvest.night.start && at(item.created_at) < harvest.night.end);
  const empty = !harvest.done.length && !harvest.waiting.length && !harvest.stopped.length && !made.length && !harvest.usage.calls;
  if (empty && !harvest.decision) return null;
  const row = item => <li key={item.id}><button type="button" className="today-item" onClick={() => onOpenTask(item.id)}><strong>{item.summary || '（結果の説明はありません）'}</strong><small>{item.name}</small></button></li>;
  return <section className="today-card night-card" aria-labelledby="basket-heading">
    <h2 id="basket-heading"><MoonIcon size={18} />朝の収穫かご（{nightLabel(harvest.night.key)}）</h2>
    {harvest.decision?.decision === 'skipped' ? <p className="night-status">この夜は休ませました。</p> : null}
    {empty ? <p className="today-empty">この夜に進んだ仕事はありません。</p> : <>
      {harvest.done.length || made.length ? <><h3 className="small-heading">できたこと</h3><ul className="today-list">{harvest.done.map(row)}
        {made.map(item => <li key={item.id}><span className={`attention-chip ${['verified', 'reviewed'].includes(item.quality_status) ? 'ok' : 'warn'}`}>{['verified', 'reviewed'].includes(item.quality_status) ? '証拠あり' : '証拠なし'}</span><button type="button" className="today-item" onClick={() => onArtifact(item.id)}><strong>{documentName(item.name)}</strong><small>{memberMap[item.member]?.name} · {qualityLabel(item.quality_status)}</small></button></li>)}</ul></> : null}
      {harvest.waiting.length ? <><h3 className="small-heading">判断してほしいこと</h3><ul className="today-list">{harvest.waiting.map(row)}</ul></> : null}
      {harvest.stopped.length ? <><h3 className="small-heading">止まったこと</h3><ul className="today-list">{harvest.stopped.map(row)}</ul></> : null}
    </>}
    <p className="task-usage">{harvest.usage.calls ? `使った量：${usageLine(harvest.usage)}` : '使った量：モデルは呼び出していません。'}{harvest.decision?.decision === 'approved' ? `（上限${harvest.decision.call_limit}回）` : ''}</p>
  </section>;
}

/** 設定の「活動と人数」に置く切り替え。押した時点で保存する。 */
export function NightPreviewSetting() {
  const [state, setState, reload] = useNight();
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  return <Switch checked={state.preview} disabled={busy} label="夜の計画を下見する" description="夜（22時〜7時）の自発活動は、夕方に「きょう」で計画を見て許可してから始めます。この切り替えは押した時点で保存されます。"
    onChange={async enabled => { setBusy(true); try { await api('/night/preview', 'POST', { enabled }); await reload(); } finally { setBusy(false); } }} />;
}
