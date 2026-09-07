// Derived from Carried c695f855419ffc69d1e62b04f1de8de36c7c162d, core/auth/src/oauth.ts.
// Apache-2.0. Modified for Niwa; see THIRD_PARTY_NOTICES.md and provenance/carried.json.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { OAuthCredential } from './credential-store.ts';
import { validateCredential } from './credential-store.ts';

const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_SCOPE = 'openid profile email offline_access';
const DEFAULT_CALLBACK_HOST = 'localhost';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_CALLBACK_PATH = '/auth/callback';
const DEFAULT_AUTHORIZE_PARAMS = Object.freeze({
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: 'niwa',
});
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export interface OAuthClientConfig {
  /** Required for the experimental ChatGPT subscription login boundary. */
  readonly experimental_opt_in?: boolean;
  readonly client_id?: string;
  readonly authorize_url?: string;
  readonly token_url?: string;
  readonly scope?: string;
  readonly callback_host?: string;
  /** OpenAI's registered loopback redirect uses port 1455 by default. Use 0 in tests. */
  readonly callback_port?: number;
  readonly callback_path?: string;
  /** Legacy alias retained for callers that used one timeout for the flow. */
  readonly timeout_ms?: number;
  /** Maximum time allowed while waiting for the loopback authorization callback. */
  readonly authorization_timeout_ms?: number;
  /** Maximum time allowed for the token exchange, including reading its body. */
  readonly token_exchange_timeout_ms?: number;
  /** Maximum time allowed for a refresh exchange, including reading its body. */
  readonly refresh_timeout_ms?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly open_external?: (url: string) => Promise<void>;
  readonly authorize_params?: Readonly<Record<string, string>>;
  /** Bounded, fixed progress messages; never receives credentials or responses. */
  readonly on_progress?: (event: OAuthProgressEvent) => void | Promise<void>;
}

export type OAuthProgressStage =
  | 'opening_browser'
  | 'waiting_for_callback'
  | 'authorization_received'
  | 'exchanging_code'
  | 'validating_response'
  | 'refreshing_credential'
  | 'saving_credential'
  | 'verifying_credential'
  | 'authenticated';

export interface OAuthProgressEvent {
  readonly stage: OAuthProgressStage;
  readonly message: string;
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly pkce: PkcePair;
  readonly redirect_uri: string;
}

export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  constructor(readonly code: OAuthErrorCode, message: string) {
    super(message);
  }
}

export type OAuthErrorCode =
  | 'EXPERIMENTAL_OPT_IN_REQUIRED'
  | 'INVALID_CONFIG'
  | 'CALLBACK_ERROR'
  | 'STATE_MISMATCH'
  | 'TIMEOUT'
  | 'AUTHORIZATION_TIMEOUT'
  | 'ABORTED'
  | 'TOKEN_EXCHANGE_TIMEOUT'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'REFRESH_TIMEOUT'
  | 'REFRESH_FAILED';

export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return Object.freeze({ verifier, challenge });
}

export function createAuthorizationRequest(
  config: OAuthClientConfig,
  redirectUri: string,
): AuthorizationRequest {
  const clientId = config.client_id ?? DEFAULT_CLIENT_ID;
  if (!isSafeParameter(clientId, 256)) throw new OAuthError('INVALID_CONFIG', 'OAuth client_id is invalid.');
  validateRedirectUri(redirectUri);
  const authorizeUrl = toHttpsUrl(config.authorize_url ?? DEFAULT_AUTHORIZE_URL, 'authorize_url');
  const pkce = createPkcePair();
  const state = base64Url(randomBytes(24));
  const params = new URLSearchParams({
    ...DEFAULT_AUTHORIZE_PARAMS,
    ...config.authorize_params,
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: config.scope ?? DEFAULT_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  });
  return Object.freeze({
    url: `${authorizeUrl.toString()}?${params.toString()}`,
    state,
    pkce,
    redirect_uri: redirectUri,
  });
}

export async function exchangeAuthorizationCode(
  config: OAuthClientConfig,
  input: { readonly code: string; readonly redirect_uri: string; readonly verifier: string },
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  emitProgress(config, { stage: 'exchanging_code', message: 'Exchanging authorization code…' });
  const response = await tokenRequest(config, {
    grant_type: 'authorization_code',
    client_id: config.client_id ?? DEFAULT_CLIENT_ID,
    code: input.code,
    redirect_uri: input.redirect_uri,
    code_verifier: input.verifier,
  }, 'token_exchange', signal);
  return parseCredentialResponse(response, 'TOKEN_EXCHANGE_FAILED');
}

