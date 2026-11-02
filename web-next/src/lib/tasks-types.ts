export type TaskStatus = 'queued' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
export type TaskRunStatus = 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export type TaskAction = 'accept' | 'retry' | 'cancel';

export interface TaskArtifact {
  title: string;
  url: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  runner_id: string;
  attempt: number;
  status: TaskRunStatus;
  started_at: number;
  finished_at: number | null;
  lease_expires_at: number | null;
  summary: string | null;
  error: string | null;
  artifacts: TaskArtifact[];
}

export interface Task {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  created_by: string;
  created_by_name: string;
  assigned_bot_id: string;
  thread_id: string;
  created_at: number;
  updated_at: number;
  revision: number;
  latest_run?: TaskRun | null;
}

export interface TaskAgent {
  id: string;
  name: string;
  role: string | null;
  online: boolean;
}

export interface TaskInput {
  title: string;
  description: string;
  assigned_bot_id: string;
}

export interface TaskListResponse {
  items: Task[];
  total: number;
}

export interface TaskDetailResponse {
  task: Task;
  runs: TaskRun[];
}

export const TASK_STATUSES: TaskStatus[] = [
  'queued', 'running', 'reviewing', 'completed', 'failed', 'cancelled',
];
