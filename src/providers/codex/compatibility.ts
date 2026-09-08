// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/codex-responses-compatibility.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import { validateSubscriptionHeaderValue } from './transport.ts';

/**
 * The ChatGPT subscription endpoint is an internal Codex transport rather
 * than the public OpenAI Responses API.  Keep its compatibility identity
 * versioned and separate from Carried's product version.
 */
export interface CodexResponsesCompatibilityProfile {
  readonly protocol_revision: string;
  readonly client_version: string;
  readonly originator: string;
  readonly user_agent: string;
  readonly request_shape_version: number;
}

export const DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE: CodexResponsesCompatibilityProfile = Object.freeze({
  protocol_revision: 'responses-v1',
  client_version: '0.149.0',
  originator: 'codex_cli_rs',
  user_agent: 'codex_cli_rs/0.149.0',
  request_shape_version: 1,
});

/** Build a bounded, immutable profile for a first-party-compatible request. */
export function createCodexResponsesCompatibilityProfile(
  overrides: Partial<CodexResponsesCompatibilityProfile> = {},
): CodexResponsesCompatibilityProfile {
  const clientVersion = boundedToken(
    overrides.client_version ?? DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.client_version,
    'client_version',
  );
  const originator = validateSubscriptionHeaderValue(
    overrides.originator ?? DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.originator,
    'originator',
  );
  const userAgent = validateSubscriptionHeaderValue(
    overrides.user_agent ?? `${originator}/${clientVersion}`,
    'user_agent',
  );
  const protocolRevision = boundedToken(
    overrides.protocol_revision ?? DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.protocol_revision,
    'protocol_revision',
  );
  const shapeVersion = overrides.request_shape_version ?? DEFAULT_CODEX_RESPONSES_COMPATIBILITY_PROFILE.request_shape_version;
  if (!Number.isSafeInteger(shapeVersion) || shapeVersion < 1 || shapeVersion > 16) {
    throw new Error('request_shape_version must be a bounded positive safe integer.');
  }
  if (!userAgent.startsWith(`${originator}/`)) {
    throw new Error('user_agent must use the compatibility originator prefix.');
  }
  return Object.freeze({
    protocol_revision: protocolRevision,
    client_version: clientVersion,
    originator,
    user_agent: userAgent,
    request_shape_version: shapeVersion,
  });
}

function boundedToken(value: string, name: string): string {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`${name} contains invalid compatibility metadata.`);
  }
  return value;
}