export async function refreshOAuthCredential(
  config: OAuthClientConfig,
  refreshToken: string,
  priorAccountId?: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  if (refreshToken.length === 0) throw new OAuthError('REFRESH_FAILED', 'Refresh credential is empty.');
  emitProgress(config, { stage: 'refreshing_credential', message: 'Refreshing OAuth credential…' });
  try {
    const response = await tokenRequest(config, {
      grant_type: 'refresh_token',
      client_id: config.client_id ?? DEFAULT_CLIENT_ID,
      refresh_token: refreshToken,
    }, 'refresh', signal);
    return parseCredentialResponse(response, 'REFRESH_FAILED', refreshToken, priorAccountId);
  } catch (error) {
    if (error instanceof OAuthError && ['ABORTED', 'REFRESH_TIMEOUT', 'TOKEN_RESPONSE_INVALID', 'REFRESH_FAILED'].includes(error.code)) throw error;
    throw new OAuthError('REFRESH_FAILED', 'The OAuth credential could not be refreshed.');
  }
}

/** Performs a one-shot browser OAuth flow. State/verifier remain memory-only. */
export async function loginWithBrowser(
  config: OAuthClientConfig = {},
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  if (config.experimental_opt_in !== true) {
    throw new OAuthError('EXPERIMENTAL_OPT_IN_REQUIRED', 'GPT subscription login requires explicit experimental opt-in.');
  }
  const host = config.callback_host ?? DEFAULT_CALLBACK_HOST;
  const callbackPort = config.callback_port ?? DEFAULT_CALLBACK_PORT;
  const callbackPath = config.callback_path ?? DEFAULT_CALLBACK_PATH;
  const authorizationTimeoutMs = configuredTimeout(config.authorization_timeout_ms ?? config.timeout_ms ?? 120_000, 'authorization_timeout_ms');
  if (!Number.isSafeInteger(callbackPort) || callbackPort < 0 || callbackPort > 65_535) {
    throw new OAuthError('INVALID_CONFIG', 'OAuth callback port is invalid.');
  }
  if (!isLoopbackHost(host)) {
    throw new OAuthError('INVALID_CONFIG', 'OAuth callback host must be loopback.');
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(callbackPath) || callbackPath.includes('..')) {
    throw new OAuthError('INVALID_CONFIG', 'OAuth callback path is invalid.');
  }

  if (signal?.aborted) throw new OAuthError('ABORTED', 'OAuth login was aborted.');

  const server = createServer();
  try {
    await listen(server, host, callbackPort);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new OAuthError('INVALID_CONFIG', 'OAuth callback server did not bind a TCP port.');
  }
  const redirectHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const redirectUri = `http://${redirectHost}:${address.port}${callbackPath}`;
  try {
    const authorization = createAuthorizationRequest(config, redirectUri);
    const openExternal = config.open_external;
    if (!openExternal) throw new OAuthError('INVALID_CONFIG', 'Niwa requires a host-owned login URL handler.');
    const callbackAbort = new AbortController();
    const onExternalAbort = () => callbackAbort.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    emitProgress(config, { stage: 'opening_browser', message: 'Opening browser…' });
    const callbackPromise = waitForCallback(
      server,
      callbackPath,
      authorization.state,
      authorizationTimeoutMs,
      callbackAbort.signal,
    );
    // Attach a rejection observer immediately; the browser request can fail before
    // the opener promise settles, and the awaited promise still preserves the error.
    void callbackPromise.catch(() => undefined);
    emitProgress(config, { stage: 'waiting_for_callback', message: 'Waiting for authorization…' });
    try {
      await runWithDeadline(authorizationTimeoutMs, 'AUTHORIZATION_TIMEOUT', signal, async () => {
        try { await openExternal(authorization.url); }
        catch (error) {
          if (error instanceof OAuthError) throw error;
          throw new OAuthError('CALLBACK_ERROR', 'Could not open the browser for OAuth login.');
        }
      });
      const callback = await callbackPromise;
      emitProgress(config, { stage: 'authorization_received', message: 'Authorization received.' });
      // The callback server is no longer needed once the code is in memory.
      // Close it before contacting the token endpoint so its port is available
      // for another login attempt, even while exchange is pending.
      await closeServer(server);
      return await exchangeAuthorizationCode(config, {
        code: callback.code,
        redirect_uri: redirectUri,
        verifier: authorization.pkce.verifier,
      }, signal);
    } finally {
      callbackAbort.abort();
      signal?.removeEventListener('abort', onExternalAbort);
    }
  } finally {
    await closeServer(server);
  }
}

