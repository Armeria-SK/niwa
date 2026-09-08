// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/model-input-safety.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import type { JsonObject, ModelMessage, ModelRequest } from '../../contracts/index.ts';

import { isSensitiveName, sanitizeModelInputText } from '../../shared/redaction.ts';

export interface SanitizedModelRequest {
  readonly request: ModelRequest;
  readonly redaction_count: number;
}

export interface SanitizedModelInputJson {
  readonly value: JsonObject;
  readonly redaction_count: number;
}

/**
 * Return true only when an exact credential currently owned by the host occurs
 * in the inspected JSON-like value. Sensitive-looking property names are not
 * credential material. Object keys are nevertheless scanned for an exact
 * configured value because the fail-closed boundary covers the whole outbound
 * payload.
 */
export function containsExactCredentialMaterial(
  value: unknown,
  exactSecrets: readonly string[],
): boolean {
  const secrets = exactSecrets.filter((secret) => secret.length > 0);
  if (secrets.length === 0) return false;
  return containsExact(value, secrets);
}

/**
 * Structural identifiers cannot be rewritten without breaking request
 * correlation. Reject only high-confidence secret-shaped identifier values;
 * ordinary auth/credential/token names remain valid.
 */
export function containsHighConfidenceSecretIdentifier(request: ModelRequest): boolean {
  const identifiers = [
    ...request.tools.map((tool) => tool.name),
    ...(request.response_contract.type === 'json_schema' ? [request.response_contract.name] : []),
    ...request.messages.flatMap((message) => {
      if (message.role === 'user') return [];
      if (message.role === 'tool') return [message.tool_call_id, message.name];
      return message.tool_calls?.flatMap((call) => [call.tool_call_id, call.name]) ?? [];
    }),
  ];
  return identifiers.some((identifier) => sanitizeModelInputText(identifier).redaction_count > 0);
}

/** Tool arguments with secret-semantic keys remain non-executable. */
export function containsSensitiveJsonKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveJsonKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => isSensitiveName(key) || containsSensitiveJsonKey(child),
  );
}

/**
 * Clone a ModelRequest while sanitizing high-confidence secret values in every
 * string value. Property names remain unchanged, so repository source and JSON
 * schemas can describe auth/credential/token fields without being corrupted.
 */
export function sanitizeModelRequestTextFields(request: ModelRequest): SanitizedModelRequest {
  const state = { redaction_count: 0 };
  const text = (value: string): string => {
    const sanitized = sanitizeModelInputText(value);
    state.redaction_count += sanitized.redaction_count;
    return sanitized.text;
  };
  const messages = request.messages.map((message): ModelMessage => {
    if (message.role === 'user') return { role: 'user', content: text(message.content) };
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        name: message.name,
        content: text(message.content),
      };
    }
    return {
      role: 'assistant',
      ...(message.content === undefined ? {} : { content: text(message.content) }),
      ...(message.tool_calls === undefined ? {} : {
        tool_calls: message.tool_calls.map((call) => ({
          tool_call_id: call.tool_call_id,
          name: call.name,
          arguments: sanitizeJsonTextValues(call.arguments, text),
        })),
      }),
    };
  });
  const sanitized: ModelRequest = {
    ...request,
    system_instructions: text(request.system_instructions),
    messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: text(tool.description),
      input_schema: sanitizeJsonTextValues(tool.input_schema, text),
    })),
    response_contract: request.response_contract.type === 'text'
      ? { type: 'text' }
      : {
        ...request.response_contract,
        schema: sanitizeJsonTextValues(request.response_contract.schema, text),
      },
    model_options: { ...request.model_options },
    budget: { ...request.budget },
  };
  return Object.freeze({ request: sanitized, redaction_count: state.redaction_count });
}

/** Sanitize string values in a JSON object while preserving every key. */
export function sanitizeModelInputJsonValues(value: JsonObject): SanitizedModelInputJson {
  let redactionCount = 0;
  const sanitized = sanitizeJsonTextValues(value, (text) => {
    const result = sanitizeModelInputText(text);
    redactionCount += result.redaction_count;
    return result.text;
  });
  return Object.freeze({ value: sanitized, redaction_count: redactionCount });
}

function containsExact(value: unknown, exactSecrets: readonly string[]): boolean {
  if (typeof value === 'string') return exactSecrets.some((secret) => value.includes(secret));
  if (Array.isArray(value)) return value.some((child) => containsExact(child, exactSecrets));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      exactSecrets.some((secret) => key.includes(secret)) || containsExact(child, exactSecrets),
  );
}

function sanitizeJsonTextValues(value: JsonObject, text: (value: string) => string): JsonObject {
  return sanitizeJsonValue(value, text) as JsonObject;
}

function sanitizeJsonValue(value: unknown, text: (value: string) => string): unknown {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((child) => sanitizeJsonValue(child, text));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeJsonValue(child, text)]),
  );
}
