import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { HubDB } from '../src/db.js';
import { SqliteDriver } from '../src/db/sqlite-driver.js';
import { SqliteSessionStore } from '../src/session.js';
import type { DatabaseDriver } from '../src/db/driver.js';
import { PlatformTaskStore } from '../src/platform/store.js';
import type { TaskActor } from '../src/platform/types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('platform tasks over the authenticated Hub API', () => {
  let env: TestEnv;
  let org: { id: string; org_secret: string };
  let creator: { bot: any; token: string };
  let worker: { bot: any; token: string };
  let stranger: { bot: any; token: string };
  let admin: { bot: any; token: string };
  let foreign: { bot: any; token: string };

  beforeEach(async () => {
    env = await createTestEnv({ admin_secret: 'task-test-platform-admin' });
    org = await env.createOrg();
    creator = await env.registerBot(org.org_secret, 'creator');
    worker = await env.registerBot(org.org_secret, 'worker', { role: 'Developer' });
    stranger = await env.registerBot(org.org_secret, 'stranger');
    admin = await env.registerBot(org.org_secret, 'admin');
    await env.promoteBot(org.org_secret, admin.bot.id);
    const otherOrg = await env.createOrg();
    foreign = await env.registerBot(otherOrg.org_secret, 'foreign');
  });
  afterEach(async () => { await env?.cleanup(); });

  const request = (method: string, suffix: string, token: string, body?: unknown, headers?: Record<string, string>) =>
    api(env.baseUrl, method, `/api/tasks${suffix}`, { token, body, headers });
  async function createTask(overrides: Record<string, unknown> = {}, key = crypto.randomUUID()) {
    const response = await request('POST', '', creator.token, {
      title: 'Build a reviewable demo', description: 'Return a summary and preview link.',
      assigned_bot_id: worker.bot.id, ...overrides,
    }, { 'Idempotency-Key': key });
    expect(response.status).toBe(201);
    return response.body;
  }
  async function claim() {
    const response = await request('POST', '/claim', worker.token, { runner_id: 'mock:local-worker' });
    expect(response.status).toBe(200);
    expect(response.body.task).not.toBeNull();
    return response.body;
  }
  const finish = (lease: any, result: Record<string, unknown> = {}) => request(
    'POST', `/${lease.task.id}/runs/${lease.run.id}/finish`, worker.token,
    { lease_token: lease.lease_token, status: 'succeeded', summary: 'Demo ready for human review.', ...result },
  );
  function rawDb() { return new Database(path.join(env.dataDir, 'hxa-connect.db')); }
  async function ownerCookie(token = creator.token, name = 'Product Owner') {
    const response = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'bot', token, owner_name: name },
    });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.match(/hxa_session=([^;]+)/)![1];
  }

  it('creates one private task/thread under concurrent idempotent requests and snapshots the Bot Owner', async () => {
    const cookie = await ownerCookie();
    const body = { title: '  Internal demo  ', description: '', assigned_bot_id: worker.bot.id };
    const replies = await Promise.all(Array.from({ length: 8 }, () => api(env.baseUrl, 'POST', '/api/tasks', {
      cookie, body, headers: { 'Idempotency-Key': 'same-create' },
    })));
    expect(replies.filter(reply => reply.status === 201)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(7);
    expect(new Set(replies.map(reply => reply.body.id)).size).toBe(1);
    const task = replies[0].body;
    expect(task).toMatchObject({ title: 'Internal demo', status: 'queued', revision: 1,
      created_by: creator.bot.id, created_by_name: 'Product Owner', assigned_bot_id: worker.bot.id });
    expect(typeof task.created_at).toBe('number');
    const thread = await env.db.getThread(task.thread_id);
    expect(thread).toMatchObject({ visibility: 'private', join_policy: 'invite_only', initiator_id: creator.bot.id });
    expect((await env.db.getParticipants(task.thread_id)).map(item => item.bot_id).sort())
      .toEqual([creator.bot.id, worker.bot.id].sort());
    const conflict = await request('POST', '', creator.token, { ...body, title: 'Different' }, { 'Idempotency-Key': 'same-create' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const self = await createTask({ assigned_bot_id: creator.bot.id });
    expect(await env.db.getParticipants(self.thread_id)).toHaveLength(1);
    const db = rawDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM platform_tasks').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  it('rolls back the private thread and participants if the task insert fails', async () => {
    const db = rawDb();
    try {
      db.exec("CREATE TRIGGER fail_task_insert BEFORE INSERT ON platform_tasks BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END");
      const response = await request('POST', '', creator.token, {
        title: 'Must roll back', description: '', assigned_bot_id: worker.bot.id,
      }, { 'Idempotency-Key': 'rollback' });
      expect(response.status).toBe(500);
      expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM thread_participants').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM platform_tasks').get()).toEqual({ n: 0 });
      db.exec('DROP TRIGGER fail_task_insert');
      await createTask({}, 'rollback');
    } finally { db.close(); }
  });

  it('enforces actor visibility, organization isolation, token scopes and session boundaries', async () => {
    const task = await createTask();
    expect((await api(env.baseUrl, 'GET', '/api/tasks')).status).toBe(401);
    for (const actor of [stranger, foreign]) {
      expect((await request('GET', `/${task.id}`, actor.token)).status).toBe(404);
      expect((await request('GET', '', actor.token)).body).toEqual({ items: [], total: 0 });
      expect((await request('POST', `/${task.id}/cancel`, actor.token, { expected_revision: 1 })).status).toBe(404);
    }
    expect((await request('GET', `/${task.id}`, worker.token)).status).toBe(200);
    expect((await request('GET', `/${task.id}`, admin.token)).status).toBe(200);
    const readToken = await env.db.createBotToken(creator.bot.id, ['read']);
    expect((await request('GET', `/${task.id}`, readToken.token)).status).toBe(200);
    const scopedMutation = await request('POST', `/${task.id}/cancel`, readToken.token, { expected_revision: 1 });
    expect(scopedMutation.status).toBe(403);
    expect(scopedMutation.body.code).toBe('INSUFFICIENT_SCOPE');
    const workerRead = await env.db.createBotToken(worker.bot.id, ['read']);
    expect((await request('POST', '/claim', workerRead.token, { runner_id: 'forbidden' })).status).toBe(403);
    const orgCookie = await env.loginAsOrg(org.org_secret);
    expect((await api(env.baseUrl, 'GET', '/api/tasks', { cookie: orgCookie })).status).toBe(403);
    const superLogin = await api(env.baseUrl, 'POST', '/api/auth/login', {
      body: { type: 'super_admin', admin_secret: 'task-test-platform-admin' },
    });
    expect(superLogin.status).toBe(200);
    const superCookie = superLogin.headers.get('set-cookie')!.match(/hxa_session=([^;]+)/)![1];
    expect((await api(env.baseUrl, 'GET', '/api/tasks', { cookie: superCookie })).status).toBe(403);
    const foreignAssign = await request('POST', '', creator.token, {
      title: 'Foreign assignment', description: '', assigned_bot_id: foreign.bot.id,
    }, { 'Idempotency-Key': 'foreign' });
    expect(foreignAssign.status).toBe(404);
    const agents = await request('GET', '/agents', creator.token);
    expect(agents.status).toBe(200);
    expect(agents.body.items.map((item: any) => item.id).sort())
      .toEqual([creator, worker, stranger, admin].map(item => item.bot.id).sort());
    expect(agents.body.items.every((item: any) => Object.keys(item).sort().join(',') === 'id,name,online,role')).toBe(true);
    expect(agents.body.items.every((item: any) => typeof item.online === 'boolean')).toBe(true);
  });

  it('gives exactly one parallel claimant a secret lease and requires assigned-bot bearer auth for execution', async () => {
    const task = await createTask();
    expect((await request('POST', '/claim', stranger.token, { runner_id: 'unassigned' })).body).toEqual({ task: null });
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      request('POST', '/claim', worker.token, { runner_id: `worker-${index}` })));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    const claims = replies.filter(reply => reply.body.task !== null);
    expect(claims).toHaveLength(1);
    const lease = claims[0].body;
    expect(lease.task).toMatchObject({ id: task.id, status: 'running', revision: 2 });
    expect(lease.run).toMatchObject({ attempt: 1, status: 'running' });
    expect(lease.lease_token).toMatch(/^[a-f0-9]{64}$/);
    const cookie = await ownerCookie(worker.token, 'Developer');
    for (const options of [{ cookie }, { cookie, token: worker.token }]) {
      expect((await api(env.baseUrl, 'POST', '/api/tasks/claim', { ...options, body: { runner_id: 'browser' } })).status).toBe(403);
      expect((await api(env.baseUrl, 'POST', `/api/tasks/${task.id}/runs/${lease.run.id}/heartbeat`, {
        ...options, body: { lease_token: lease.lease_token },
      })).status).toBe(403);
    }
    const base = `/${task.id}/runs/${lease.run.id}/heartbeat`;
    expect((await request('POST', base, creator.token, { lease_token: lease.lease_token })).status).toBe(403);
    const invalid = await request('POST', base, worker.token, { lease_token: 'not-the-lease' });
    expect(invalid.status).toBe(403);
    expect(invalid.body.code).toBe('TASK_LEASE_INVALID');
    const heartbeat = await request('POST', base, worker.token, { lease_token: lease.lease_token });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.lease_expires_at).toBeGreaterThanOrEqual(lease.run.lease_expires_at);
    const detail = await request('GET', `/${task.id}`, creator.token);
    expect(detail.body.runs).toHaveLength(1);
    const publicJson = JSON.stringify([detail.body, (await request('GET', '', creator.token)).body]);
    for (const secret of [lease.lease_token, 'lease_token', 'finish_payload_hash', 'request_hash', 'idempotency_key']) {
      expect(publicJson).not.toContain(secret);
    }
    const db = rawDb();
    try {
      const stored: any = db.prepare('SELECT lease_token_hash FROM platform_task_runs WHERE id = ?').get(lease.run.id);
      expect(stored.lease_token_hash).toBe(crypto.createHash('sha256').update(lease.lease_token).digest('hex'));
      expect(stored.lease_token_hash).not.toBe(lease.lease_token);
    } finally { db.close(); }
  });

  it('allows only one active task per logical bot when two runners compete for two queued tasks', async () => {
    await createTask({ title: 'First demo' });
    await createTask({ title: 'Second demo' });
    const responses = await Promise.all([
      request('POST', '/claim', worker.token, { runner_id: 'runner-one' }),
      request('POST', '/claim', worker.token, { runner_id: 'runner-two' }),
    ]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const leases = responses.filter(response => response.body.task !== null);
    expect(leases).toHaveLength(1);
    const listed = await request('GET', '', creator.token);
    expect(listed.body.items.map((task: any) => task.status).sort()).toEqual(['queued', 'running']);
    expect((await finish(leases[0].body)).body.task.status).toBe('reviewing');
    const next = await claim();
    expect(next.task.id).not.toBe(leases[0].body.task.id);
    expect(next.run.attempt).toBe(1);
  });

  it('finishes idempotently, preserves artifacts, and only completes after creator/admin acceptance', async () => {
    const task = await createTask();
    const premature = await request('POST', `/${task.id}/accept`, creator.token, { expected_revision: 1 });
    expect(premature.body.code).toBe('INVALID_TRANSITION');
    const lease = await claim();
    const result = { artifacts: [{ title: 'Preview', url: 'https://example.test/demo?version=1' }] };
    const replies = await Promise.all(Array.from({ length: 5 }, () => finish(lease, result)));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    expect(replies.every(reply => reply.body.task.revision === 3 && reply.body.task.status === 'reviewing')).toBe(true);
    expect(replies[0].body.run.artifacts).toEqual(result.artifacts);
    const conflict = await finish(lease, { summary: 'Different result' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await request('POST', `/${task.id}/accept`, worker.token, { expected_revision: 3 })).status).toBe(403);
    expect((await request('POST', `/${task.id}/accept`, creator.token, { expected_revision: 2 })).body.code).toBe('REVISION_CONFLICT');
    const accepted = await request('POST', `/${task.id}/accept`, admin.token, { expected_revision: 3 });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'completed', revision: 4 });
    expect((await finish(lease, result)).body.task).toMatchObject({ status: 'completed', revision: 4 });
    expect((await request('POST', `/${task.id}/cancel`, creator.token, { expected_revision: 4 })).body.code).toBe('INVALID_TRANSITION');
    const filtered = await request('GET', '?status=completed&limit=1', creator.token);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].id).toBe(task.id);
  });

  it('retains attempt history and fences old finishes after an explicit retry', async () => {
    const task = await createTask();
    const first = await claim();
    const failed = await finish(first, { status: 'failed', summary: null, error: 'Build failed' });
    expect(failed.status).toBe(200);
    expect(failed.body.task).toMatchObject({ status: 'failed', revision: 3 });
    const retry = await request('POST', `/${task.id}/retry`, creator.token, { expected_revision: 3 });
    expect(retry.body).toMatchObject({ status: 'queued', revision: 4 });
    expect((await finish(first, { status: 'failed', summary: null, error: 'Build failed' })).body.code).toBe('TASK_RUN_INACTIVE');
    const second = await claim();
    expect(second.run.attempt).toBe(2);
    expect(second.run.id).not.toBe(first.run.id);
    expect((await finish(first)).body.code).toBe('TASK_RUN_INACTIVE');
    expect((await request('POST', `/${task.id}/runs/${first.run.id}/heartbeat`, worker.token,
      { lease_token: first.lease_token })).body.code).toBe('TASK_RUN_INACTIVE');
    expect((await finish(second)).status).toBe(200);
    const detail = await request('GET', `/${task.id}`, creator.token);
    expect(detail.body.runs.map((run: any) => [run.attempt, run.status])).toEqual([[2, 'succeeded'], [1, 'failed']]);
  });

  it('commits lease expiration even when rejecting a late finish and never automatically requeues it', async () => {
    const task = await createTask();
    const lease = await claim();
    const db = rawDb();
    try { db.prepare('UPDATE platform_task_runs SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, lease.run.id); }
    finally { db.close(); }
    const late = await finish(lease);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('TASK_LEASE_EXPIRED');
    const detail = await request('GET', `/${task.id}`, creator.token);
    expect(detail.body.task).toMatchObject({ status: 'failed', revision: 3 });
    expect(detail.body.runs[0].status).toBe('expired');
    expect((await request('POST', '/claim', worker.token, { runner_id: 'after-restart' })).body).toEqual({ task: null });
    expect((await request('POST', `/${task.id}/runs/${lease.run.id}/heartbeat`, worker.token,
      { lease_token: lease.lease_token })).body.code).toBe('TASK_LEASE_EXPIRED');
    expect((await request('POST', `/${task.id}/retry`, creator.token, { expected_revision: 3 })).status).toBe(200);
    expect((await claim()).run.attempt).toBe(2);
  });

  it('cancels active attempts and resolves a finish/cancel race without inconsistent task state', async () => {
    const task = await createTask();
    const lease = await claim();
    const cancelled = await request('POST', `/${task.id}/cancel`, creator.token, { expected_revision: 2 });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', revision: 3 });
    expect(cancelled.body.latest_run.status).toBe('cancelled');
    expect((await finish(lease)).body.code).toBe('TASK_CANCELLED');
    expect((await request('POST', `/${task.id}/runs/${lease.run.id}/heartbeat`, worker.token,
      { lease_token: lease.lease_token })).body.code).toBe('TASK_CANCELLED');

    const other = await createTask();
    const racingLease = await claim();
    const outcomes = await Promise.all([
      finish(racingLease),
      request('POST', `/${other.id}/cancel`, creator.token, { expected_revision: 2 }),
    ]);
    expect(outcomes.map(reply => reply.status).sort()).toEqual([200, 409]);
    const detail = await request('GET', `/${other.id}`, creator.token);
    expect(detail.body.task.revision).toBe(3);
    expect([['reviewing', 'succeeded'], ['cancelled', 'cancelled']])
      .toContainEqual([detail.body.task.status, detail.body.runs[0].status]);
  });

  it('validates bounded inputs, revision preconditions, finish results and safe artifact links', async () => {
    for (const suffix of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=-1', '?limit=NaN', '?status=unknown', '?status=queued&status=failed']) {
      expect((await request('GET', suffix, creator.token)).status).toBe(400);
    }
    const valid = { title: 'Demo', description: '', assigned_bot_id: worker.bot.id };
    for (const body of [{ ...valid, title: ' ' }, { ...valid, title: 'a'.repeat(201) },
      { ...valid, description: 'a'.repeat(20001) }, { ...valid, assigned_bot_id: '' }, { ...valid, unknown: true }]) {
      expect((await request('POST', '', creator.token, body, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(400);
    }
    expect((await request('POST', '', creator.token, valid)).status).toBe(400);
    const task = await createTask();
    for (const revision of [null, 0, '1', 1.5]) {
      expect((await request('POST', `/${task.id}/cancel`, creator.token, { expected_revision: revision })).status).toBe(400);
    }
    const lease = await claim();
    for (const result of [{ summary: '' }, { summary: ' ' }, { status: 'failed', error: null },
      { summary: 'a'.repeat(10001) }, { status: 'reviewing' },
      { artifacts: [{ title: 'X', url: 'javascript:alert(1)' }] },
      { artifacts: [{ title: 'X', url: 'https://user:password@example.test' }] },
      { artifacts: [{ title: 'X', url: '/relative' }] },
      { artifacts: Array.from({ length: 21 }, () => ({ title: 'X', url: 'https://example.test' })) }]) {
      const response = await finish(lease, result);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    expect((await request('GET', `/${task.id}`, creator.token)).body.task.status).toBe('running');
  });
});

describe('platform task persistence', () => {
  it('keeps queued work, completed attempt results and live leases across a HubDB restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-task-restart-'));
    const dbPath = path.join(dir, 'hub.db');
    let db = new HubDB(new SqliteDriver(dbPath));
    try {
      await db.init();
      const org = await db.createOrg('restart-org');
      const creatorResult = await db.registerBot(org.id, 'creator');
      const workerResult = await db.registerBot(org.id, 'worker');
      if (!('bot' in creatorResult) || !('bot' in workerResult)) throw new Error('Unexpected registration conflict');
      const creator: TaskActor = { orgId: org.id, botId: creatorResult.bot.id, name: 'Owner', admin: false };
      const worker: TaskActor = { orgId: org.id, botId: workerResult.bot.id, name: 'Worker', admin: false };
      const done = await db.tasks.create(creator, { title: 'Review later', description: '', assigned_bot_id: worker.botId }, 'done');
      const first = await db.tasks.claim(worker, 'mock:server');
      await db.tasks.finish(worker, done.task.id, first.run!.id, first.lease_token!, {
        status: 'succeeded', summary: 'Persistent result', error: null,
        artifacts: [{ title: 'Preview', url: 'https://example.test/persisted' }],
      });
      const queued = await db.tasks.create(creator, { title: 'Offline employee', description: '', assigned_bot_id: creator.botId }, 'queued');
      const running = await db.tasks.create(creator, { title: 'Live attempt', description: '', assigned_bot_id: worker.botId }, 'running');
      const live = await db.tasks.claim(worker, 'mock:laptop');
      await db.close();
      db = new HubDB(new SqliteDriver(dbPath));
      await db.init();
      expect((await db.tasks.detail(creator, done.task.id)).runs[0]).toMatchObject({
        status: 'succeeded', summary: 'Persistent result', artifacts: [{ title: 'Preview', url: 'https://example.test/persisted' }],
      });
      expect((await db.tasks.detail(creator, queued.task.id)).task.status).toBe('queued');
      expect((await db.tasks.detail(creator, running.task.id)).task.status).toBe('running');
      await db.tasks.heartbeat(worker, running.task.id, live.run!.id, live.lease_token!);
      const replay = await db.tasks.create(creator, { title: 'Review later', description: '', assigned_bot_id: worker.botId }, 'done');
      expect(replay.replayed).toBe(true);
      expect(replay.task.id).toBe(done.task.id);
      const finished = await db.tasks.finish(worker, running.task.id, live.run!.id, live.lease_token!, {
        status: 'failed', summary: null, error: 'Stopped after restart', artifacts: [],
      });
      expect(finished.task.status).toBe('failed');
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M0 task storage boundary', () => {
  it('keeps non-SQLite initialization inert and rejects every task operation without executing SQL', async () => {
    let calls = 0;
    const unexpected = async (): Promise<never> => { calls++; throw new Error('Unexpected database call'); };
    const driver: DatabaseDriver = {
      dialect: 'postgres', run: unexpected, get: unexpected, all: unexpected, exec: unexpected,
      transaction: unexpected, isHealthy: unexpected, close: unexpected,
    };
    const store = new PlatformTaskStore(driver);
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      await store.init();
      expect(interval).not.toHaveBeenCalled();
      const actor: TaskActor = { orgId: 'org', botId: 'bot', name: 'Owner', admin: false };
      const operations = [
        () => store.agents(actor),
        () => store.list(actor, { limit: 10 }),
        () => store.detail(actor, 'task'),
        () => store.create(actor, { title: 'Demo', description: '', assigned_bot_id: 'bot' }, 'key'),
        () => store.claim(actor, 'runner'),
        () => store.heartbeat(actor, 'task', 'run', 'lease'),
        () => store.finish(actor, 'task', 'run', 'lease', { status: 'succeeded', summary: 'Done', error: null, artifacts: [] }),
        () => store.transition(actor, 'task', 'accept', 1),
        () => store.transition(actor, 'task', 'retry', 1),
        () => store.transition(actor, 'task', 'cancel', 1),
        () => store.expireLeases(),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toMatchObject({ status: 503, code: 'TASK_STORAGE_UNSUPPORTED' });
      }
      expect(calls).toBe(0);
    } finally { store.close(); interval.mockRestore(); }
  });
});

describe('SQLite asynchronous transaction isolation', () => {
  let dir: string;
  let driver: SqliteDriver;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-task-isolation-'));
    driver = new SqliteDriver(path.join(dir, 'db.sqlite'));
    await driver.exec('CREATE TABLE entries (name TEXT PRIMARY KEY)');
  });
  afterEach(async () => { await driver.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('does not let an independent Hub session write or read join a failing transaction', async () => {
    await driver.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, role TEXT, org_id TEXT, bot_id TEXT, owner_name TEXT,
      scopes TEXT, is_scoped_token INTEGER, created_at INTEGER, expires_at INTEGER
    )`);
    const sessions = new SqliteSessionStore(driver);
    const entered = gate();
    const release = gate();
    const failing = driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('rolled-back')");
      entered.resolve();
      await release.promise;
      throw new Error('Intentional rollback');
    });
    const failure = expect(failing).rejects.toThrow('Intentional rollback');
    await entered.promise;
    let sessionWritten = false;
    const externalSession = sessions.set({
      id: 'independent-session', role: 'bot_owner', org_id: 'org', bot_id: 'bot', owner_name: 'Owner',
      scopes: ['full'], is_scoped_token: false, created_at: Date.now(), expires_at: Date.now() + 60_000,
    }).then(() => { sessionWritten = true; });
    let outsideRead = false;
    const read = driver.all('SELECT name FROM entries').then(rows => { outsideRead = true; return rows; });
    await turn();
    expect(sessionWritten).toBe(false);
    expect(outsideRead).toBe(false);
    release.resolve();
    await failure;
    await externalSession;
    expect(await read).toEqual([]);
    expect(await sessions.get('independent-session')).not.toBeNull();
  });

  it('serializes independent transactions and isolates their rollback', async () => {
    const entered = gate();
    const release = gate();
    const first = driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('first')");
      entered.resolve();
      await release.promise;
      throw new Error('First failed');
    });
    const failure = expect(first).rejects.toThrow('First failed');
    await entered.promise;
    let secondEntered = false;
    const second = driver.transaction(async tx => {
      secondEntered = true;
      await tx.run("INSERT INTO entries VALUES ('second')");
    });
    await turn();
    expect(secondEntered).toBe(false);
    release.resolve();
    await Promise.all([failure, second]);
    expect(await driver.all('SELECT name FROM entries')).toEqual([{ name: 'second' }]);
  });

  it('supports sequential nested savepoints without rolling back the parent', async () => {
    await driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('outer-before')");
      await expect(tx.transaction(async nested => {
        await nested.run("INSERT INTO entries VALUES ('nested-failed')");
        throw new Error('Nested rollback');
      })).rejects.toThrow('Nested rollback');
      await tx.transaction(async nested => { await nested.run("INSERT INTO entries VALUES ('nested-ok')"); });
      await tx.run("INSERT INTO entries VALUES ('outer-after')");
    });
    expect(await driver.all('SELECT name FROM entries ORDER BY name'))
      .toEqual([{ name: 'nested-ok' }, { name: 'outer-after' }, { name: 'outer-before' }]);
  });

  it('rejects overlapping nested transactions and waits for the open savepoint before rollback', async () => {
    const entered = gate();
    const release = gate();
    const outer = driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('outer')");
      const first = tx.transaction(async nested => {
        await nested.run("INSERT INTO entries VALUES ('child')");
        entered.resolve();
        await release.promise;
      });
      const second = tx.transaction(async nested => { await nested.run("INSERT INTO entries VALUES ('forbidden')"); });
      await Promise.all([first, second]);
    });
    const failure = expect(outer).rejects.toThrow('Concurrent nested SQLite transactions are not supported');
    await entered.promise;
    release.resolve();
    await failure;
    expect(await driver.all('SELECT name FROM entries')).toEqual([]);
    await driver.run("INSERT INTO entries VALUES ('connection-usable')");
  });

  it('rejects parent SQL while a child savepoint is open instead of silently rolling back parent writes', async () => {
    await driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('outer-before')");
      const entered = gate();
      const release = gate();
      const nested = tx.transaction(async child => {
        await child.run("INSERT INTO entries VALUES ('child-rollback')");
        entered.resolve();
        await release.promise;
        throw new Error('Child rollback');
      });
      const childFailure = expect(nested).rejects.toThrow('Child rollback');
      await entered.promise;
      await expect(tx.run("INSERT INTO entries VALUES ('unsafe-parent-write')"))
        .rejects.toThrow('parent transaction while a nested transaction is active');
      await expect(tx.get('SELECT COUNT(*) FROM entries'))
        .rejects.toThrow('parent transaction while a nested transaction is active');
      release.resolve();
      await childFailure;
      await tx.run("INSERT INTO entries VALUES ('outer-after')");
    });
    expect(await driver.all('SELECT name FROM entries ORDER BY name'))
      .toEqual([{ name: 'outer-after' }, { name: 'outer-before' }]);
  });

  it('does not let a detached stale transaction context bypass the connection queue', async () => {
    const detachedGate = gate();
    let detached!: Promise<void>;
    await driver.transaction(async () => {
      detached = (async () => {
        await detachedGate.promise;
        await driver.run("INSERT INTO entries VALUES ('detached')");
      })();
    });
    const entered = gate();
    const release = gate();
    const current = driver.transaction(async tx => {
      await tx.run("INSERT INTO entries VALUES ('current')");
      entered.resolve();
      await release.promise;
      throw new Error('Current rolled back');
    });
    const failure = expect(current).rejects.toThrow('Current rolled back');
    await entered.promise;
    let detachedDone = false;
    detached.then(() => { detachedDone = true; });
    detachedGate.resolve();
    await turn();
    expect(detachedDone).toBe(false);
    release.resolve();
    await Promise.all([failure, detached]);
    expect(await driver.all('SELECT name FROM entries')).toEqual([{ name: 'detached' }]);
  });
});
