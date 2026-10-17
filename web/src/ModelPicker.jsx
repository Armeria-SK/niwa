import { useState } from 'react';
import { api } from './api.js';
import { CLAUDE_EFFORTS, modelLabel, modelListPath, nativeReasoning, providerLabel } from './providers.js';
import { useAnthropicModels } from './anthropicModels.js';

const ALL = ['openai_subscription', 'anthropic', 'openai_compatible', 'local_llm'];
const key = item => `${item.provider}:${item.model}`;
const firstEffort = item => nativeReasoning(item.provider) ? 'native' : item.reasoning || item.default_effort || item.supported_efforts?.[0] || (item.provider === 'anthropic' ? 'medium' : 'native');

/** モデルを1つ選ぶ部品。Botのプロフィール・リーダー・新しいBotの標準・上限時の切替先で、同じ見た目と動きにする。
 * Claudeはキーが保存されていれば一覧を自動で取り、ほかの接続先はボタンで一覧を取る。一覧にないモデルはIDを直接入力して選べる。
 * value は { provider, model, reasoning }。keep に渡したもの（保存済みの選択など）は一覧になくても選択肢に残す。
 * 推論の強さを使わない場面では reasoning={false}、未選択を許す場面では emptyLabel を渡す（未選択の value は null）。 */
export function ModelPicker({ label, value, keep = [], onChange, disabled = false, providers = ALL, reasoning = true, emptyLabel, claude: shared }) {
  const own = useAnthropicModels(!shared && providers.includes('anthropic'));
  const claude = shared || own;
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [manual, setManual] = useState({ openai_compatible: '', anthropic: '' });
  const claudeModels = providers.includes('anthropic') ? claude.models : [];
  const listed = [...claudeModels, ...models.filter(item => providers.includes(item.provider) && !claudeModels.some(other => key(other) === key(item)))];
  const known = item => listed.find(other => key(other) === key(item));
  const choices = [value, ...keep, ...listed].filter(Boolean).filter((item, index, all) => all.findIndex(other => key(other) === key(item)) === index).map(item => ({ ...item, display_name: known(item)?.display_name || item.display_name }));
  const efforts = !value ? [] : nativeReasoning(value.provider) ? ['native'] : known(value)?.supported_efforts || (value.provider === 'anthropic' ? ['native', ...CLAUDE_EFFORTS] : [value.reasoning]);
  const pick = item => onChange(item ? { provider: item.provider, model: item.model, ...(reasoning ? { reasoning: firstEffort(item) } : {}) } : null);
  async function load(provider) {
    setBusy(true); setError(''); setMessage('');
    try {
      const values = await api(modelListPath(provider));
      setModels(current => [...current.filter(item => item.provider !== provider), ...values.map(item => ({ ...item, provider, model: item.model || item.model_id }))]);
      setMessage(`${providerLabel(provider)}のモデルを${values.length}件取得しました。`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  function choose(provider) {
    const item = { provider, model: manual[provider].trim() };
    setModels(current => [...current.filter(other => key(other) !== key(item)), item]); setManual(current => ({ ...current, [provider]: '' }));
    pick({ ...item, reasoning: provider === 'anthropic' ? 'medium' : 'native' });
  }
  const typed = providers.filter(provider => provider === 'openai_compatible' || (provider === 'anthropic' && claude.manual));
  const off = disabled || busy;
  return <div className="model-picker" role="group" aria-label={label}>
    <div className="field-pair">
      <label className="field"><span>{label}</span><select value={value ? key(value) : ''} disabled={off} onChange={event => pick(choices.find(item => key(item) === event.target.value))}>{emptyLabel ? <option value="">{emptyLabel}</option> : null}{choices.map(item => <option key={key(item)} value={key(item)}>{modelLabel(item)} · {providerLabel(item.provider)}</option>)}</select></label>
      {reasoning ? <label className="field"><span>推論の強さ</span><select aria-label={`${label}の推論の強さ`} value={value?.reasoning || ''} disabled={off || !value || nativeReasoning(value.provider)} onChange={event => onChange({ ...value, reasoning: event.target.value })}>{efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label> : null}
    </div>
    <details className="model-picker-more"><summary>ほかのモデルを探す</summary>
      <div className="inline-actions">{providers.map(provider => provider === 'anthropic'
        ? <button key={provider} type="button" className="button subtle" disabled={off || claude.loading} onClick={claude.reload}>Claudeの一覧を取り直す</button>
        : <button key={provider} type="button" className="button subtle" disabled={off} onClick={() => load(provider)}>{providerLabel(provider)}の一覧を取得</button>)}</div>
      {typed.map(provider => <div className="inline-actions" key={provider}><label className="field"><span>{providerLabel(provider)}のモデルIDを直接入力</span><input value={manual[provider]} disabled={off} maxLength={256} onChange={event => setManual(current => ({ ...current, [provider]: event.target.value }))} placeholder={provider === 'anthropic' ? '例: claude-opus-5-5' : '例: gpt-4.1-mini'} /></label><button type="button" className="button subtle" disabled={off || !manual[provider].trim()} onClick={() => choose(provider)}>このモデルを選ぶ</button></div>)}
      <p className="field-hint">一覧の取得ではモデルの名前だけを読み、応答の生成（課金対象）はしません。</p>
    </details>
    {claude.error && providers.includes('anthropic') ? <p className="field-hint" role="status">{claude.error}</p> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    {busy || message ? <p className="saved-inline" role="status">{busy ? '接続先に問い合わせています…' : message}</p> : null}
  </div>;
}