async function tokenRequest(
  config: OAuthClientConfig,
  body: Readonly<Record<string, string>>,
  stage: 'token_exchange' | 'refresh',
  signal?: AbortSignal,
): Promise<unknown> {
  const tokenUrl = toHttpsUrl(config.token_url ?? DEFAULT_TOKEN_URL, 'token_url');
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = stage === 'token_exchange'
    ? configuredTimeout(config.token_exchange_timeout_ms ?? config.timeout_ms ?? 120_000, 'token_exchange_timeout_ms')
    : configuredTimeout(config.refresh_timeout_ms ?? config.timeout_ms ?? 120_000, 'refresh_timeout_ms');
  const timeoutCode: OAuthErrorCode = stage === 'token_exchange' ? 'TOKEN_EXCHANGE_TIMEOUT' : 'REFRESH_TIMEOUT';
  const failureCode: OAuthErrorCode = stage === 'token_exchange' ? 'TOKEN_EXCHANGE_FAILED' : 'REFRESH_FAILED';
  try {
    return await runWithDeadline(timeoutMs, timeoutCode, signal, async (stageSignal) => {
      let response: Response;
      try {
        response = await fetchImpl(tokenUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams(body).toString(),
          signal: stageSignal,
        });
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (stageSignal.aborted) throw new OAuthError('ABORTED', 'OAuth token exchange was aborted.');
        throw new OAuthError(failureCode, 'The OAuth token endpoint was unreachable.');
      }
      let text: string;
      try {
        text = await boundedText(response, stageSignal);
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth token response could not be read safely.');
      }
      if (!response.ok) throw new OAuthError(failureCode, 'The OAuth token endpoint rejected the exchange.');
      try {
        emitProgress(config, { stage: 'validating_response', message: 'Validating token response…' });
        return JSON.parse(text);
      } catch {
        throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth token response was not valid JSON.');
      }
    });
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(failureCode, 'The OAuth token exchange failed safely.');
  }
}

function parseCredentialResponse(value: unknown, failureCode: 'TOKEN_EXCHANGE_FAILED' | 'REFRESH_FAILED', priorRefreshToken?: string, priorAccountId?: string): OAuthCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth token response was malformed.');
  }
  const record = value as Record<string, unknown>;
  const access = record['access_token'];
  const refresh = record['refresh_token'] ?? priorRefreshToken;
  const expiresIn = record['expires_in'];
  if (typeof access !== 'string' || access.length === 0 || typeof refresh !== 'string' || refresh.length === 0) {
    throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth token response did not contain required credentials.');
  }
  const lifetime = Number.isSafeInteger(expiresIn) && (expiresIn as number) > 0 ? (expiresIn as number) : 3600;
  const accountId = extractAccountId(record['id_token']) ?? extractAccountId(access) ?? priorAccountId;
  const credential = {
    access_token: access,
    refresh_token: refresh,
    expires_at: Date.now() + lifetime * 1000,
    ...(accountId === undefined ? {} : { account_id: accountId }),
    ...(typeof record['token_type'] === 'string' ? { token_type: record['token_type'] } : {}),
  };
  try { validateCredential(credential); }
  catch { throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth token response contained invalid credentials.'); }
  return Object.freeze(credential);
}

function extractAccountId(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'];
    const nested = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>)['chatgpt_account_id'] : undefined;
    const direct = nested ?? payload['account_id'] ?? payload['accountId'] ?? payload['chatgpt_account_id'];
    return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
  } catch {
    return undefined;
  }
}

function toHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('INVALID_CONFIG', `${label} must be an absolute HTTPS URL.`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OAuthError('INVALID_CONFIG', `${label} must use HTTPS (or loopback HTTP for tests).`);
  }
  if (!loopback && url.hostname.toLowerCase() !== 'auth.openai.com') {
    throw new OAuthError('INVALID_CONFIG', `${label} must use the OpenAI OAuth host.`);
  }
  if (url.username || url.password || url.search || url.hash) throw new OAuthError('INVALID_CONFIG', `${label} contains forbidden URL components.`);
  return url;
}

