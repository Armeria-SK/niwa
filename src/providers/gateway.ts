import {ModelSetupError, setupFailure} from './shared/setup-error.ts';
import type { Agent, FallbackProvider } from '../domain/types.ts';
import { check, DomainError } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { ResolveAdapter } from '../runtime/turns.ts';
import { inspectOllamaModel, listOllamaModels, ollamaUrl, OllamaAdapter, type OllamaSlot } from './ollama/adapter.ts';
import { OllamaLimiter } from './ollama/limiter.ts';
import type { Subscription } from '../auth/subscription.ts';
import { createHash } from 'node:crypto';
import type { ModelAdapter } from './shared/adapter.ts';
import { EndpointLimiter } from './shared/limiter.ts';
import { listCompatibleModels, OpenAICompatibleAdapter } from './openai-compatible/adapter.ts';
import { compatibleUrl, normalizeCompatibleUrl } from './openai-compatible/url.ts';
import { validApiKey, type ApiKeyStore } from '../auth/api-key.ts';
import { ANTHROPIC_ORIGIN, AnthropicAdapter, DEFAULT_ANTHROPIC_MODEL, listAnthropicModels, unlistedAnthropicModel, type AnthropicModel } from './anthropic/adapter.ts';

interface CompatibleTarget { readonly url: string; readonly key: string | undefined; readonly revision: number }
const COMPATIBLE_MODEL = /^[^\x00-\x1f\x7f]{1,256}$/u;
const ANTHROPIC_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const ANTHROPIC_EFFORTS = ['native', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Claude API key and options. The key is bound to the official API origin and is never sent anywhere else. */
export interface AnthropicOptions { readonly key: ApiKeyStore; readonly reasoningSummary?: boolean }
interface AnthropicTarget { readonly key: string; readonly revision: number }

/** Host-owned selection and discovery. URLs and model identity never come from model tool calls. */
export class ModelGateway {
  #runtime: Runtime;
  #fetch: typeof fetch;
  #limiter = new OllamaLimiter();
  #compatibleLimiter = new EndpointLimiter();
  readonly subscription: Subscription | undefined;
  /** OpenAI-compatible API key. Absent when the host has no secrets directory (tests, embedded use). */
  readonly compatibleKey: ApiKeyStore | undefined;
  readonly #anthropic: AnthropicOptions | undefined;
  #anthropicLimiter = new EndpointLimiter();
  #anthropicModels: { revision: number; at: number; models: AnthropicModel[] } | undefined;
  constructor(runtime: Runtime, fetchImpl = fetch, subscription?: Subscription, compatibleKey?: ApiKeyStore, anthropic?: AnthropicOptions) {
    this.#runtime = runtime; this.#fetch = fetchImpl; this.subscription = subscription; this.compatibleKey = compatibleKey; this.#anthropic = anthropic;
  }
  /** The stored key, only when it was saved for the official API origin. */
  async #anthropicTarget(): Promise<AnthropicTarget | undefined> {
    const store = this.#anthropic?.key; if (!store) return undefined;
    const revision = store.revision; const record = await store.read();
    return record && record.origin === ANTHROPIC_ORIGIN ? { key: record.key, revision } : undefined;
  }
  async #anthropicRequired(): Promise<AnthropicTarget> {
    const target = await this.#anthropicTarget();
    if (!target) throw new ModelSetupError({ code: 'AUTH_UNAVAILABLE', retryable: false, message: 'Claude（Anthropic API）のAPIキーを「設定」→「モデルと接続」で保存してください。' });
    return target;
  }
  /** Model list for this key, newest first. Cached briefly so resolving a bot does not list models on every step. */
  async #anthropicList(target: AnthropicTarget, fresh = false, signal?: AbortSignal): Promise<AnthropicModel[]> {
    const cached = this.#anthropicModels;
    if (!fresh && cached && cached.revision === target.revision && Date.now() - cached.at < 600_000) return cached.models;
    const models = await listAnthropicModels(target.key, this.#fetch, signal);
    if ((this.#anthropic?.key.revision ?? 0) === target.revision) this.#anthropicModels = { revision: target.revision, at: Date.now(), models };
    return models;
  }
  /** Capabilities of the selected model; a typed id is used as-is when the list cannot be read for reasons other than the key. */
  async #anthropicModel(target: AnthropicTarget, model: string, signal?: AbortSignal): Promise<AnthropicModel> {
    try { return (await this.#anthropicList(target, false, signal)).find(item => item.id === model) ?? unlistedAnthropicModel(model); }
    catch (error) { if (['AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'ABORTED'].includes(setupFailure(error).code)) throw error; return unlistedAnthropicModel(model); }
  }
  #anthropicAdapter(target: AnthropicTarget, model: AnthropicModel): AnthropicAdapter {
    const runtime = this.#runtime;
    return new AnthropicAdapter({ apiKey: target.key, fetch: this.#fetch, summary: this.#anthropic?.reasoningSummary === true,
      slot: signal => this.#anthropicLimiter.acquire(ANTHROPIC_ORIGIN, () => runtime.modelSettings(runtime.administrator()).anthropicParallel, signal) }, model);
  }
  async anthropicStatus() {
    const settings = this.#runtime.modelSettings(this.#runtime.administrator());
    return { available: !!this.#anthropic, parallel: settings.anthropicParallel, keyConfigured: !!(await this.#anthropicTarget()), defaultModel: DEFAULT_ANTHROPIC_MODEL };
  }
  /** Parallelism and key are validated together so a rejected field never leaves a partial save. */
  async configureAnthropic(input: { apiKey?: string; parallel?: number }) {
    const admin = this.#runtime.administrator();
    if (input.apiKey !== undefined) {
      check(this.#anthropic, 'conflict', 'API key storage unavailable');
      check(validApiKey(input.apiKey), 'invalid', 'Invalid API key');
    }
    check(input.parallel === undefined || (Number.isInteger(input.parallel) && input.parallel >= 1 && input.parallel <= 8), 'invalid', 'Invalid parallel request count');
    if (input.parallel !== undefined) this.#runtime.configureAnthropicParallel(admin, input.parallel);
    if (input.apiKey !== undefined) {
      await this.#anthropic!.key.write({ origin: ANTHROPIC_ORIGIN, key: input.apiKey });
      this.#anthropicModels = undefined;
      this.#runtime.invalidateProvider(admin, 'anthropic');
    }
    return this.anthropicStatus();
  }
  async clearAnthropicKey() {
    check(this.#anthropic, 'conflict', 'API key storage unavailable');
    await this.#anthropic.key.clear(); this.#anthropicModels = undefined;
    this.#runtime.invalidateProvider(this.#runtime.administrator(), 'anthropic');
    return this.anthropicStatus();
  }
  /** Models the key can use, newest first, with display names and the effort levels each model accepts. */
  async anthropicCatalog() {
    const models = await this.#anthropicList(await this.#anthropicRequired(), true);
    return models.map(model => ({ provider: 'anthropic' as const, model: model.id, model_id: model.id, display_name: model.display_name, created_at: model.created_at,
      supported_efforts: model.efforts.length ? [...model.efforts] : ['native'], default_effort: model.efforts.length ? (model.efforts.includes('medium') ? 'medium' : model.efforts[0]!) : 'native' }));
  }
  /** Lists models only, so the check itself is not billed. */
  async checkAnthropic(): Promise<{ ok: true; models: number } | { ok: false; code: string; message: string }> {
    try { return { ok: true, models: (await this.anthropicCatalog()).length }; }
    catch (error) { const failure = setupFailure(error); return { ok: false, code: failure.code === 'AUTH_UNAVAILABLE' ? 'NOT_CONFIGURED' : failure.code, message: failure.message }; }
  }
  async selectAnthropic(agentId: string, model: string, effort: string): Promise<Agent> {
    (await this.#verify('anthropic', model, effort))();
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'anthropic', model, effort);
  }
  /** The stored key is used only for the origin it was entered for, so changing the URL never sends it elsewhere. */
  async #compatible(): Promise<CompatibleTarget> {
    const url = this.#runtime.modelSettings(this.#runtime.administrator()).compatibleUrl;
    check(url, 'conflict', 'OpenAI-compatible API is not configured');
    const revision = this.compatibleKey?.revision ?? 0;
    const record = await this.compatibleKey?.read();
    return { url, key: record && record.origin === new URL(url).origin ? record.key : undefined, revision };
  }
  #compatibleCurrent(target: CompatibleTarget): () => void {
    return () => check(this.#runtime.modelSettings(this.#runtime.administrator()).compatibleUrl === target.url && (this.compatibleKey?.revision ?? 0) === target.revision,
      'conflict', 'OpenAI-compatible configuration changed during discovery');
  }
  #compatibleAdapter(target: CompatibleTarget, model: string): OpenAICompatibleAdapter {
    const runtime = this.#runtime; const lane = compatibleUrl(target.url, 'chat/completions').href;
    return new OpenAICompatibleAdapter({ baseUrl: target.url, apiKey: target.key, fetch: this.#fetch,
      slot: signal => this.#compatibleLimiter.acquire(lane, () => runtime.modelSettings(runtime.administrator()).compatibleParallel, signal) }, model);
  }
  async compatibleStatus() {
    const settings = this.#runtime.modelSettings(this.#runtime.administrator());
    const record = this.compatibleKey ? await this.compatibleKey.read() : undefined;
    return { available: !!this.compatibleKey, url: settings.compatibleUrl, parallel: settings.compatibleParallel,
      keyConfigured: !!record && !!settings.compatibleUrl && record.origin === new URL(settings.compatibleUrl).origin };
  }
  /** URL, parallelism and key are saved in that order; the key is bound to the saved URL's origin. */
  async configureCompatible(input: { url?: string | null; apiKey?: string; parallel?: number }) {
    const admin = this.#runtime.administrator();
    // Validate everything first so a rejected field never leaves a partial save.
    if (input.apiKey !== undefined) {
      check(this.compatibleKey, 'conflict', 'API key storage unavailable');
      check(validApiKey(input.apiKey), 'invalid', 'Invalid API key');
    }
    check(input.url === undefined || input.url === null || normalizeCompatibleUrl(input.url) !== undefined, 'invalid', 'Invalid OpenAI-compatible URL');
    check(input.parallel === undefined || (Number.isInteger(input.parallel) && input.parallel >= 1 && input.parallel <= 8), 'invalid', 'Invalid parallel request count');
    if (input.url !== undefined) this.#runtime.configureCompatible(admin, input.url);
    if (input.parallel !== undefined) this.#runtime.configureCompatibleParallel(admin, input.parallel);
    if (input.apiKey !== undefined) {
      const url = this.#runtime.modelSettings(admin).compatibleUrl;
      check(url, 'invalid', 'Save the OpenAI-compatible URL with the key');
      await this.compatibleKey!.write({ origin: new URL(url).origin, key: input.apiKey });
      this.#runtime.invalidateProvider(admin, 'openai_compatible');
    }
    return this.compatibleStatus();
  }
  async clearCompatibleKey() {
    check(this.compatibleKey, 'conflict', 'API key storage unavailable');
    await this.compatibleKey.clear();
    this.#runtime.invalidateProvider(this.#runtime.administrator(), 'openai_compatible');
    return this.compatibleStatus();
  }
  async compatibleCatalog(): Promise<{ provider: 'openai_compatible'; model: string }[]> {
    const target = await this.#compatible();
    return (await listCompatibleModels(target.url, target.key, this.#fetch)).map(model => ({ provider: 'openai_compatible', model }));
  }
  /** Lists models only, so the check itself is not billed. Failures carry a trusted message, never the key or response body. */
  async checkCompatible(): Promise<{ ok: true; models: number } | { ok: false; code: string; message: string }> {
    try { return { ok: true, models: (await this.compatibleCatalog()).length }; }
    catch (error) {
      if (error instanceof DomainError) return { ok: false, code: 'NOT_CONFIGURED', message: '接続先URLを保存してください。' };
      const failure = setupFailure(error); return { ok: false, code: failure.code, message: failure.message };
    }
  }
  async selectCompatible(agentId: string, model: string): Promise<Agent> {
    (await this.#verify('openai_compatible', model, 'native'))();
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'openai_compatible', model, 'native');
  }
  #slot(url: string): OllamaSlot {
    const key = ollamaUrl(url, 'chat').href;
    return signal => this.#limiter.acquire(key, () => this.#runtime.modelSettings(this.#runtime.administrator()).maxParallel, signal);
  }
  #url(): string {
    const url = this.#runtime.modelSettings(this.#runtime.administrator()).ollamaUrl;
    check(url, 'conflict', 'Ollama is not configured');
    return url;
  }
  async catalog(): Promise<{ provider: 'ollama'; model: string }[]> {
    return (await listOllamaModels(this.#url(), this.#fetch)).map(model => ({ provider: 'ollama', model }));
  }
  async select(agentId: string, model: string): Promise<Agent> {
    (await this.#verify('ollama', model, 'native'))();
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'ollama', model, 'native');
  }
  async updateProfile(agentId: string, patch: Record<string, unknown>, version: string, selection?: Pick<Agent, 'provider' | 'model' | 'reasoning'>) {
    // Copy before discovery so validation and persistence always use the same input.
    patch = { ...patch }; selection = selection && { ...selection };
    if (selection) (await this.#verify(selection.provider, selection.model, selection.reasoning))();
    const admin = this.#runtime.administrator();
    this.#runtime.updateProfile(admin, agentId, patch, version, selection);
    return { version: this.#runtime.profileVersion(admin, agentId) };
  }
  async #verify(provider: Agent['provider'], model: string, effort: string): Promise<() => void> {
    if (provider === 'openai_subscription') {
      check(this.subscription, 'conflict', 'Subscription service unavailable');
      const revision = this.subscription.revision;
      await this.subscription.profile(model, effort);
      return () => check(this.subscription!.revision === revision, 'conflict', 'Subscription account changed');
    }
    if (provider === 'openai_compatible') {
      check(effort === 'native' && typeof model === 'string' && COMPATIBLE_MODEL.test(model) && model.trim() === model, 'invalid', 'Invalid OpenAI-compatible selection');
      const target = await this.#compatible();
      let available: string[] | undefined;
      try { available = await listCompatibleModels(target.url, target.key, this.#fetch); }
      catch (error) {
        // A server without a model list still accepts a typed model id; rejected credentials never do.
        const code = setupFailure(error).code;
        if (code === 'AUTHENTICATION_FAILED' || code === 'PERMISSION_DENIED' || code === 'ABORTED') throw error;
      }
      check(!available || available.includes(model), 'invalid', 'The model is not available');
      return this.#compatibleCurrent(target);
    }
    if (provider === 'anthropic') {
      check(typeof model === 'string' && ANTHROPIC_MODEL.test(model) && ANTHROPIC_EFFORTS.includes(effort), 'invalid', 'Invalid Claude selection');
      const target = await this.#anthropicRequired();
      let available: AnthropicModel[] | undefined;
      try { available = await this.#anthropicList(target, true); }
      catch (error) {
        // A typed model id is accepted when the list cannot be read; rejected keys never are.
        if (['AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'ABORTED'].includes(setupFailure(error).code)) throw error;
      }
      const found = available?.find(item => item.id === model);
      check(!available || found, 'invalid', 'The model is not available');
      // `native` leaves the level to Niwa's default (medium); a model without effort control accepts only that.
      check(!found || effort === 'native' || (found.efforts.length > 0 && (effort === 'minimal' || found.efforts.includes(effort as AnthropicModel['efforts'][number]))), 'invalid', 'The model does not support this reasoning effort');
      return () => check((this.#anthropic?.key.revision ?? 0) === target.revision, 'conflict', 'Claude API key changed during discovery');
    }
    check(provider === 'ollama' && effort === 'native', 'invalid', 'Invalid Ollama selection');
    const url = this.#url();
    const installed = await listOllamaModels(url, this.#fetch);
    check(installed.includes(model), 'invalid', 'The model is not installed');
    await inspectOllamaModel(url, model, this.#fetch);
    return () => check(this.#url() === url, 'conflict', 'Ollama configuration changed during discovery');
  }
  async selectFallback(model: string | null, provider: FallbackProvider = 'ollama'): Promise<ReturnType<Runtime['modelSettings']>> {
    const admin = this.#runtime.administrator();
    if (provider === 'anthropic') {
      if (model !== null) (await this.#verify('anthropic', model, 'native'))();
      this.#runtime.configureFallback(admin, ANTHROPIC_ORIGIN, model, provider);
      return this.#runtime.modelSettings(admin);
    }
    if (provider === 'openai_compatible') {
      // Chat Completions models are used with tools; the endpoint reports unsupported tools per request.
      if (model !== null) (await this.#verify('openai_compatible', model, 'native'))();
      this.#runtime.configureFallback(admin, this.#runtime.modelSettings(admin).compatibleUrl ?? '', model, provider);
      return this.#runtime.modelSettings(admin);
    }
    check(provider === 'ollama', 'invalid', 'Invalid fallback provider');
    const url = this.#url();
    if (model !== null) {
      check((await listOllamaModels(url, this.#fetch)).includes(model), 'invalid', 'The model is not installed');
      const capability = await inspectOllamaModel(url, model, this.#fetch);
      check(capability.tools, 'invalid', 'The fallback model must support tools');
    }
    this.#runtime.configureFallback(admin, url, model, provider);
    return this.#runtime.modelSettings(admin);
  }
  async selectSubscription(agentId: string, model: string, effort: string): Promise<Agent> {
    (await this.#verify('openai_subscription', model, effort))();
    return this.#runtime.setAgentModel(this.#runtime.administrator(), agentId, 'openai_subscription', model, effort);
  }
  async selectGenerated(provider: Agent['provider'], model: string, reasoning: string) {
    (await this.#verify(provider, model, reasoning))();
    const admin = this.#runtime.administrator();
    this.#runtime.configureGeneratedModel(admin, provider, model, reasoning);
    return this.#runtime.generatedModel(admin);
  }
  resolve: ResolveAdapter = async (agent, _taskId, signal) => {
    signal?.throwIfAborted();
    if (agent.provider === 'openai_subscription' && this.subscription) {
      const subscription = this.subscription; const generation = subscription.revision;
      const credential = await subscription.account.read();
      if(!credential)throw new ModelSetupError({code:'AUTH_UNAVAILABLE',retryable:false,message:'モデル接続のログインが必要です。'});
      if(!credential.account_id)throw new ModelSetupError({code:'AUTH_UNAVAILABLE',retryable:false,message:'モデル接続のアカウント情報を確認してください。'});
      const key = createHash('sha256').update(credential.account_id).digest('hex');
      const runtime = this.#runtime; const admin = runtime.administrator();
      if (runtime.providerLimits.blocked(admin, key)) {
        const settings=runtime.modelSettings(admin);
        if(!settings.fallbackModel||!(settings.fallbackProvider==='ollama'?settings.ollamaUrl:settings.fallbackProvider==='anthropic'?await this.#anthropicTarget():settings.compatibleUrl))throw new ModelSetupError({code:'QUOTA_EXCEEDED',retryable:true,message:'接続先の利用枠回復を待っています。',reset_at:Math.ceil(runtime.providerLimits.nextProbe(admin,key)/1000)});
        const fallback = await this.#fallback(agent, signal);
        check(subscription.revision === generation, 'conflict', 'Subscription account changed'); return fallback;
      }
      const profile = await this.subscription.profile(agent.model, agent.reasoning, signal); signal?.throwIfAborted();
      check(subscription.revision === generation, 'conflict', 'Subscription account changed');
      const adapter = subscription.connection.create(profile);
      return { adapter_id: adapter.adapter_id, capabilities: adapter.capabilities,
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
      };
    }
    if (agent.provider === 'openai_compatible') {
      let target: CompatibleTarget;
      try { target = await this.#compatible(); }
      catch (error) { throw error instanceof DomainError ? new ModelSetupError({ code: 'INVALID_REQUEST', retryable: false, message: 'OpenAI互換APIの接続先URLを設定してください。' }) : error; }
      signal?.throwIfAborted();
      return this.#record(this.#compatibleAdapter(target, agent.model), agent.id, 'openai_compatible', agent.model, 'configured');
    }
    if (agent.provider === 'anthropic') {
      const target = await this.#anthropicRequired();
      const model = await this.#anthropicModel(target, agent.model, signal); signal?.throwIfAborted();
      check((this.#anthropic?.key.revision ?? 0) === target.revision, 'conflict', 'Claude API key changed during discovery');
      return this.#record(this.#anthropicAdapter(target, model), agent.id, 'anthropic', agent.model, 'configured');
    }
    check(agent.provider === 'ollama', 'conflict', 'Subscription login and capability verification are required');
    const url = this.#url();
    const model = await inspectOllamaModel(url, agent.model, this.#fetch);
    signal?.throwIfAborted();
    check(this.#url() === url, 'conflict', 'Ollama configuration changed during discovery');
    return this.#record(new OllamaAdapter(url, model, this.#fetch, this.#slot(url)), agent.id, 'ollama', agent.model, 'configured');
  };
  #record(adapter: ModelAdapter, agentId: string, provider: Agent['provider'], model: string, reason: 'configured' | 'quota'): ModelAdapter {
    const runtime = this.#runtime;
    return { adapter_id: adapter.adapter_id, capabilities: adapter.capabilities,
      ...(adapter.context_window === undefined ? {} : { context_window: adapter.context_window }),
      async *run(request, options) {
        options?.signal?.throwIfAborted();
        runtime.recordModelRoute(runtime.administrator(), agentId, provider, model, reason);
        yield* adapter.run(request, options);
      },
    };
  }
  async #fallback(agent: Agent, signal?: AbortSignal): Promise<ModelAdapter> {
    const admin = this.#runtime.administrator(); const settings = this.#runtime.modelSettings(admin);
    if (settings.fallbackProvider === 'anthropic') {
      check(settings.fallbackModel, 'conflict', 'A verified fallback model is required');
      const target = await this.#anthropicRequired();
      const model = await this.#anthropicModel(target, settings.fallbackModel, signal); signal?.throwIfAborted();
      const current = this.#runtime.modelSettings(admin);
      check(current.fallbackProvider === 'anthropic' && current.fallbackModel === settings.fallbackModel, 'conflict', 'Fallback settings changed');
      return this.#record(this.#anthropicAdapter(target, model), agent.id, 'anthropic', settings.fallbackModel, 'quota');
    }
    if (settings.fallbackProvider === 'openai_compatible') {
      check(settings.compatibleUrl && settings.fallbackModel, 'conflict', 'A verified fallback model is required');
      const target = await this.#compatible(); signal?.throwIfAborted();
      const current = this.#runtime.modelSettings(admin);
      check(current.compatibleUrl === target.url && current.fallbackProvider === 'openai_compatible' && current.fallbackModel === settings.fallbackModel, 'conflict', 'Fallback settings changed');
      return this.#record(this.#compatibleAdapter(target, settings.fallbackModel), agent.id, 'openai_compatible', settings.fallbackModel, 'quota');
    }
    check(settings.ollamaUrl && settings.fallbackModel, 'conflict', 'A verified fallback model is required');
    const model = await inspectOllamaModel(settings.ollamaUrl, settings.fallbackModel, this.#fetch);
    signal?.throwIfAborted();
    check(model.tools, 'conflict', 'Fallback model must support tools');
    const current = this.#runtime.modelSettings(admin);
    check(current.ollamaUrl === settings.ollamaUrl && current.fallbackModel === settings.fallbackModel, 'conflict', 'Fallback settings changed');
    return this.#record(new OllamaAdapter(settings.ollamaUrl, model, this.#fetch, this.#slot(settings.ollamaUrl)), agent.id, 'ollama', settings.fallbackModel, 'quota');
  }
}
