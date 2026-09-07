import { OpenAISubscriptionAdapter, type OpenAISubscriptionAdapterConfig } from './adapter.ts';
import { OpenAISubscriptionModelCatalogAdapter } from './model-catalog.ts';
import { DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE } from './compatibility.ts';
import { ConnectionGate } from '../shared/serial.ts';
import type { ModelProfile } from '../shared/profile.ts';
import type { ModelAdapter } from '../shared/adapter.ts';

/** One instance per account in the host; never share a task adapter across bots or rooms. */
export class CodexConnection {
  #gate = new ConnectionGate();
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
    return this.#gate.wrap(new OpenAISubscriptionAdapter({ ...this.#config, model_profile: profile }));
  }
}
