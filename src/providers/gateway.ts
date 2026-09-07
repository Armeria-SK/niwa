import type { Agent } from '../domain/types.ts';
import { check } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { ResolveAdapter } from '../runtime/turns.ts';
import { inspectOllamaModel, listOllamaModels, OllamaAdapter } from './ollama/adapter.ts';
import type { Subscription } from '../auth/subscription.ts';
import { createHash } from 'node:crypto';
import { ConnectionGate } from './shared/serial.ts';
import type { ModelAdapter } from './shared/adapter.ts';

/** Host-owned selection and discovery. URLs and model identity never come from model tool calls. */
export class ModelGateway {
  #runtime: Runtime;
  #fetch: typeof fetch;
  #gate = new ConnectionGate();
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
      const subscription = this.subscription; const generation = subscription.revision;
      const credential = await subscription.account.read();
      check(credential, 'conflict', 'Subscription login is required');
      check(credential.account_id, 'conflict', 'Subscription account identity is required');
      const key = createHash('sha256').update(credential.account_id).digest('hex');
      const runtime = this.#runtime; const admin = runtime.administrator();
      if (runtime.providerLimits.blocked(admin, key)) {
        const fallback = await this.#fallback(agent, signal);
        check(subscription.revision === generation, 'conflict', 'Subscription account changed'); return fallback;
      }
      const profile = await this.subscription.profile(agent.model, agent.reasoning); signal?.throwIfAborted();
      check(subscription.revision === generation, 'conflict', 'Subscription account changed');
      const adapter = subscription.connection.create(profile);
      return this.#gate.wrap({ adapter_id: adapter.adapter_id, capabilities: adapter.capabilities,
        ...(adapter.context_window === undefined ? {} : { context_window: adapter.context_window }),
        async *run(request, options) {
          check(subscription.revision === generation, 'conflict', 'Subscription account changed');
          const revision = runtime.providerLimits.begin(admin, key);
          if (revision === undefined) {
            yield { type: 'failed', error: { code: 'QUOTA_EXCEEDED', message: 'Subscription quota is waiting for recovery', retryable: true } }; return;
          }
          runtime.recordModelRoute(admin, agent.id, 'openai_subscription', agent.model, 'configured');
          let completed = false; let failed = false;
          for await (const event of adapter.run(request, options)) {
            if (subscription.revision === generation) {
              if (event.type === 'failed') { failed = true; if (event.error.code === 'QUOTA_EXCEEDED') runtime.providerLimits.exceeded(admin, key, event.error.reset_at); }
              if (event.type === 'completed') completed = true;
            }
            yield event;
          }
          if (completed && !failed && subscription.revision === generation) runtime.providerLimits.recovered(admin, key, revision);
        },
      });
    }
    check(agent.provider === 'ollama', 'conflict', 'Subscription login and capability verification are required');
    const url = this.#url();
    const model = await inspectOllamaModel(url, agent.model, this.#fetch);
    signal?.throwIfAborted();
    check(this.#url() === url, 'conflict', 'Ollama configuration changed during discovery');
    return this.#record(new OllamaAdapter(url, model, this.#fetch), agent.id, agent.model, 'configured');
  };
  #record(adapter: ModelAdapter, agentId: string, model: string, reason: 'configured' | 'quota'): ModelAdapter {
    const runtime = this.#runtime;
    return { adapter_id: adapter.adapter_id, capabilities: adapter.capabilities,
      ...(adapter.context_window === undefined ? {} : { context_window: adapter.context_window }),
      async *run(request, options) {
        options?.signal?.throwIfAborted();
        runtime.recordModelRoute(runtime.administrator(), agentId, 'ollama', model, reason);
        yield* adapter.run(request, options);
      },
    };
  }
  async #fallback(agent: Agent, signal?: AbortSignal): Promise<ModelAdapter> {
    const admin = this.#runtime.administrator(); const settings = this.#runtime.modelSettings(admin);
    check(settings.ollamaUrl && settings.fallbackModel, 'conflict', 'A verified fallback model is required');
    const model = await inspectOllamaModel(settings.ollamaUrl, settings.fallbackModel, this.#fetch);
    signal?.throwIfAborted();
    check(model.tools, 'conflict', 'Fallback model must support tools');
    const current = this.#runtime.modelSettings(admin);
    check(current.ollamaUrl === settings.ollamaUrl && current.fallbackModel === settings.fallbackModel, 'conflict', 'Fallback settings changed');
    return this.#record(new OllamaAdapter(settings.ollamaUrl, model, this.#fetch), agent.id, settings.fallbackModel, 'quota');
  }
}
