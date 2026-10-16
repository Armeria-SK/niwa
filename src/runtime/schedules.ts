import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { check, text } from '../domain/types.ts';
import { transaction } from '../storage/database.ts';
import { pageUrl, publicIPv4, readWatchedPage } from '../tools/web/public-page.ts';
import { compare, externalContext, failureReason, observe, type ExternalUpdate, type Observation, type WatchedPage } from './schedule-sources.ts';
import type { Actor } from './runtime.ts';
import type { Tasks } from './tasks.ts';

type Trigger = 'interval' | 'shared_changes' | 'page_changes' | 'webhook';
const external = (trigger: string) => trigger === 'page_changes' || trigger === 'webhook';
/** Webhook bounds: stored deliveries per run, accepted deliveries and started runs per schedule per hour, stored body characters. */
const HOOK_PENDING = 5, HOOK_DELIVERIES_PER_HOUR = 120, HOOK_RUNS_PER_HOUR = 12, HOOK_BODY = 8000;

export interface ScheduleInput {
  id: string; agent_id: string; room_id: string; prompt: string;
  interval_ms: number; next_at: number; max_runs: number; timeout_ms: number;
  max_model_calls?: number;
  trigger_kind?: Trigger;
  source_url?: string;
  autonomous?: boolean;
}
interface Schedule extends Omit<ScheduleInput, 'autonomous'> { version: string; autonomous: number; source_revision: string; max_model_calls: number; model_calls: number; enabled: number; run_count: number; failure_reset: number; wait_reason: string | null;
  trigger_kind: Trigger; source_url: string; checked_at: number | null; check_status: string | null; check_failures: number; hook_ready: number; has_pending: number }
export type HookResult = { status: 'accepted' | 'unauthorized' | 'stopped' } | { status: 'rate_limited'; retry_after: number };

/** Administrator-owned triggers; each occurrence and its task commit together. */
export class Schedules {
  constructor(private db: DatabaseSync, private tasks: Tasks, private admin: (actor: Actor) => unknown,
    private recipient: (actor: Actor, agentId: string, roomId: string) => void) {}
  private checking = new Set<string>();

