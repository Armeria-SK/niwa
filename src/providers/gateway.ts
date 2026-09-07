import type { Agent } from '../domain/types.ts';
import { check } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { ResolveAdapter } from '../runtime/turns.ts';
import { inspectOllamaModel, listOllamaModels, OllamaAdapter } from './ollama/adapter.ts';
import type { Subscription } from '../auth/subscription.ts';

/** Host-owned selection and discovery. URLs and model identity never come from model tool calls. */
export class ModelGateway {
  #runtime: Runtime;
  #fetch: typeof fetch;
  readonly subscription: Subscription | undefined;
  constructor(runtime: Runtime, fetchImpl = fetch, subscription?: Subscription) { this.#runtime = runtime; this.#fetch = fetchImpl; this.subscription = subscription; }
  #url(): string {
    const url = this.#runtime.modelSettings(this.#runtime.administrator()).ollamaUrl;
    check(url, 'conflict', 'Ollama is not configured');
    return url;
  }
  async catalog(): Promise<{ provider: 'ollama'; model: string }[]> {
    return (await listOllamaModels(this.#url(), this.#fetch)).map(model => ({ provider: 'ollama', model }));
  }
  async select(agentId: string, model: string): Promise<Agent> {
    const url = this.#url();
    const installed = await listOllamaModels(url, this.#fetch);
    check(installed.includes(model), 'invalid', 'The model is not installed');
    await inspectOllamaModel(url, model, this.#fetch);
    check(this.#url() === url, 'conflict', 'Ollama configuration changed during discovery');
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'ollama', model, 'native');
  }
  async selectFallback(model: string | null): Promise<ReturnType<Runtime['modelSettings']>> {
    const url = this.#url();
    if (model !== null) {
      check((await listOllamaModels(url, this.#fetch)).includes(model), 'invalid', 'The model is not installed');
      const capability = await inspectOllamaModel(url, model, this.#fetch);
      check(capability.tools, 'invalid', 'The fallback model must support tools');
    }
    this.#runtime.configureFallback(this.#runtime.administrator(), url, model);
    return this.#runtime.modelSettings(this.#runtime.administrator());
  }
  async selectSubscription(agentId: string, model: string, effort: string): Promise<Agent> {
    check(this.subscription, 'conflict', 'Subscription service unavailable');
    const revision = this.subscription.revision;
    await this.subscription.profile(model, effort);
    check(this.subscription.revision === revision, 'conflict', 'Subscription account changed');
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'openai_subscription', model, effort);
  }
  resolve: ResolveAdapter = async (agent, _taskId, signal) => {
    signal?.throwIfAborted();
    if (agent.provider === 'openai_subscription' && this.subscription) {
      const profile = await this.subscription.profile(agent.model, agent.reasoning); signal?.throwIfAborted();
      return this.subscription.connection.create(profile);
    }
    check(agent.provider === 'ollama', 'conflict', 'Subscription login and capability verification are required');
    const url = this.#url();
    const model = await inspectOllamaModel(url, agent.model, this.#fetch);
    signal?.throwIfAborted();
    check(this.#url() === url, 'conflict', 'Ollama configuration changed during discovery');
    return new OllamaAdapter(url, model, this.#fetch);
  };
}
