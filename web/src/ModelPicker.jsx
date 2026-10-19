import { useEffect, useState } from 'react';
import { api } from './api.js';
import { CLAUDE_EFFORTS, PROVIDER_ORDER, groupByProvider, modelLabel, modelListPath, nativeReasoning, providerLabel } from './providers.js';
import { useAnthropicModels } from './anthropicModels.js';
import { MODELS_CHANGED, providerModels, readyProviders } from './modelLists.js';
import { serverText, t } from './i18n.js';

const ALL = PROVIDER_ORDER;
const key = item => `${item.provider}:${item.model}`;
const HIDDEN = 'not-connected';
const firstEffort = item => nativeReasoning(item.provider) ? 'native' : item.reasoning || item.default_effort || item.supported_efforts?.[0] || (item.provider === 'anthropic' ? 'medium' : 'native');

/** モデルを1つ選ぶ部品。Botのプロフィール・リーダー・新しいBotの標準・上限時の切替先で、同じ見た目と動きにする。
 * つながっている接続先のモデルは、開いたときに自動で一覧を取り、接続先ごとにまとめて並べる。一覧にないモデルはIDを直接入力して選べる。
 * value は { provider, model, reasoning }。keep に渡したもの（保存済みの選択など）は一覧になくても選択肢に残す。
 * 推論の強さを使わない場面では reasoning={false}、未選択を許す場面では emptyLabel を渡す（未選択の value は null）。 */
