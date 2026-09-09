import type {SubmissionContext} from '../runtime/conversation-work.ts';
import {qualityReviewSchema,type QualityReview} from '../runtime/artifact-quality.ts';
import {environmentDefinitionSchema} from '../tools/environments/registry.ts';
import {randomUUID} from 'node:crypto';
import type {WorkareaTransport} from '../runtime/workareas.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DomainError } from '../domain/types.ts';
import type { Agent, Settings } from '../domain/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { WebAuth } from './auth.ts';
import { ModelGateway } from '../providers/gateway.ts';
import { serveStatic } from './static.ts';
import { profileSchema, creationProfileSchema } from '../domain/profile.ts';
import type { Backups } from '../backup/backups.ts';
import type { WorkspaceRead, WorkspaceDownload } from '../tools/files/client.ts';
import type { XOAuth } from '../auth/x-oauth.ts';

const string = Type.String({ minLength: 1, maxLength: 20_000 });
const id = Type.String({ pattern: '^[0-9a-f-]{36}$' });
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const scheduleFields = { agent_id: id, room_id: id, prompt: string,
      interval_ms: Type.Integer({ minimum: 60_000, maximum: 365 * 86400_000 }), next_at: Type.Integer({ minimum: 0, maximum: 8_000_000_000_000_000 }),
      max_runs: Type.Integer({ minimum: 1, maximum: 10_000 }), timeout_ms: Type.Integer({ minimum: 60_000, maximum: 86400_000 }),
      max_model_calls: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      trigger_kind: Type.Optional(Type.Union([Type.Literal('interval'), Type.Literal('shared_changes')])), autonomous: Type.Optional(Type.Boolean()) };
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
  workspace?: { read: WorkspaceRead; download: WorkspaceDownload }, x?: XOAuth, workareas?:WorkareaTransport) {
  const admin = runtime.administrator();
  type Route = { method: string; path: RegExp; schema?: TSchema; run: (match: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown };
  const scoped=(area:string,input:Parameters<Runtime['workareas']['execute']>[2])=>{
    if(!workareas)throw new DomainError('conflict','Workareas are not configured');
    return runtime.workareas.execute(admin,area,input,workareas);
  };
  const routes: Route[] = [
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

    { method: 'GET', path: /^\/api\/x$/, run: () => x ? x.status() : { available: false, connected: false, pending: false } },
    { method: 'POST', path: /^\/api\/x\/login$/, schema: object({}), run: () => {
      if (!x) throw new DomainError('conflict', 'X is not configured'); return x.begin(auth.origin + '/api/x/callback'); } },
    { method: 'POST', path: /^\/api\/x\/logout$/, schema: object({}), run: async () => {
      if (!x) throw new DomainError('conflict', 'X is not configured'); await x.disconnect(); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/workspace\/files$/, run: async (_m, _b, url) => workspace
      ? { available: true, ...await workspace.read('list', url.searchParams.get('path') ?? '') } : { available: false, entries: [], path: '', truncated: false } },
    { method: 'GET', path: /^\/api\/workspace\/file$/, run: (_m, _b, url) => {
      if (!workspace) throw new DomainError('conflict', 'Workspace service unavailable');
      return workspace.download(url.searchParams.get('path') ?? ''); } },
    { method: 'POST', path: /^\/api\/agents$/, schema: object({ id, name: Type.String({ minLength: 1, maxLength: 100 }), profile: creationProfileSchema }), run: (_m, b) => runtime.requestMember(admin, b.id as string, b.name as string, b.profile as Record<string, unknown>) },
    { method:'GET',path:/^\/api\/initiatives$/,run:()=>({...runtime.initiatives.settings(admin),items:runtime.initiatives.list(admin)}) },
    { method:'PATCH',path:/^\/api\/initiatives$/,schema:object({enabled:Type.Boolean()}),run:(_m,b)=>{runtime.initiatives.enable(admin,b.enabled as boolean);return {ok:true};} },
    { method:'PATCH',path:/^\/api\/initiatives\/([0-9a-f-]{36})$/,schema:object({paused:Type.Boolean(),revision:Type.Integer({minimum:1})}),run:(m,b)=>{runtime.initiatives.pause(admin,m[1]!,b.revision as number,b.paused as boolean);return {ok:true};} },
    { method: 'GET', path: /^\/api\/autonomy$/, run: () => runtime.autonomousWakes.list(admin) },
    { method: 'GET', path: /^\/api\/schedules$/, run: () => runtime.schedules.list(admin) },
    { method: 'DELETE', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, run: m => { runtime.schedules.remove(admin, m[1]!); return { ok: true }; } },
    { method: 'POST', path: /^\/api\/schedules$/, schema: object({ id, ...scheduleFields }),
      run: (_m, b) => runtime.schedules.create(admin, b as unknown as import('../runtime/schedules.ts').ScheduleInput) },
    { method: 'PUT', path: /^\/api\/schedules\/([0-9a-f-]{36})$/, schema: object({ ...scheduleFields, version: Type.String({ pattern: '^[0-9a-f]{64}$' }) }),
      run: (m, b) => runtime.schedules.update(admin, { ...b, id: m[1]! } as unknown as import('../runtime/schedules.ts').ScheduleInput, b.version as string) },
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
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/profile$/, schema: object({ patch: profileSchema, version: Type.String({ pattern: '^[0-9a-f]{64}$' }), selection: Type.Optional(object({ provider: Type.Union([Type.Literal('ollama'), Type.Literal('openai_subscription')]), model: Type.String({ minLength: 1, maxLength: 256 }), reasoning: Type.String({ minLength: 1, maxLength: 20 }) })) }), run: (m, b) => models.updateProfile(m[1]!, b.patch as Record<string, unknown>, b.version as string, b.selection as Pick<Agent, 'provider' | 'model' | 'reasoning'> | undefined) },
    { method: 'DELETE', path: /^\/api\/agents\/([0-9a-f-]{36})$/, schema: object({ version: Type.String({ pattern: '^[0-9a-f]{64}$' }) }), run: async (m, b) => { runtime.deleteAgent(admin, m[1]!, b.version as string);if(workareas)await runtime.workareas.purgeRetired(workareas);return { ok: true }; } },
    { method: 'GET', path: /^\/api\/state$/, run: () => ({ approvals: runtime.approvals(admin), businessTasks: runtime.businessTasks(admin), deletedAgents: runtime.deletedAgents(admin), agents: runtime.agents(admin).map(agent => ({ ...agent, profile: runtime.profile(admin, agent.id), profile_version: runtime.profileVersion(admin, agent.id), memory_version: runtime.memoryVersion(admin, agent.id) })),
      rooms: runtime.rooms(admin).map(room => ({ ...room, ...runtime.roomPreferences(admin, room.id), ...runtime.messageSummary(admin, room.id), acknowledgments: runtime.acknowledgments(admin, room.id), participants: runtime.participants(admin, room.id) })), settings: runtime.settings(admin), commonRules: runtime.commonRules(admin), tasks: runtime.tasks.list(admin).map(task => ({ ...task, control_revision:runtime.tasks.controlRevision(admin,String(task.id)), progress:runtime.tasks.progress(admin,String(task.id)), replies: runtime.tasks.replies(admin, task.id) })) }) },
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
    { method: 'POST', path: /^\/api\/rooms\/([0-9a-f-]{36})\/messages$/, schema: object({ id, body: string, reply_to: Type.Optional(id), request_context:Type.Optional(object({kind:Type.Union(['status','new','amend','cancel'].map(value=>Type.Literal(value))),task_id:Type.Optional(id),expected_revision:Type.Optional(Type.Integer({minimum:0}))})), agent_id: Type.Optional(id), agent_ids: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })) }),
      run: (m, b) => {
        if (b.agent_id && b.agent_ids) throw new DomainError('invalid', 'Specify one recipient field');
        return runtime.submit(admin, b.id as string, m[1]!, b.body as string, (b.agent_ids ?? b.agent_id) as string | string[] | undefined, b.reply_to as string | undefined,b.request_context as SubmissionContext | undefined); } },
    { method: 'PATCH', path: /^\/api\/settings$/, schema: object({ paused: Type.Optional(Type.Boolean()), autonomous: Type.Optional(Type.Boolean()), generatedLimit: Type.Optional(Type.Integer({ minimum: 0 })),
      concurrencyLimit: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 1 })])), backupDays: Type.Optional(Type.Integer({ minimum: 1 })), backupTime: Type.Optional(Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })) }),
      run: (_m, b) => runtime.updateSettings(admin, b as Partial<Settings>) },
    { method: 'PATCH', path: /^\/api\/agents\/([0-9a-f-]{36})\/dormancy$/, schema: object({ dormant: Type.Boolean() }),
      run: (m, b) => { runtime.setDormant(admin, m[1]!, b.dormant as boolean); return { ok: true }; } },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories$/, run: (m, _b, url) => runtime.memories(admin, m[1]!, url.searchParams.get('q') ?? '') },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/page$/, run: (m, _b, url) => runtime.memoryPage(admin, m[1]!, url.searchParams.get('q') ?? '', Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)) },
    { method: 'GET', path: /^\/api\/agents\/([0-9a-f-]{36})\/memories\/([0-9a-f-]{36}|[0-9a-f]{64})\/corrections$/, run: m => runtime.memoryCorrections(admin, m[1]!, m[2]!) },
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
    {method:'GET',path:/^\/api\/tasks\/([0-9a-f-]{36})\/prompt-runs$/,run:m=>runtime.tasks.promptRuns(admin,m[1]!)},
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
      // Cross-site OAuth redirects lack the Strict admin cookie. A state created by an authenticated POST is consumed once instead.
      if (req.method === 'GET' && url.pathname === '/api/x/callback' && x) {
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
          if (url.searchParams.has('error') || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) throw new Error('Invalid callback');
          await x.finish(url.searchParams.get('state')!, url.searchParams.get('code')!);
          send(res, 200, { connected: true, message: 'Xを接続しました。このタブを閉じてNiwaの設定へ戻ってください。' });
        } catch { send(res, 400, { connected: false, message: 'Xの接続を完了できませんでした。Niwaの設定から接続をやり直してください。' }); }
        return;
      }
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
