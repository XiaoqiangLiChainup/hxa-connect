import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { runWorker } from '../scripts/task-runner/worker.mjs';
import { runCodexProcess } from '../scripts/codex-runner/process.mjs';
import { acquireWorkerLock, reportState } from '../scripts/codex-runner/state.mjs';
import { uploadArtifacts } from '../scripts/codex-runner/artifacts.mjs';
import { createSandboxProfileName } from '../scripts/codex-runner/sandbox-policy.mjs';
import { createZylosExecutor } from '../scripts/zylos-runner/adapter.mjs';
import { loadTaskAdapter, verifyTaskSource } from '../scripts/zylos-runner/provenance.mjs';
import { inspectTaskLedger } from '../vendor/zylos-core/cli/lib/runtime/task-runtime.js';

const fixtureModule = fileURLToPath(new URL('./fixtures/codex-process-main.mjs', import.meta.url));
let temporary: string;
let hub: TestEnv | undefined;
let controllers: AbortController[];
let jobs: Promise<unknown>[];
let executors: any[];
let sentinels: ChildProcess[];
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, maximum = 5000) {
  const deadline = performance.now() + maximum;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('The offline worker fixture did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function findFile(directory: string, name: string): string | null {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { const found = findFile(file, name); if (found) return found; }
    else if (entry.name === name) return file;
  }
  return null;
}

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-worker-'));
  controllers = []; jobs = []; executors = []; sentinels = [];
});

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(jobs);
  await Promise.allSettled(executors.map(executor => executor.drain()));
  for (const sentinel of sentinels) {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      const closed = new Promise(resolve => sentinel.once('close', resolve));
      sentinel.kill('SIGKILL'); await closed;
    }
  }
  await hub?.cleanup(); hub = undefined;
  vi.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function setup() {
  hub = await createTestEnv();
  const org = await hub.createOrg();
  const owner = await hub.registerBot(org.org_secret, 'native-owner');
  const worker = await hub.registerBot(org.org_secret, 'native-worker');
  const stateRoot = path.join(temporary, 'state-root');
  const homeDir = path.join(temporary, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(temporary, 'credentials');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir]) fs.mkdirSync(directory, { mode: 0o700 });
  const codexBin = path.join(temporary, 'offline-codex');
  fs.writeFileSync(codexBin, `#!${process.execPath}\nimport ${JSON.stringify(fixtureModule)};\n`, { mode: 0o700 });
  const config = {
    url: hub.baseUrl, token: worker.token, tokenFile: path.join(credentialDir, 'unused-test-token'),
    runnerId: 'native-offline-worker', once: true, heartbeatMs: 40, pollMs: 10,
    requestTimeoutMs: 1000, uploadTimeoutMs: 1000, maxRetries: 0, retryBaseMs: 10, retryMaxMs: 20,
    stateRoot, homeDir, codexHome, credentialDir, codexBin,
    childPath: '/usr/local/bin:/usr/bin:/bin', sandboxProfile: createSandboxProfileName(), isolateStateReads: true,
    model: 'offline-native-fixture', reasoningEffort: 'medium', profile: 'files', timeoutMs: 5000, termGraceMs: 100,
    minFreeBytes: 0, maxFileBytes: 5 * 1024 * 1024, maxArtifactBytes: 10 * 1024 * 1024, maxArtifacts: 19,
    requiredArtifacts: [], publicBaseUrl: 'https://agents.example.test/pilot',
  };
  const requests: Array<{ operation: string; path: string }> = [];
  const hooks: Record<string, (url: string, init: RequestInit) => Promise<Response>> = {};
  const logs: unknown[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    const operation = pathname.endsWith('/claim') ? 'claim'
      : pathname.endsWith('/heartbeat') ? 'heartbeat'
      : pathname.endsWith('/finish') ? 'finish'
      : pathname === '/api/files/upload' && init.method === 'POST' ? 'upload' : 'download';
    requests.push({ operation, path: pathname });
    return hooks[operation] ? hooks[operation](url, init) : fetch(url, init);
  };
  let native: any;
  const dependencies = {
    verifySource: (value: any) => {
      expect(value).not.toHaveProperty('token'); expect(value).not.toHaveProperty('tokenFile');
      return verifyTaskSource(value, { requireRootOwned: false });
    },
    loadAdapter: async (value: any) => {
      expect(value).not.toHaveProperty('token'); expect(value).not.toHaveProperty('tokenFile');
      native = await loadTaskAdapter(value, { requireRootOwned: false });
      return native;
    },
    fetchImpl,
  };
  const runProcess = vi.fn((context: any) => {
    expect(context.config).not.toHaveProperty('token');
    expect(context.config).not.toHaveProperty('tokenFile');
    expect(context.config).not.toHaveProperty('url');
    expect(context).not.toHaveProperty('lease_token');
    expect(context.config.isolateStateReads).toBe(true);
    return runCodexProcess(context);
  });
  async function executor(overrides: any = {}) {
    const value = await createZylosExecutor(config, { ...dependencies, runProcess, ...overrides });
    executors.push(value);
    return value;
  }
  async function create(mode = 'success') {
    const response = await api(hub!.baseUrl, 'POST', '/api/tasks', { token: owner.token,
      headers: { 'Idempotency-Key': randomUUID() }, body: {
        title: 'Native Zylos offline integration', description: `fixture:${mode}`, assigned_bot_id: worker.bot.id,
      } });
    expect(response.status).toBe(201);
    return response.body;
  }
  function start(value: any, changes: any = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const promise = runWorker({ ...config, ...changes }, { fetchImpl, executeTask: value.executeTask,
      onRunSettled: value.onRunSettled, signal: controller.signal, logger: (entry: unknown) => logs.push(entry) });
    jobs.push(promise.catch(() => {}));
    return promise;
  }
  return { config, org, owner, worker, requests, hooks, logs, dependencies, runProcess, executor, create, start, native: () => native };
}