export function ModelPicker({ label, value, keep = [], onChange, disabled = false, providers = ALL, reasoning = true, emptyLabel, claude: shared }) {
  const own = useAnthropicModels(!shared && providers.includes('anthropic'));
  const claude = shared || own;
  const [models, setModels] = useState([]);
  // 取得できた件数は、言語を切り替えても読めるように、文ではなく接続先と数で覚えておく。
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fetched, setFetched] = useState(null);
  const [manual, setManual] = useState({ openai_compatible: '', anthropic: '' });
  const [ready, setReady] = useState(null);
  // つながっている接続先の一覧を自動で読む（Claudeは専用の仕組みで読む）。読めなかった接続先は、下のボタンから取り直せる。
  const wanted = providers.join(',');
  useEffect(() => {
    let active = true;
    async function refresh() {
      // 読めなかったときは false（つながっているかが分からない）にして、前と同じくすべてのモデルを出す。
      const connected = await readyProviders().catch(() => false);
      if (!active) return;
      setReady(connected);
      if (!connected) return;
      for (const provider of wanted.split(',').filter(item => item !== 'anthropic' && connected.includes(item))) {
        const values = await providerModels(provider).catch(() => null);
        if (active && values) setModels(current => [...current.filter(item => item.provider !== provider), ...values]);
      }
    }
    void refresh();
    window.addEventListener(MODELS_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(MODELS_CHANGED, refresh); };
  }, [wanted]);
  const claudeModels = providers.includes('anthropic') ? claude.models : [];
  const listed = [...claudeModels, ...models.filter(item => providers.includes(item.provider) && !claudeModels.some(other => key(other) === key(item)))];
  const known = item => listed.find(other => key(other) === key(item));
  // つながっていない接続先のモデル（最初から入っている ChatGPT のモデルなど）は、保存されていても名前を出さず、選んだようにも見せない。
  // つながっているかが分かるまでは何も選ばせない（ready が null の間）。
  const checked = Array.isArray(ready);
  const connected = item => !checked || ready.includes(item.provider);
  const usable = providers.filter(provider => connected({ provider }));
  const noConnection = checked && !usable.length;
  const shown = value && connected(value) ? value : null;
  const choices = [value, ...keep, ...listed].filter(Boolean).filter(connected).filter((item, index, all) => all.findIndex(other => key(other) === key(item)) === index).map(item => ({ ...item, display_name: known(item)?.display_name || item.display_name }));
  const efforts = !shown ? [] : nativeReasoning(value.provider) ? ['native'] : known(value)?.supported_efforts || (value.provider === 'anthropic' ? ['native', ...CLAUDE_EFFORTS] : [value.reasoning]);
  const pick = item => onChange(item ? { provider: item.provider, model: item.model, ...(reasoning ? { reasoning: firstEffort(item) } : {}) } : null);
  async function load(provider) {
    setBusy(true); setError(''); setFetched(null);
    try {
      const values = await api(modelListPath(provider));
      setModels(current => [...current.filter(item => item.provider !== provider), ...values.map(item => ({ ...item, provider, model: item.model || item.model_id }))]);
      setFetched({ provider, count: values.length });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function choose(provider) {
    const item = { provider, model: manual[provider].trim() };
    setModels(current => [...current.filter(other => key(other) !== key(item)), item]); setManual(current => ({ ...current, [provider]: '' }));
    pick({ ...item, reasoning: provider === 'anthropic' ? 'medium' : 'native' });
  }
  const typed = usable.filter(provider => provider === 'openai_compatible' || (provider === 'anthropic' && claude.manual));
  const off = disabled || busy;
  // 保存されているモデルの接続先がつながっていないときは、名前の代わりに「選んでください」を出す（選び直すまで保存の中身は変わらない）。
  const hidden = value && !shown;
  const selected = shown ? key(shown) : hidden ? HIDDEN : '';
  return <div className="model-picker" role="group" aria-label={label}>
    <div className="field-pair">
      <label className="field"><span>{label}</span><select value={ready === null || noConnection ? '' : selected} disabled={off || ready === null || noConnection} onChange={event => pick(choices.find(item => key(item) === event.target.value))}>{ready === null ? <option value="">{t('common.loading')}</option> : noConnection ? <option value="">{t('settings.pickerNoConnection')}</option> : <>{hidden ? <option value={HIDDEN} disabled>{t('settings.pickerChooseConnected')}</option> : null}{emptyLabel ? <option value="">{emptyLabel}</option> : null}{groupByProvider(choices).map(group => <optgroup key={group.provider} label={group.label}>{group.items.map(item => <option key={key(item)} value={key(item)}>{modelLabel(item)} · {group.label}</option>)}</optgroup>)}</>}</select></label>
      {reasoning ? <label className="field"><span>{t('settings.reasoningLabel')}</span><select aria-label={t('settings.reasoningAria', { label })} value={shown?.reasoning || ''} disabled={off || !shown || nativeReasoning(shown.provider)} onChange={event => onChange({ ...value, reasoning: event.target.value })}>{efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label> : null}
    </div>
    {noConnection ? <p className="field-hint" role="status">{t('settings.pickerNoConnectionHint')}</p> : ready === null ? null : <details className="model-picker-more"><summary>{t('settings.pickerMore')}</summary>
      <div className="inline-actions">{usable.map(provider => provider === 'anthropic'
        ? <button key={provider} type="button" className="button subtle" disabled={off || claude.loading} onClick={claude.reload}>{t('settings.claudeReload')}</button>
        : <button key={provider} type="button" className="button subtle" disabled={off} onClick={() => load(provider)}>{t('settings.providerListFetch', { provider: providerLabel(provider) })}</button>)}</div>
      {typed.map(provider => <div className="inline-actions" key={provider}><label className="field"><span>{t('settings.manualModelId', { provider: providerLabel(provider) })}</span><input value={manual[provider]} disabled={off} maxLength={256} onChange={event => setManual(current => ({ ...current, [provider]: event.target.value }))} placeholder={t('settings.modelIdExample', { model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-4.1-mini' })} /></label><button type="button" className="button subtle" disabled={off || !manual[provider].trim()} onClick={() => choose(provider)}>{t('settings.chooseModel')}</button></div>)}
      <p className="field-hint">{t('settings.listFetchHint')}</p>
    </details>}
    {hidden && !noConnection ? <p className="field-hint" role="status">{t('settings.providerNotConnected', { provider: providerLabel(value.provider) })}<br />{t('settings.providerNotConnectedHint')}</p> : null}
    {claude.error && providers.includes('anthropic') ? <p className="field-hint" role="status">{claude.error}</p> : null}
    {error ? <p className="field-error" role="alert">{serverText(error)}</p> : null}
    {busy || fetched ? <p className="saved-inline" role="status">{busy ? t('settings.pickerAsking') : t('settings.pickerFetched', { provider: providerLabel(fetched.provider), count: fetched.count })}</p> : null}
  </div>;
}
