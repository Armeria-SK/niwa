import { OpenAISubscriptionAdapter, type OpenAISubscriptionAdapterConfig } from './adapter.ts';
import { OpenAISubscriptionModelCatalogAdapter } from './model-catalog.ts';
import { DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE } from './compatibility.ts';
import type { ModelProfile } from '../shared/profile.ts';
import type { ModelAdapter } from '../shared/adapter.ts';

/** One instance per account in the host; never share a task adapter across bots or rooms. */
export class CodexConnection {
  #config: Omit<OpenAISubscriptionAdapterConfig, 'model_profile'>;
  readonly catalog: OpenAISubscriptionModelCatalogAdapter;
  constructor(config: Omit<OpenAISubscriptionAdapterConfig, 'model_profile'>) {
    this.#config = { ...config };
    this.catalog = new OpenAISubscriptionModelCatalogAdapter({
      experimental_opt_in: config.experimental_opt_in,
      credential_store: config.credential_store,
      client_version: config.compatibility_profile?.client_version ?? DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.client_version,
      ...(config.fetch ? { fetch: config.fetch } : {}),
      ...(config.base_url ? { base_url: config.base_url } : {}),
      ...(config.refresh ? { refresh: config.refresh } : {}),
    });
  }
  create(profile: ModelProfile): ModelAdapter {
    const adapter = new OpenAISubscriptionAdapter({ ...this.#config, model_profile: profile });
    // Each task gets independent continuation state; only OAuth refresh remains account-coordinated.
    return { adapter_id: adapter.adapter_id, capabilities: { ...adapter.capabilities, supports_parallel_sessions: true },
      supported_efforts: adapter.supported_efforts, ...(adapter.context_window === undefined ? {} : { context_window: adapter.context_window }),
      run: adapter.run.bind(adapter) };
  }
}
