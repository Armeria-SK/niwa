// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/providers/src/openai-subscription-transport.ts.
// Apache-2.0. Modified for Niwa; upstream revision and source path are recorded above.
import type { OAuthCredential } from '../../auth/credential-store.ts';

export const DEFAULT_SUBSCRIPTION_BASE_URL = 'https://chatgpt.com/backend-api/codex/';
export const DEFAULT_SUBSCRIPTION_ORIGINATOR = 'niwa';
export const DEFAULT_SUBSCRIPTION_USER_AGENT = 'niwa/0.1';

export interface SubscriptionRequestIdentity {
  readonly originator?: string;
  readonly user_agent?: string;
}

/** Shared private transport boundary for the experimental subscription
 * endpoints. Callers decide their own Accept/Content-Type headers; this
 * helper prevents independent Authorization / account-id implementations. */
export function createSubscriptionHeaders(
  credential: OAuthCredential,
  options: SubscriptionRequestIdentity & { readonly accept: string; readonly content_type?: string },
): Record<string, string> {
  const originator = validateHeaderValue(options.originator ?? DEFAULT_SUBSCRIPTION_ORIGINATOR, 'originator');
  const userAgent = validateHeaderValue(options.user_agent ?? DEFAULT_SUBSCRIPTION_USER_AGENT, 'user_agent');
  const accept = validateHeaderValue(options.accept, 'accept');
  const contentType = options.content_type === undefined ? undefined : validateHeaderValue(options.content_type, 'content_type');
  return {
    Authorization: `Bearer ${credential.access_token}`,
    Accept: accept,
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    originator,
    'User-Agent': userAgent,
    ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
    ...(credential.account_id === undefined ? {} : { 'chatgpt-account-id': credential.account_id }),
  };
}

export function normalizeSubscriptionBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GPT subscription base_url must be an absolute URL.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('GPT subscription base_url requires HTTPS.');
  const chatgptHost = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
  if (!loopback && !chatgptHost) throw new Error('GPT subscription base_url must use the ChatGPT host.');
  if (url.username || url.password || url.search || url.hash) throw new Error('GPT subscription base_url contains forbidden URL components.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function validateSubscriptionHeaderValue(value: string, name: string): string {
  return validateHeaderValue(value, name);
}

function validateHeaderValue(value: string, name: string): string {
  if (value.length === 0 || value.length > 256 || [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return code <= 0x1f || code === 0x7f;
  })) throw new Error(`${name} contains invalid header characters.`);
  return value;
}
