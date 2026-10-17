import type { Actor, Runtime } from './runtime.ts';
import type { TaskLease } from '../domain/task.ts';
import type { TurnRunner } from './turns.ts';

/** An aborted job that has not settled for this long no longer holds an execution slot. */
const UNWINDING_SLOT_MS = 120_000;

/** The host owns startup recovery and must stop this scheduler before closing Runtime. */
export class Scheduler {
  #runtime: Runtime;
  #admin: Actor;
  #runner: Pick<TurnRunner, 'run'>;
  #jobs = new Map<string, { actor: Actor; lease: TaskLease; abort: AbortController; abortedAt?: number; done: Promise<void> }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #nextWakeCheck = 0;
  #logged = new Map<string, number>();
  #now: () => number;
  #watching: Promise<void> | undefined;
  #watchAbort = new AbortController();
  #modelReady: (() => Promise<ReadonlySet<string>>) | undefined;
  #ready: ReadonlySet<string> | undefined;
  #readying: Promise<void> | undefined;
  #nextReadyCheck = 0;

  /** With `modelReady`, autonomous wakes start only for Bots whose provider it lists; until the first answer, none start. */
  constructor(runtime: Runtime, runner: Pick<TurnRunner, 'run'>, now: () => number = Date.now, modelReady?: () => Promise<ReadonlySet<string>>) {
    this.#runtime = runtime; this.#admin = runtime.administrator(); this.#runner = runner; this.#now = now; this.#modelReady = modelReady;
  }
  #abort(job: { abort: AbortController; abortedAt?: number }): void {
    job.abortedAt ??= this.#now();
    job.abort.abort();
  }
  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.tick(), 100);
    this.tick();
  }
  /** A throwing phase must not stop the timer, the other phases or startup; identical errors log once a minute per phase. */
  #guard(phase: string, work: () => void): void {
    try { work(); } catch (error) {
      const message = `${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      const key = `${phase}:${message}`, now = Date.now();
      if (now < (this.#logged.get(key) ?? 0)) return;
      if (this.#logged.size > 100) this.#logged.clear();
      this.#logged.set(key, now + 60_000); console.error(`scheduler ${phase} failed: ${message}`);
    }
  }
  tick(): void {
    if (this.#stopped) return;
    const tasks = this.#runtime.tasks;
    this.#guard('recoverCountLimits', () => tasks.recoverCountLimits(this.#admin));
    this.#guard('expire', () => tasks.expire(this.#admin));
    this.#guard('retryProviders', () => tasks.retryProviders(this.#admin));
    this.#guard('schedules', () => this.#runtime.schedules.dispatch(this.#admin));
    if (Date.now() >= this.#nextWakeCheck) {
      this.#nextWakeCheck = Date.now() + 1000;
      // Saved connections change only through settings; reading the key files every five seconds is enough.
      if (this.#modelReady && !this.#readying && Date.now() >= this.#nextReadyCheck) {
        this.#nextReadyCheck = Date.now() + 5000;
        this.#readying = this.#modelReady().then(ready => { this.#ready = ready; })
          .catch(error => this.#guard('modelReady', () => { throw error; })).finally(() => { this.#readying = undefined; });
      }
      this.#guard('autonomousWakes', () => this.#runtime.autonomousWakes.dispatch(this.#admin, undefined, this.#modelReady ? this.#ready ?? new Set() : undefined));
      // Page checks are network-bound; one pass at a time, and a rejected pass is logged like a throwing phase.
      if (!this.#watching) this.#guard('watch', () => {
        this.#watching = this.#runtime.schedules.watch(this.#admin, this.#watchAbort.signal)
          .catch(error => this.#guard('watch', () => { throw error; })).finally(() => { this.#watching = undefined; });
      });
    }
    this.#guard('interrupt', () => {
      const requested = tasks.queuedRequestAgents(this.#admin);
      for (const job of this.#jobs.values()) {
        if (job.lease.task.internal_autonomous && requested.has(job.lease.task.agent_id) && tasks.active(job.actor,job.lease)) {
          tasks.interrupt(this.#admin,job.lease);
        }
        if (!tasks.active(job.actor, job.lease)) this.#abort(job);
      }
    });
    // An invalidated lease can still have a model request unwinding. Do not overlap it.
    const busy = new Set([...this.#jobs.values()].map(job => job.lease.task.agent_id));
    // Their DB slot is already free, but a runner (e.g. a tool ignoring the signal) may still be running; count it until it settles or times out.
    const unwinding = [...this.#jobs.values()].filter(job => job.abort.signal.aborted && this.#now() - (job.abortedAt ?? 0) < UNWINDING_SLOT_MS).length;
    this.#guard('claim', () => { for (let lease = tasks.claim(this.#admin, busy, unwinding); lease; lease = tasks.claim(this.#admin, busy, unwinding)) {
      const current = lease;
      const actor = this.#runtime.agentSession(current.task.agent_id);
      const abort = new AbortController();
      busy.add(current.task.agent_id);
      const done = Promise.resolve().then(() => this.#runner.run(current, abort.signal)).catch(() => {
        if (tasks.active(actor, current)) tasks.wait(actor, current, 'waiting_user', '実行処理でエラーが発生しました。確認後に再開してください。');
      }).finally(() => {
        // A runner must either finish or wait. Never leave a silently stranded running task.
        if (tasks.active(actor, current)) tasks.wait(actor, current, 'waiting_user', '実行が中断されました。確認後に再開してください。');
        this.#jobs.delete(current.task.id);
      });
      this.#jobs.set(current.task.id, { actor, lease: current, abort, done });
    } });
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#watchAbort.abort(); await this.#watching; await this.#readying;
    for (const job of this.#jobs.values()) {
      this.#runtime.tasks.interrupt(this.#admin, job.lease);
      this.#abort(job);
    }
    await Promise.all([...this.#jobs.values()].map(job => job.done));
  }
}
