// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/contracts/src/model-adapter-capabilities.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import { Type, type Static } from '@sinclair/typebox';

export const executionModeSchema = Type.Union([
  Type.Literal('model_api'),
  Type.Literal('agent_runtime'),
]);

export const authModeSchema = Type.Union([
  Type.Literal('api_key'),
  Type.Literal('subscription_oauth'),
  Type.Literal('provider_managed'),
  Type.Literal('none'),
]);

export const billingModeSchema = Type.Union([
  Type.Literal('api_usage'),
  Type.Literal('subscription'),
  Type.Literal('external_provider'),
  Type.Literal('none'),
]);

export const modelAdapterCapabilitiesSchema = Type.Object(
  {
    execution_mode: executionModeSchema,
    auth_mode: authModeSchema,
    billing_mode: billingModeSchema,
    owns_agent_loop: Type.Boolean(),
    supports_niwa_tool_loop: Type.Boolean(),
    supports_tool_calls: Type.Boolean(),
    supports_structured_output: Type.Boolean(),
    supports_streaming: Type.Boolean(),
    supports_session_resume: Type.Boolean(),
    supports_parallel_sessions: Type.Boolean(),
    supports_usage_reporting: Type.Boolean(),
  },
  { $id: 'ModelAdapterCapabilities', additionalProperties: false },
);

export type ModelAdapterCapabilities = Static<typeof modelAdapterCapabilitiesSchema>;

export const capabilityConsistencyIssueCodeSchema = Type.Union([
  Type.Literal('MODEL_API_OWNS_AGENT_LOOP'),
  Type.Literal('AGENT_RUNTIME_WITHOUT_AGENT_LOOP'),
  Type.Literal('AGENT_RUNTIME_WITH_NIWA_TOOL_LOOP'),
  Type.Literal('NIWA_TOOL_LOOP_REQUIRES_MODEL_API'),
  Type.Literal('NIWA_TOOL_LOOP_REQUIRES_TOOL_CALLS'),
  Type.Literal('SUBSCRIPTION_OAUTH_REQUIRES_SUBSCRIPTION_BILLING'),
  Type.Literal('AUTH_NONE_REQUIRES_BILLING_NONE'),
  Type.Literal('BILLING_NONE_REQUIRES_AUTH_NONE'),
  Type.Literal('API_KEY_REQUIRES_USAGE_OR_EXTERNAL_BILLING'),
  Type.Literal('SUBSCRIPTION_BILLING_REQUIRES_MANAGED_AUTH'),
  Type.Literal('PROVIDER_MANAGED_REQUIRES_EXTERNAL_OR_SUBSCRIPTION_BILLING'),
]);

export type CapabilityConsistencyIssueCode = Static<
  typeof capabilityConsistencyIssueCodeSchema
>;

export interface CapabilityConsistencyIssue {
  code: CapabilityConsistencyIssueCode;
  fields: readonly (keyof ModelAdapterCapabilities)[];
  message: string;
}

export function validateCapabilityConsistency(
  capabilities: ModelAdapterCapabilities,
): CapabilityConsistencyIssue[] {
  const issues: CapabilityConsistencyIssue[] = [];

  if (capabilities.execution_mode === 'model_api' && capabilities.owns_agent_loop) {
    issues.push({
      code: 'MODEL_API_OWNS_AGENT_LOOP',
      fields: ['execution_mode', 'owns_agent_loop'],
      message: 'A model API adapter cannot own the agent loop.',
    });
  }

  if (capabilities.execution_mode === 'agent_runtime' && !capabilities.owns_agent_loop) {
    issues.push({
      code: 'AGENT_RUNTIME_WITHOUT_AGENT_LOOP',
      fields: ['execution_mode', 'owns_agent_loop'],
      message: 'An agent runtime must own its agent loop.',
    });
  }

  if (
    capabilities.execution_mode === 'agent_runtime' &&
    capabilities.supports_niwa_tool_loop
  ) {
    issues.push({
      code: 'AGENT_RUNTIME_WITH_NIWA_TOOL_LOOP',
      fields: ['execution_mode', 'supports_niwa_tool_loop'],
      message: 'A provider-owned agent runtime cannot use the Carried tool loop.',
    });
  }

  if (
    capabilities.supports_niwa_tool_loop &&
    capabilities.execution_mode !== 'model_api'
  ) {
    issues.push({
      code: 'NIWA_TOOL_LOOP_REQUIRES_MODEL_API',
      fields: ['supports_niwa_tool_loop', 'execution_mode'],
      message: 'The Carried tool loop requires model API execution mode.',
    });
  }

  if (capabilities.supports_niwa_tool_loop && !capabilities.supports_tool_calls) {
    issues.push({
      code: 'NIWA_TOOL_LOOP_REQUIRES_TOOL_CALLS',
      fields: ['supports_niwa_tool_loop', 'supports_tool_calls'],
      message: 'The Carried tool loop requires structured tool calls.',
    });
  }

  if (
    capabilities.auth_mode === 'subscription_oauth' &&
    capabilities.billing_mode !== 'subscription'
  ) {
    issues.push({
      code: 'SUBSCRIPTION_OAUTH_REQUIRES_SUBSCRIPTION_BILLING',
      fields: ['auth_mode', 'billing_mode'],
      message: 'Subscription OAuth requires subscription billing.',
    });
  }

  if (capabilities.auth_mode === 'none' && capabilities.billing_mode !== 'none') {
    issues.push({
      code: 'AUTH_NONE_REQUIRES_BILLING_NONE',
      fields: ['auth_mode', 'billing_mode'],
      message: 'An adapter without authentication must also use no billing.',
    });
  }

  if (capabilities.billing_mode === 'none' && capabilities.auth_mode !== 'none') {
    issues.push({
      code: 'BILLING_NONE_REQUIRES_AUTH_NONE',
      fields: ['billing_mode', 'auth_mode'],
      message: 'No billing is only valid with no authentication.',
    });
  }

  if (
    capabilities.auth_mode === 'api_key' &&
    capabilities.billing_mode !== 'api_usage' &&
    capabilities.billing_mode !== 'external_provider'
  ) {
    issues.push({
      code: 'API_KEY_REQUIRES_USAGE_OR_EXTERNAL_BILLING',
      fields: ['auth_mode', 'billing_mode'],
      message: 'API-key authentication requires API usage or external-provider billing.',
    });
  }

  if (
    capabilities.billing_mode === 'subscription' &&
    capabilities.auth_mode !== 'subscription_oauth' &&
    capabilities.auth_mode !== 'provider_managed'
  ) {
    issues.push({
      code: 'SUBSCRIPTION_BILLING_REQUIRES_MANAGED_AUTH',
      fields: ['billing_mode', 'auth_mode'],
      message: 'Subscription billing requires subscription OAuth or provider-managed auth.',
    });
  }

  if (
    capabilities.auth_mode === 'provider_managed' &&
    capabilities.billing_mode !== 'subscription' &&
    capabilities.billing_mode !== 'external_provider'
  ) {
    issues.push({
      code: 'PROVIDER_MANAGED_REQUIRES_EXTERNAL_OR_SUBSCRIPTION_BILLING',
      fields: ['auth_mode', 'billing_mode'],
      message: 'Provider-managed auth requires subscription or external-provider billing.',
    });
  }

  return issues;
}

export function isCapabilityConsistent(capabilities: ModelAdapterCapabilities): boolean {
  return validateCapabilityConsistency(capabilities).length === 0;
}
