// Capability intersection adapted from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d,
// core/providers/src/model-profile.ts (Apache-2.0). Niwa omits coding-role validation.
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isCapabilityConsistent, reasoningEffortSchema } from '../../contracts/index.ts';
import type { ModelAdapterCapabilities } from '../../contracts/index.ts';

export const modelProfileSchema = Type.Object({
  runtime: Type.Union([Type.Literal('gpt'), Type.Literal('api')]),
  provider_id: Type.Union([Type.Literal('openai_subscription'), Type.Literal('ollama')]),
  provider_model_id: Type.String({ minLength: 1, maxLength: 256 }),
  supported_efforts: Type.Array(reasoningEffortSchema, { uniqueItems: true }),
  max_output_tokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  context_window: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  supports_tool_calls: Type.Boolean(),
  supports_structured_output: Type.Boolean(),
  supports_streaming: Type.Boolean(),
  supports_session_resume: Type.Boolean(),
  supports_parallel_sessions: Type.Boolean(),
  supports_usage_reporting: Type.Boolean(),
  base_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false });
export type ModelProfile = Static<typeof modelProfileSchema>;

export function createEffectiveModelCapabilities(
  adapter: ModelAdapterCapabilities,
  profile: ModelProfile,
  _purpose?: 'coding' | 'conversation',
): ModelAdapterCapabilities {
  if (!isCapabilityConsistent(adapter) || !Value.Check(modelProfileSchema, profile)) {
    throw new Error('Model capabilities or profile are invalid.');
  }
  // Selection metadata never expands adapter or observed model capabilities.
  const effective = { ...adapter };
  for (const key of [
    'supports_tool_calls', 'supports_structured_output', 'supports_streaming',
    'supports_session_resume', 'supports_parallel_sessions', 'supports_usage_reporting',
  ] as const) effective[key] = adapter[key] && profile[key];
  effective.supports_niwa_tool_loop = adapter.supports_niwa_tool_loop && effective.supports_tool_calls;
  if (!isCapabilityConsistent(effective)) throw new Error('Effective capabilities are inconsistent.');
  return Object.freeze(effective);
}
