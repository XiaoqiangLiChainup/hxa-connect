import crypto from 'node:crypto';
import type { DatabaseDriver } from '../db/driver.js';
import { logger } from '../logger.js';
import { TaskError, type TaskActor, type CreateTaskInput, type FinishTaskInput, type PlatformTask, type TaskRun, type TaskStatus } from './types.js';

export const TASK_LEASE_MS = 60_000;

interface TaskRow extends Omit<PlatformTask, 'latest_run'> {
  latest_run_id: string | null;
  idempotency_key: string;
  request_hash: string;
}
interface RunRow extends Omit<TaskRun, 'artifacts'> {
  artifacts: string;
  lease_token_hash: string;
  finish_payload_hash: string | null;
}

function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function payloadHash(value: CreateTaskInput | FinishTaskInput): string {
  // Callers supply validated, explicitly constructed objects; keys are stable.
  return hash(JSON.stringify(value));
}

function publicRun(row: RunRow): TaskRun {
  // Explicit projection: neither lease_token_hash nor finish_payload_hash may
  // escape through list/detail/finish responses or a future schema addition.
  return {
    id: row.id, task_id: row.task_id, runner_id: row.runner_id,
    attempt: Number(row.attempt), status: row.status,
    started_at: Number(row.started_at),
    finished_at: row.finished_at === null ? null : Number(row.finished_at),
    lease_expires_at: Number(row.lease_expires_at),
    summary: row.summary, error: row.error, artifacts: JSON.parse(row.artifacts),
  };
}

