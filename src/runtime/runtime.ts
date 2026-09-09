import {promptSchema} from '../storage/prompt-schema.ts';
import {artifactQualitySchema} from '../storage/artifact-quality-schema.ts';
import {ArtifactQuality} from './artifact-quality.ts';
import {initiativeSchema} from '../storage/initiative-schema.ts';
import {Initiatives} from './initiatives.ts';
import {executionSchema} from '../storage/execution-schema.ts';
import {Workareas} from './workareas.ts';
import {workareasSchema} from '../storage/workareas-schema.ts';
import { restoreSafetySchema } from '../storage/restore-safety-schema.ts';
import { userActionsSchema } from '../storage/user-actions-schema.ts';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { agentDeletionSchema } from '../storage/agent-deletion-schema.ts';
import { resolve, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { check, text, DomainError } from '../domain/types.ts';
import type { Agent, Room, Message, Memory, Settings } from '../domain/types.ts';
import { openDatabase, transaction } from '../storage/database.ts';
import { controlSchema, memoryMigrations } from '../storage/schema.ts';
import { taskSchema } from '../storage/task-schema.ts';
import { Tasks } from './tasks.ts';
import { autonomousContinuitySchema } from '../storage/autonomous-continuity-schema.ts';
import { AutonomousWakes } from './autonomous-wakes.ts';
import { autonomousWakeSchema } from '../storage/autonomous-wake-schema.ts';
import { workNoteSchema } from '../storage/work-note-schema.ts';
import { coordinationSchema } from '../storage/coordination-schema.ts';
import { handoffSchema } from '../storage/handoff-schema.ts';
import { artifactVersionSchema } from '../storage/artifact-version-schema.ts';
import { ArtifactVersions } from './artifact-versions.ts';
import { coordinationUpdateSchema, isAcknowledgment, type CoordinationUpdate } from '../domain/coordination.ts';
import { Schedules } from './schedules.ts';
import { scheduleSchema } from '../storage/schedule-schema.ts';
import { scheduleBudgetSchema } from '../storage/schedule-budget-schema.ts';
import { scheduleTriggerSchema } from '../storage/schedule-trigger-schema.ts';
import { scheduleDeletionSchema } from '../storage/schedule-deletion-schema.ts';
import { autonomySchema } from '../storage/autonomy-schema.ts';
import { providerLimitSchema } from '../storage/provider-limit-schema.ts';
import { modelRouteSchema } from '../storage/model-route-schema.ts';
import { providerRetrySchema } from '../storage/provider-retry-schema.ts';
import { commonRulesSchema } from '../storage/common-rules-schema.ts';
import { autonomyControlSchema } from '../storage/autonomy-control-schema.ts';
import { backupTimeSchema } from '../storage/backup-time-schema.ts';
import { generatedModelSchema } from '../storage/generated-model-schema.ts';
import { ProviderLimits } from './provider-limits.ts';
import { submissionSchema } from '../storage/submission-schema.ts';
import { modelSchema } from '../storage/model-schema.ts';
import { fallbackSchema } from '../storage/fallback-schema.ts';
import { externalSchema } from '../storage/external-schema.ts';
import { historySearchSchema } from '../storage/history-search-schema.ts';
import { profileSchema as profileMigration } from '../storage/profile-schema.ts';
import { conversationSchema } from '../storage/conversation-schema.ts';
import { organizationSchema } from '../storage/organization-schema.ts';
import { taskControlSchema } from '../storage/task-control-schema.ts';
import { productivitySchema } from '../storage/productivity-schema.ts';
import { deletionSchema } from '../storage/deletion-schema.ts';
import { assertDirectoryPath } from '../config/paths.ts';
import { profileSchema, creationProfileSchema } from '../domain/profile.ts';
import { Value } from '@sinclair/typebox/value';
import { conversationReplySchema } from '../storage/conversation-reply-schema.ts';
import type { Task, TaskLease } from '../domain/task.ts';
import { summarySchema, type WorkSummary } from '../domain/summary.ts';
import { executeProcedure } from './procedures.ts';
import type { JsonObject } from '../contracts/model.ts';
import { contentManagementSchema } from '../storage/content-management-schema.ts';
import { actionApprovalSchema } from '../storage/action-approval-schema.ts';
import { memoryReviewSchema, type MemoryReview } from '../domain/memory-review.ts';

declare const identity: unique symbol;
/** Opaque in-process capability; never construct this from HTTP or tool arguments. */
export type Actor = { readonly [identity]: true };
type Principal = { kind: 'admin'; id: 'administrator' } | { kind: 'agent'; id: string };

/** Trusted application service. Do not expose this object to generated code or models. */
export class Runtime {
  readonly quality: ArtifactQuality;
  readonly initiatives: Initiatives;
  readonly workareas: Workareas;
  readonly tasks: Tasks;
  readonly autonomousWakes: AutonomousWakes;
  readonly artifactVersions: ArtifactVersions;
  readonly schedules: Schedules;
  readonly providerLimits: ProviderLimits;
  #db: DatabaseSync;
  #root: string;
  #identities = new WeakMap<Actor, Principal>();
  #memories = new Map<string, DatabaseSync>();
  #closed = false;

  constructor(stateDirectory: string) {
    this.#root = resolve(stateDirectory);
    this.#db = openDatabase(join(this.#root, 'control.db'), [controlSchema, taskSchema, submissionSchema, modelSchema, profileMigration, conversationSchema, organizationSchema, taskControlSchema, productivitySchema, deletionSchema, fallbackSchema, externalSchema, historySearchSchema, scheduleSchema, scheduleBudgetSchema, scheduleTriggerSchema, scheduleDeletionSchema, autonomySchema, providerLimitSchema, modelRouteSchema, providerRetrySchema, commonRulesSchema, autonomyControlSchema, backupTimeSchema, generatedModelSchema, conversationReplySchema, agentDeletionSchema, contentManagementSchema, actionApprovalSchema, userActionsSchema, restoreSafetySchema, coordinationSchema, artifactVersionSchema, handoffSchema, workNoteSchema, autonomousWakeSchema, autonomousContinuitySchema, workareasSchema, executionSchema, initiativeSchema, artifactQualitySchema, promptSchema]);
    try { for (const record of this.#db.prepare('SELECT id FROM deleted_agents').all()) this.#purgeAgent(record.id as string); }
    catch (error) { this.#db.close(); throw error; }
    this.providerLimits = new ProviderLimits(this.#db, actor => this.#admin(actor));
    this.tasks = new Tasks(this.#db, {
      principal: actor => this.#principal(actor),
      initiative: (actor,task) => this.initiatives.current(actor,task),
      checkpoint: (actor,lease,input) => this.initiatives.checkpoint(actor,lease,input),
      room: (actor, id) => this.#room(actor, id),
      memory: (actor, id) => this.#memory(actor, id),
      announceDelegation: (actor, roomId, agentId, prompt) => {
        return this.post(actor, roomId, `@${this.#agent(agentId).name} への依頼\n${prompt}`).id;
      },
      participant: (agentId, roomId) => {
        const agent = this.#agent(agentId);
        const room = this.#db.prepare("SELECT visibility FROM rooms WHERE id=? AND id NOT IN (SELECT id FROM deleted_content WHERE kind='room')").get(roomId);
        return !!room && agent.status === 'active' && (room.visibility === 'shared'
          || !!this.#db.prepare('SELECT 1 FROM participants WHERE room_id=? AND agent_id=?').get(roomId, agentId));
      },
    });
    this.workareas = new Workareas(this.#db,this,actor=>this.#principal(actor));
    this.initiatives = new Initiatives(this.#db,this,actor=>this.#principal(actor));
    this.autonomousWakes = new AutonomousWakes(this.#db,this.tasks,actor=>this.#admin(actor),actor=>this.createRoom(actor,'自発活動').id,this.initiatives);
    this.quality = new ArtifactQuality(this.#db,this,actor=>this.#principal(actor));
    this.artifactVersions = new ArtifactVersions(this.#db,this,actor=>this.#principal(actor));
    this.schedules = new Schedules(this.#db, this.tasks, actor => this.#admin(actor), (actor, agentId, roomId) => {
      this.#room(actor, roomId);
      check(!this.roomPreferences(actor, roomId).archived, 'conflict', 'Restore the archived room before scheduling');
      check(this.#agent(agentId).status === 'active', 'forbidden', 'Agent is dormant');
      this.#room(this.agentSession(agentId), roomId);
    });
  }

  close(): void {
    if (this.#closed) return;
    for (const db of this.#memories.values()) db.close();
    this.#db.close();
    this.#closed = true;
    this.#identities = new WeakMap();
  }
  /** The service lock excludes other hosts; synchronous execution pauses all application writes. */
  snapshot(actor: Actor, directory: string): string[] {
    this.#admin(actor); assertDirectoryPath(directory);
    mkdirSync(directory, { mode: 0o700 });
    const databases = [['control.db', this.#db] as const, ...this.agents(actor).map(agent =>
      [`agents/${agent.id}/memory.db`, this.#memory(actor, agent.id)] as const)];
    for (const [name, db] of databases) {
      const target = join(directory, name);
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      closeSync(openSync(target, 'wx', 0o600));
      db.prepare('VACUUM INTO ?').run(target);
    }
    return databases.map(([name]) => name);
  }

  // Composition-root functions: future HTTP authentication / scheduler issues these.
  // These are NOT login endpoints; models never get to choose an execution identity.
  administrator(): Actor { return this.#issue({ kind: 'admin', id: 'administrator' }); }
  agentSession(agentId: string): Actor {
    this.#agent(agentId);
    return this.#issue({ kind: 'agent', id: agentId });
  }
  #issue(principal: Principal): Actor {
    check(!this.#closed, 'conflict', 'Runtime is closed');
    const actor = Object.freeze({}) as Actor;
    this.#identities.set(actor, principal);
    return actor;
  }
  #principal(actor: Actor): Principal {
    const principal = this.#identities.get(actor);
    check(principal, 'forbidden', 'Unrecognized execution identity');
    if (principal.kind === 'agent') {
      check(this.#agent(principal.id).status === 'active', 'forbidden', 'Agent is dormant');
    }
    return principal;
  }
  #admin(actor: Actor): Principal {
    const principal = this.#principal(actor);
    check(principal.kind === 'admin', 'forbidden', 'Administrator required');
    return principal;
  }
  #bot(actor: Actor): Principal & { kind: 'agent' } {
    const principal = this.#principal(actor);
    check(principal.kind === 'agent', 'forbidden', 'Agent required');
    return principal;
  }
  #agent(id: string): Agent {
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'forbidden', 'Invalid agent identity');
    const agent = this.#db.prepare('SELECT * FROM agents WHERE id = ? AND id NOT IN (SELECT id FROM deleted_agents)').get(id) as unknown as Agent | undefined;
    check(agent, 'not_found', 'Agent not found');
    return agent;
  }
  #running(actor: Actor): Principal {
    const principal = this.#principal(actor);
    if (principal.kind === 'agent') check(!this.settings(actor).paused, 'forbidden', 'Runtime is paused');
    return principal;
  }
  #leader(actor: Actor): Principal {
    const principal = this.#bot(actor);
    check(this.#agent(principal.id).role === 'leader', 'forbidden', 'Leader required');
    return principal;
  }

  bootstrap(actor: Actor): Agent {
    this.#admin(actor);
    return transaction(this.#db, () => {
      const existing = this.#db.prepare("SELECT * FROM agents WHERE role = 'leader'").get() as unknown as Agent | undefined;
      if (existing) return existing;
      const id = randomUUID();
      // Provisional name/model preference only; catalog verification and persona dialogue follow later.
      this.#db.prepare('INSERT INTO agents(id,name,role,status,model,reasoning) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'リーダー', 'leader', 'active', 'gpt-6-astra', 'low');
      return this.#agent(id);
    });
  }
  agents(actor: Actor): Agent[] {
    this.#principal(actor);
    return this.#db.prepare('SELECT * FROM agents WHERE id NOT IN (SELECT id FROM deleted_agents) ORDER BY rowid').all() as unknown as Agent[];
  }
  deletedAgents(actor: Actor): { id: string; deleted_at: number }[] {
    this.#admin(actor);
    return this.#db.prepare('SELECT id,deleted_at FROM deleted_agents').all() as { id: string; deleted_at: number }[];
  }
  deleteAgent(actor: Actor, agentId: string, expected?: string): void {
    this.#admin(actor);
    if (!this.#db.prepare('SELECT 1 FROM deleted_agents WHERE id=?').get(agentId)) {
      check(this.#agent(agentId).role !== 'leader', 'forbidden', 'Leader cannot be deleted');
      check(expected === undefined || expected === this.profileVersion(actor, agentId), 'conflict', 'Profile changed; reload before deleting');
      this.applyAgentDeletions(actor, [{ id: agentId, deleted_at: Date.now() }]);
    } else this.#purgeAgent(agentId);
  }
  /** Retain deletion identities even when restoring a snapshot older than the Bot. */
  applyAgentDeletions(actor: Actor, records: ReturnType<Runtime['deletedAgents']>): void {
    this.#admin(actor);
    for (const record of records) {
      check(/^[0-9a-f-]{36}$/.test(record.id) && Number.isSafeInteger(record.deleted_at) && record.deleted_at >= 0, 'invalid', 'Invalid Bot deletion');
      check(this.#db.prepare('SELECT role FROM agents WHERE id=?').get(record.id)?.role !== 'leader', 'forbidden', 'Leader cannot be deleted');
      transaction(this.#db, () => {
        for (const task of this.tasks.list(actor)) if (task.agent_id === record.id && !['completed', 'failed', 'cancelled'].includes(task.state)) this.tasks.cancel(actor, task.id);
        this.#db.prepare("UPDATE schedules SET deleted=1,enabled=0,prompt='',source_revision='',wait_reason=NULL WHERE agent_id=?").run(record.id);
        this.#db.prepare('DELETE FROM agent_profiles WHERE agent_id=?').run(record.id);
        this.#db.prepare('DELETE FROM tool_receipts WHERE task_id IN (SELECT id FROM tasks WHERE agent_id=?)').run(record.id);
        this.#db.prepare("UPDATE agents SET name='削除したBot',status='dormant' WHERE id=?").run(record.id);
        this.#db.prepare('INSERT OR IGNORE INTO deleted_agents VALUES (?,?)').run(record.id, record.deleted_at);
      });
      this.#purgeAgent(record.id);
    }
  }
  #purgeAgent(agentId: string): void {
    check(/^[0-9a-f-]{36}$/.test(agentId), 'invalid', 'Invalid Bot deletion');
    this.#db.prepare("UPDATE workareas SET deleted=1 WHERE kind='personal' AND owner_id=?").run(agentId);
    this.#db.prepare('DELETE FROM workarea_members WHERE agent_id=?').run(agentId);
    this.#db.prepare("DELETE FROM initiatives WHERE owner_id=? AND room_id IN (SELECT id FROM rooms WHERE visibility<>'shared')").run(agentId);
    this.#db.prepare("UPDATE initiatives SET state='paused' WHERE owner_id=?").run(agentId);
    this.#memories.get(agentId)?.close(); this.#memories.delete(agentId);
    const directory = join(this.#root, 'agents', agentId);
    assertDirectoryPath(directory);
    rmSync(directory, { recursive: true, force: true });
  }
  invalidateProvider(actor: Actor, provider: Agent['provider']): void {
    this.#admin(actor);
    for (const agent of this.agents(actor)) if (agent.provider === provider) this.#interruptTasks(agent.id);
  }
  profile(actor: Actor, agentId: string): Record<string, string> {
    const principal = this.#principal(actor); this.#agent(agentId);
    check(principal.kind === 'admin' || principal.id === agentId, 'forbidden', 'Private profile');
    const row = this.#db.prepare('SELECT profile FROM agent_profiles WHERE agent_id=?').get(agentId);
    return row ? JSON.parse(row.profile as string) as Record<string, string> : {};
  }
  profileVersion(actor: Actor, agentId: string): string {
    const { name, provider, model, reasoning } = this.#agent(agentId);
    return createHash('sha256').update(JSON.stringify([this.profile(actor, agentId), name, provider, model, reasoning])).digest('hex');
  }
  updateProfile(actor: Actor, agentId: string, patch: Record<string, unknown>, expected?: string, selection?: Pick<Agent, 'provider' | 'model' | 'reasoning'>): void {
    this.#admin(actor); this.#agent(agentId);
    check(Value.Check(profileSchema, patch), 'invalid', 'Invalid profile');
    if (selection) {
      check(selection.provider === 'openai_subscription' || selection.provider === 'ollama', 'invalid', 'Invalid provider');
      text(selection.model, 256); text(selection.reasoning, 64);
    }
    this.#writeProfile(actor, agentId, patch, true, expected, selection);
  }
  updateOwnProfile(actor: Actor, name: string, persona: string): void {
    const principal = this.#bot(actor); this.#running(actor);
    this.#writeProfile(actor, principal.id, { name: text(name, 100), persona: text(persona, 10_000) }, false);
  }
  #writeProfile(actor: Actor, agentId: string, patch: Record<string, unknown>, interrupt: boolean, expected?: string, selection?: Pick<Agent, 'provider' | 'model' | 'reasoning'>): void {
    transaction(this.#db, () => {
      check(expected === undefined || expected === this.profileVersion(actor, agentId), 'conflict', 'Profile changed; reload before saving');
      if (interrupt) {
        // Invalidate before the control write: a failed edit may discard work, but never preserve stale instructions.
        const memory = this.#memory(actor, agentId);
        transaction(memory, () => memory.exec("UPDATE memory_state SET revision=revision+1 WHERE id=1; UPDATE task_steps SET discarded=1,events='[]';"));
      }
      const { name, ...details } = patch;
      if (name !== undefined) this.#db.prepare('UPDATE agents SET name=? WHERE id=?').run(text(name, 100), agentId);
      const next = { ...this.profile(actor, agentId), ...details };
      this.#db.prepare('INSERT INTO agent_profiles VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET profile=excluded.profile').run(agentId, JSON.stringify(next));
      if (selection) this.#db.prepare('UPDATE agents SET provider=?,model=?,reasoning=? WHERE id=?').run(selection.provider, selection.model, selection.reasoning, agentId);
      if (interrupt) this.#interruptTasks(agentId);
    });
  }
  createAgent(actor: Actor, name: string, profile: Record<string, unknown> = {}): Agent {
    this.#leader(actor);
    this.#running(actor);
    return this.#createMember(actor, name, profile);
  }
  #createMember(actor: Actor, name: string, profile: Record<string, unknown>): Agent {
    text(name, 100);
    check(Value.Check(creationProfileSchema, profile), 'invalid', 'Invalid initial profile');
    return transaction(this.#db, () => {
      const { count } = this.#db.prepare("SELECT count(*) AS count FROM agents WHERE role = 'member' AND id NOT IN (SELECT id FROM deleted_agents)").get() as { count: number };
      check(count < this.settings(actor).generatedLimit, 'limit', 'Generated agent limit reached');
      const id = randomUUID();
      const selected = this.generatedModel(actor);
      this.#db.prepare('INSERT INTO agents(id,name,role,status,model,reasoning,provider) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, 'member', 'active', selected.model, selected.reasoning, selected.provider);
      this.#db.prepare('INSERT INTO agent_profiles(agent_id,profile) VALUES (?,?)').run(id, JSON.stringify(profile));
      return this.#agent(id);
    });
  }
  requestMember(actor: Actor, id: string, name: string, profile: Record<string, unknown>): Agent {
    this.#admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid member request id');
    text(name, 100);
    check(Value.Check(creationProfileSchema, profile), 'invalid', 'Invalid initial profile');
    const hash = createHash('sha256').update(JSON.stringify([name, Object.entries(profile).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
    return transaction(this.#db, () => {
      const prior = this.#db.prepare('SELECT * FROM member_requests WHERE id=?').get(id);
      if (prior) {
        check(prior.input_hash === hash, 'conflict', 'Member request id was reused with different input');
        return this.#agent(prior.agent_id as string);
      }
      const agent = this.#createMember(actor, name, profile);
      this.#db.prepare('INSERT INTO member_requests VALUES (?,?,?)').run(id, hash, agent.id);
      return agent;
    });
  }
  setDormant(actor: Actor, agentId: string, dormant: boolean): void {
    const principal = this.#principal(actor);
    if (principal.kind !== 'admin') { this.#leader(actor); this.#running(actor); }
    check(typeof dormant === 'boolean', 'invalid', 'Expected boolean');
    check(this.#agent(agentId).role !== 'leader', 'forbidden', 'Leader cannot be made dormant');
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(dormant ? 'dormant' : 'active', agentId);
      if (dormant) this.#interruptTasks(agentId);
    });
  }

  #interruptTasks(agentId?: string): void {
    const condition = agentId === undefined ? "state='running'" : "state='running' AND agent_id=?";
    const args = agentId === undefined ? [] : [agentId];
    this.#db.prepare(`INSERT INTO task_events(task_id,kind,created_at) SELECT id,'interrupted',? FROM tasks WHERE ${condition}`).run(Date.now(), ...args);
    this.#db.prepare(`UPDATE tasks SET state='queued',lease_token=NULL,updated_at=? WHERE ${condition}`).run(Date.now(), ...args);
  }

  generatedModel(actor: Actor): Pick<Agent, 'provider' | 'model' | 'reasoning'> {
    this.#principal(actor);
    return this.#db.prepare('SELECT provider,model,reasoning FROM generated_model WHERE id=1').get() as Pick<Agent, 'provider' | 'model' | 'reasoning'>;
  }
  configureGeneratedModel(actor: Actor, provider: Agent['provider'], model: string, reasoning: string): void {
    this.#admin(actor); text(model, 256); text(reasoning, 64);
    check(provider === 'openai_subscription' || provider === 'ollama', 'invalid', 'Invalid provider');
    this.#db.prepare('UPDATE generated_model SET provider=?,model=?,reasoning=? WHERE id=1').run(provider, model, reasoning);
  }
  commonRules(actor: Actor): { revision: number; body: string } {
    this.#principal(actor);
    return this.#db.prepare('SELECT revision,body FROM common_rules WHERE id=1').get() as { revision: number; body: string };
  }
  updateCommonRules(actor: Actor, revision: number, body: string): void {
    this.#admin(actor);
    check(Number.isSafeInteger(revision) && revision >= 1, 'invalid', 'Invalid rule revision');
    check(typeof body === 'string' && body.length <= 20_000, 'invalid', 'Rules are too long');
    transaction(this.#db, () => {
      const current = this.commonRules(actor);
      check(current.revision === revision, 'conflict', 'Rules changed; reload before saving');
      if (current.body === body) return;
      this.#db.prepare('UPDATE common_rules SET revision=revision+1,body=? WHERE id=1').run(body);
      this.#interruptTasks();
    });
  }
  modelRoutes(actor: Actor) {
    this.#admin(actor);
    return this.#db.prepare(`SELECT a.id,a.name,a.provider AS configured_provider,a.model AS configured_model,
      r.provider,r.model,r.reason,r.attempted_at FROM agents a LEFT JOIN model_routes r ON r.agent_id=a.id ORDER BY a.id`).all();
  }
  recordModelRoute(actor: Actor, agentId: string, provider: Agent['provider'], model: string, reason: 'configured' | 'quota'): void {
    this.#admin(actor); this.#agent(agentId); text(model, 256);
    check(provider === 'ollama' || provider === 'openai_subscription', 'invalid', 'Invalid provider');
    check(reason === 'configured' || reason === 'quota', 'invalid', 'Invalid route reason');
    this.#db.prepare(`INSERT INTO model_routes(agent_id,provider,model,reason,attempted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,reason=excluded.reason,attempted_at=excluded.attempted_at`)
      .run(agentId, provider, model, reason, Date.now());
  }
  modelSettings(actor: Actor): { ollamaUrl: string | null; fallbackModel: string | null } {
    this.#admin(actor);
    const row = this.#db.prepare('SELECT ollama_url,fallback_model FROM model_settings WHERE id=1').get()!;
    return { ollamaUrl: row.ollama_url as string | null, fallbackModel: row.fallback_model as string | null };
  }
  /** Host must verify local model capabilities against this exact endpoint before saving. */
  configureFallback(actor: Actor, url: string, model: string | null): void {
    this.#admin(actor);
    check(this.modelSettings(actor).ollamaUrl === url, 'conflict', 'Ollama configuration changed during discovery');
    if (model !== null) text(model, 256);
    this.#db.prepare('UPDATE model_settings SET fallback_model=? WHERE id=1').run(model);
  }
  configureOllama(actor: Actor, url: string | null): void {
    this.#admin(actor);
    if (url !== null) {
      text(url, 2048);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new DomainError('invalid', 'Invalid Ollama URL'); }
      check(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'invalid', 'Invalid Ollama URL');
    }
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE model_settings SET fallback_model=CASE WHEN ollama_url IS ? THEN fallback_model ELSE NULL END,ollama_url=? WHERE id=1').run(url, url);
      this.#interruptTasks();
    });
  }
  /** The host verifies selection capabilities before invoking this persistence operation. */
  setAgentModel(actor: Actor, agentId: string, provider: Agent['provider'], model: string, reasoning: string): Agent {
    this.#admin(actor); this.#agent(agentId);
    check(provider === 'openai_subscription' || provider === 'ollama', 'invalid', 'Invalid provider');
    text(model, 256); text(reasoning, 64);
    return transaction(this.#db, () => {
      this.#db.prepare('UPDATE agents SET provider=?,model=?,reasoning=? WHERE id=?').run(provider, model, reasoning, agentId);
      this.#interruptTasks(agentId);
      return this.#agent(agentId);
    });
  }

  settings(actor: Actor): Settings {
    this.#principal(actor);
    const row = this.#db.prepare('SELECT * FROM settings WHERE id = 1').get() as {
      paused: number; generated_limit: number; concurrency_limit: number | null; backup_days: number; autonomous: number; backup_time: string;
    };
    return { paused: row.paused === 1, generatedLimit: row.generated_limit,
      concurrencyLimit: row.concurrency_limit, backupDays: row.backup_days, autonomous: row.autonomous === 1, backupTime: row.backup_time };
  }
  updateSettings(actor: Actor, patch: Partial<Settings>): Settings {
    this.#admin(actor);
    check(patch && typeof patch === 'object' && !Array.isArray(patch), 'invalid', 'Expected settings');
    const allowed = ['paused', 'generatedLimit', 'concurrencyLimit', 'backupDays', 'autonomous', 'backupTime'];
    check(Object.keys(patch).every(key => allowed.includes(key)), 'invalid', 'Unknown setting');
    return transaction(this.#db, () => {
      const next = { ...this.settings(actor), ...patch };
      check(typeof next.paused === 'boolean', 'invalid', 'Expected boolean');
      check(typeof next.autonomous === 'boolean', 'invalid', 'Expected autonomy boolean');
      check(Number.isSafeInteger(next.generatedLimit) && next.generatedLimit >= 0, 'invalid', 'Invalid agent limit');
      check(next.concurrencyLimit === null || (Number.isSafeInteger(next.concurrencyLimit) && next.concurrencyLimit > 0),
        'invalid', 'Invalid concurrency limit');
      check(Number.isSafeInteger(next.backupDays) && next.backupDays > 0, 'invalid', 'Invalid backup days');
      check(typeof next.backupTime === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(next.backupTime), 'invalid', 'Invalid backup time');
      this.#db.prepare('UPDATE settings SET paused=?, generated_limit=?, concurrency_limit=?, backup_days=?,autonomous=?,backup_time=? WHERE id=1')
        .run(Number(next.paused), next.generatedLimit, next.concurrencyLimit, next.backupDays, Number(next.autonomous), next.backupTime);
      if (!next.autonomous) this.tasks.suspendAutonomous(actor);
      if (next.paused) this.#interruptTasks();
      return next;
    });
  }

  /** A room is one UI thread. Private participants are immutable; admin always has access. */
  createRoom(actor: Actor, title: string, participants?: string[]): Room {
    const principal = this.#running(actor);
    text(title, 200);
    if (participants !== undefined) {
      check(Array.isArray(participants) && participants.length > 0 && participants.length <= 100,
        'invalid', 'Private rooms need participants');
      for (const id of participants) this.#agent(id);
      check(principal.kind === 'admin' || participants.includes(principal.id), 'forbidden', 'Creator must participate');
    }
    const room: Room = { id: randomUUID(), title, visibility: participants ? 'private' : 'shared' };
    return transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(room.id, title, room.visibility);
      for (const id of new Set(participants)) this.#db.prepare('INSERT INTO participants VALUES (?, ?)').run(room.id, id);
      return room;
    });
  }
  rooms(actor: Actor): Room[] {
    const principal = this.#principal(actor);
    const records = (principal.kind === 'admin'
      ? this.#db.prepare('SELECT * FROM rooms ORDER BY rowid').all()
      : this.#db.prepare(`SELECT * FROM rooms WHERE visibility = 'shared' OR id IN
          (SELECT room_id FROM participants WHERE agent_id = ?) ORDER BY rowid`).all(principal.id)) as unknown as Room[];
    const deleted = new Set(this.#db.prepare("SELECT id FROM deleted_content WHERE kind='room'").all().map(row => row.id));
    return records.filter(room => !deleted.has(room.id));
  }
  participants(actor: Actor, roomId: string): string[] {
    const room = this.#room(actor, roomId);
    if (room.visibility === 'shared') return this.agents(actor).map(agent => agent.id);
    return (this.#db.prepare('SELECT agent_id FROM participants WHERE room_id=?').all(roomId) as { agent_id: string }[]).map(row => row.agent_id);
  }
  roomPreferences(actor: Actor, roomId: string): { pinned: boolean; archived: boolean } {
    this.#admin(actor); this.#room(actor, roomId);
    const row = this.#db.prepare('SELECT pinned,archived FROM room_preferences WHERE room_id=?').get(roomId);
    return { pinned: row?.pinned === 1, archived: row?.archived === 1 };
  }
  createArtifact(actor: Actor, roomId: string, name: string, kind: string, description: string, content: string, taskId?: string): string {
    const principal = this.#bot(actor); this.#running(actor); this.#room(actor, roomId);
    text(name, 200); text(kind, 50); text(description, 1000); text(content, 100_000);
    check(!/[\\/\x00-\x1f]/.test(name), 'invalid', 'Use a filename without directories');
    return transaction(this.#db, () => {
      const id = randomUUID();
      this.#db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)').run(id, roomId, principal.id, name, kind, description, content, Date.now());
      this.quality.attach(id,taskId);
      this.reportUpdate(actor, roomId, 'done', `${name}ができました`, description, taskId, id);
      return id;
    });
  }
  artifacts(actor: Actor, query = ''): Record<string, unknown>[] {
    check(typeof query === 'string' && query.length <= 200, 'invalid', 'Invalid artifact query');
    const rooms = new Set(this.rooms(actor).map(room => room.id));
    return this.#db.prepare(`SELECT id,room_id,author_id,name,kind,description,created_at FROM artifacts
      WHERE instr(lower(name || ' ' || description || ' ' || content), lower(?)) > 0 ORDER BY created_at DESC`)
      .all(query.trim()).filter(row => rooms.has(row.room_id as string)&&this.workareas.visible(actor,String(row.id))&&this.quality.readable(actor,String(row.id)));
  }
  artifact(actor: Actor, id: string): Record<string, unknown> {
    const row = this.#db.prepare('SELECT * FROM artifacts WHERE id=?').get(text(id, 100));
    check(row&&this.workareas.visible(actor,id)&&this.quality.readable(actor,id), 'not_found', 'Artifact not found'); this.#room(actor, row.room_id as string);
    return row;
  }
  reportUpdate(actor: Actor, roomId: string, kind: 'done' | 'decision' | 'question', title: string, detail: string, taskId?: string, artifactId?: string): void {
    const principal = this.#bot(actor); this.#running(actor); this.#room(actor, roomId);
    check(['done', 'decision', 'question'].includes(kind), 'invalid', 'Invalid update kind'); text(title, 200); text(detail);
    if (taskId) check(this.tasks.get(actor, taskId).room_id === roomId, 'forbidden', 'Task belongs to another room');
    if (artifactId) check(this.artifact(actor, artifactId).room_id === roomId, 'forbidden', 'Artifact belongs to another room');
    this.#db.prepare('INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,artifact_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(roomId, principal.id, kind, title, detail, taskId ?? null, artifactId ?? null, Date.now());
  }
  updates(actor: Actor): Record<string, unknown>[] {
    this.#admin(actor);
    return this.#db.prepare('SELECT * FROM updates ORDER BY created_at DESC,id DESC').all();
  }
  readUpdates(actor: Actor, ids: number[]): void {
    this.#admin(actor); check(Array.isArray(ids) && ids.length <= 1000 && ids.every(id => Number.isSafeInteger(id) && id > 0), 'invalid', 'Invalid update ids');
    transaction(this.#db, () => { for (const id of ids) this.#db.prepare('UPDATE updates SET seen=1 WHERE id=?').run(id); });
  }
  businessTasks(actor: Actor): Record<string, unknown>[] {
    this.#admin(actor); return this.#db.prepare('SELECT * FROM business_tasks').all();
  }
  approvals(actor: Actor): Record<string, unknown>[] {
    this.#admin(actor);
    return this.#db.prepare("SELECT a.* FROM approval_requests a JOIN tasks t ON t.id=a.task_id WHERE a.status='pending' AND t.state='waiting_user'").all();
  }
  requestApproval(actor: Actor, lease: TaskLease, title: string, detail: string): void {
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active'); text(title, 200); text(detail, 2000);
    transaction(this.#db, () => {
      this.#db.prepare("INSERT INTO approval_requests(task_id,title,detail,version,status) VALUES (?,?,?,?,'pending') ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,detail=excluded.detail,version=excluded.version,status='pending',action_hash=NULL,operation_id=NULL").run(lease.task.id, title, detail, randomUUID());
      this.tasks.wait(actor, lease, 'waiting_user', title);
    });
  }
  /** Caller supplies the complete normalized operation. The display and binding use identical bytes. */
  authorizeAction(actor: Actor, lease: TaskLease, operationId: string, title: string, action: JsonObject): boolean {
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    check(/^[A-Za-z0-9:_-]{1,160}$/.test(operationId), 'invalid', 'Invalid approval operation');
    const detail = JSON.stringify(action, null, 2); text(detail, 2000);
    const hash = createHash('sha256').update(detail).digest('hex');
    return transaction(this.#db, () => {
      const prior = this.#db.prepare('SELECT action_hash,operation_id,status FROM approval_requests WHERE task_id=?').get(lease.task.id);
      if (prior?.action_hash === hash && prior.operation_id === operationId && prior.status === 'approved') return true;
      this.requestApproval(actor, lease, title, detail);
      this.#db.prepare('UPDATE approval_requests SET action_hash=?,operation_id=? WHERE task_id=?').run(hash, operationId, lease.task.id);
      return false;
    });
  }
  decideApproval(actor: Actor, id: string, approved: boolean, version: string): void {
    this.#admin(actor); check(typeof approved === 'boolean', 'invalid', 'Expected approval decision');
    transaction(this.#db, () => {
      const task = this.tasks.get(actor, id);
      const request = this.#db.prepare("SELECT * FROM approval_requests WHERE task_id=? AND status='pending'").get(id);
      check(request && request.version === version && task.state === 'waiting_user', 'conflict', 'Approval is no longer pending');
      this.#db.prepare('UPDATE approval_requests SET status=? WHERE task_id=?').run(approved ? 'approved' : 'declined', id);
      if (approved) this.#db.prepare('UPDATE tasks SET paused=0 WHERE id=?').run(id);
      if (approved) this.tasks.resume(actor, id, `管理者が次の内容を承認しました：${request.title}\n${request.detail}`);
      else this.tasks.cancel(actor, id);
    });
  }
  registerBusinessTask(actor: Actor, lease: TaskLease, title: string, detail: string): void {
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active'); text(title, 200); text(detail, 2000);
    this.#db.prepare('INSERT INTO business_tasks VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,detail=excluded.detail').run(lease.task.id, title, detail);
  }
  deletedContent(actor: Actor): { kind: 'room' | 'artifact'; id: string; deleted_at: number }[] {
    this.#admin(actor); return this.#db.prepare('SELECT * FROM deleted_content').all() as ReturnType<Runtime['deletedContent']>;
  }
  deleteContent(actor: Actor, kind: 'room' | 'artifact', id: string): void {
    this.#admin(actor);
    if (!this.#db.prepare('SELECT 1 FROM deleted_content WHERE kind=? AND id=?').get(kind, id)) {
      if (kind === 'room') this.#room(actor, id); else this.artifact(actor, id);
    }
    this.applyContentDeletions(actor, [{ kind, id, deleted_at: Date.now() }]);
  }
  applyContentDeletions(actor: Actor, records: ReturnType<Runtime['deletedContent']>): void {
    this.#admin(actor);
    for (const record of records) {
      check(['room', 'artifact'].includes(record.kind) && /^[0-9a-f-]{36}$/.test(record.id) && Number.isSafeInteger(record.deleted_at) && record.deleted_at >= 0, 'invalid', 'Invalid content deletion');
      // Invalidate saved output before deleting its source, including work in other rooms.
      for (const agent of this.agents(actor)) {
        const memory = this.#memory(actor, agent.id);
        transaction(memory, () => {
          if (record.kind === 'room') for (const row of memory.prepare('SELECT id,revision FROM memories WHERE source_room_id=?').all(record.id)) {
            memory.prepare('DELETE FROM memories WHERE id=?').run(row.id as string);
            this.#audit(memory, row.id as string, 'deleted', 'administrator', Number(row.revision) + 1);
          }
          memory.exec("UPDATE memory_state SET revision=revision+1 WHERE id=1; UPDATE task_steps SET discarded=1,events='[]';");
        });
      }
      transaction(this.#db, () => {
        if (record.kind === 'room') {
          for (const task of this.tasks.list(actor)) if (task.room_id === record.id && !['completed', 'cancelled'].includes(task.state)) this.tasks.cancel(actor, task.id);
          this.#db.prepare("UPDATE schedules SET deleted=1,enabled=0,prompt='',source_revision='',wait_reason=NULL WHERE room_id=?").run(record.id);
          this.#db.prepare('DELETE FROM updates WHERE room_id=?').run(record.id);
          this.#db.prepare('DELETE FROM artifacts WHERE room_id=?').run(record.id);
          this.#db.prepare('DELETE FROM submissions WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)').run(record.id);
          this.#db.prepare('DELETE FROM messages WHERE room_id=?').run(record.id);
          this.#db.prepare('UPDATE workareas SET deleted=1 WHERE room_id=?').run(record.id);
          this.#db.prepare("UPDATE rooms SET title='' WHERE id=?").run(record.id);
          this.#db.prepare('DELETE FROM task_coordination WHERE task_id IN (SELECT id FROM tasks WHERE room_id=?)').run(record.id);
          this.#db.prepare("UPDATE tasks SET prompt='',result=NULL,wait_reason=NULL,source_message_id=NULL WHERE room_id=?").run(record.id);
          for (const table of ['autonomous_boundaries', 'work_notes', 'task_replies', 'tool_receipts', 'business_tasks', 'approval_requests']) this.#db.prepare('DELETE FROM ' + table + ' WHERE task_id IN (SELECT id FROM tasks WHERE room_id=?)').run(record.id);
        } else {
          this.#db.prepare('DELETE FROM updates WHERE artifact_id=?').run(record.id);
          this.#db.prepare('DELETE FROM artifacts WHERE id=?').run(record.id);
        }
        this.#db.prepare('INSERT OR IGNORE INTO deleted_content VALUES (?,?,?)').run(record.kind, record.id, record.deleted_at);
      });
    }
  }
  organizeRoom(actor: Actor, roomId: string, patch: { pinned?: boolean; archived?: boolean }): void {
    this.#admin(actor); this.#room(actor, roomId);
    check(Object.entries(patch).every(([key, value]) => ['pinned', 'archived'].includes(key) && typeof value === 'boolean'), 'invalid', 'Invalid room preferences');
    const next = { ...this.roomPreferences(actor, roomId), ...patch };
    this.#db.prepare('INSERT INTO room_preferences VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived')
      .run(roomId, Number(next.pinned), Number(next.archived));
    if (next.archived) this.tasks.suspendAutonomous(actor);
  }
  #room(actor: Actor, id: string): Room {
    const principal = this.#principal(actor);
    check(!this.#db.prepare("SELECT 1 FROM deleted_content WHERE kind='room' AND id=?").get(id), 'not_found', 'Room deleted');
    const room = this.#db.prepare('SELECT * FROM rooms WHERE id = ?').get(text(id, 100)) as unknown as Room | undefined;
    check(room && (principal.kind === 'admin' || room.visibility === 'shared'
      || this.#db.prepare('SELECT 1 FROM participants WHERE room_id = ? AND agent_id = ?').get(id, principal.id)),
    'forbidden', 'Room unavailable');
    return room;
  }
  post(actor: Actor, roomId: string, body: string): Message {
    const principal = this.#running(actor);
    this.#room(actor, roomId);
    text(body);
    const message: Message = { reply_to: null, id: randomUUID(), room_id: roomId, author_id: principal.id, body, created_at: new Date().toISOString() };
    this.#db.prepare('INSERT INTO messages(id,room_id,author_id,body,created_at) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, roomId, message.author_id, body, message.created_at);
    return message;
  }
  messages(actor: Actor, roomId: string): Message[] {
    this.#room(actor, roomId);
    return this.#db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY rowid').all(roomId) as unknown as Message[];
  }
  acknowledgments(actor: Actor, roomId: string) {
    this.#room(actor, roomId);
    return this.#db.prepare(`SELECT a.message_id,a.agent_id,a.created_at FROM message_acknowledgments a JOIN messages m ON m.id=a.message_id WHERE m.room_id=? ORDER BY a.created_at`).all(roomId);
  }
  /** Explicit public progress only; model reasoning and private transcripts are never read. */
  workNotes(actor: Actor, roomId: string) {
    this.#room(actor, roomId);
    return this.#db.prepare(`SELECT n.*,t.agent_id,t.state FROM work_notes n JOIN tasks t ON t.id=n.task_id
      WHERE t.room_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 200`).all(roomId).reverse();
  }
  addWorkNote(actor: Actor, lease: TaskLease, body: string) {
    check(this.tasks.active(actor, lease), 'conflict', 'Task lease is no longer active');
    const task = this.tasks.get(actor, lease.task.id);
    this.#room(actor, task.room_id);
    check(typeof body === 'string' && body.trim().length > 0 && body.length <= 300, 'invalid', 'Write a short public progress note');
    const previous = this.#db.prepare('SELECT body FROM work_notes WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task.id);
    if (previous?.body === body.trim()) return { saved: false };
    const count = Number(this.#db.prepare('SELECT count(*) AS n FROM work_notes WHERE task_id=?').get(task.id)!.n);
    check(count < 50, 'invalid', 'Progress note limit reached; continue the actual work');
    this.#db.prepare('INSERT INTO work_notes(id,task_id,body,created_at) VALUES (?,?,?,?)').run(randomUUID(),task.id,body.trim(),Date.now());
    return { saved: true };
  }
  /** Share operational facts in this room only; never expose another Bot's memory or model transcript. */
  coordination(actor: Actor, roomId: string) {
    this.#room(actor, roomId);
    return this.#db.prepare(`SELECT t.id,t.agent_id,t.requester_id,t.parent_id,substr(t.prompt,1,500) AS prompt,t.state,t.paused,t.wait_reason,t.deadline_at,t.created_at,t.updated_at,
      coalesce(c.revision,0) AS revision,coalesce(c.completion_condition,'') AS completion_condition,coalesce(c.stop_condition,'') AS stop_condition,
      coalesce(c.blocker,'') AS blocker,c.waiting_for,c.next_agent_id,
      (SELECT min(created_at) FROM task_events WHERE task_id=t.id AND kind='running') AS started_at,
      (SELECT max(u.created_at) FROM updates u WHERE u.task_id=t.id AND u.artifact_id IS NOT NULL) AS last_artifact_at,
      (SELECT artifact_id FROM updates WHERE task_id=t.id AND artifact_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1) AS artifact_id,
      EXISTS(SELECT 1 FROM approval_requests WHERE task_id=t.id AND status='pending') AS approval_pending,
      (SELECT count(*) FROM external_operations WHERE task_id=t.id) AS external_operations,
      EXISTS(SELECT 1 FROM task_events WHERE task_id=t.id AND kind='work_acknowledged') AS work_acknowledged,
      (SELECT artifact_id FROM task_handoffs WHERE task_id=t.id) AS ready_artifact_id,
      (SELECT sha256 FROM task_handoffs WHERE task_id=t.id) AS ready_sha256,
      (SELECT child_id FROM task_handoffs WHERE task_id=t.id) AS handoff_child_id,
      EXISTS(SELECT 1 FROM task_events WHERE task_id=t.id AND kind='acknowledged') AS acknowledgment_only
      FROM tasks t LEFT JOIN task_coordination c ON c.task_id=t.id WHERE t.room_id=? ORDER BY t.state IN ('completed','cancelled','failed'),t.updated_at DESC,t.rowid DESC LIMIT 100`).all(roomId);
  }
  coordinationDigest(actor: Actor, roomId: string, now=Date.now()) {
    this.#room(actor,roomId);
    const since=now-86_400_000;
    const artifacts=this.#db.prepare('SELECT a.id,a.name,a.author_id,a.created_at,coalesce(v.version,1) AS version FROM artifacts a LEFT JOIN artifact_versions v ON v.artifact_id=a.id WHERE a.room_id=? AND a.created_at>=? ORDER BY a.created_at DESC LIMIT 20').all(roomId,since).filter(row=>this.workareas.visible(actor,String(row.id))&&this.quality.readable(actor,String(row.id)));
    const artifactCount=this.artifacts(actor).filter(item=>item.room_id===roomId&&Number(item.created_at)>=since).length;
    const operations=this.#db.prepare(`SELECT l.tool_name,count(*) AS intents,sum(e.output IS NOT NULL) AS recorded,sum(e.output IS NULL) AS unknown
      FROM external_operation_labels l JOIN external_operations e USING(task_id,operation_id) JOIN tasks t ON t.id=l.task_id
      WHERE t.room_id=? AND l.started_at>=? AND l.tool_name IN ('browser_form_submit','browser_request_submit','x_post') GROUP BY l.tool_name`).all(roomId,since);
    const pending=this.#db.prepare(`SELECT
      sum(EXISTS(SELECT 1 FROM approval_requests a WHERE a.task_id=t.id AND a.status='pending')) AS approvals,
      sum(coalesce(c.blocker,'')!='') AS blockers,sum(t.deadline_at<=?) AS overdue
      FROM tasks t LEFT JOIN task_coordination c ON c.task_id=t.id WHERE t.room_id=? AND t.state NOT IN ('completed','failed','cancelled')`).get(now,roomId)!;
    const expired=this.#db.prepare("SELECT count(*) AS n FROM tasks WHERE room_id=? AND state='failed' AND result='Task deadline exceeded' AND updated_at>=?").get(roomId,since)!.n;
    return {since,artifact_count:Number(artifactCount),artifacts,operations,
      approvals:Number(pending.approvals||0),blockers:Number(pending.blockers||0),overdue:Number(pending.overdue||0)+Number(expired),
      revenue:'unverified',customer_contacts:'unverified',operation_note:'送信の実行記録です。記録済みでも業務の成功や入金を意味しません。導入以前の未分類の操作は含みません。'};
  }
  reviewReady(actor: Actor, lease: TaskLease, artifactId:string, sha256:string) {
    check(this.tasks.active(actor,lease),'conflict','Task is no longer active');
    const artifact=this.artifactVersions.inspect(actor,artifactId);
    check(artifact.room_id===lease.task.room_id && artifact.author_id===lease.task.agent_id,'forbidden','Use your artifact in this conversation');
    check(artifact.sha256===sha256 && artifact.versions[0]!.id===artifactId,'conflict','Use the latest fixed artifact version');
    check(this.#db.prepare('SELECT 1 FROM updates WHERE task_id=? AND artifact_id=?').get(lease.task.id,artifactId),'invalid','Artifact must belong to this task');
    check(!this.#db.prepare('SELECT child_id FROM task_handoffs WHERE task_id=? AND child_id IS NOT NULL').get(lease.task.id),'conflict','This task has already handed off its artifact');
    this.quality.ready(actor,artifactId);
    this.#db.prepare('INSERT INTO task_handoffs VALUES (?,?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET artifact_id=excluded.artifact_id,sha256=excluded.sha256').run(lease.task.id,artifactId,sha256);
    return {phase:'review_ready',artifact_id:artifactId,sha256};
  }
  handoff(actor: Actor, lease: TaskLease, prompt:string,purpose:'review'|'delivery'='delivery') {
    check(this.tasks.active(actor,lease),'conflict','Task is no longer active');text(prompt,17_000);
    return transaction(this.#db,()=>{
      const ready=this.#db.prepare('SELECT * FROM task_handoffs WHERE task_id=?').get(lease.task.id);
      check(ready,'conflict','Handoff not ready: register a finished artifact and exact SHA256 first');
      if(ready.child_id) return {task_id:ready.child_id,reused:true};
      const next=this.#db.prepare('SELECT next_agent_id FROM task_coordination WHERE task_id=?').get(lease.task.id)?.next_agent_id;
      check(typeof next==='string' && next!=='administrator','invalid','Choose the next Bot before handing off');
      const item=this.artifactVersions.inspect(actor,String(ready.artifact_id));
      check(item.sha256===ready.sha256 && item.versions[0]!.id===ready.artifact_id,'conflict','Prepared artifact changed; prepare the latest version');
      if(purpose==='review')this.quality.ready(actor,String(ready.artifact_id));else this.quality.verified(actor,String(ready.artifact_id));
      const child=this.tasks.delegate(actor,lease,next,`成果物の受け渡し\n親タスク：${lease.task.id}\n親の段階：review_ready\n成果物ID：${ready.artifact_id}\nSHA-256：${ready.sha256}\n依頼内容：${purpose==='review'?'内容のレビュー依頼です。まだ確認済みとしての引渡しではありません。\n':''}${prompt}`);
      this.#db.prepare('UPDATE task_handoffs SET child_id=? WHERE task_id=?').run(child.id,lease.task.id);
      this.#db.prepare('INSERT INTO artifact_references VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(child.id,ready.artifact_id!,ready.sha256!,Date.now());
      return {task_id:child.id,artifact_id:ready.artifact_id,sha256:ready.sha256};
    });
  }
  updateCoordination(actor: Actor, lease: TaskLease, input: CoordinationUpdate) {
    check(Value.Check(coordinationUpdateSchema,input),'invalid','Invalid task coordination');
    check(this.tasks.active(actor,lease),'conflict','Task is no longer active');
    this.#room(actor,lease.task.room_id);
    for (const id of [input.waiting_for,input.next_agent_id]) if (id && id!=='administrator') this.#room(this.agentSession(id),lease.task.room_id);
    check(!input.blocker || input.waiting_for,'invalid','A blocker needs the person who can unblock it');
    return transaction(this.#db,()=>{
      const old=this.#db.prepare('SELECT * FROM task_coordination WHERE task_id=?').get(lease.task.id);
      check(Number(old?.revision ?? 0)===input.expected_revision,'conflict','Task coordination changed; read it again');
      const fields=['completion_condition','stop_condition','blocker','waiting_for','next_agent_id'] as const;
      if(old && fields.every(key=>old[key]===input[key])) {
        if(input.blocker) this.tasks.wait(actor,lease,'waiting_user',input.blocker);
        return {revision:Number(old.revision),changed:false};
      }
      const revision=input.expected_revision+1;
      this.#db.prepare('INSERT INTO task_coordination VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,completion_condition=excluded.completion_condition,stop_condition=excluded.stop_condition,blocker=excluded.blocker,waiting_for=excluded.waiting_for,next_agent_id=excluded.next_agent_id,updated_at=excluded.updated_at')
        .run(lease.task.id,revision,input.completion_condition,input.stop_condition,input.blocker,input.waiting_for,input.next_agent_id,Date.now());
      const blockerChanged=!!input.blocker && (input.blocker!==old?.blocker || input.waiting_for!==old?.waiting_for);
      // A planned recipient is metadata, never permission to start another Bot.
      if(input.notify!=='none' && blockerChanged) {
        const ids=new Set([lease.task.requester_id,input.waiting_for,input.next_agent_id]);
        if(input.notify==='leader' && input.blocker) for(const member of this.agents(actor)) if(member.role==='leader') ids.add(member.id);
        const recipients=[...ids].filter((id):id is string=>!!id && id!=='administrator' && id!==lease.task.agent_id)
          .filter(id=>{try{this.#room(this.agentSession(id),lease.task.room_id);return true;}catch{return false;}});
        const names=recipients.map(id=>`@${this.#agent(id).name}`).join(' ');
        const body=`${names ? names+'\n' : ''}作業を保留しています：${input.blocker}\n親タスク：${lease.task.id}\n状態：waiting_user\n成果物：通知だけでは受け渡しません\n必要な対応：${input.waiting_for==='administrator'?'管理者':this.#agent(input.waiting_for!).name} — ${input.blocker}`;
        const message=this.post(actor,lease.task.room_id,body);
        for(const id of recipients) this.tasks.address(actor,lease,id,body,message.id);
      }
      if(input.blocker) this.tasks.wait(actor,lease,'waiting_user',input.blocker);
      return {revision,changed:true};
    });
  }
  messageSummary(actor: Actor, roomId: string): { message_count: number; last_sequence: number; first_at: string | null; last_at: string | null } {
    this.#room(actor, roomId);
    return this.#db.prepare(`SELECT count(*) AS message_count,coalesce(max(rowid),0) AS last_sequence,
      (SELECT created_at FROM messages WHERE room_id=? ORDER BY rowid LIMIT 1) AS first_at,
      (SELECT created_at FROM messages WHERE room_id=? ORDER BY rowid DESC LIMIT 1) AS last_at FROM messages WHERE room_id=?`)
      .get(roomId, roomId, roomId) as { message_count: number; last_sequence: number; first_at: string | null; last_at: string | null };
  }
  messagePage(actor: Actor, roomId: string, before = Number.MAX_SAFE_INTEGER) {
    this.#room(actor, roomId);
    check(Number.isSafeInteger(before) && before > 0, 'invalid', 'Invalid message cursor');
    const first = this.#db.prepare('SELECT *,rowid AS sequence FROM messages WHERE room_id=? ORDER BY rowid LIMIT 1').get(roomId) as (Message & { sequence: number }) | undefined;
    const rows = this.#db.prepare('SELECT *,rowid AS sequence FROM messages WHERE room_id=? AND rowid>? AND rowid<? ORDER BY rowid DESC LIMIT 51')
      .all(roomId, first?.sequence ?? 0, before) as unknown as (Message & { sequence: number })[];
    return { first: first ?? null, items: rows.slice(0, 50).reverse(), next: rows.length > 50 ? rows[49]!.sequence : null };
  }
  searchRoomMessages(actor: Actor, query: string): string[] {
    check(typeof query === 'string' && query.length <= 200, 'invalid', 'Invalid conversation query');
    const allowed = new Set(this.rooms(actor).map(room => room.id));
    if (!query) return [...allowed];
    return this.#db.prepare('SELECT DISTINCT room_id FROM messages WHERE instr(lower(body),lower(?))>0').all(query)
      .map(row => row.room_id as string).filter(id => allowed.has(id));
  }

  /** A directed conversation continues at its recipient without a reporting turn from the sender. */
  respond(actor: Actor, lease: TaskLease, content: string, recipientIds?: string[]): void {
    transaction(this.#db, () => {
      check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
      const agents = this.agents(actor);
      let body = content.trim();
      let recipients: Agent[] = [];
      if (recipientIds !== undefined) {
        check(Array.isArray(recipientIds) && recipientIds.length <= 100, 'invalid', 'Invalid recipients');
        recipients = [...new Set(recipientIds)].map(id => {
          const agent = agents.find(item => item.id === id);
          check(agent, 'invalid', 'Unknown conversation recipient');
          this.#room(this.agentSession(id), lease.task.room_id);
          return agent;
        });
        if (recipients.length) {
          while (true) {
            const existing = recipients.find(item => (body.startsWith(`@${item.name}`) || body.startsWith(`＠${item.name}`)) && /^(?:\s|[、,:：？?@＠]|$)/u.test(body.slice(item.name.length + 1)));
            if (!existing) break;
            body = body.slice(existing.name.length + 1).replace(/^[\s、,:：]+/u, '');
          }
          body = `${[...new Set(recipients.map(item => `@${item.name}`))].join(' ')} ${body}`.trim();
        }
      } else {
        let remaining = body;
        while (remaining.startsWith('@')) {
          const matches = agents.filter(agent => remaining.startsWith(`@${agent.name}`) && /^(?:\s|[、,:：？?@]|$)/u.test(remaining.slice(agent.name.length + 1)));
          if (matches.length !== 1) break;
          const recipient = matches[0]!;
          recipients.push(recipient);
          remaining = remaining.slice(recipient.name.length + 1).replace(/^[\s、,:：]+/u, '');
        }
      }
      let acknowledgment = body;
      for (const recipient of recipients) if (acknowledgment.startsWith(`@${recipient.name}`)) acknowledgment = acknowledgment.slice(recipient.name.length + 1).trimStart();
      if (lease.task.conversation_reply === 1 && isAcknowledgment(acknowledgment)) {
        try { this.tasks.acknowledge(actor, lease); return; }
        catch (error) { if (!(error instanceof DomainError)) throw error; }
      }
      const message = body ? this.post(actor, lease.task.room_id, body) : undefined;
      if (message) this.#db.prepare('UPDATE work_notes SET reply_id=? WHERE task_id=?').run(message.id, lease.task.id);
      for (const id of new Set(recipients.map(item => item.id))) {
        if (id === lease.task.agent_id) continue;
        if (lease.task.parent_id && id === lease.task.requester_id && this.tasks.get(actor, lease.task.parent_id).state === 'waiting_child') continue;
        this.tasks.address(actor, lease, id, body, message?.id);
      }
      this.tasks.finish(actor, lease, body || '完了');
    });
  }

  /** A browser retry must not post twice or start two jobs. Both records commit together. */
  createConversation(actor: Actor, id: string, title: string, body: string, participants?: string[], agentId?: string): { room: Room; message: Message; task: Task | null } {
    this.#admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid conversation request id');
    text(title, 200); text(body);
    const hash = createHash('sha256').update(JSON.stringify([title, body, participants ?? null, agentId ?? null])).digest('hex');
    return transaction(this.#db, () => {
      const previous = this.#db.prepare('SELECT input_hash,room_id FROM conversation_requests WHERE id=?').get(id) as
        { input_hash: string; room_id: string } | undefined;
      if (previous) check(previous.input_hash === hash, 'conflict', 'Conversation request id was reused with different input');
      const room = previous ? this.#room(actor, previous.room_id) : this.createRoom(actor, title, participants);
      const submitted = this.submit(actor, id, room.id, body, agentId);
      if (!previous) this.#db.prepare('INSERT INTO conversation_requests VALUES (?,?,?)').run(id, hash, room.id);
      return { room, ...submitted };
    });
  }
  /** A browser retry must not post twice or start two jobs. Both records commit together. */
  submit(actor: Actor, id: string, roomId: string, body: string, agentId?: string | string[], replyTo?: string): { message: Message; task: Task | null } {
    this.#admin(actor);
    check(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id), 'invalid', 'Invalid submission id');
    text(body);
    const recipients = Array.isArray(agentId) ? [...new Set(agentId)].sort() : agentId ? [agentId] : [];
    check(!Array.isArray(agentId) || (agentId.length > 0 && agentId.length <= 100 && agentId.every(value => typeof value === 'string')), 'invalid', 'Invalid recipients');
    const hash = createHash('sha256').update(JSON.stringify([roomId, body, Array.isArray(agentId) ? recipients : agentId ?? null, ...(replyTo === undefined ? [] : [replyTo])])).digest('hex');
    return transaction(this.#db, () => {
      const previous = this.#db.prepare('SELECT * FROM submissions WHERE id=?').get(id) as
        { input_hash: string; message_id: string; task_id: string | null } | undefined;
      if (previous) {
        check(previous.input_hash === hash, 'conflict', 'Submission id was reused with different input');
        const message = this.#db.prepare('SELECT * FROM messages WHERE id=?').get(previous.message_id) as unknown as Message;
        return { message, task: previous.task_id ? this.tasks.get(actor, previous.task_id) : null };
      }
      check(!this.roomPreferences(actor, roomId).archived, 'conflict', 'Restore the archived room before replying');
      if (replyTo !== undefined) check(typeof replyTo === 'string' && !!this.#db.prepare('SELECT 1 FROM messages WHERE id=? AND room_id=?').get(replyTo, roomId), 'not_found', 'Reply target is no longer available in this conversation');
      const message = this.post(actor, roomId, body);
      if (replyTo !== undefined) {
        this.#db.prepare('UPDATE messages SET reply_to=? WHERE id=?').run(replyTo, message.id);
        message.reply_to = replyTo;
      }
      let task: Task | null = null;
      for (const recipient of recipients) {
        this.#room(this.agentSession(recipient), roomId);
        check(this.#agent(recipient).status === 'active', 'forbidden', 'Recipient is dormant');
        const questions = this.tasks.list(actor).filter(task => task.agent_id === recipient && task.room_id === roomId && task.state === 'waiting_user');
        if (questions.length === 1) {
          this.tasks.resume(actor, questions[0]!.id, body);
          task ??= this.tasks.get(actor, questions[0]!.id);
        } else { const next = this.tasks.create(actor, recipient, roomId, body); task ??= next; }
      }
      this.#db.prepare('INSERT INTO submissions VALUES (?,?,?,?)').run(id, hash, message.id, task?.id ?? null);
      return { message, task };
    });
  }

  #memory(actor: Actor, agentId: string): DatabaseSync {
    const principal = this.#principal(actor);
    check(principal.kind === 'admin' || principal.id === agentId, 'forbidden', 'Private memory');
    this.#agent(agentId); // Registered server UUID only, before constructing a filesystem path.
    let db = this.#memories.get(agentId);
    if (!db) {
      db = openDatabase(join(this.#root, 'agents', agentId, 'memory.db'), memoryMigrations);
      this.#memories.set(agentId, db);
    }
    return db;
  }
  #audit(db: DatabaseSync, id: string, action: string, actorId: string, revision: number): void {
    db.prepare('INSERT INTO memory_audit(memory_id, action, actor_id, revision, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, action, actorId, revision, new Date().toISOString());
    // New memories are picked up on the next turn. Corrections/deletions invalidate old generated output.
    if (action !== 'created') db.exec('UPDATE memory_state SET revision = revision + 1 WHERE id = 1');
  }
  remember(actor: Actor, sourceMessageId: string, body: string, operationId?: string): Memory {
    const principal = this.#bot(actor);
    this.#running(actor);
    text(body);
    const source = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(text(sourceMessageId, 100)) as unknown as Message | undefined;
    check(source, 'forbidden', 'Source unavailable');
    this.#room(actor, source.room_id);
    const db = this.#memory(actor, principal.id);
    return transaction(db, () => {
      const id = operationId === undefined ? randomUUID() : createHash('sha256').update(text(operationId, 200)).digest('hex');
      if (operationId !== undefined) {
        check(!this.#db.prepare('SELECT 1 FROM deletion_records WHERE agent_id=? AND memory_id=?').get(principal.id, id), 'conflict', 'This memory was deleted');
        const existing = db.prepare('SELECT * FROM memories WHERE id=?').get(id) as unknown as Memory | undefined;
        if (existing) return existing;
        check(!db.prepare('SELECT 1 FROM memory_audit WHERE memory_id=?').get(id), 'conflict', 'This memory was deleted');
      }
      const memory: Memory = { id, body, source_message_id: source.id, source_room_id: source.room_id, revision: 1 };
      db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?)').run(memory.id, body, source.id, source.room_id, 1);
      this.#audit(db, memory.id, 'created', principal.id, 1);
      return memory;
    });
  }
  memories(actor: Actor, agentId: string, query = ''): Memory[] {
    const db = this.#memory(actor, agentId);
    check(typeof query === 'string' && query.length <= 200, 'invalid', 'Invalid search query');
    if (!query) return db.prepare('SELECT * FROM memories ORDER BY rowid').all() as unknown as Memory[];
    // Literal search supports short Japanese terms as well as trigram-indexed substrings.
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    return db.prepare(`SELECT m.* FROM memories m JOIN memory_search s ON s.id = m.id
      WHERE s.body LIKE ? ESCAPE '\\' ORDER BY m.rowid`).all(`%${escaped}%`) as unknown as Memory[];
  }
  memoryReviewed(actor: Actor, lease: TaskLease): boolean {
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    return !!this.#memory(actor, this.#bot(actor).id).prepare(`SELECT 1 FROM task_memory_reviews
      WHERE task_id=? AND memory_revision=(SELECT revision FROM memory_state WHERE id=1) AND rules_revision=?`)
      .get(lease.task.id, this.commonRules(actor).revision);
  }
  reviewMemory(actor: Actor, lease: TaskLease, review: MemoryReview): JsonObject {
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    check(Value.Check(memoryReviewSchema, review), 'invalid', 'Invalid memory review');
    const principal = this.#bot(actor); const db = this.#memory(actor, principal.id);
    const sources = new Set(this.messages(actor, lease.task.room_id).map(message => message.id));
    for (const memory of review.memories) {
      check(sources.has(memory.source_message_id), 'forbidden', 'Source is outside this conversation');
      text(memory.body, 2000);
    }
    return transaction(db, () => {
      if (this.memoryReviewed(actor, lease)) return { reviewed: true };
      for (const memory of review.memories) {
        // One automatic note per source. Corrections and deletion tombstones win over re-extraction.
        const operation = `review:${memory.source_message_id}`;
        const id = createHash('sha256').update(operation).digest('hex');
        if (db.prepare('SELECT 1 FROM memory_audit WHERE memory_id=?').get(id) ||
          this.#db.prepare('SELECT 1 FROM deletion_records WHERE agent_id=? AND memory_id=?').get(principal.id, id) ||
          db.prepare('SELECT 1 FROM memories WHERE source_room_id=? AND body=?').get(lease.task.room_id, memory.body)) continue;
        this.remember(actor, memory.source_message_id, memory.body, operation);
      }
      db.prepare(`INSERT OR REPLACE INTO task_memory_reviews VALUES (?,(SELECT revision FROM memory_state WHERE id=1),?)`)
        .run(lease.task.id, this.commonRules(actor).revision);
      return { reviewed: true };
    });
  }
  memoryVersion(actor: Actor, agentId: string): number {
    const db = this.#memory(actor, agentId);
    return Number(db.prepare('SELECT coalesce(max(sequence),0) AS version FROM memory_audit').get()!.version);
  }
  memoryPage(actor: Actor, agentId: string, query = '', before = Number.MAX_SAFE_INTEGER): { items: Memory[]; total: number; next: number | null } {
    const db = this.#memory(actor, agentId);
    check(typeof query === 'string' && query.length <= 200 && Number.isSafeInteger(before) && before > 0, 'invalid', 'Invalid memory page');
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = db.prepare(`SELECT m.*,a.sequence AS cursor FROM memories m JOIN memory_audit a ON a.memory_id=m.id AND a.action='created'
      WHERE a.sequence<? AND m.body LIKE ? ESCAPE '\\' ORDER BY a.sequence DESC LIMIT 51`).all(before, pattern) as unknown as (Memory & { cursor: number })[];
    return { items: rows.slice(0, 50).map(({ cursor: _cursor, ...item }) => item),
      total: Number(db.prepare("SELECT count(*) AS total FROM memories WHERE body LIKE ? ESCAPE '\\'").get(pattern)!.total),
      next: rows.length > 50 ? rows[49]!.cursor : null };
  }
  correctMemory(actor: Actor, agentId: string, id: string, revision: number, body: string): void {
    const principal = this.#admin(actor);
    text(body);
    const db = this.#memory(actor, agentId);
    transaction(db, () => {
      const result = db.prepare('UPDATE memories SET body = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .run(body, text(id, 100), this.#revision(revision));
      check(result.changes === 1, 'conflict', 'Memory revision changed or memory was deleted');
      this.#audit(db, id, 'admin_corrected', principal.id, revision + 1);
    });
  }
  deleteMemory(actor: Actor, agentId: string, id: string, revision: number): void {
    const principal = this.#admin(actor);
    const db = this.#memory(actor, agentId);
    transaction(db, () => {
      const result = db.prepare('DELETE FROM memories WHERE id = ? AND revision = ?').run(text(id, 100), this.#revision(revision));
      check(result.changes === 1, 'conflict', 'Memory revision changed or memory was deleted');
      this.#audit(db, id, 'deleted', principal.id, revision + 1);
    });
  }
  #revision(value: number): number {
    check(Number.isSafeInteger(value) && value >= 1, 'invalid', 'Invalid revision');
    return value;
  }
  memoryAudit(actor: Actor, agentId: string): unknown[] {
    this.#admin(actor);
    return this.#memory(actor, agentId).prepare('SELECT * FROM memory_audit ORDER BY sequence').all();
  }
  memoryCorrections(actor: Actor, agentId: string, id: string): unknown[] {
    this.#admin(actor);
    const db = this.#memory(actor, agentId);
    check(db.prepare('SELECT 1 FROM memories WHERE id=?').get(text(id, 100)), 'not_found', 'Memory not found');
    return db.prepare("SELECT sequence,actor_id,revision,created_at FROM memory_audit WHERE memory_id=? AND action='admin_corrected' ORDER BY sequence DESC LIMIT 100").all(id).reverse();
  }
  deletionRecords(actor: Actor): { agent_id: string; memory_id: string; revision: number }[] {
    this.#admin(actor);
    const records = this.#db.prepare('SELECT * FROM deletion_records').all() as { agent_id: string; memory_id: string; revision: number }[];
    for (const agent of this.agents(actor)) {
      const rows = this.#memory(actor, agent.id).prepare("SELECT memory_id,max(revision) AS revision FROM memory_audit WHERE action='deleted' GROUP BY memory_id").all() as { memory_id: string; revision: number }[];
      records.push(...rows.map(row => ({ agent_id: agent.id, ...row })));
    }
    return records;
  }
  /** Restore preparation only. Preserve even records for bots absent from this older snapshot. */
  applyDeletions(actor: Actor, records: ReturnType<Runtime['deletionRecords']>): void {
    this.#admin(actor);
    const agents = new Set(this.agents(actor).map(agent => agent.id));
    for (const record of records) {
      text(record.agent_id, 100); text(record.memory_id, 100); this.#revision(record.revision);
      this.#db.prepare('INSERT INTO deletion_records VALUES (?,?,?) ON CONFLICT(agent_id,memory_id) DO UPDATE SET revision=max(revision,excluded.revision)')
        .run(record.agent_id, record.memory_id, record.revision);
      if (!agents.has(record.agent_id)) continue;
      const db = this.#memory(actor, record.agent_id);
      transaction(db, () => {
        db.prepare('DELETE FROM memories WHERE id=?').run(record.memory_id);
        db.exec("UPDATE memory_state SET revision=revision+1 WHERE id=1; UPDATE task_steps SET discarded=1,events='[]';");
      });
    }
  }
  context(actor: Actor, roomId: string): { memories: Memory[]; revision: number } {
    const principal = this.#bot(actor);
    this.#room(actor, roomId);
    const db = this.#memory(actor, principal.id);
    return transaction(db, () => {
      const memories = this.memories(actor, principal.id).filter(memory => {
        const sourceRoom = this.#room(actor, memory.source_room_id);
        return sourceRoom.visibility === 'shared' || sourceRoom.id === roomId;
      });
      const { revision } = db.prepare('SELECT revision FROM memory_state WHERE id = 1').get() as { revision: number };
      return { memories, revision };
    });
  }
  isContextCurrent(actor: Actor, revision: number): boolean {
    const principal = this.#bot(actor);
    const db = this.#memory(actor, principal.id);
    return (db.prepare('SELECT revision FROM memory_state WHERE id = 1').get() as { revision: number }).revision === revision;
  }
  searchHistory(actor: Actor, roomId: string, query: string) {
    const principal = this.#bot(actor); this.#room(actor, roomId); text(query, 200);
    const rooms = this.rooms(actor).filter(room => room.visibility === 'shared' || room.id === roomId).map(room => room.id);
    const indexed = [...query].length >= 3;
    const match = indexed ? `"${query.replaceAll('"', '""')}"` : query;
    const entries = this.#db.prepare(`SELECT kind,source_id,room_id,body FROM history_search
      WHERE room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'history_search MATCH ?' : 'instr(body,?)>0'}
      ORDER BY rowid DESC LIMIT 20`).all(JSON.stringify(rooms), match) as { kind: string; source_id: string; room_id: string; body: string }[];
    const memory = this.#memory(actor, principal.id);
    const memories = memory.prepare(`SELECT m.* FROM memories m JOIN memory_search s ON s.id=m.id
      WHERE m.source_room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'memory_search MATCH ?' : 'instr(s.body,?)>0'}
      ORDER BY m.rowid DESC LIMIT 20`).all(JSON.stringify(rooms), match) as unknown as Memory[];
    const excerpt = (body: string) => {
      const start = Math.max(0, body.toLowerCase().indexOf(query.toLowerCase()) - 160);
      return { text: body.slice(start, start + 1000), truncated: start > 0 || body.length > start + 1000 };
    };
    const summaries: { kind: string; source_id: string; room_id: string; text: string; truncated: boolean }[] = [];
    const candidates = memory.prepare(`SELECT s.id FROM task_summaries s JOIN summary_search f ON f.id=s.id
      WHERE s.room_id IN (SELECT value FROM json_each(?)) AND ${indexed ? 'summary_search MATCH ?' : 'instr(f.body,?)>0'} ORDER BY s.created_at DESC,s.id`).all(JSON.stringify(rooms), match);
    for (const candidate of candidates) {
      const summary = this.#summary(actor, roomId, String(candidate.id));
      if (summary) summaries.push({ kind: 'summary', source_id: String(candidate.id), room_id: summary.room_id, ...excerpt(summary.body) });
      if (summaries.length >= 20) break;
    }
    return [...entries.filter(entry=>entry.kind!=='artifact'||(this.workareas.visible(actor,entry.source_id)&&this.quality.readable(actor,entry.source_id))).map(entry => ({ kind: entry.kind, source_id: entry.source_id, room_id: entry.room_id, ...excerpt(entry.body) })), ...summaries,
      ...memories.map(item => ({ kind: 'memory', source_id: item.id, room_id: item.source_room_id, revision: item.revision,
        source_message_id: item.source_message_id, ...excerpt(item.body) }))];
  }
  readHistory(actor: Actor, roomId: string, kind: string, sourceId: string, offset = 0, revision: string | null = null) {
    const principal = this.#bot(actor); this.#room(actor, roomId); text(sourceId, 100);
    check(Number.isSafeInteger(offset) && offset >= 0 && (offset === 0 || revision !== null), 'invalid', 'Continuation requires a source revision');
    const queries: Record<string, string> = {
      message: 'SELECT room_id,body FROM messages WHERE id=?',
      task: "SELECT room_id,prompt || char(10) || coalesce(result,'') AS body FROM tasks WHERE id=?",
      task_reply: 'SELECT t.room_id,r.body FROM task_replies r JOIN tasks t ON t.id=r.task_id WHERE r.sequence=?',
      artifact: 'SELECT room_id,name || char(10) || description || char(10) || content AS body FROM artifacts WHERE id=?',
    };
    check(kind === 'memory' || kind === 'summary' || Object.hasOwn(queries, kind), 'invalid', 'Unknown source kind');
    if(kind==='artifact')this.artifact(actor,sourceId);
    const record = (kind === 'summary' ? this.#summary(actor, roomId, sourceId) : kind === 'memory'
      ? this.#memory(actor, principal.id).prepare('SELECT source_room_id AS room_id,body,revision FROM memories WHERE id=?').get(sourceId)
      : this.#db.prepare(queries[kind]!).get(sourceId)) as { room_id: string; body: string; revision?: number } | undefined;
    const allowed = this.rooms(actor).some(room => room.id === record?.room_id && (room.visibility === 'shared' || room.id === roomId));
    check(record && allowed, 'not_found', 'Source unavailable in this conversation');
    const current = createHash('sha256').update(JSON.stringify([kind, sourceId, record.room_id, record.body, record.revision ?? null])).digest('hex');
    check(revision === null || revision === current, 'conflict', 'Source changed; read it again from the beginning');
    check(offset <= record.body.length, 'invalid', 'Offset exceeds source length');
    const next = Math.min(offset + 20_000, record.body.length);
    return { kind, source_id: sourceId, room_id: record.room_id, revision: current, offset,
      text: record.body.slice(offset, next), next_offset: next < record.body.length ? next : null, untrusted: true };
  }
  saveSummary(actor: Actor, lease: TaskLease, operationId: string, summary: WorkSummary) {
    const principal = this.#bot(actor);
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const task = this.tasks.get(actor, lease.task.id); text(operationId, 200);
    check(Value.Check(summarySchema, summary), 'invalid', 'Invalid work summary');
    const body = JSON.stringify(summary); text(body, 16_000);
    for (const source of summary.sources) this.readHistory(actor, task.room_id, source.kind, source.source_id, 0, source.revision);
    const db = this.#memory(actor, principal.id), hash = createHash('sha256').update(body).digest('hex');
    return transaction(db, () => {
      const prior = db.prepare('SELECT revision,operation_id,input_hash FROM task_summaries WHERE id=?').get(task.id);
      if (prior?.operation_id === operationId) {
        check(prior.input_hash === hash, 'conflict', 'Summary operation input changed');
        return { id: task.id, revision: Number(prior.revision) };
      }
      const revision = Number(prior?.revision ?? 0) + 1;
      db.prepare(`INSERT INTO task_summaries VALUES (?,?,?,?,?,(SELECT revision FROM memory_state WHERE id=1),?,?,?)
        ON CONFLICT(id) DO UPDATE SET purpose=excluded.purpose,body=excluded.body,revision=excluded.revision,
          memory_revision=excluded.memory_revision,operation_id=excluded.operation_id,input_hash=excluded.input_hash,created_at=excluded.created_at`)
        .run(task.id, task.room_id, task.prompt, body, revision, operationId, hash, Date.now());
      return { id: task.id, revision };
    });
  }
  procedureTool(actor: Actor, lease: TaskLease, operationId: string, name: string, args: JsonObject): JsonObject {
    const principal = this.#bot(actor); this.#running(actor);
    check(this.tasks.active(actor, lease), 'conflict', 'Task is no longer active');
    const task = this.tasks.get(actor, lease.task.id); text(operationId, 180);
    return executeProcedure({
      db: this.#memory(actor, principal.id), task,
      rooms: this.rooms(actor).filter(room => room.visibility === 'shared' || room.id === task.room_id).map(room => room.id),
      readSource: (kind, id, revision) => this.readHistory(actor, task.room_id, kind, id, 0, revision),
      taskInfo: id => this.tasks.get(actor, id),
      updatePlan: (revision, remaining) => this.tasks.updatePlan(actor, lease, `${operationId}:plan`, revision, remaining),
    }, name, args, operationId);
  }
  completionSummarySources(actor: Actor, lease: TaskLease): JsonObject[] {
    const state = this.tasks.workState(actor, lease);
    const sources = [
      ...this.messages(actor, lease.task.room_id).slice(-10).map(message => ({ kind: 'message' as const, id: message.id })),
      ...state.artifacts.slice(-10).map(artifact => ({ kind: 'artifact' as const, id: String(artifact.id) })),
      ...state.child_results.filter(child => child.state === 'completed' || child.state === 'failed').slice(-10)
        .map(child => ({ kind: 'task' as const, id: String(child.task_id) })),
    ];
    // The current task is still changing. Citing its current state would immediately stale the summary.
    return sources.map(source => {
      const read = this.readHistory(actor, lease.task.room_id, source.kind, source.id);
      const body = String(read.text);
      return { ...read, text: body.slice(0, 1000), ...(body.length > 1000 ? { next_offset: 1000 } : {}) };
    });
  }
  needsCompletionSummary(actor: Actor, lease: TaskLease): boolean {
    const state = this.tasks.workState(actor, lease);
    const workedTools = this.tasks.steps(actor, lease.task.id).some(step => !step.discarded && step.events.some(event => event.type === 'tool_call' &&
      !['memory_review', 'memory_search', 'memory_remember', 'task_history_read', 'task_summary_save', 'conversation_send', 'task_rest'].includes(event.name)));
    const worked = state.remaining_plan.revision > 0 || state.external_operations.length > 0 || state.artifacts.length > 0 || state.child_results.length > 0 ||
      workedTools || !!this.#db.prepare('SELECT 1 FROM business_tasks WHERE task_id=?').get(lease.task.id);
    return worked && !this.#summary(actor, lease.task.room_id, lease.task.id) && this.completionSummarySources(actor, lease).length > 0;
  }
  /** Validate dependencies before returning derived text; summaries never become execution authority. */
  #summary(actor: Actor, roomId: string, id: string): { room_id: string; body: string; revision: number } | undefined {
    const principal = this.#bot(actor), db = this.#memory(actor, principal.id);
    const row = db.prepare('SELECT * FROM task_summaries WHERE id=?').get(id);
    if (!row || !this.rooms(actor).some(room => room.id === row.room_id && (room.visibility === 'shared' || room.id === roomId))) return undefined;
    try {
      const summary = JSON.parse(String(row.body)) as unknown;
      if (!Value.Check(summarySchema, summary) || !this.isContextCurrent(actor, Number(row.memory_revision))) throw new Error('Invalid summary');
      for (const source of summary.sources) this.readHistory(actor, roomId, source.kind, source.source_id, 0, source.revision);
      return { room_id: String(row.room_id), revision: Number(row.revision), body: JSON.stringify({
        purpose: row.purpose, ...summary, generated: true, task_id: id, task_state: this.tasks.get(actor, id).state, created_at: row.created_at,
      }) };
    } catch {
      db.prepare('DELETE FROM task_summaries WHERE id=?').run(id);
      return undefined;
    }
  }
}
