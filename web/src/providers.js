export const PROVIDER_LABELS = { openai_subscription: 'Codex', ollama: 'Ollama', openai_compatible: 'OpenAI互換API', anthropic: 'Claude（Anthropic API）' };
export const providerLabel = provider => PROVIDER_LABELS[provider] || provider;
/** 推論の強さを指定できるのはCodexとClaude。他はモデル既定の動作を使う。 */
export const nativeReasoning = provider => provider === 'ollama' || provider === 'openai_compatible';
export const modelListPath = provider => ({ ollama: '/models', openai_compatible: '/openai-compatible/models', anthropic: '/anthropic/models' })[provider] || '/subscription/models';
/** Claudeは表示名とモデルIDを並べて示す。 */
export const modelLabel = item => item.display_name && item.display_name !== item.model ? `${item.display_name}（${item.model}）` : item.model;
/** モデル一覧を取得できないときに直接入力したClaudeのモデルで選べる推論の強さ。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
