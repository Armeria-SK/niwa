export type AgentStatus = 'active' | 'dormant';
export interface Agent {
  id: string;
  name: string;
  role: 'leader' | 'member';
  status: AgentStatus;
  model: string;
  reasoning: string;
  provider: 'openai_subscription' | 'ollama';
}
export interface Room {
  id: string;
  title: string;
  visibility: 'shared' | 'private';
}
export interface Message {
  reply_to?: string | null;
  id: string;
  room_id: string;
  author_id: string;
  body: string;
  created_at: string;
}
export interface Memory {
  id: string;
  body: string;
  source_message_id: string;
  source_room_id: string;
  revision: number;
}
export interface Settings {
  paused: boolean;
  autonomous: boolean;
  generatedLimit: number;
  concurrencyLimit: number | null;
  backupDays: number;
  backupTime: string;
}
export class DomainError extends Error {
  code: 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'limit';
  constructor(code: DomainError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
  }
}
export function check(condition: unknown, code: DomainError['code'], message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export function text(value: unknown, max = 20_000): string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    'invalid', 'Text is empty or too long');
  return value;
}
