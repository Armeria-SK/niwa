export const PROVIDER_LABELS = { openai_subscription: 'Codex', local_llm: 'Local LLM', openai_compatible: 'OpenAI互換API', anthropic: 'Claude（Anthropic API）' };
export const providerLabel = provider => PROVIDER_LABELS[provider] || provider;
/** 推論の強さを指定できるのはCodexとClaude。他はモデル既定の動作を使う。 */
export const nativeReasoning = provider => provider === 'local_llm' || provider === 'openai_compatible';
export const modelListPath = provider => ({ local_llm: '/models', openai_compatible: '/openai-compatible/models', anthropic: '/anthropic/models' })[provider] || '/subscription/models';
/** Claudeは表示名とモデルIDを並べて示す。 */
export const modelLabel = item => item.display_name && item.display_name !== item.model ? `${item.display_name}（${item.model}）` : item.model;
/** モデル一覧を取得できないときに直接入力したClaudeのモデルで選べる推論の強さ。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** 保存済みの接続先（ready）で、そのBot（agent）が返事をできないときの案内を返す。読み込めていない間（null）は何も出さない。 */
export function modelSetupNotice(ready, agent) {
  if (!Array.isArray(ready)) return null;
  if (!ready.length) return { title: 'まずモデルをつなぎましょう', body: 'Botが考えて返事をするには、AIモデルへの接続が1つ以上必要です。ChatGPT・Claude（Anthropic API）・OpenAI互換API・Local LLMから選べます。つなぐまで、自分から動く活動も始まりません。' };
  if (!agent?.provider || ready.includes(agent.provider)) return null;
  const who = agent.authority === 'leader' ? 'リーダー' : agent.name;
  return { title: `${who}のモデル（${providerLabel(agent.provider)}）がつながっていません`, body: `その接続を保存するか、Botのプロフィールで${who}のモデルを、つながっている接続先のものに変えてください。` };
}
