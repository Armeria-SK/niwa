export type TaskState = 'queued' | 'running' | 'waiting_child' | 'waiting_user' | 'waiting_provider' | 'completed' | 'failed' | 'cancelled';
export interface Task {
  id: string;
  agent_id: string;
  requester_id: string;
  room_id: string;
  parent_id: string | null;
  prompt: string;
  state: TaskState;
  paused: number;
  result: string | null;
  wait_reason: string | null;
  attempt: number;
  deadline_at: number;
  created_at: number;
  updated_at: number;
}
/** Only the scheduler holds this lease. It is never included in a model prompt or Web response. */
export interface TaskLease { task: Task; token: string }
export interface TaskEvent { sequence: number; task_id: string; kind: string; created_at: number }
export const isTerminal = (state: TaskState): boolean => ['completed', 'failed', 'cancelled'].includes(state);
