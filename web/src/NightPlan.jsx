import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Switch } from './components.jsx';
import { documentName, qualityLabel } from './artifact-display.js';
import { locale, serverText, t } from './i18n.js';
import { rich } from './i18n-react.js';
import { usageLine } from './work-display.js';
import { MoonIcon } from './icons.jsx';

const at = value => Number(typeof value === 'string' ? Date.parse(value) : value) || 0;
/** 夜のキー（その夜が始まる日、YYYY-MM-DD）を見出しに入れる形にする。month・day は日本語の文に、date はほかの言語の文に使う。 */
const nightVars = key => {
  const [year, month, day] = key.split('-').map(Number);
  return { month, day, date: new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }) };
};

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
    <h2 id="night-heading"><MoonIcon size={18} />{t('today.tonightHeading', nightVars(state.night.key))}</h2>
    {decided ? <><p className="night-status">{state.decision.decision === 'approved' ? t('today.nightApproved', { limit: state.decision.call_limit, used: state.used.calls }) : t('today.nightSkipped')}</p>
      <button type="button" className="text-button" onClick={() => setAgain(true)}>{t('today.decideAgain')}</button></>
      : <>
      <p className="field-hint">{rich('today.nightIntro', { br: <br /> })}</p>
      <h3 className="small-heading">{t('today.nightDoing')}</h3>
      <ul className="night-list">{state.plan.items.map(item => <li key={item.agent_id}><strong>{item.name}</strong>{item.doing.length ? item.doing.join(t('today.nightDoingSeparator')) : t('today.nightDoingDefault')}</li>)}</ul>
      <label className="field narrow-field"><span>{t('today.nightLimitLabel')}</span><div className="input-with-unit"><input type="number" min="1" max="500" value={limit} disabled={busy} onChange={event => setLimit(event.target.value)} /><span>{t('today.nightLimitUnit')}</span></div><small>{t('today.nightLimitHint')}</small></label>
      <h3 className="small-heading">{t('today.nightNever')}</h3>
      <ul className="night-list never">{state.plan.never.map(text => <li key={text}>{serverText(text)}</li>)}</ul>
      <div className="inline-actions"><button type="button" className="button primary" disabled={busy || !(Number(limit) >= 1 && Number(limit) <= 500)} onClick={() => decide(true)}>{t('today.nightApprove')}</button><button type="button" className="button subtle" disabled={busy} onClick={() => decide(false)}>{t('today.nightRest')}</button></div>
    </>}
    {state.streak >= 3 ? <div className="night-suggest"><p>{rich('today.nightStreak', { count: state.streak, br: <br /> })}</p><button type="button" className="button secondary" disabled={busy} onClick={() => run(async () => { await api('/night/preview', 'POST', { enabled: false }); return api('/night'); })}>{t('today.skipPreview')}</button></div> : null}
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
  const row = item => <li key={item.id}><button type="button" className="today-item" onClick={() => onOpenTask(item.id)}><strong>{item.summary || t('today.noResultSummary')}</strong><small>{item.name}</small></button></li>;
  return <section className="today-card night-card" aria-labelledby="basket-heading">
    <h2 id="basket-heading"><MoonIcon size={18} />{t('today.basketHeading', nightVars(harvest.night.key))}</h2>
    {harvest.decision?.decision === 'skipped' ? <p className="night-status">{t('today.basketSkipped')}</p> : null}
    {empty ? <p className="today-empty">{t('today.basketEmpty')}</p> : <>
      {harvest.done.length || made.length ? <><h3 className="small-heading">{t('today.basketDone')}</h3><ul className="today-list">{harvest.done.map(row)}
        {made.map(item => <li key={item.id}><span className={`attention-chip ${['verified', 'reviewed'].includes(item.quality_status) ? 'ok' : 'warn'}`}>{['verified', 'reviewed'].includes(item.quality_status) ? t('today.withEvidence') : t('today.withoutEvidence')}</span><button type="button" className="today-item" onClick={() => onArtifact(item.id)}><strong>{documentName(item.name)}</strong><small>{memberMap[item.member]?.name} · {qualityLabel(item.quality_status)}</small></button></li>)}</ul></> : null}
      {harvest.waiting.length ? <><h3 className="small-heading">{t('today.basketWaiting')}</h3><ul className="today-list">{harvest.waiting.map(row)}</ul></> : null}
      {harvest.stopped.length ? <><h3 className="small-heading">{t('today.basketStopped')}</h3><ul className="today-list">{harvest.stopped.map(row)}</ul></> : null}
    </>}
    <p className="task-usage">{harvest.usage.calls ? t('today.basketUsage', { usage: usageLine(harvest.usage) }) : t('today.basketNoUsage')}{harvest.decision?.decision === 'approved' ? t('today.basketLimit', { count: harvest.decision.call_limit }) : ''}</p>
  </section>;
}

/** 設定の「活動と人数」に置く切り替え。押した時点で保存する。 */
export function NightPreviewSetting() {
  const [state, setState, reload] = useNight();
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  return <Switch checked={state.preview} disabled={busy} label={t('today.previewSettingLabel')} description={t('today.previewSettingDescription')}
    onChange={async enabled => { setBusy(true); try { await api('/night/preview', 'POST', { enabled }); await reload(); } finally { setBusy(false); } }} />;
}
