export const PROVIDER_LABELS = { openai_subscription: 'Codex', ollama: 'Ollama', openai_compatible: 'OpenAI互換API' };
export const providerLabel = provider => PROVIDER_LABELS[provider] || provider;
/** 推論の強さを指定できるのはCodexだけ。他はモデル既定の動作を使う。 */
export const nativeReasoning = provider => provider === 'ollama' || provider === 'openai_compatible';
export const modelListPath = provider => ({ ollama: '/models', openai_compatible: '/openai-compatible/models' })[provider] || '/subscription/models';