describe('genuine Zylos worker through a temporary authenticated Hub', () => {
  it('runs native Core, publishes/downloads owned artifacts and provenance, and leaves final acceptance human-owned', async () => {
    const f = await setup();
    const first = await f.create();
    const next = await f.create();
    const lock = acquireWorkerLock(f.config.stateRoot);
    const executor = await f.executor();
    const nativeCall = vi.spyOn(f.native(), 'runTask');
    const stats = await f.start(executor);
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(stats.lastResult.task).toMatchObject({ id: first.id, status: 'reviewing' });
    expect(nativeCall).toHaveBeenCalledTimes(1);
    expect(f.runProcess).toHaveBeenCalledTimes(1);
    expect(stats.lastResult.run.artifacts).toHaveLength(2);
    const source = verifyTaskSource(f.config, { requireRootOwned: false });
    const cookie = await hub!.loginAsOrg(f.org.org_secret);
    for (const artifact of stats.lastResult.run.artifacts) {
      expect(artifact.url).toMatch(/^https:\/\/agents\.example\.test\/pilot\/api\/files\//u);
      const response = await fetch(`${hub!.baseUrl}${new URL(artifact.url).pathname.replace(/^\/pilot/u, '')}`, {
        headers: { Cookie: `hxa_session=${cookie}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const content = await response.text();
      expect(content).not.toContain(f.worker.token);
      if (artifact.title === 'Run metadata') {
        const audit = JSON.parse(content);
        expect(audit).toMatchObject({
          format: 'hxa-zylos-run-v1', executor: 'zylos-core-task', backend: 'codex', engine: 'codex-exec',
          api: 'zylos-task-v1', task_id: first.id, run_id: stats.lastResult.run.id, attempt: 1,
          core_commit: source.core_commit, patch_sha256: source.patch_sha256, source_manifest_sha256: source.source_manifest_sha256,
          core_version: '0.5.2', extension_version: '0.5.2+hxa.task.1', core_task_api_invoked: true,
          source_root_managed: false, execution: { cleanupComplete: true, pipesClosed: true, exitCode: 0 },
          hub_finish: 'not_yet_confirmed_at_upload',
        });
        for (const key of ['instruction_sha256', 'memory_sha256', 'payload_sha256', 'ledger_key']) expect(audit[key]).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
    const ledger = inspectTaskLedger(f.config.stateRoot);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ task_id: first.id, run_id: stats.lastResult.run.id, status: 'succeeded', cleanup_complete: true, reconciliation_required: false });
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
    const report = reportState(f.config.stateRoot);
    expect(report.runs[0]).toMatchObject({ finish_confirmed: true, status: 'succeeded', unknown_upload_paths: [], possible_orphans: [] });
    expect(report.runs[0].known_file_ids).toHaveLength(2);
    expect(executor.canReleaseLock()).toBe(true);
    lock.release();
    const accepted = await api(hub!.baseUrl, 'POST', `/api/tasks/${first.id}/accept`, { token: f.owner.token,
      body: { expected_revision: stats.lastResult.task.revision } });
    expect(accepted.status).toBe(200); expect(accepted.body.status).toBe('completed');
  });

  it.each(['declared-failure', 'extra-field'])('records %s as failed without any artifact publication', async mode => {
    const f = await setup();
    const task = await f.create(mode);
    const executor = await f.executor();
    const stats = await f.start(executor);
    expect(stats).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(stats.lastResult.task.id).toBe(task.id);
    expect(stats.lastResult.run.artifacts).toEqual([]);
    expect(f.requests.filter(request => request.operation === 'upload')).toHaveLength(0);
    expect(f.runProcess).toHaveBeenCalledTimes(1);
  });

  it('refuses missing native provenance before upload and keeps a durable stop after the failed finish', async () => {
    const f = await setup();
    await f.create(); const next = await f.create();
    acquireWorkerLock(f.config.stateRoot);
    const executor = await f.executor({ loadAdapter: async (config: any) => {
      const runtime = await f.dependencies.loadAdapter(config);
      const original = runtime.runTask.bind(runtime);
      runtime.runTask = async (...args: any[]) => {
        const result = await original(...args);
        return { ...result, zylos: undefined };
      };
      return runtime;
    } });
    await expect(f.start(executor, { once: false })).rejects.toMatchObject({ code: 'RUN_SETTLEMENT_FAILED' });
    expect(f.requests.filter(request => request.operation === 'upload')).toHaveLength(0);
    expect(f.requests.filter(request => request.operation === 'claim')).toHaveLength(1);
    expect(executor.canReleaseLock()).toBe(false);
    expect(reportState(f.config.stateRoot).lock_present).toBe(true);
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
  });

  it.each(['cancel', 'lease-expiry', 'heartbeat-401'])(
    'fences %s, joins the owned process cleanup, and does not touch an unrelated session', async reason => {
      const f = await setup();
      const task = await f.create('ignore-term');
      const next = await f.create();
      acquireWorkerLock(f.config.stateRoot);
      const executor = await f.executor();
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
      sentinels.push(sentinel);
      const result = f.start(executor, { once: false }).catch((error: unknown) => error);
      await until(() => Boolean(findFile(f.config.stateRoot, 'ready.json')));
      if (reason === 'cancel') {
        const current = await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token });
        expect((await api(hub!.baseUrl, 'POST', `/api/tasks/${task.id}/cancel`, { token: f.owner.token,
          body: { expected_revision: current.body.task.revision } })).status).toBe(200);
      } else if (reason === 'lease-expiry') {
        await (hub!.db as any).driver.run('UPDATE platform_task_runs SET lease_expires_at = ? WHERE task_id = ?', [Date.now() - 1, task.id]);
        await hub!.db.tasks.expireLeases();
      } else {
        f.hooks.heartbeat = async () => json({ code: 'AUTH_REQUIRED', message: 'Do not repeat this diagnostic.' }, 401);
      }
      const error = await result;
      expect(error).toMatchObject({ code: reason === 'cancel' ? 'TASK_CANCELLED' : reason === 'lease-expiry' ? 'TASK_LEASE_EXPIRED' : 'AUTH_REQUIRED' });
      expect(f.requests.filter(request => request.operation === 'finish')).toHaveLength(0);
      expect(f.requests.filter(request => request.operation === 'upload')).toHaveLength(0);
      expect(f.requests.filter(request => request.operation === 'claim')).toHaveLength(1);
      const processRecord = JSON.parse(fs.readFileSync(findFile(f.config.stateRoot, 'process.json')!, 'utf8'));
      expect(processRecord).toMatchObject({ state: 'closed', cleanupComplete: true, pipesClosed: true, killSent: true });
      expect(sentinel.exitCode).toBe(null); expect(sentinel.signalCode).toBe(null);
      expect(executor.canReleaseLock()).toBe(false);
      expect(reportState(f.config.stateRoot).lock_present).toBe(true);
      expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
      expect(JSON.stringify(f.logs)).not.toContain(f.worker.token);
    },
  );

  it('does not finish a late artifact result after cancellation, while retaining already-uploaded IDs', async () => {
    const f = await setup();
    const task = await f.create();
    const ready = gate(), release = gate();
    const executor = await f.executor({ upload: async (options: any) => {
      const published = await uploadArtifacts(options);
      ready.resolve(); await release.promise;
      return published;
    } });
    const result = f.start(executor).catch((error: unknown) => error);
    try {
      await ready.promise;
      const current = await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token });
      expect((await api(hub!.baseUrl, 'POST', `/api/tasks/${task.id}/cancel`, { token: f.owner.token,
        body: { expected_revision: current.body.task.revision } })).status).toBe(200);
      await until(() => f.logs.some((entry: any) => entry.event === 'task_stopped'));
    } finally { release.resolve(); }
    expect(await result).toMatchObject({ code: 'TASK_CANCELLED' });
    expect(f.requests.filter(request => request.operation === 'finish')).toHaveLength(0);
    const report = reportState(f.config.stateRoot);
    expect(report.runs[0]).toMatchObject({ finish_confirmed: false, phase: 'unconfirmed' });
    expect(report.runs[0].known_file_ids).toHaveLength(2);
    expect(report.runs[0].possible_orphans).toHaveLength(2);
    expect(executor.canReleaseLock()).toBe(false);
  });

  it('retains an uncertain upload intent and stops before the queued successor', async () => {
    const f = await setup();
    const task = await f.create(); const next = await f.create();
    acquireWorkerLock(f.config.stateRoot);
    f.hooks.upload = async (url, init) => {
      await fetch(url, init);
      throw new TypeError(`Lost upload response ${f.worker.token}`);
    };
    const executor = await f.executor();
    await expect(f.start(executor, { once: false })).rejects.toMatchObject({ code: 'RUN_SETTLEMENT_FAILED' });
    expect(f.requests.filter(request => request.operation === 'upload')).toHaveLength(1);
    expect(f.requests.filter(request => request.operation === 'claim')).toHaveLength(1);
    const report = reportState(f.config.stateRoot);
    expect(report.lock_present).toBe(true);
    expect(report.runs[0]).toMatchObject({ finish_confirmed: true, status: 'failed' });
    expect(report.runs[0].unknown_upload_paths).toEqual(['index.html']);
    expect(executor.canReleaseLock()).toBe(false);
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token })).body.task.status).toBe('failed');
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
    expect(JSON.stringify(f.logs)).not.toContain(f.worker.token);
  });

  it('retains finish uncertainty without replaying execution or starting the successor', async () => {
    const f = await setup();
    const task = await f.create(); const next = await f.create();
    f.hooks.finish = async (url, init) => { await fetch(url, init); throw new TypeError('Offline lost finish response'); };
    const executor = await f.executor();
    await expect(f.start(executor, { once: false })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(f.runProcess).toHaveBeenCalledTimes(1);
    expect(f.requests.filter(request => request.operation === 'claim')).toHaveLength(1);
    expect(f.requests.filter(request => request.operation === 'finish')).toHaveLength(1);
    expect(reportState(f.config.stateRoot).runs[0]).toMatchObject({ finish_confirmed: false, phase: 'unconfirmed' });
    expect(executor.canReleaseLock()).toBe(false);
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token })).body.task.status).toBe('reviewing');
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
  });

  it('rejects replay of an existing native intent after a fresh runtime and fresh platform attempt directory', async () => {
    const f = await setup();
    await f.create();
    const claim = await api(hub!.baseUrl, 'POST', '/api/tasks/claim', { token: f.worker.token, body: { runner_id: f.config.runnerId } });
    expect(claim.status).toBe(200);
    const controller = new AbortController(); controllers.push(controller);
    const context = { task: claim.body.task, run: claim.body.run, signal: controller.signal };
    const first = await f.executor();
    const result = await first.executeTask(context);
    const finish = await api(hub!.baseUrl, 'POST', `/api/tasks/${context.task.id}/runs/${context.run.id}/finish`, {
      token: f.worker.token, body: { lease_token: claim.body.lease_token, ...result },
    });
    expect(finish.status).toBe(200);
    await first.onRunSettled({ ...context, confirmed: true, status: 'succeeded' });
    const uploadCount = f.requests.filter(request => request.operation === 'upload').length;
    const restarted = await f.executor();
    const replay = await restarted.executeTask(context);
    expect(replay).toMatchObject({ status: 'failed', artifacts: [] });
    expect(replay.error).toContain('ZYLOS_TASK_CONFLICT');
    await expect(restarted.onRunSettled({ ...context, confirmed: false, code: 'ZYLOS_TASK_CONFLICT' })).rejects.toBeDefined();
    expect(f.runProcess).toHaveBeenCalledTimes(1);
    expect(f.requests.filter(request => request.operation === 'upload')).toHaveLength(uploadCount);
    expect(restarted.canReleaseLock()).toBe(false);
    expect(inspectTaskLedger(f.config.stateRoot).records).toHaveLength(1);
  });

  it('rejects source/capability mismatch before any claim or engine call', async () => {
    const f = await setup();
    const loader = vi.fn(f.dependencies.loadAdapter);
    await expect(f.executor({ verifySource: async () => ({ api: 'untrusted', patch_sha256: 'private-diagnostic' }), loadAdapter: loader }))
      .rejects.toMatchObject({ code: 'ZYLOS_SOURCE_PROVENANCE_INVALID' });
    expect(loader).not.toHaveBeenCalled();
    await expect(f.executor({ loadAdapter: async (config: any) => {
      const runtime = await f.dependencies.loadAdapter(config);
      runtime.taskCapabilities = () => ({ ...runtime.taskCapabilities, supported: true });
      return runtime;
    } })).rejects.toMatchObject({ code: 'ZYLOS_SOURCE_PROVENANCE_INVALID' });
    expect(f.runProcess).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });
});
