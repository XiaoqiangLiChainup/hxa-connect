import type {
  Task, TaskAction, TaskAgent, TaskDetailResponse, TaskInput, TaskListResponse, TaskStatus,
} from './tasks-types';

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + '/api/tasks';

export class TasksApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'TasksApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(BASE + path, {
    ...init,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new TasksApiError(
      response.status,
      typeof body?.code === 'string' ? body.code : 'UNKNOWN',
      typeof body?.error === 'string' ? body.error : response.statusText,
    );
  }
  return response.json() as Promise<T>;
}

export function listTaskAgents(signal?: AbortSignal): Promise<{ items: TaskAgent[] }> {
  return request('/agents', { signal });
}

export function listTasks(
  params: { status?: TaskStatus; limit?: number } = {},
  signal?: AbortSignal,
): Promise<TaskListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  query.set('limit', String(params.limit ?? 100));
  return request('?' + query.toString(), { signal });
}

export function getTask(id: string, signal?: AbortSignal): Promise<TaskDetailResponse> {
  return request('/' + encodeURIComponent(id), { signal });
}

export function createTask(input: TaskInput, idempotencyKey: string): Promise<Task> {
  return request('', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function actOnTask(id: string, action: TaskAction, revision: number): Promise<Task> {
  return request('/' + encodeURIComponent(id) + '/' + action, {
    method: 'POST',
    body: JSON.stringify({ expected_revision: revision }),
  });
}
