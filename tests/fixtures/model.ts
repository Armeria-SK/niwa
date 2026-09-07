import type { ModelRequest } from '../../src/contracts/model.ts';
import type { ModelProfile } from '../../src/providers/shared/profile.ts';
import type { OAuthCredential } from '../../src/auth/credential-store.ts';

export const profile: ModelProfile = {
  runtime: 'gpt', provider_id: 'openai_subscription', provider_model_id: 'artificial-model',
  supported_efforts: ['low'], max_output_tokens: 4096,
  supports_tool_calls: true, supports_structured_output: true, supports_streaming: false,
  supports_session_resume: false, supports_parallel_sessions: false, supports_usage_reporting: true,
};
export const request: ModelRequest = {
  system_instructions: 'Artificial test instructions.', messages: [{ role: 'user', content: 'Hello' }],
  tools: [], response_contract: { type: 'text' }, reasoning_effort: 'low', model_options: {},
  budget: { max_output_tokens: 100, max_total_tokens: 1000, max_requests: 3, max_tool_calls: 3 },
};
export const credential: OAuthCredential = {
  access_token: 'artificial-access-value', refresh_token: 'artificial-refresh-value',
  expires_at: 9_999_999_999_999, account_id: 'artificial-account',
};
export function frame(value: Record<string, unknown>): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}
export function response(text = 'こんにちは'): Response {
  const bytes = new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: text })
    + frame({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }));
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(index, index + 7)); index += 7; }
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
