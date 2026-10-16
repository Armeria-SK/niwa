import type { ModelOutputDelta } from '../contracts/model.ts';
import { JsonStringFieldStream } from '../shared/json-string-field.ts';
import { redactDisplaySnapshot } from '../shared/redaction.ts';

export const DRAFT_MAX_CHARS = 8000;
export const DRAFT_INTERVAL_MS = 200;
const MAX_DRAFTS = 64, MAX_CALLS = 16, SEND_TOOL = 'conversation_send', SEND_FIELD = 'body';

export type DraftEnd = 'completed' | 'failed' | 'cancelled';
export interface DraftSnapshot { room_id: string; agent_id: string; task_id: string; text: string; truncated: boolean; started_at: number; updated_at: number; seq: number }
export type LiveEvent = { type: 'draft'; draft: DraftSnapshot } | { type: 'draft_end'; room_id: string; agent_id: string; task_id: string; reason: DraftEnd };
export interface DraftHandle { push(delta: ModelOutputDelta): void; close(reason: DraftEnd): void }

/** Reduce one model call's partial output to the text that would become the visible reply. */
export class DraftComposer {
  #text = ''; #textTruncated = false; #otherTool = false;
  #calls = new Map<string, { name: string | undefined; body?: JsonStringFieldStream }>();
  #send: JsonStringFieldStream | undefined;
  push(delta: ModelOutputDelta): void {
    if (delta.channel === 'text') {
      if (this.#text.length >= DRAFT_MAX_CHARS) { this.#textTruncated = true; return; }
      this.#text += delta.delta; if (this.#text.length > DRAFT_MAX_CHARS) { this.#text = this.#text.slice(0, DRAFT_MAX_CHARS); this.#textTruncated = true; }
      return;
    }
    let call = this.#calls.get(delta.call_id);
    if (!call) {
      if (this.#calls.size >= MAX_CALLS) return;
      call = { name: delta.name };
      if (delta.name === SEND_TOOL) { call.body = new JsonStringFieldStream(SEND_FIELD, DRAFT_MAX_CHARS); this.#send = call.body; }
      else this.#otherTool = true;
      this.#calls.set(delta.call_id, call);
    }
    call.body?.push(delta.delta);
  }
  /** A send body wins; text beside another tool call is commentary that never reaches the room. */
  get text(): string { return this.#send ? (this.#send.invalid ? '' : this.#send.value) : this.#otherTool ? '' : this.#text; }
  get truncated(): boolean { return this.#send ? this.#send.truncated : !this.#otherTool && this.#textTruncated; }
}

/** Hold back a trailing ASCII run so a partially streamed credential is never shown before redaction can match it. */
export function displayDraft(text: string): string {
  return redactDisplaySnapshot(text.replace(/[A-Za-z0-9_\-+/=.:~%]+$/u, '')).slice(0, DRAFT_MAX_CHARS);
}

type Entry = { meta: Pick<DraftSnapshot, 'room_id' | 'agent_id' | 'task_id' | 'started_at'>; composer: DraftComposer; shown: string; seq: number; emitted: number; timer?: ReturnType<typeof setTimeout> | undefined; closed: boolean };

/** Memory-only live notifications. Drafts are never stored, logged, or returned to models. */
export class LiveUpdates {
  #listeners = new Set<(event: LiveEvent) => void>();
  #drafts = new Map<string, Entry>();
  subscribe(listener: (event: LiveEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  get listeners(): number { return this.#listeners.size; }
  drafts(): DraftSnapshot[] { return [...this.#drafts.values()].filter(entry => entry.emitted > 0).map(entry => this.#snapshot(entry)); }
  open(meta: { room_id: string; agent_id: string; task_id: string }): DraftHandle {
    const previous = this.#drafts.get(meta.task_id); if (previous) this.#close(previous, 'cancelled');
    while (this.#drafts.size >= MAX_DRAFTS) this.#close(this.#drafts.values().next().value!, 'cancelled');
    const entry: Entry = { meta: { ...meta, started_at: Date.now() }, composer: new DraftComposer(), shown: '', seq: 0, emitted: 0, closed: false };
    this.#drafts.set(meta.task_id, entry);
    return { push: delta => this.#push(entry, delta), close: reason => this.#close(entry, reason) };
  }
  #snapshot(entry: Entry): DraftSnapshot { return { ...entry.meta, text: entry.shown, truncated: entry.composer.truncated, updated_at: entry.emitted, seq: entry.seq }; }
  #push(entry: Entry, delta: ModelOutputDelta): void {
    if (entry.closed) return;
    entry.composer.push(delta);
    if (entry.timer) return;
    const wait = entry.emitted + DRAFT_INTERVAL_MS - Date.now();
    if (wait <= 0) this.#flush(entry);
    else { entry.timer = setTimeout(() => { entry.timer = undefined; this.#flush(entry); }, wait); entry.timer.unref?.(); }
  }
  #flush(entry: Entry): void {
    if (entry.closed) return;
    const shown = displayDraft(entry.composer.text);
    if (shown === entry.shown) return;
    entry.shown = shown; entry.seq++; entry.emitted = Date.now();
    this.#emit({ type: 'draft', draft: this.#snapshot(entry) });
  }
  #close(entry: Entry, reason: DraftEnd): void {
    if (entry.closed) return;
    entry.closed = true; clearTimeout(entry.timer); entry.timer = undefined;
    if (this.#drafts.get(entry.meta.task_id) === entry) this.#drafts.delete(entry.meta.task_id);
    if (entry.emitted > 0) this.#emit({ type: 'draft_end', room_id: entry.meta.room_id, agent_id: entry.meta.agent_id, task_id: entry.meta.task_id, reason });
  }
  #emit(event: LiveEvent): void { for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* one viewer cannot stop another */ } } }
}