export class PlatformTaskStore {
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly driver: DatabaseDriver) {}

  async init(): Promise<void> {
    // M0 Task/Run concurrency is supported only by the serialized SQLite driver.
    // Keep the existing PostgreSQL Hub usable without creating task tables or
    // starting cleanup work that would imply unsupported task guarantees.
    if (this.driver.dialect !== 'sqlite') return;
    const ts = 'INTEGER';
    await this.driver.exec(`
      CREATE TABLE IF NOT EXISTS platform_tasks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','reviewing','completed','failed','cancelled')),
        created_by TEXT NOT NULL,
        created_by_name TEXT,
        assigned_bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        created_at ${ts} NOT NULL,
        updated_at ${ts} NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        latest_run_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        UNIQUE(org_id, created_by, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_platform_tasks_queue
        ON platform_tasks(org_id, assigned_bot_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_platform_tasks_creator
        ON platform_tasks(org_id, created_by, created_at);
      CREATE TABLE IF NOT EXISTS platform_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES platform_tasks(id) ON DELETE CASCADE,
        runner_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt >= 1),
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','expired','cancelled')),
        started_at ${ts} NOT NULL,
        finished_at ${ts},
        lease_expires_at ${ts} NOT NULL,
        lease_token_hash TEXT NOT NULL,
        finish_payload_hash TEXT,
        summary TEXT,
        error TEXT,
        artifacts TEXT NOT NULL DEFAULT '[]',
        UNIQUE(task_id, attempt)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_one_active_run
        ON platform_task_runs(task_id) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS idx_platform_run_leases
        ON platform_task_runs(status, lease_expires_at);
    `);
    await this.expireLeases();
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        void this.expireLeases().catch(error => logger.error({ err: error }, 'Task lease cleanup failed'));
      }, 5_000);
      this.cleanupTimer.unref();
    }
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private requireSupportedStorage(): void {
    if (this.driver.dialect !== 'sqlite') {
      throw new TaskError(503, 'TASK_STORAGE_UNSUPPORTED', 'M0 tasks require SQLite storage');
    }
  }

  private async expireWithin(tx: DatabaseDriver, now: number, orgId?: string): Promise<void> {
    const rows = await tx.all<{ id: string; task_id: string }>(`
      SELECT r.id, r.task_id FROM platform_task_runs r
      JOIN platform_tasks t ON t.id = r.task_id
      WHERE r.status = 'running' AND r.lease_expires_at <= ?
      ${orgId ? 'AND t.org_id = ?' : ''}
    `, orgId ? [now, orgId] : [now]);
    for (const row of rows) {
      const updated = await tx.run(`
        UPDATE platform_task_runs SET status = 'expired', finished_at = ?, error = ?
        WHERE id = ? AND status = 'running' AND lease_expires_at <= ?
      `, [now, 'Execution lease expired; inspect effects before explicitly retrying.', row.id, now]);
      if (updated.changes) {
        await tx.run(`
          UPDATE platform_tasks SET status = 'failed', updated_at = ?, revision = revision + 1
          WHERE id = ? AND latest_run_id = ? AND status = 'running'
        `, [now, row.task_id, row.id]);
      }
    }
  }

  async expireLeases(orgId?: string): Promise<void> {
    this.requireSupportedStorage();
    await this.driver.transaction(tx => this.expireWithin(tx, Date.now(), orgId));
  }

  private async operation<T>(orgId: string, action: (tx: DatabaseDriver, now: number) => Promise<T>): Promise<T> {
    this.requireSupportedStorage();
    const outcome = await this.driver.transaction(async tx => {
      const now = Date.now();
      await this.expireWithin(tx, now, orgId);
      try {
        return { kind: 'ok' as const, value: await action(tx, now) };
      } catch (error) {
        // Expected refusals happen before action writes. Commit lease expiration
        // even when the request that observes it is a stale heartbeat/finish.
        if (error instanceof TaskError) return { kind: 'error' as const, error };
        throw error;
      }
    });
    if (outcome.kind === 'error') throw outcome.error;
    return outcome.value;
  }

  private async taskFor(tx: DatabaseDriver, actor: TaskActor, id: string): Promise<TaskRow> {
    const row = await tx.get<TaskRow>('SELECT * FROM platform_tasks WHERE id = ? AND org_id = ?', [id, actor.orgId]);
    if (!row || (!actor.admin && row.created_by !== actor.botId && row.assigned_bot_id !== actor.botId)) {
      throw new TaskError(404, 'NOT_FOUND', 'Task not found');
    }
    return row;
  }

  private async projectTask(tx: DatabaseDriver, row: TaskRow): Promise<PlatformTask> {
    const task: PlatformTask = {
      id: row.id, org_id: row.org_id, title: row.title, description: row.description,
      status: row.status, created_by: row.created_by, created_by_name: row.created_by_name,
      assigned_bot_id: row.assigned_bot_id, thread_id: row.thread_id,
      created_at: Number(row.created_at), updated_at: Number(row.updated_at), revision: Number(row.revision),
    };
    if (row.latest_run_id) {
      const run = await tx.get<RunRow>('SELECT * FROM platform_task_runs WHERE id = ? AND task_id = ?', [row.latest_run_id, row.id]);
      if (run) task.latest_run = publicRun(run);
    }
    return task;
  }

  async agents(actor: TaskActor): Promise<{ items: Array<{ id: string; name: string; role: string | null; online: boolean }> }> {
    this.requireSupportedStorage();
    const rows = await this.driver.all<{ id: string; name: string; role: string | null; online: number }>(
      "SELECT id, name, role, online FROM bots WHERE org_id = ? AND join_status = 'active' ORDER BY name, id", [actor.orgId]);
    return { items: rows.map(row => ({ ...row, online: Boolean(row.online) })) };
  }

  async list(actor: TaskActor, options: { status?: TaskStatus; limit: number }): Promise<{ items: PlatformTask[]; total: number }> {
    return this.operation(actor.orgId, async tx => {
      const clauses = ['org_id = ?'];
      const params: unknown[] = [actor.orgId];
      if (!actor.admin) { clauses.push('(created_by = ? OR assigned_bot_id = ?)'); params.push(actor.botId, actor.botId); }
      if (options.status) { clauses.push('status = ?'); params.push(options.status); }
      const where = clauses.join(' AND ');
      const count = await tx.get<{ total: number }>(`SELECT COUNT(*) AS total FROM platform_tasks WHERE ${where}`, params);
      const rows = await tx.all<TaskRow>(`SELECT * FROM platform_tasks WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, options.limit]);
      const items: PlatformTask[] = [];
      for (const row of rows) items.push(await this.projectTask(tx, row));
      return { items, total: Number(count?.total ?? 0) };
    });
  }

  async detail(actor: TaskActor, id: string): Promise<{ task: PlatformTask; runs: TaskRun[] }> {
    return this.operation(actor.orgId, async tx => {
      const row = await this.taskFor(tx, actor, id);
      const runs = await tx.all<RunRow>('SELECT * FROM platform_task_runs WHERE task_id = ? ORDER BY attempt DESC', [id]);
      return { task: await this.projectTask(tx, row), runs: runs.map(publicRun) };
    });
  }

  async create(actor: TaskActor, input: CreateTaskInput, key: string): Promise<{ task: PlatformTask; replayed: boolean }> {
    return this.operation(actor.orgId, async (tx, now) => {
      const requestHash = payloadHash(input);
      const existing = await tx.get<TaskRow>(
        'SELECT * FROM platform_tasks WHERE org_id = ? AND created_by = ? AND idempotency_key = ?', [actor.orgId, actor.botId, key]);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new TaskError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request');
        return { task: await this.projectTask(tx, existing), replayed: true };
      }
      const assignee = await tx.get<{ id: string }>(
        "SELECT id FROM bots WHERE id = ? AND org_id = ? AND join_status = 'active'", [input.assigned_bot_id, actor.orgId]);
      if (!assignee) throw new TaskError(404, 'NOT_FOUND', 'Assigned agent not found');
      const creator = await tx.get<{ id: string }>(
        "SELECT id FROM bots WHERE id = ? AND org_id = ? AND join_status = 'active'", [actor.botId, actor.orgId]);
      if (!creator) throw new TaskError(403, 'FORBIDDEN', 'Creator is not an active organization bot');

      const id = crypto.randomUUID();
      const threadId = crypto.randomUUID();
      await tx.run(`
        INSERT INTO threads (id, org_id, topic, status, initiator_id, context, visibility, join_policy, revision, created_at, updated_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [threadId, actor.orgId, input.title, 'active', actor.botId, JSON.stringify({ platform_task_id: id }), 'private', 'invite_only', 1, now, now, now]);
      for (const botId of new Set([actor.botId, input.assigned_bot_id])) {
        await tx.run('INSERT INTO thread_participants (thread_id, bot_id, label, joined_at) VALUES (?, ?, ?, ?)',
          [threadId, botId, botId === actor.botId ? 'creator' : 'assignee', now]);
      }
      await tx.run(`
        INSERT INTO platform_tasks (id, org_id, title, description, status, created_by, created_by_name, assigned_bot_id, thread_id, created_at, updated_at, revision, latest_run_id, idempotency_key, request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, actor.orgId, input.title, input.description, 'queued', actor.botId, actor.name, input.assigned_bot_id, threadId, now, now, 1, null, key, requestHash]);
      const row = await tx.get<TaskRow>('SELECT * FROM platform_tasks WHERE id = ?', [id]);
      return { task: await this.projectTask(tx, row!), replayed: false };
    });
  }

  async claim(actor: TaskActor, runnerId: string): Promise<{ task: PlatformTask | null; run?: TaskRun; lease_token?: string }> {
    return this.operation(actor.orgId, async (tx, now) => {
      // A logical bot may share a single Zylos/CLI session across runners. Until
      // we have explicit instance capacity, allow only one active task per bot.
      const active = await tx.get<{ id: string }>(`
        SELECT id FROM platform_tasks WHERE org_id = ? AND assigned_bot_id = ? AND status = 'running' LIMIT 1
      `, [actor.orgId, actor.botId]);
      if (active) return { task: null };
      const row = await tx.get<TaskRow>(`
        SELECT * FROM platform_tasks WHERE org_id = ? AND assigned_bot_id = ? AND status = 'queued'
        ORDER BY created_at, id LIMIT 1
      `, [actor.orgId, actor.botId]);
      if (!row) return { task: null };
      const runId = crypto.randomUUID();
      const leaseToken = crypto.randomBytes(32).toString('hex');
      const attempts = await tx.get<{ attempt: number }>('SELECT MAX(attempt) AS attempt FROM platform_task_runs WHERE task_id = ?', [row.id]);
      const attempt = Number(attempts?.attempt ?? 0) + 1;
      const claimed = await tx.run(`
        UPDATE platform_tasks SET status = 'running', latest_run_id = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'queued' AND revision = ?
      `, [runId, now, row.id, row.revision]);
      if (!claimed.changes) return { task: null };
      await tx.run(`
        INSERT INTO platform_task_runs (id, task_id, runner_id, attempt, status, started_at, finished_at, lease_expires_at, lease_token_hash, finish_payload_hash, summary, error, artifacts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [runId, row.id, runnerId, attempt, 'running', now, null, now + TASK_LEASE_MS, hash(leaseToken), null, null, null, '[]']);
      const task = await tx.get<TaskRow>('SELECT * FROM platform_tasks WHERE id = ?', [row.id]);
      const run = await tx.get<RunRow>('SELECT * FROM platform_task_runs WHERE id = ?', [runId]);
      return { task: await this.projectTask(tx, task!), run: publicRun(run!), lease_token: leaseToken };
    });
  }

  private async runFor(tx: DatabaseDriver, actor: TaskActor, taskId: string, runId: string, leaseToken: string): Promise<{ task: TaskRow; run: RunRow }> {
    const task = await this.taskFor(tx, actor, taskId);
    if (task.assigned_bot_id !== actor.botId) throw new TaskError(403, 'FORBIDDEN', 'Only the assigned agent may operate this run');
    const run = await tx.get<RunRow>('SELECT * FROM platform_task_runs WHERE id = ? AND task_id = ?', [runId, taskId]);
    if (!run) throw new TaskError(404, 'NOT_FOUND', 'Run not found');
    const expected = Buffer.from(run.lease_token_hash, 'hex');
    const provided = Buffer.from(hash(leaseToken), 'hex');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new TaskError(403, 'TASK_LEASE_INVALID', 'Invalid execution lease');
    }
    if (task.status === 'cancelled' || run.status === 'cancelled') throw new TaskError(409, 'TASK_CANCELLED', 'Task was cancelled');
    if (run.status === 'expired') throw new TaskError(409, 'TASK_LEASE_EXPIRED', 'Execution lease expired');
    if (task.latest_run_id !== runId || task.status === 'queued') throw new TaskError(409, 'TASK_RUN_INACTIVE', 'Execution attempt is no longer current');
    return { task, run };
  }

  async heartbeat(actor: TaskActor, taskId: string, runId: string, leaseToken: string): Promise<{ lease_expires_at: number }> {
    return this.operation(actor.orgId, async (tx, now) => {
      const { task, run } = await this.runFor(tx, actor, taskId, runId, leaseToken);
      if (run.status !== 'running' || task.status !== 'running') throw new TaskError(409, 'TASK_RUN_INACTIVE', 'Execution attempt is not running');
      const expiresAt = now + TASK_LEASE_MS;
      await tx.run("UPDATE platform_task_runs SET lease_expires_at = ? WHERE id = ? AND status = 'running'", [expiresAt, runId]);
      return { lease_expires_at: expiresAt };
    });
  }

  async finish(actor: TaskActor, taskId: string, runId: string, leaseToken: string, result: FinishTaskInput): Promise<{ task: PlatformTask; run: TaskRun }> {
    return this.operation(actor.orgId, async (tx, now) => {
      const { task, run } = await this.runFor(tx, actor, taskId, runId, leaseToken);
      const finishHash = payloadHash(result);
      if (run.status === 'succeeded' || run.status === 'failed') {
        if (run.finish_payload_hash !== finishHash) throw new TaskError(409, 'IDEMPOTENCY_CONFLICT', 'This run already has a different final result');
        return { task: await this.projectTask(tx, task), run: publicRun(run) };
      }
      if (run.status !== 'running' || task.status !== 'running') throw new TaskError(409, 'TASK_RUN_INACTIVE', 'Execution attempt is not running');
      await tx.run(`
        UPDATE platform_task_runs SET status = ?, finished_at = ?, summary = ?, error = ?, artifacts = ?, finish_payload_hash = ?
        WHERE id = ? AND status = 'running'
      `, [result.status, now, result.summary, result.error, JSON.stringify(result.artifacts), finishHash, runId]);
      await tx.run(`
        UPDATE platform_tasks SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND latest_run_id = ? AND status = 'running'
      `, [result.status === 'succeeded' ? 'reviewing' : 'failed', now, taskId, runId]);
      const updatedTask = await tx.get<TaskRow>('SELECT * FROM platform_tasks WHERE id = ?', [taskId]);
      const updatedRun = await tx.get<RunRow>('SELECT * FROM platform_task_runs WHERE id = ?', [runId]);
      return { task: await this.projectTask(tx, updatedTask!), run: publicRun(updatedRun!) };
    });
  }

  async transition(actor: TaskActor, id: string, action: 'accept' | 'retry' | 'cancel', expectedRevision: number): Promise<PlatformTask> {
    return this.operation(actor.orgId, async (tx, now) => {
      const task = await this.taskFor(tx, actor, id);
      if (!actor.admin && task.created_by !== actor.botId) throw new TaskError(403, 'FORBIDDEN', 'Only the creator or an organization admin agent may manage this task');
      if (Number(task.revision) !== expectedRevision) throw new TaskError(409, 'REVISION_CONFLICT', 'Task changed; reload its current revision');
      const allowed = action === 'accept' ? task.status === 'reviewing'
        : action === 'retry' ? task.status === 'failed'
        : !['completed', 'cancelled'].includes(task.status);
      if (!allowed) throw new TaskError(409, 'INVALID_TRANSITION', `Cannot ${action} a ${task.status} task`);
      if (action === 'cancel' && task.latest_run_id) {
        await tx.run("UPDATE platform_task_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'", [now, task.latest_run_id]);
      }
      const status: TaskStatus = action === 'accept' ? 'completed' : action === 'retry' ? 'queued' : 'cancelled';
      await tx.run('UPDATE platform_tasks SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?',
        [status, now, id, expectedRevision]);
      const updated = await tx.get<TaskRow>('SELECT * FROM platform_tasks WHERE id = ?', [id]);
      return this.projectTask(tx, updated!);
    });
  }
}
