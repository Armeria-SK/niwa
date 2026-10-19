import { t } from './i18n.js';

// 訳す名前は読むときに今の言語で引く（getter）。Codex と Local LLM はどの言語でも同じ名前。
export const PROVIDER_LABELS = { openai_subscription: 'Codex', local_llm: 'Local LLM', get openai_compatible() { return t('settings.providerCompatible'); }, get anthropic() { return t('settings.providerAnthropic'); } };
export const providerLabel = provider => PROVIDER_LABELS[provider] || provider;
/** 選ぶ欄で並べる接続先の順。ChatGPT（Codex）は試験対応なので最後に置く。 */
export const PROVIDER_ORDER = ['anthropic', 'openai_compatible', 'local_llm', 'openai_subscription'];
/** モデルを接続先ごとにまとめる。並びは PROVIDER_ORDER に従い、知らない接続先は最後に回す。中の順番は変えない。 */
export function groupByProvider(items) {
  const rank = provider => { const index = PROVIDER_ORDER.indexOf(provider); return index < 0 ? PROVIDER_ORDER.length : index; };
  const providers = [...new Set(items.map(item => item.provider))].sort((a, b) => rank(a) - rank(b));
  return providers.map(provider => ({ provider, label: providerLabel(provider), items: items.filter(item => item.provider === provider) }));
}
/** 推論の強さを指定できるのはCodexとClaude。他はモデル既定の動作を使う。 */
export const nativeReasoning = provider => provider === 'local_llm' || provider === 'openai_compatible';
export const modelListPath = provider => ({ local_llm: '/models', openai_compatible: '/openai-compatible/models', anthropic: '/anthropic/models' })[provider] || '/subscription/models';
/** Claudeは表示名とモデルIDを並べて示す。 */
export const modelLabel = item => item.display_name && item.display_name !== item.model ? t('settings.modelWithId', { name: item.display_name, model: item.model }) : item.model;
/** モデル一覧を取得できないときに直接入力したClaudeのモデルで選べる推論の強さ。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** 保存済みの接続先（ready）で、そのBot（agent）が返事をできないときの案内を返す。読み込めていない間（null）は何も出さない。 */
export function modelSetupNotice(ready, agent) {
  if (!Array.isArray(ready)) return null;
  if (!ready.length) return { title: t('settings.setupFirstTitle'), body: t('settings.setupFirstBody') };
  if (!agent?.provider || ready.includes(agent.provider)) return null;
  const provider = providerLabel(agent.provider);
  if (agent.authority === 'leader') return { title: t('settings.setupLeaderTitle', { provider }), body: t('settings.setupLeaderBody') };
  return { title: t('settings.setupBotTitle', { name: agent.name, provider }), body: t('settings.setupBotBody', { name: agent.name }) };
}
