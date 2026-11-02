export const TASK_STATUSES = ['queued', 'running', 'reviewing', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

export interface TaskArtifact { title: string; url: string }

export interface TaskRun {
  id: string;
  task_id: string;
  runner_id: string;
  attempt: number;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  lease_expires_at: number;
  summary: string | null;
  error: string | null;
  artifacts: TaskArtifact[];
}

export interface PlatformTask {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  created_by: string;
  created_by_name: string | null;
  assigned_bot_id: string;
  thread_id: string;
  created_at: number;
  updated_at: number;
  revision: number;
  latest_run?: TaskRun;
}

export interface TaskActor {
  orgId: string;
  botId: string;
  name: string;
  admin: boolean;
}

export interface CreateTaskInput { title: string; description: string; assigned_bot_id: string }
export interface FinishTaskInput {
  status: 'succeeded' | 'failed';
  summary: string | null;
  error: string | null;
  artifacts: TaskArtifact[];
}

export class TaskError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'TaskError';
  }
}
