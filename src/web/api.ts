import type {SubmissionContext} from '../runtime/conversation-work.ts';
import {mcpScope,type McpConnector} from '../tools/mcp/client.ts';
import {mcpUpdateSchema,mcpProbeSchema,mcpOAuthStartSchema,mcpOAuthLogoutSchema,type McpSettings} from '../tools/mcp/settings.ts';
import {qualityReviewSchema,type QualityReview} from '../runtime/artifact-quality.ts';
import {environmentDefinitionSchema} from '../tools/environments/registry.ts';
import {randomUUID} from 'node:crypto';
import type {WorkareaTransport} from '../runtime/workareas.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DomainError } from '../domain/types.ts';
import { ATTACHMENT_LIMITS } from '../domain/attachments.ts';
import type { Agent, FallbackProvider, Settings } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { WebAuth } from './auth.ts';
import { LiveStreams } from './live-stream.ts';
import { ModelGateway } from '../providers/gateway.ts';
import { serveStatic } from './static.ts';
import { profileSchema, creationProfileSchema } from '../domain/profile.ts';
import type { Backups } from '../backup/backups.ts';
import type { WorkspaceRead, WorkspaceDownload } from '../tools/files/client.ts';

const string = Type.String({ minLength: 1, maxLength: 20_000 });
const id = Type.String({ pattern: '^[0-9a-f-]{36}$' });
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const provider = Type.Union([Type.Literal('local_llm'), Type.Literal('openai_subscription'), Type.Literal('openai_compatible'), Type.Literal('anthropic')]);
const scheduleFields = { agent_id: id, room_id: id, prompt: string,
      interval_ms: Type.Integer({ minimum: 60_000, maximum: 365 * 86400_000 }), next_at: Type.Integer({ minimum: 0, maximum: 8_000_000_000_000_000 }),
      max_runs: Type.Integer({ minimum: 1, maximum: 10_000 }), timeout_ms: Type.Integer({ minimum: 60_000, maximum: 86400_000 }),
      max_model_calls: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      trigger_kind: Type.Optional(Type.Union([Type.Literal('interval'), Type.Literal('shared_changes'), Type.Literal('page_changes'), Type.Literal('webhook')])),
      source_url: Type.Optional(Type.String({ maxLength: 4096 })), autonomous: Type.Optional(Type.Boolean()) };
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
/** Landing page for the cross-site OAuth return. A link, not a redirect, so the Strict session cookie is sent when the person comes back. */
function sendNotice(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Niwa</title><body style="font-family:sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.7"><p>${message}</p><p><a href="/#settings/mcp">Niwaの画面に戻る</a></p></body></html>`);
}
/** Webhook bodies: at most 64 KiB of UTF-8 JSON or plain text. The content stays untrusted data for the next run. */
async function readHook(req: IncomingMessage): Promise<{ type: string; text: string } | number> {
  const type = (req.headers['content-type'] ?? 'text/plain').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/plain') { req.resume(); return 415; }
  // Excess bytes are discarded rather than destroying the socket, so the sender still receives the 413.
  if (Number(req.headers['content-length']) > 65_536) { req.resume(); return 413; }
  const chunks: Buffer[] = []; let bytes = 0;
  const complete = await new Promise<boolean>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => { if ((bytes += chunk.length) > 65_536) { chunks.length = 0; resolve(false); } else chunks.push(chunk); });
    req.on('end', () => resolve(true)); req.on('error', reject);
  });
  if (!complete) return 413;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (type === 'application/json') JSON.parse(text);
    return { type, text };
  } catch { return 400; }
}
async function readBody(req: IncomingMessage, limit = 65_536): Promise<unknown> {

  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new DomainError('invalid', 'Expected JSON');
  if (Number(req.headers['content-length']) > limit) throw new DomainError('limit', 'Body too large');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) throw new DomainError('limit', 'Body too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new DomainError('invalid', 'Invalid JSON'); }
}

/** This server exposes administrator routes only. Model tools use the separate actor-bound API. */
export function createApiServer(runtime: Runtime, auth: WebAuth, models = new ModelGateway(runtime), webRoot?: string, backups?: Backups,
  workspace?: { read: WorkspaceRead; download: WorkspaceDownload }, workareas?:WorkareaTransport, mcp?:McpConnector, mcpSettings?:McpSettings) {
  const admin = runtime.administrator();
  const live = new LiveStreams(runtime, admin, auth);
  type Route = { method: string; path: RegExp; schema?: TSchema; limit?: number; run: (match: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown };
  const scoped=(area:string,input:Parameters<Runtime['workareas']['execute']>[2])=>{
    if(!workareas)throw new DomainError('conflict','Workareas are not configured');
    return runtime.workareas.execute(admin,area,input,workareas);
  };
  const routes: Route[] = [
    {method:'GET',path:/^\/api\/mcp$/,run:()=>mcpSettings?.status()??({available:!!mcp,tools:mcp?.tools(true).map(tool=>({name:tool.name,description:tool.description}))??[]})},
    {method:'POST',path:/^\/api\/mcp\/probe$/,schema:mcpProbeSchema,run:(_m,b)=>{
      if(!mcpSettings)throw new DomainError('conflict','MCP configuration unavailable');return mcpSettings.probe(b as Parameters<McpSettings['probe']>[0]);}},
    {method:'PUT',path:/^\/api\/mcp$/,schema:mcpUpdateSchema,run:(_m,b)=>{
      if(!mcpSettings)throw new DomainError('conflict','MCP configuration unavailable');return mcpSettings.save(b as unknown as Parameters<McpSettings['save']>[0]);}},
    {method:'POST',path:/^\/api\/mcp\/oauth\/start$/,schema:mcpOAuthStartSchema,run:(_m,b)=>{
      if(!mcpSettings)throw new DomainError('conflict','MCP configuration unavailable');return mcpSettings.oauthStart(b as Parameters<McpSettings['oauthStart']>[0],auth.origin+'/api/mcp/oauth/callback');}},
    {method:'POST',path:/^\/api\/mcp\/oauth\/logout$/,schema:mcpOAuthLogoutSchema,run:(_m,b)=>{
      if(!mcpSettings)throw new DomainError('conflict','MCP configuration unavailable');return mcpSettings.oauthLogout(b as Parameters<McpSettings['oauthLogout']>[0]);}},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/executions$/,run:m=>{
      if(!workareas)throw new DomainError('conflict','Executor unavailable');return runtime.workareas.execution(admin,m[1]!,{operation:'execution_list'},workareas);}},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/executions\/([0-9a-f-]{36})\/stop$/,schema:object({}),run:m=>{
      if(!workareas)throw new DomainError('conflict','Executor unavailable');return runtime.workareas.execution(admin,m[1]!,{operation:'execution_stop',execution_id:m[2]!},workareas);}},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/executions\/([0-9a-f-]{36})\/preview$/,run:(m,_b,u)=>{
      if(!workareas)throw new DomainError('conflict','Executor unavailable');return runtime.workareas.execution(admin,m[1]!,{operation:'execution_preview',execution_id:m[2]!,path:u.searchParams.get('path')??'/',mobile:u.searchParams.get('mobile')==='true'},workareas);}},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/executions\/([0-9a-f-]{36})$/,run:m=>{
      if(!workareas)throw new DomainError('conflict','Executor unavailable');return runtime.workareas.execution(admin,m[1]!,{operation:'execution_status',execution_id:m[2]!},workareas);}},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments\/([a-f0-9]{64})\/retire$/,schema:object({}),run:m=>scoped(m[1]!,{operation:'environment_retire',environment:m[2]!})},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments\/collect$/,schema:object({}),run:m=>scoped(m[1]!,{operation:'environment_collect'})},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments$/,run:m=>scoped(m[1]!,{operation:'environment_list'})},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments$/,schema:object({definition:environmentDefinitionSchema}),run:(m,b)=>scoped(m[1]!,{operation:'environment_prepare',definition:b.definition,allow_start:true})},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments\/([a-f0-9]{64})\/test$/,schema:object({seconds:Type.Integer({minimum:1,maximum:300}),operation_id:id}),run:(m,b)=>scoped(m[1]!,{operation:'environment_test',environment:m[2]!,seconds:b.seconds as number,operation_id:b.operation_id as string,allow_start:true})},
    {method:'POST',path:/^\/api\/workareas\/([0-9a-f-]{36})\/environments\/([a-f0-9]{64})\/activate$/,schema:object({operation_id:id,expected_environment:Type.Union([Type.Null(),Type.String({pattern:'^[a-f0-9]{64}$'})])}),run:(m,b)=>scoped(m[1]!,{operation:'environment_activate',operation_id:b.operation_id as string,allow_start:true,environment:m[2]!,expected_environment:b.expected_environment as string|null})},
    {method:'GET',path:/^\/api\/workareas$/,run:()=>({available:!!workareas,...runtime.workareas.settings(admin),areas:runtime.workareas.list(admin),agents:runtime.agents(admin).map(a=>({id:a.id,name:a.name})),rooms:runtime.rooms(admin).map(r=>({id:r.id,title:r.title,visibility:r.visibility,participants:runtime.participants(admin,r.id)})),backup:'metadata_only'})},
    {method:'PATCH',path:/^\/api\/workareas$/,schema:object({enabled:Type.Boolean()}),run:(_m,b)=>{
      if(b.enabled&&!workareas)throw new DomainError('conflict','Prepare the workarea executor first');
      runtime.workareas.enable(admin,b.enabled as boolean);return {ok:true};}},
    {method:'POST',path:/^\/api\/workareas\/projects$/,schema:object({id:Type.Optional(id),name:Type.String({minLength:1,maxLength:100}),room_id:id,members:Type.Array(id,{minItems:1,maxItems:100,uniqueItems:true}),expected_revision:Type.Optional(Type.Integer({minimum:1}))}),run:(_m,b)=>runtime.workareas.project(admin,b as unknown as Parameters<Runtime['workareas']['project']>[1])},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/files$/,run:(m,_b,u)=>scoped(m[1]!,{operation:'list',path:u.searchParams.get('path')??'',...(u.searchParams.has('revision')?{revision:u.searchParams.get('revision')!}:{})})},
    {method:'GET',path:/^\/api\/workareas\/([0-9a-f-]{36})\/file$/,run:(m,_b,u)=>scoped(m[1]!,{operation:'download',path:u.searchParams.get('path')??'',...(u.searchParams.has('revision')?{revision:u.searchParams.get('revision')!}:{})})},
    {method:'PUT',path:/^\/api\/workareas\/([0-9a-f-]{36})\/file$/,schema:object({path:Type.String({minLength:1,maxLength:512}),content:Type.String({maxLength:20000}),expected_revision:Type.Union([Type.Null(),Type.String({pattern:'^[a-f0-9]{64}$'})])}),run:(m,b)=>scoped(m[1]!,{operation:'write',path:b.path as string,content:b.content as string,expected_revision:b.expected_revision as string|null,operation_id:randomUUID(),allow_start:true})},
    {method:'GET',path:/^\/api\/artifacts\/([0-9a-f-]{36})\/file$/,run:async m=>{
      if(!workareas)throw new DomainError('conflict','Workarea executor unavailable');
      const file=runtime.workareas.file(admin,m[1]!);
      const bytes=await workareas({operation:'published',artifact:String(file.blob_id),area:String(file.blob_id),epoch:runtime.workareas.epoch()});
      runtime.workareas.file(admin,m[1]!);
      if(bytes.revision!==file.sha256)throw new DomainError('conflict','Published file mismatch');return bytes;}},

    { method: 'GET', path: /^\/api\/workspace\/files$/, run: async (_m, _b, url) => workspace
      ? { available: true, ...await workspace.read('list', url.searchParams.get('path') ?? '') } : { available: false, entries: [], path: '', truncated: false } },
    { method: 'GET', path: /^\/api\/workspace\/file$/, run: (_m, _b, url) => {
      if (!workspace) throw new DomainError('conflict', 'Workspace service unavailable');
      return workspace.download(url.searchParams.get('path') ?? ''); } },
    { method: 'POST', path: /^\/api\/agents$/, schema: object({ id, name: Type.String({ minLength: 1, maxLength: 100 }), profile: creationProfileSchema }), run: (_m, b) => runtime.requestMember(admin, b.id as string, b.name as string, b.profile as Record<string, unknown>) },
    { method:'GET',path:/^\/api\/initiatives$/,run:()=>({...runtime.initiatives.settings(admin),items:runtime.initiatives.list(admin)}) },
    { method:'PATCH',path:/^\/api\/initiatives$/,schema:object({enabled:Type.Boolean()}),run:(_m,b)=>{runtime.initiatives.enable(admin,b.enabled as boolean);return {ok:true};} },
    { method:'PATCH',path:/^\/api\/initiatives\/([0-9a-f-]{36})$/,schema:object({paused:Type.Boolean(),revision:Type.Integer({minimum:1})}),run:(m,b)=>{runtime.initiatives.pause(admin,m[1]!,b.revision as number,b.paused as boolean);return {ok:true};} },
    {method:'PATCH',path:/^\/api\/agents\/([0-9a-f-]{36})\/autonomy$/,schema:object({enabled:Type.Boolean()}),run:(m,b)=>runtime.autonomousWakes.configure(admin,m[1]!,b.enabled as boolean)},
    { method: 'GET', path: /^\/api\/model-ready$/, run: async () => ({ providers: [...await models.readyProviders()] }) },
    { method: 'GET', path: /^\/api\/autonomy$/, run: async () => runtime.autonomousWakes.list(admin, await models.readyProviders()) },
    { method: 'GET', path: /^\/api\/schedules$/, run: () => runtime.schedules.list(admin) },
    { method: 'DELETE', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, run: m => { runtime.schedules.remove(admin, m[1]!); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/schedules$/, schema: object({ id, ...scheduleFields }),
      run: (_m, b) => runtime.schedules.create(admin, b as unknown as import('../runtime/schedules.ts').ScheduleInput) },
    { method: 'PUT', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, schema: object({ ...scheduleFields, version: Type.String({ pattern: '^[0-9a-f]{64}$' }) }),
      run: (m, b) => runtime.schedules.update(admin, { ...b, id: m[1]! } as unknown as import('../runtime/schedules.ts').ScheduleInput, b.version as string) },
    { method: 'POST', path: /^\/api\/schedules\/([0-9a-f-]{36})\/token$/, schema: object({}), run: m => runtime.schedules.issueHookToken(admin, m[1]!) },
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
    { method: 'GET', path: /^\/api\/backups$/, run: async () => {
      const items = await backups?.list() ?? [];
      return { available: !!backups, error: backups?.error ?? null, failed_at: backups?.failedAt ?? null, next_attempt_at: backups?.nextAttemptAt ?? null,
        items: items.map(item => ({ id: item.id, created_at: item.created_at, bytes: item.files.reduce((sum, file) => sum + file.bytes, 0) })) }; } },
    { method: 'POST', path: /^\/api\/backups$/, schema: object({}), run: async () => {
      if (!backups) throw new DomainError('conflict', 'Backup service unavailable');
      const item = await backups.create(); return { id: item.id, created_at: item.created_at }; } },
    {method:'GET',path:/^\/api\/quality$/,run:()=>runtime.quality.settings(admin)},
    {method:'PATCH',path:/^\/api\/quality$/,schema:object({enabled:Type.Boolean()}),run:(_m,b)=>{runtime.quality.enable(admin,b.enabled as boolean);return {ok:true};}},
    { method: 'GET', path: /^\/api\/artifacts$/, run: (_m, _b, url) => runtime.artifacts(admin, url.searchParams.get('query') ?? '') },
    { method: 'GET', path: /^\/api\/artifacts\/([0-9a-f-]{36})$/, run: m => runtime.artifactVersions.inspect(admin, m[1]!) },
    { method: 'POST', path: /^\/api\/artifacts\/([0-9a-f-]{36})\/review$/, schema: object({expected_sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),verdict:Type.Union([Type.Literal('approved'),Type.Literal('changes_requested')]),note:Type.String({minLength:1,maxLength:1000}),checks:Type.Optional(qualityReviewSchema)}),run:(m,b)=>runtime.artifactVersions.review(admin,m[1]!,b.expected_sha256 as string,b.verdict as 'approved'|'changes_requested',b.note as string,b.checks as QualityReview|undefined) },
    { method: 'POST', path: /^\/api\/artifacts\/([0-9a-f-]{36})\/freeze$/, schema: object({expected_sha256:Type.String({pattern:'^[a-f0-9]{64}$'})}),run:(m,b)=>runtime.artifactVersions.freeze(admin,m[1]!,b.expected_sha256 as string) },
    { method: 'DELETE', path: /^\/api\/artifacts\/([0-9a-f-]{36})$/, schema: object({}), run: m => { runtime.deleteContent(admin, 'artifact', m[1]!); return { ok: true }; } },
    { method: 'DELETE', path: /^\/api\/rooms\/([0-9a-f-]{36})$/, schema: object({}), run: async m => { runtime.deleteContent(admin, 'room', m[1]!); if(workareas)await runtime.workareas.purgeRetired(workareas);return { ok: true }; } },
    { method: 'POST', path: /^\/api\/approvals\/([0-9a-f-]{36})$/, schema: object({ approved: Type.Boolean(), version: id }), run: (m, b) => { runtime.decideApproval(admin, m[1]!, b.approved as boolean, b.version as string); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/updates$/, run: () => runtime.updates(admin) },
    { method: 'POST', path: /^\/api\/updates\/read$/, schema: object({ ids: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 1000, uniqueItems: true }) }),
      run: (_m, b) => { runtime.readUpdates(admin, b.ids as number[]); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/conversations$/, schema: object({ id, title: Type.String({ minLength: 1, maxLength: 200 }), body: string,
      participants: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })), agent_id: Type.Optional(id) }),
      run: (_m, b) => runtime.createConversation(admin, b.id as string, b.title as string, b.body as string, b.participants as string[] | undefined, b.agent_id as string | undefined) },
    { method: 'GET', path: /^\/api\/model-settings$/, run: () => runtime.modelSettings(admin) },
    { method: 'GET', path: /^\/api\/model-settings\/generated$/, run: () => runtime.generatedModel(admin) },
    { method: 'PUT', path: /^\/api\/model-settings\/generated$/, schema: object({ provider, model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.String({ minLength: 1, maxLength: 64 }) }),
      run: (_m, b) => models.selectGenerated(b.provider as Agent['provider'], b.model as string, b.reasoning as string) },
    { method: 'GET', path: /^\/api\/model-routes$/, run: () => runtime.modelRoutes(admin) },
    { method: 'PUT', path: /^\/api\/common-rules$/, schema: object({ revision: Type.Integer({ minimum: 1 }), body: Type.String({ maxLength: 20_000 }) }),
      run: (_m, b) => { runtime.updateCommonRules(admin, b.revision as number, b.body as string); return runtime.commonRules(admin); } },
    { method: 'PATCH', path: /^\/api\/model-settings$/, schema: object({ localLlmUrl: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 2048 })])), maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }),
      run: (_m, b) => { if (b.localLlmUrl !== undefined) runtime.configureLocalLlm(admin, b.localLlmUrl as string | null); if (b.maxParallel !== undefined) runtime.configureLocalLlmParallel(admin, b.maxParallel as number); return runtime.modelSettings(admin); } },
    { method: 'GET', path: /^\/api\/models$/, run: () => models.catalog() },
    // The API key is write-only: responses report only whether one is configured for the saved URL.
    { method: 'GET', path: /^\/api\/openai-compatible$/, run: () => models.compatibleStatus() },
    { method: 'PUT', path: /^\/api\/openai-compatible$/, schema: object({ url: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 2048 })])),
      apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), parallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }),
      run: (_m, b) => models.configureCompatible(b as { url?: string | null; apiKey?: string; parallel?: number }) },
    { method: 'DELETE', path: /^\/api\/openai-compatible\/key$/, schema: object({}), run: () => models.clearCompatibleKey() },
    { method: 'GET', path: /^\/api\/openai-compatible\/models$/, run: () => models.compatibleCatalog() },
    { method: 'POST', path: /^\/api\/openai-compatible\/check$/, schema: object({}), run: () => models.checkCompatible() },
    // The Claude API key is write-only as well; it is bound to the official API origin.
    { method: 'GET', path: /^\/api\/anthropic$/, run: () => models.anthropicStatus() },
    { method: 'PUT', path: /^\/api\/anthropic$/, schema: object({ apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), parallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }),
      run: (_m, b) => models.configureAnthropic(b as { apiKey?: string; parallel?: number }) },
    { method: 'DELETE', path: /^\/api\/anthropic\/key$/, schema: object({}), run: () => models.clearAnthropicKey() },
    { method: 'GET', path: /^\/api\/anthropic\/models$/, run: () => models.anthropicCatalog() },
    { method: 'POST', path: /^\/api\/anthropic\/check$/, schema: object({}), run: () => models.checkAnthropic() },
    { method: 'PUT', path: /^\/api\/model-settings\/fallback$/, schema: object({ model: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 256 })]),
      provider: Type.Optional(Type.Union([Type.Literal('local_llm'), Type.Literal('openai_compatible'), Type.Literal('anthropic')])) }),
      run: (_m, b) => models.selectFallback(b.model as string | null, (b.provider ?? 'local_llm') as FallbackProvider) },
    { method: 'PUT', path: /^\/api\/agents\/([0-9a-f-]{36})\/model$/, schema: object({ provider, model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.Optional(Type.String({ maxLength: 20 })) }),
      run: (m, b) => b.provider === 'local_llm' ? models.select(m[1]!, b.model as string) : b.provider === 'openai_compatible' ? models.selectCompatible(m[1]!, b.model as string)
        : b.provider === 'anthropic' ? models.selectAnthropic(m[1]!, b.model as string, (b.reasoning as string | undefined) || 'medium') : models.selectSubscription(m[1]!, b.model as string, b.reasoning as string) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/profile$/, schema: object({ patch: profileSchema, version: Type.String({ pattern: '^[0-9a-f]{64}$' }), selection: Type.Optional(object({ provider, model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.String({ minLength: 1, maxLength: 20 }) })) }), run: (m, b) => models.updateProfile(m[1]!, b.patch as Record<string, unknown>, b.version as string, b.selection as Pick<Agent, 'provider' | 'model' | 'reasoning'> | undefined) },
    { method: 'DELETE', path: /^\/api\/agents\/([0-9a-f-]{36})$/, schema: object({ version: Type.String({ pattern: '^[0-9a-f]{64}$' }) }), run: async (m, b) => { runtime.deleteAgent(admin, m[1]!, b.version as string);if(workareas)await runtime.workareas.purgeRetired(workareas);return { ok: true }; } },
    { method: 'GET', path: /^\/api\/state$/, run: () => ({ approvals: runtime.approvals(admin), businessTasks: runtime.businessTasks(admin), deletedAgents: runtime.deletedAgents(admin), agents: runtime.agents(admin).map(agent => ({ ...agent, profile: runtime.profile(admin, agent.id), profile_version: runtime.profileVersion(admin, agent.id), memory_version: runtime.memoryVersion(admin, agent.id) })),
      rooms: runtime.rooms(admin).map(room => ({ ...room, ...runtime.roomPreferences(admin, room.id), ...runtime.messageSummary(admin, room.id), acknowledgments: runtime.acknowledgments(admin, room.id), participants: runtime.participants(admin, room.id) })), settings: runtime.settings(admin), commonRules: runtime.commonRules(admin), tasks: runtime.tasks.list(admin).map(task => ({ ...task, work_root_id:runtime.tasks.workRoot(admin,String(task.id)), control_revision:runtime.tasks.controlRevision(admin,String(task.id)), progress:runtime.tasks.progress(admin,String(task.id)), replies: runtime.tasks.replies(admin, task.id) })) }) },
    { method: 'PATCH', path: /^\/api\/rooms\/([0-9a-f-]{36})\/organization$/, schema: object({ pinned: Type.Optional(Type.Boolean()), archived: Type.Optional(Type.Boolean()) }),
      run: (m, b) => { runtime.organizeRoom(admin, m[1]!, b); return runtime.roomPreferences(admin, m[1]!); } },
    { method: 'POST', path: /^\/api\/rooms$/, schema: object({ title: Type.String({ minLength: 1, maxLength: 200 }), participants: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })) }),
      run: (_m, b) => runtime.createRoom(admin, b.title as string, b.participants as string[] | undefined) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages$/, run: m => runtime.messages(admin, m[1]!) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/response-progress$/, run: m => runtime.tasks.responseProgress(admin,m[1]!) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/work-notes$/, run: m => ({notes:runtime.workNotes(admin,m[1]!),progress:runtime.tasks.list(admin).filter(t=>t.room_id===m[1]).slice(-50).map(t=>runtime.tasks.progress(admin,t.id))}) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/coordination$/, run: m => ({tasks:runtime.coordination(admin,m[1]!).map(task=>({...task,progress:runtime.tasks.progress(admin,String(task.id))})),digest:runtime.coordinationDigest(admin,m[1]!)}) },
    { method: 'GET', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages\/page$/, run: (m, _b, url) => runtime.messagePage(admin, m[1]!, Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)) },
    { method: 'GET', path: /^\/api\/rooms\/search$/, run: (_m, _b, url) => runtime.searchRoomMessages(admin, url.searchParams.get('q') ?? '') },
    // Up to five base64 text files of 256 KiB each; the runtime decodes and validates every file again.
    { method: 'POST', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages$/, limit: 2_097_152, schema: object({ id, body: Type.String({ maxLength: 20_000 }), attachments: Type.Optional(Type.Array(object({ name: Type.String({ minLength: 1, maxLength: 1000 }), content: Type.String({ maxLength: Math.ceil(ATTACHMENT_LIMITS.bytes / 3) * 4 }) }), { maxItems: ATTACHMENT_LIMITS.count })), reply_to: Type.Optional(id), request_context:Type.Optional(object({kind:Type.Union(['status','new','amend','cancel'].map(value=>Type.Literal(value))),task_id:Type.Optional(id),expected_revision:Type.Optional(Type.Integer({minimum:0}))})), agent_id: Type.Optional(id), agent_ids: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })) }),
      run: (m, b) => {
        if (b.agent_id && b.agent_ids) throw new DomainError('invalid', 'Specify one recipient field');
        return runtime.submit(admin, b.id as string, m[1]!, b.body as string, (b.agent_ids ?? b.agent_id) as string | string[] | undefined, b.reply_to as string | undefined,b.request_context as SubmissionContext | undefined,b.attachments); } },
    { method: 'PATCH', path: /^\/api\/settings$/, schema: object({ paused: Type.Optional(Type.Boolean()), autonomous: Type.Optional(Type.Boolean()), generatedLimit: Type.Optional(Type.Integer({ minimum: 0 })),
      concurrencyLimit: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })])), backupDays: Type.Optional(Type.Integer({ minimum: 1 })), backupEnabled: Type.Optional(Type.Boolean()), backupTime: Type.Optional(Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })) }),
      run: (_m, b) => runtime.updateSettings(admin, b as Partial<Settings>) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/dormancy$/, schema: object({ dormant: Type.Boolean() }),
      run: (m, b) => { runtime.setDormant(admin, m[1]!, b.dormant as boolean); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories$/, run: (m, _b, url) => runtime.memories(admin, m[1]!, url.searchParams.get('q') ?? '') },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/procedures$/, run: m => runtime.procedureBook(admin, m[1]!) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/procedures\/([0-9a-f]{64})$/, schema: object({ enabled: Type.Boolean() }), run: (m, b) => { runtime.setProcedureEnabled(admin, m[1]!, m[2]!, b.enabled as boolean); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/page$/, run: (m, _b, url) => runtime.memoryPageWithSources(admin, m[1]!, url.searchParams.get('q') ?? '', Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)) },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/([0-9a-f-]{36}|[0-9a-f]{64})\/corrections$/, run: m => runtime.memoryCorrections(admin, m[1]!, m[2]!) },
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
    {method:'GET',path:/^\/api\/tasks\/([0-9a-f-]{36})\/prompt-runs$/,run:m=>runtime.tasks.promptRuns(admin,m[1]!)},
    { method: 'GET', path: /^\/api\/tasks\/([0-9a-f-]{36})\/history$/, run: m => runtime.tasks.history(admin, m[1]!) },
    { method: 'GET', path: /^\/api\/events$/, run: (_m, _b, url) => runtime.tasks.events(admin, Number(url.searchParams.get('after') ?? '0')) },
  ];
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (req, res) => {
    try {
      // External services post here through the operator's HTTPS proxy, so Host and the admin cookie are not required; the per-schedule token is.
      // Browsers cannot attach the token header cross-site without a preflight this server never answers, and a foreign Origin is refused outright.
      const hook = /^\/api\/hooks\/([0-9a-f-]{36})$/.exec(req.url ?? '');
      if (hook) {
        // An unread body is drained so a kept-alive connection stays usable after an early refusal.
        const refuse = (status: number, error: string) => { req.resume(); send(res, status, { error }); };
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); refuse(405, 'method_not_allowed'); return; }
        if (req.headers.origin && req.headers.origin !== auth.origin) { refuse(403, 'origin_rejected'); return; }
        const header = req.headers.authorization ?? '', named = req.headers['x-niwa-token'];
        const token = /^Bearer [A-Za-z0-9_-]{1,256}$/.test(header) ? header.slice(7) : typeof named === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(named) ? named : '';
        const denied = () => { res.setHeader('WWW-Authenticate', 'Bearer'); refuse(401, 'authentication_required'); };
        if (!runtime.schedules.hookAuthorized(admin, hook[1]!, token)) { denied(); return; }
        const body = await readHook(req);
        if (typeof body === 'number') { send(res, body, { error: { 400: 'invalid', 413: 'limit', 415: 'unsupported_media_type' }[body] }); return; }
        const result = runtime.schedules.receive(admin, hook[1]!, token, body.type, body.text);
        if (result.status === 'unauthorized') { denied(); return; }
        if (result.status === 'rate_limited') { res.setHeader('Retry-After', String(result.retry_after)); send(res, 429, { error: 'rate_limited' }); return; }
        send(res, result.status === 'stopped' ? 409 : 202, result.status === 'stopped' ? { error: 'schedule_stopped' } : { accepted: true }); return;
      }
      if (!auth.validOrigin(req)) { send(res, 403, { error: 'origin_rejected' }); return; }
      const url = new URL(req.url ?? '/', auth.origin);
      if (url.origin !== auth.origin) { send(res, 403, { error: 'origin_rejected' }); return; }
      if (!url.pathname.startsWith('/api/') && webRoot && serveStatic(webRoot, req, res)) return;
      if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
      // The browser returns from the provider without the Strict admin cookie. The single-use state created by an authenticated start is the proof instead.
      if (req.method === 'GET' && url.pathname === '/api/mcp/oauth/callback' && mcpSettings) {
        res.setHeader('Referrer-Policy', 'no-referrer');
        const once = (name: string) => { const all = url.searchParams.getAll(name); return all.length > 1 ? null : all[0]; };
        const params = { state: once('state'), code: once('code'), error: once('error'), iss: once('iss') };
        let done = false;
        if (!Object.values(params).includes(null as never)) try { done = await mcpSettings.oauthFinish(params as Parameters<McpSettings['oauthFinish']>[0]); } catch { done = false; }
        if (done) sendNotice(res, 200, 'MCPの接続先にログインしました。Niwaの画面に戻って「接続を確認」を押してください。');
        else sendNotice(res, 400, params.error ? 'ログインが取り消されたか、拒否されました。Niwaの設定から、もう一度ログインしてください。' : 'ログインを完了できませんでした。Niwaの設定から、もう一度ログインしてください。');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readBody(req);
        if (!Value.Check(object({ key: Type.String({ maxLength: 128 }) }), body)) throw new DomainError('invalid', 'Invalid login');
        const result = auth.login((body as { key: string }).key, req, res);
        if (typeof result === 'object') { res.setHeader('Retry-After', String(result.retryAfter)); send(res, 429, { error: 'rate_limited' }); return; }
        send(res, result === 'ok' ? 200 : 401, { authenticated: result === 'ok', ...(result === 'ok' ? {} : { error: 'invalid_key' }) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') { send(res, 200, { authenticated: auth.authenticated(req) }); return; }
      if (!auth.authenticated(req)) { send(res, 401, { error: 'authentication_required' }); return; }
      const resource=/^\/api\/mcp\/([a-z][a-z0-9_]{0,19})\/resource$/.exec(url.pathname);
      const resourceMcp=mcpSettings?.connector??mcp;
      if(req.method==='GET'&&resource&&resourceMcp){
        const room=url.searchParams.get('room')??'';
        if(!runtime.rooms(admin).some(r=>r.id===room))throw new DomainError('not_found','Conversation not found');
        const file=await resourceMcp.resource(resource[1]!,url.searchParams.get('uri')??'',mcpScope(runtime.workareas.epoch(),room));
        res.writeHead(200,{'Content-Type':file.mime,'Content-Disposition':'attachment','Content-Length':file.data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(file.data);return;
      }
      const attached=/^\/api\/attachments\/([0-9a-f-]{36})$/.exec(url.pathname);
      if(req.method==='GET'&&attached){
        // Stored text is served as an inert download, never rendered as HTML or script on this origin.
        const file=runtime.attachment(admin,attached[1]!),data=Buffer.from(file.body,'utf8');
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,'Content-Length':data.length,
          'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(data);return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') { auth.logout(req, res); send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && url.pathname === '/api/events/stream') { live.open(req, res); return; }
      for (const route of routes) {
        const match = url.pathname.match(route.path);
        if (req.method !== route.method || !match) continue;
        const body = route.schema ? await readBody(req, route.limit) : {};
        if (route.schema && !Value.Check(route.schema, body)) throw new DomainError('invalid', 'Invalid request');
        send(res, 200, await route.run(match, body as Record<string, unknown>, url)); return;
      }
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'internal_error';
      const status = { forbidden: 403, invalid: 400, not_found: 404, conflict: 409, limit: 413, internal_error: 500 }[code];
      if (!res.destroyed && !res.headersSent) send(res, status, { error: code });
    }
  });
  server.on('close', () => live.close());
  return server;
}