function validateRedirectUri(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError('INVALID_CONFIG', 'OAuth redirect_uri is invalid.'); }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/')) {
    throw new OAuthError('INVALID_CONFIG', 'OAuth redirect_uri must be a loopback HTTP URL.');
  }
}

function isSafeParameter(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return code <= 0x1f || code === 0x7f;
  });
}

async function waitForCallback(server: Server, callbackPath: string, expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      void handleCallback(request, response, callbackPath, expectedState)
        .then((result) => finish(undefined, result), (error: unknown) => finish(error instanceof Error ? error : new OAuthError('CALLBACK_ERROR', 'OAuth callback failed.')))
        .catch(() => undefined);
    };
    const finish = (error?: Error, value?: { code: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.removeListener('request', onRequest);
      if (error) reject(error);
      else resolve(value as { code: string });
    };
    const onAbort = () => finish(new OAuthError('ABORTED', 'OAuth login was aborted.'));
    const timer = setTimeout(() => finish(new OAuthError('AUTHORIZATION_TIMEOUT', 'OAuth authorization timed out.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.on('request', onRequest);
  });
}

async function handleCallback(request: IncomingMessage, response: ServerResponse, callbackPath: string, expectedState: string): Promise<{ code: string }> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== callbackPath) {
    respond(response, 404, 'Not found');
    throw new OAuthError('CALLBACK_ERROR', 'OAuth callback path did not match.');
  }
  const state = url.searchParams.get('state');
  if (!state || !safeEqual(state, expectedState)) {
    respond(response, 400, 'OAuth state mismatch');
    throw new OAuthError('STATE_MISMATCH', 'OAuth state did not match.');
  }
  const error = url.searchParams.get('error');
  if (error) {
    respond(response, 400, 'OAuth authorization was denied');
    throw new OAuthError('CALLBACK_ERROR', 'OAuth authorization was denied.');
  }
  const code = url.searchParams.get('code');
  if (!code || code.length > 8192) {
    respond(response, 400, 'OAuth code missing');
    throw new OAuthError('CALLBACK_ERROR', 'OAuth callback did not contain a code.');
  }
  respond(response, 200, 'Authorization received by Carried. Return to the terminal while sign-in finishes. You may close this window.');
  return { code };
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(message);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new OAuthError('INVALID_CONFIG', 'OAuth callback port could not be bound.'));
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closeAllConnections = (server as Server & { closeAllConnections?: () => void }).closeAllConnections;
  try { closeAllConnections?.call(server); } catch { /* best effort */ }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
    try { server.close(finish); } catch { finish(); }
  });
}

async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let output = '';
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new OAuthError('TOKEN_RESPONSE_INVALID', 'The OAuth response exceeded the safety limit.');
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    if (signal?.aborted) throw new OAuthError('ABORTED', 'OAuth token exchange was aborted.');
    return output + decoder.decode();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* body cleanup is best effort */ }
  }
}

function configuredTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60 * 1000) {
    throw new OAuthError('INVALID_CONFIG', `OAuth ${label} is invalid.`);
  }
  return value;
}

async function runWithDeadline<T>(
  timeoutMs: number,
  timeoutCode: OAuthErrorCode,
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (externalSignal?.aborted) throw new OAuthError('ABORTED', 'OAuth operation was aborted.');
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: OAuthError) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    controller.abort();
    rejectAbort?.(new OAuthError('ABORTED', 'OAuth operation was aborted.'));
  };
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new OAuthError(timeoutCode, 'OAuth operation timed out safely.'));
    }, timeoutMs);
    timer.unref?.();
  });
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  // A provider/fetch implementation may ignore AbortSignal and settle later.
  // Observe that late promise so it can never become an unhandled rejection.
  void operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (timedOut) throw new OAuthError(timeoutCode, 'OAuth operation timed out safely.');
    if (externalSignal?.aborted) throw new OAuthError('ABORTED', 'OAuth operation was aborted.');
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

function emitProgress(config: OAuthClientConfig, event: OAuthProgressEvent): void {
  try {
    const result = config.on_progress?.(Object.freeze(event));
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch { /* progress is observational and never changes OAuth authority */ }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export {
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_AUTHORIZE_PARAMS,
  DEFAULT_CALLBACK_HOST,
  DEFAULT_CALLBACK_PATH,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_CLIENT_ID,
  DEFAULT_SCOPE,
  DEFAULT_TOKEN_URL,
};
