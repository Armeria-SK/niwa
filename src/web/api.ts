import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DomainError } from '../domain/types.ts';
import type { Settings } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { WebAuth } from './auth.ts';
import { ModelGateway } from '../providers/gateway.ts';
import { serveStatic } from './static.ts';
import { profileSchema } from '../domain/profile.ts';
import type { Backups } from '../backup/backups.ts';
import type { WorkspaceRead, WorkspaceDownload } from '../tools/files/client.ts';

const string = Type.String({ minLength: 1, maxLength: 20_000 });
const id = Type.String({ pattern: '^[0-9a-f-]{36}$' });
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new DomainError('invalid', 'Expected JSON');
  if (Number(req.headers['content-length']) > 65_536) throw new DomainError('limit', 'Body too large');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65_536) throw new DomainError('limit', 'Body too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new DomainError('invalid', 'Invalid JSON'); }
}

/** This server exposes administrator routes only. Model tools use the separate actor-bound API. */
export function createApiServer(runtime: Runtime, auth: WebAuth, models = new ModelGateway(runtime), webRoot?: string, backups?: Backups,
  workspace?: { read: WorkspaceRead; download: WorkspaceDownload }) {
  const admin = runtime.administrator();
  type Route = { method: string; path: RegExp; schema?: TSchema; run: (match: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown };
  const routes: Route[] = [
    { method: 'GET', path: /^\/api\/workspace\/files$/, run: async (_m, _b, url) => workspace
      ? { available: true, ...await workspace.read('list', url.searchParams.get('path') ?? '') } : { available: false, entries: [], path: '', truncated: false } },
    { method: 'GET', path: /^\/api\/workspace\/file$/, run: (_m, _b, url) => {
      if (!workspace) throw new DomainError('conflict', 'Workspace service unavailable');
      return workspace.download(url.searchParams.get('path') ?? ''); } },
    { method: 'GET', path: /^\/api\/schedules$/, run: () => runtime.schedules.list(admin) },
    { method: 'DELETE', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, run: m => { runtime.schedules.remove(admin, m[1]!); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/schedules$/, schema: object({ id, agent_id: id, room_id: id, prompt: string,
      interval_ms: Type.Integer({ minimum: 60_000, maximum: 365 * 86400_000 }), next_at: Type.Integer({ minimum: 0, maximum: 8_000_000_000_000_000 }),
      max_runs: Type.Integer({ minimum: 1, maximum: 10_000 }), timeout_ms: Type.Integer({ minimum: 60_000, maximum: 86400_000 }),
      max_model_calls: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      trigger_kind: Type.Optional(Type.Union([Type.Literal('interval'), Type.Literal('shared_changes')])), autonomous: Type.Optional(Type.Boolean()) }),
      run: (_m, b) => runtime.schedules.create(admin, b as unknown as import('../runtime/schedules.ts').ScheduleInput) },
    { method: 'PATCH', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, schema: object({ enabled: Type.Boolean() }),
      run: (m, b) => { runtime.schedules.setEnabled(admin, m[1]!, b.enabled as boolean); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/subscription$/, run: async () => models.subscription ? { available: true, ...await models.subscription.status() } : { available: false, connected: false, pending: false, url: null, error: null } },
    { method: 'POST', path: /^\/api\/subscription\/login$/, schema: object({ experimental_opt_in: Type.Literal(true) }), run: async () => {
      if (!models.subscription) throw new DomainError('conflict', 'Subscription service unavailable');
      return { url: await models.subscription.start() }; } },
    { method: 'POST', path: /^\/api\/subscription\/logout$/, schema: object({}), run: async () => {
      if (!models.subscription) throw new DomainError('conflict', 'Subscription service unavailable');
      await models.subscription.logout(); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/subscription\/models$/, run: async () => {
      if (!models.subscription) throw new DomainError('conflict', 'Subscription service unavailable');
      return models.subscription.models(); } },
    { method: 'GET', path: /^\/api\/backups$/, run: async () => ({ available: !!backups, error: backups?.error ?? null,
      items: (await backups?.list() ?? []).map(item => ({ id: item.id, created_at: item.created_at, bytes: item.files.reduce((sum, file) => sum + file.bytes, 0) })) }) },
    { method: 'POST', path: /^\/api\/backups$/, schema: object({}), run: async () => {
      if (!backups) throw new DomainError('conflict', 'Backup service unavailable');
      const item = await backups.create(); return { id: item.id, created_at: item.created_at }; } },
    { method: 'GET', path: /^\/api\/artifacts$/, run: (_m, _b, url) => runtime.artifacts(admin, url.searchParams.get('query') ?? '') },
    { method: 'GET', path: /^\/api\/artifacts\/([0-9a-f-]{36})$/, run: m => runtime.artifact(admin, m[1]!) },
    { method: 'GET', path: /^\/api\/updates$/, run: () => runtime.updates(admin) },
    { method: 'POST', path: /^\/api\/updates\/read$/, schema: object({ ids: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 1000, uniqueItems: true }) }),
      run: (_m, b) => { runtime.readUpdates(admin, b.ids as number[]); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/conversations$/, schema: object({ id, title: Type.String({ minLength: 1, maxLength: 200 }), body: string,
      participants: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })), agent_id: Type.Optional(id) }),
      run: (_m, b) => runtime.createConversation(admin, b.id as string, b.title as string, b.body as string, b.participants as string[] | undefined, b.agent_id as string | undefined) },
    { method: 'GET', path: /^\/api\/model-settings$/, run: () => runtime.modelSettings(admin) },
    { method: 'GET', path: /^\/api\/model-settings\/generated$/, run: () => runtime.generatedModel(admin) },
    { method: 'PUT', path: /^\/api\/model-settings\/generated$/, schema: object({ provider: Type.Union([Type.Literal('ollama'), Type.Literal('openai_subscription')]), model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.String({ minLength: 1, maxLength: 64 }) }),
      run: (_m, b) => models.selectGenerated(b.provider as 'ollama' | 'openai_subscription', b.model as string, b.reasoning as string) },
    { method: 'GET', path: /^\/api\/model-routes$/, run: () => runtime.modelRoutes(admin) },
    { method: 'PUT', path: /^\/api\/common-rules$/, schema: object({ revision: Type.Integer({ minimum: 1 }), body: Type.String({ maxLength: 20_000 }) }),
      run: (_m, b) => { runtime.updateCommonRules(admin, b.revision as number, b.body as string); return runtime.commonRules(admin); } },
    { method: 'PATCH', path: /^\/api\/model-settings$/, schema: object({ ollamaUrl: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 2048 })]) }),
      run: (_m, b) => { runtime.configureOllama(admin, b.ollamaUrl as string | null); return runtime.modelSettings(admin); } },
    { method: 'GET', path: /^\/api\/models$/, run: () => models.catalog() },
    { method: 'PUT', path: /^\/api\/model-settings\/fallback$/, schema: object({ model: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 256 })]) }),
      run: (_m, b) => models.selectFallback(b.model as string | null) },
    { method: 'PUT', path: /^\/api\/agents\/([0-9a-f-]{36})\/model$/, schema: object({ provider: Type.Union([Type.Literal('ollama'), Type.Literal('openai_subscription')]), model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.Optional(Type.String({ maxLength: 20 })) }),
      run: (m, b) => b.provider === 'ollama' ? models.select(m[1]!, b.model as string) : models.selectSubscription(m[1]!, b.model as string, b.reasoning as string) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/profile$/, schema: profileSchema, run: (m, b) => { runtime.updateProfile(admin, m[1]!, b); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/state$/, run: () => ({ agents: runtime.agents(admin).map(agent => ({ ...agent, profile: runtime.profile(admin, agent.id) })),
      rooms: runtime.rooms(admin).map(room => ({ ...room, ...runtime.roomPreferences(admin, room.id), participants: runtime.participants(admin, room.id) })), settings: runtime.settings(admin), commonRules: runtime.commonRules(admin), tasks: runtime.tasks.list(admin).map(task => ({ ...task, replies: runtime.tasks.replies(admin, task.id) })) }) },
    { method: 'PATCH', path: /^\/api\/rooms\/([0-9a-f-]{36})\/organization$/, schema: object({ pinned: Type.Optional(Type.Boolean()), archived: Type.Optional(Type.Boolean()) }),
      run: (m, b) => { runtime.organizeRoom(admin, m[1]!, b); return runtime.roomPreferences(admin, m[1]!); } },
    { method: 'POST', path: /^\/api\/rooms$/, schema: object({ title: Type.String({ minLength: 1, maxLength: 200 }), participants: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })) }),
      run: (_m, b) => runtime.createRoom(admin, b.title as string, b.participants as string[] | undefined) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages$/, run: m => runtime.messages(admin, m[1]!) },
    { method: 'POST', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages$/, schema: object({ id, body: string, agent_id: Type.Optional(id), agent_ids: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })) }),
      run: (m, b) => {
        if (b.agent_id && b.agent_ids) throw new DomainError('invalid', 'Specify one recipient field');
        return runtime.submit(admin, b.id as string, m[1]!, b.body as string, (b.agent_ids ?? b.agent_id) as string | string[] | undefined); } },
    { method: 'PATCH', path: /^\/api\/settings$/, schema: object({ paused: Type.Optional(Type.Boolean()), autonomous: Type.Optional(Type.Boolean()), generatedLimit: Type.Optional(Type.Integer({ minimum: 0 })),
      concurrencyLimit: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })])), backupDays: Type.Optional(Type.Integer({ minimum: 1 })), backupTime: Type.Optional(Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })) }),
      run: (_m, b) => runtime.updateSettings(admin, b as Partial<Settings>) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/dormancy$/, schema: object({ dormant: Type.Boolean() }),
      run: (m, b) => { runtime.setDormant(admin, m[1]!, b.dormant as boolean); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories$/, run: (m, _b, url) => runtime.memories(admin, m[1]!, url.searchParams.get('q') ?? '') },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memory-audit$/, run: m => runtime.memoryAudit(admin, m[1]!) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/([0-9a-f-]{36}|[0-9a-f]{64})$/, schema: object({ revision: Type.Integer({ minimum: 1 }), body: string }),
      run: (m, b) => { runtime.correctMemory(admin, m[1]!, m[2]!, b.revision as number, b.body as string); return { ok: true }; } },
    { method: 'DELETE', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/([0-9a-f-]{36}|[0-9a-f]{64})$/, schema: object({ revision: Type.Integer({ minimum: 1 }) }),
      run: (m, b) => { runtime.deleteMemory(admin, m[1]!, m[2]!, b.revision as number); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/tasks\/([0-9a-f-]{36})\/resume$/, schema: object({ answer: Type.Optional(string) }),
      run: (m, b) => { runtime.tasks.resume(admin, m[1]!, b.answer as string | undefined); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/tasks\/([0-9a-f-]{36})\/cancel$/, schema: object({}),
      run: m => { runtime.tasks.cancel(admin, m[1]!); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/tasks\/([0-9a-f-]{36})\/(pause|retry|complete)$/, schema: object({}),
      run: m => { runtime.tasks[m[2] as 'pause' | 'retry' | 'complete'](admin, m[1]!); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/tasks\/([0-9a-f-]{36})\/instruct$/, schema: object({ body: string }),
      run: (m, b) => { runtime.tasks.instruct(admin, m[1]!, b.body as string); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/tasks\/([0-9a-f-]{36})\/history$/, run: m => runtime.tasks.history(admin, m[1]!) },
    { method: 'GET', path: /^\/api\/events$/, run: (_m, _b, url) => runtime.tasks.events(admin, Number(url.searchParams.get('after') ?? '0')) },
  ];
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (req, res) => {
    try {
      if (!auth.validOrigin(req)) { send(res, 403, { error: 'origin_rejected' }); return; }
      const url = new URL(req.url ?? '/', auth.origin);
      if (url.origin !== auth.origin) { send(res, 403, { error: 'origin_rejected' }); return; }
      if (!url.pathname.startsWith('/api/') && webRoot && serveStatic(webRoot, req, res)) return;
      if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readBody(req);
        if (!Value.Check(object({ key: Type.String({ maxLength: 128 }) }), body)) throw new DomainError('invalid', 'Invalid login');
        const ok = auth.login((body as { key: string }).key, req, res);
        send(res, ok ? 200 : 401, { authenticated: ok }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') { send(res, 200, { authenticated: auth.authenticated(req) }); return; }
      if (!auth.authenticated(req)) { send(res, 401, { error: 'authentication_required' }); return; }
      if (req.method === 'POST' && url.pathname === '/api/logout') { auth.logout(req, res); send(res, 200, { ok: true }); return; }
      for (const route of routes) {
        const match = url.pathname.match(route.path);
        if (req.method !== route.method || !match) continue;
        const body = route.schema ? await readBody(req) : {};
        if (route.schema && !Value.Check(route.schema, body)) throw new DomainError('invalid', 'Invalid request');
        send(res, 200, await route.run(match, body as Record<string, unknown>, url)); return;
      }
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'internal_error';
      const status = { forbidden: 403, invalid: 400, not_found: 404, conflict: 409, limit: 413, internal_error: 500 }[code];
      if (!res.destroyed) send(res, status, { error: code });
    }
  });
}