  list(actor: Actor): Schedule[] {
    this.admin(actor);
    return this.db.prepare(`SELECT s.id,s.agent_id,s.room_id,s.prompt,s.interval_ms,s.next_at,s.max_runs,s.timeout_ms,
      s.enabled,s.run_count,s.failure_reset,s.wait_reason,s.max_model_calls,s.model_calls,COALESCE(x.kind,s.trigger_kind) AS trigger_kind,s.source_revision,s.autonomous,
      COALESCE(x.url,'') AS source_url,x.checked_at,x.check_status,COALESCE(x.failures,0) AS check_failures,COALESCE(x.token_hash<>'',0) AS hook_ready,COALESCE(x.pending<>'',0) AS has_pending
      FROM schedules s LEFT JOIN schedule_sources x ON x.schedule_id=s.id WHERE s.deleted=0 ORDER BY s.rowid`).all().map(row => {
      const { run_count, model_calls, source_revision, failure_reset, wait_reason, checked_at, check_status, check_failures, hook_ready, has_pending, ...configuration } = row;
      return { ...row, version: createHash('sha256').update(JSON.stringify(configuration)).digest('hex') };
    }) as unknown as Schedule[];
  }
  private sourceRevision(agentId: string, roomId: string): string {
    const messages = this.db.prepare('SELECT id,author_id,body FROM messages WHERE room_id=? AND author_id<>? ORDER BY id').all(roomId, agentId);
    return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  }
  private validate(input: ScheduleInput) {
    text(input.prompt);
    for (const [value, min, max] of [[input.interval_ms, 60_000, 365 * 86400_000],
      [input.next_at, 0, 8_000_000_000_000_000], [input.max_runs, 1, 10_000], [input.timeout_ms, 60_000, 86400_000]]) {
      check(Number.isSafeInteger(value) && value! >= min! && value! <= max!, 'invalid', 'Invalid schedule bounds');
    }
    const maxCalls = input.max_model_calls ?? input.max_runs * 24;
    const trigger = input.trigger_kind ?? 'interval';
    check(input.autonomous === undefined || typeof input.autonomous === 'boolean', 'invalid', 'Invalid autonomy mode');
    check(['interval', 'shared_changes', 'page_changes', 'webhook'].includes(trigger), 'invalid', 'Invalid schedule trigger');
    check(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 1_000_000, 'invalid', 'Invalid model call limit');
    // External text is appended to the prompt; keep room for it within the task text limit.
    check(!external(trigger) || input.prompt.length <= 16_000, 'invalid', 'Prompt is too long for external updates');
    let url = '';
    if (trigger === 'page_changes') { try { const page = pageUrl(String(input.source_url ?? '')); url = /^[\d.]+$/.test(page.hostname) && !publicIPv4(page.hostname) ? '' : page.href; } catch { url = ''; }
      check(url, 'invalid', 'Invalid page URL'); }
    else check(!input.source_url, 'invalid', 'Page URL is only for page changes');
    return { maxCalls, trigger, url };
  }
  /** Keeps a webhook token and page baseline while the source itself is unchanged. */
  private setSource(id: string, kind: Trigger, url: string): void {
    const current = this.db.prepare('SELECT kind,url FROM schedule_sources WHERE schedule_id=?').get(id);
    if (external(kind) && current?.kind === kind && current.url === url) return;
    this.db.prepare('DELETE FROM schedule_sources WHERE schedule_id=?').run(id);
    if (external(kind)) this.db.prepare('INSERT INTO schedule_sources(schedule_id,kind,url) VALUES (?,?,?)').run(id, kind, url);
  }
  update(actor: Actor, input: ScheduleInput, version: string): Schedule {
    this.admin(actor);
    const { maxCalls, trigger, url } = this.validate(input);
    return transaction(this.db, () => {
      const row = this.list(actor).find(item => item.id === input.id);
      check(row, 'not_found', 'Schedule not found');
      check(row.version === version, 'conflict', 'Schedule changed; reload before saving');
      if (input.agent_id !== row.agent_id || input.room_id !== row.room_id) this.recipient(actor, input.agent_id, input.room_id);
      if (trigger === 'shared_changes' || input.autonomous) check(this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(input.room_id)!.visibility === 'shared', 'forbidden', 'Automatic participation requires a shared room');
      check(input.next_at === row.next_at || input.next_at >= Date.now(), 'invalid', 'Next occurrence must be in the future');
      check(input.max_runs >= row.run_count && maxCalls >= row.model_calls, 'invalid', 'Limits cannot be lower than usage');
      const sameSource = input.agent_id === row.agent_id && input.room_id === row.room_id && trigger === row.trigger_kind;
      this.db.prepare(`UPDATE schedules SET agent_id=?,room_id=?,prompt=?,interval_ms=?,next_at=?,max_runs=?,timeout_ms=?,
        max_model_calls=?,trigger_kind=?,autonomous=?,source_revision=? WHERE id=?`).run(
        input.agent_id, input.room_id, input.prompt, input.interval_ms, input.next_at, input.max_runs, input.timeout_ms,
        maxCalls, external(trigger) ? 'interval' : trigger, Number(input.autonomous ?? false), sameSource ? row.source_revision : trigger === 'shared_changes' ? this.sourceRevision(input.agent_id, input.room_id) : '', input.id);
      this.setSource(input.id, trigger, url);
      return this.list(actor).find(item => item.id === input.id)!;
    });
  }
  create(actor: Actor, input: ScheduleInput): Schedule {
    this.admin(actor);
    check(typeof input.id === 'string' && /^[0-9a-f-]{36}$/.test(input.id), 'invalid', 'Invalid schedule id');
    const { maxCalls, trigger, url } = this.validate(input);
    const hash = createHash('sha256').update(JSON.stringify([input.agent_id, input.room_id, input.prompt,
      input.interval_ms, input.next_at, input.max_runs, input.timeout_ms,
      ...(input.max_model_calls === undefined ? [] : [input.max_model_calls]), ...(trigger === 'interval' ? [] : [trigger]), ...(url ? [url] : []), ...(input.autonomous ? ['autonomous'] : [])])).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT input_hash,deleted FROM schedules WHERE id=?').get(input.id);
      check(!prior?.deleted, 'conflict', 'Schedule was deleted');
      if (prior) check(prior.input_hash === hash, 'conflict', 'Schedule id already used with different input');
      else {
        this.recipient(actor, input.agent_id, input.room_id);
        if (trigger === 'shared_changes' || input.autonomous) check(this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(input.room_id)!.visibility === 'shared', 'forbidden', 'Automatic participation requires a shared room');
        check(input.next_at >= Date.now(), 'invalid', 'First occurrence must be in the future');
        this.db.prepare(`INSERT INTO schedules(id,agent_id,room_id,prompt,interval_ms,next_at,max_runs,timeout_ms,input_hash,max_model_calls,trigger_kind,source_revision,autonomous)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.agent_id, input.room_id, input.prompt,
          input.interval_ms, input.next_at, input.max_runs, input.timeout_ms, hash, maxCalls, external(trigger) ? 'interval' : trigger,
          trigger === 'shared_changes' ? this.sourceRevision(input.agent_id, input.room_id) : '', Number(input.autonomous ?? false));
        this.setSource(input.id, trigger, url);
      }
      return this.list(actor).find(row => row.id === input.id)!;
    });
  }
  setEnabled(actor: Actor, id: string, enabled: boolean): void {
    this.admin(actor); text(id, 100); check(typeof enabled === 'boolean', 'invalid', 'Invalid enabled state');
    const row = this.list(actor).find(item => item.id === id);
    check(row, 'not_found', 'Schedule not found');
    if (enabled) {
      check(row.run_count < row.max_runs, 'limit', 'Schedule run limit reached');
      check(row.model_calls < row.max_model_calls, 'limit', 'Schedule model call limit reached');
      this.recipient(actor, row.agent_id, row.room_id);
    }
    this.db.prepare('UPDATE schedules SET enabled=?,wait_reason=NULL,failure_reset=run_count WHERE id=?').run(Number(enabled), id);
  }
  remove(actor: Actor, id: string): void {
    this.admin(actor); text(id, 100);
    // Keep identity/budget links for existing jobs and reject late creation retries.
    const result = this.db.prepare("UPDATE schedules SET deleted=1,enabled=0,prompt='',source_revision='',wait_reason=NULL WHERE id=?").run(id);
    check(result.changes > 0, 'not_found', 'Schedule not found');
  }
  dispatch(actor: Actor, now = Date.now()): void {
    this.admin(actor);
    check(Number.isSafeInteger(now) && now >= 0 && now <= 8_000_000_000_000_000, 'invalid', 'Invalid clock');
    if (this.db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused === 1) return;
    let failure: unknown;
    for (const row of this.list(actor).filter(item => item.enabled)) {
      // One bad schedule rolls back only its own occurrence and is retried next tick; it must not block the others.
      try { transaction(this.db, () => this.occur(actor, row, now)); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  private occur(actor: Actor, row: Schedule, now: number): void {
    if (row.autonomous && (this.db.prepare('SELECT autonomous FROM settings WHERE id=1').get()!.autonomous !== 1 || this.db.prepare('SELECT enabled FROM agent_autonomy WHERE agent_id=?').get(row.agent_id)?.enabled === 0)) return;
    const recent = this.db.prepare(`SELECT t.id,t.state FROM schedule_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.schedule_id=? ORDER BY r.scheduled_at DESC LIMIT 3`).all(row.id);
    if (this.db.prepare(`SELECT 1 FROM schedule_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.schedule_id=? AND t.state NOT IN ('completed','failed','cancelled') LIMIT 1`).get(row.id)) return;
    let reason: string | null = row.run_count >= row.max_runs ? '起動回数の上限に達しました。' : null;
    if (row.model_calls >= row.max_model_calls) reason = '定期実行のモデル呼び出し上限に達しました。';
    if (row.run_count - row.failure_reset >= 3 && recent.length === 3 && recent.every(task => task.state !== 'completed'))
      reason = '3回続けて完了しなかったため、定期実行を停止しました。';
    if (reason) {
      this.db.prepare('UPDATE schedules SET enabled=0,wait_reason=? WHERE id=?').run(reason, row.id);
      this.db.prepare(`INSERT INTO updates(room_id,author_id,kind,title,detail,task_id,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(row.room_id, row.agent_id, row.run_count >= row.max_runs ? 'decision' : 'question',
        `定期実行を停止：${row.prompt.slice(0, 180)}`, reason, recent[0]?.id ?? null, Date.now());
      return;
    }
    if (row.next_at > now) return;
    // Dormancy or revoked room access leaves the occurrence pending without creating a task.
    try { this.recipient(actor, row.agent_id, row.room_id); } catch { return; }
    if (row.autonomous && this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(row.room_id)!.visibility !== 'shared') return;
    let next = row.next_at + (Math.floor((now - row.next_at) / row.interval_ms) + 1) * row.interval_ms, context = '';
    if (external(row.trigger_kind)) {
      // Page checks and webhook deliveries leave pending text; without it there is nothing to start.
      const pending = this.db.prepare('SELECT pending FROM schedule_sources WHERE schedule_id=?').get(row.id)?.pending;
      if (!pending) return;
      if (row.trigger_kind === 'webhook') {
        if (Number(this.db.prepare(`SELECT COUNT(*) AS runs FROM schedule_runs r JOIN tasks t ON t.id=r.task_id
          WHERE r.schedule_id=? AND t.created_at>?`).get(row.id, Date.now() - 3600_000)!.runs) >= HOOK_RUNS_PER_HOUR) return;
        next = now + row.interval_ms;
      }
      context = externalContext(JSON.parse(String(pending)) as ExternalUpdate, 20_000 - row.prompt.length);
    }
    let revision = row.source_revision;
    if (row.trigger_kind === 'shared_changes') {
      if (this.db.prepare('SELECT visibility FROM rooms WHERE id=?').get(row.room_id)!.visibility !== 'shared') return;
      revision = this.sourceRevision(row.agent_id, row.room_id);
      if (revision === row.source_revision) {
        this.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(next, row.id); return;
      }
    }
    const task = this.tasks.create(actor, row.agent_id, row.room_id, row.prompt, Date.now() + row.timeout_ms, context);
    this.db.prepare('INSERT INTO schedule_runs VALUES (?,?,?)').run(row.id, row.next_at, task.id);
    this.db.prepare('UPDATE schedules SET next_at=?,run_count=run_count+1,source_revision=? WHERE id=?').run(next, revision, row.id);
    if (external(row.trigger_kind)) this.db.prepare("UPDATE schedule_sources SET pending='' WHERE schedule_id=?").run(row.id);
  }
  /** Fetches due pages outside any transaction, then records each result alone. A failure never starts a run and backs off. */
  async watch(actor: Actor, signal?: AbortSignal, read: (url: string, signal?: AbortSignal) => Promise<WatchedPage> = readWatchedPage, now = Date.now()): Promise<void> {
    this.admin(actor);
    if (this.db.prepare('SELECT paused FROM settings WHERE id=1').get()!.paused === 1) return;
    const due = this.db.prepare(`SELECT s.id,x.url FROM schedules s JOIN schedule_sources x ON x.schedule_id=s.id
      WHERE s.deleted=0 AND s.enabled=1 AND x.kind='page_changes' AND x.pending='' AND s.next_at<=? AND s.run_count<s.max_runs AND s.model_calls<s.max_model_calls
      AND NOT EXISTS(SELECT 1 FROM schedule_runs r JOIN tasks t ON t.id=r.task_id WHERE r.schedule_id=s.id AND t.state NOT IN ('completed','failed','cancelled'))
      ORDER BY s.next_at LIMIT 8`).all(now).filter(row => !this.checking.has(String(row.id)));
    let failure: unknown;
    await Promise.all(due.map(async row => {
      const id = String(row.id), url = String(row.url); this.checking.add(id);
      try {
        let observation: Observation | undefined, error: unknown;
        try { observation = observe(await read(url, signal)); } catch (caught) { error = caught; }
        if (!signal?.aborted) transaction(this.db, () => this.record(id, url, now, observation, error));
      } catch (caught) { failure ??= caught; } finally { this.checking.delete(id); }
    }));
    if (failure) throw failure;
  }
  private record(id: string, url: string, now: number, observation: Observation | undefined, error: unknown): void {
    // An edit during the fetch replaces the source row; a result for the old URL is discarded.
    const row = this.db.prepare(`SELECT s.interval_ms,s.next_at,x.content_hash,x.snapshot,x.failures FROM schedules s JOIN schedule_sources x ON x.schedule_id=s.id
      WHERE s.id=? AND s.deleted=0 AND x.kind='page_changes' AND x.url=?`).get(id, url);
    if (!row) return;
    const interval = Number(row.interval_ms), at = Number(row.next_at), next = at + (Math.floor((now - at) / interval) + 1) * interval;
    if (!observation) {
      const failures = Number(row.failures) + 1;
      this.db.prepare('UPDATE schedule_sources SET failures=?,check_status=?,checked_at=? WHERE schedule_id=?').run(failures, `取得失敗：${failureReason(error)}（${failures}回連続）`, now, id);
      this.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(Math.max(next, now + Math.min(interval * 2 ** Math.min(failures - 1, 16), 86400_000)), id);
      return;
    }
    let status = '変更はありません', snapshot = String(row.snapshot), pending = '';
    if (!row.content_hash) { snapshot = compare('', observation, url, now).snapshot; status = '最初の内容を記録しました。次の確認から変更を比べます'; }
    else if (observation.hash !== row.content_hash) {
      const result = compare(snapshot, observation, url, now); snapshot = result.snapshot;
      if (result.change) pending = JSON.stringify(result.change);
      status = !result.change ? '新しい項目はありません' : observation.kind === 'feed' ? `新しい項目を${(result.change.new_items as unknown[]).length + Number(result.change.more_items ?? 0)}件見つけました` : '内容の変更を見つけました';
    }
    this.db.prepare('UPDATE schedule_sources SET content_hash=?,snapshot=?,pending=?,failures=0,check_status=?,checked_at=? WHERE schedule_id=?').run(observation.hash, snapshot, pending, status, now, id);
    // A detected change keeps the occurrence due so dispatch starts it; dispatch then advances the time.
    if (!pending) this.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(next, id);
  }
  /** Shown once. Only its SHA-256 is stored; issuing again invalidates the previous token. */
  issueHookToken(actor: Actor, id: string): { token: string; path: string } {
    this.admin(actor); text(id, 100);
    const token = randomBytes(32).toString('base64url');
    const result = this.db.prepare(`UPDATE schedule_sources SET token_hash=? WHERE schedule_id=? AND kind='webhook'
      AND schedule_id IN (SELECT id FROM schedules WHERE deleted=0)`).run(createHash('sha256').update(token).digest('hex'), id);
    check(result.changes > 0, 'not_found', 'Webhook schedule not found');
    return { token, path: `/api/hooks/${id}` };
  }
  private hook(id: string, token: string) {
    const row = this.db.prepare(`SELECT s.enabled,x.token_hash,x.pending,x.deliveries FROM schedules s JOIN schedule_sources x ON x.schedule_id=s.id
      WHERE s.id=? AND s.deleted=0 AND x.kind='webhook'`).get(id);
    const stored = typeof row?.token_hash === 'string' && /^[0-9a-f]{64}$/.test(row.token_hash) ? row.token_hash : '';
    const match = timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(stored || '0'.repeat(64), 'hex'));
    return match && stored && token ? row! : null;
  }
  hookAuthorized(actor: Actor, id: string, token: string): boolean { this.admin(actor); return !!this.hook(id, token); }
  /** Untrusted payloads merge into one bounded pending set, so deliveries during a run reach the next run together. */
  receive(actor: Actor, id: string, token: string, contentType: string, body: string, now = Date.now()): HookResult {
    this.admin(actor);
    return transaction(this.db, (): HookResult => {
      const row = this.hook(id, token);
      if (!row) return { status: 'unauthorized' };
      if (!row.enabled) return { status: 'stopped' };
      const deliveries = (JSON.parse(String(row.deliveries)) as number[]).filter(time => time > now - 3600_000);
      if (deliveries.length >= HOOK_DELIVERIES_PER_HOUR) return { status: 'rate_limited', retry_after: Math.max(1, Math.ceil((deliveries[0]! + 3600_000 - now) / 1000)) };
      const pending = row.pending ? JSON.parse(String(row.pending)) as { source: 'webhook'; deliveries: unknown[]; dropped?: number } : { source: 'webhook', deliveries: [] as unknown[] } as { source: 'webhook'; deliveries: unknown[]; dropped?: number };
      pending.deliveries.push({ received_at: new Date(now).toISOString(), content_type: contentType, body: body.slice(0, HOOK_BODY), ...(body.length > HOOK_BODY ? { truncated: true } : {}) });
      const dropped = pending.deliveries.length - HOOK_PENDING;
      if (dropped > 0) { pending.deliveries.splice(0, dropped); pending.dropped = (pending.dropped ?? 0) + dropped; }
      this.db.prepare('UPDATE schedule_sources SET pending=?,deliveries=?,check_status=?,checked_at=? WHERE schedule_id=?').run(
        JSON.stringify(pending), JSON.stringify([...deliveries, now]), pending.deliveries.length > 1 ? `通知を受け付けました（次の仕事に${pending.deliveries.length}件まとめて渡します）` : '通知を受け付けました', now, id);
      return { status: 'accepted' };
    });
  }
}
