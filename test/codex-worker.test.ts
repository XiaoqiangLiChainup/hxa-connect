import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { runWorker, RunnerError } from '../scripts/task-runner/worker.mjs';
import { createCodexExecutor } from '../scripts/codex-runner/adapter.mjs';
import { acquireWorkerLock, createRunState, reportState } from '../scripts/codex-runner/state.mjs';
import { LIMITS, parseCodexArguments, preflight, readCodexConfiguration, readHubToken } from '../scripts/codex-runner/config.mjs';
import { main } from '../scripts/codex-worker.mjs';

const HTML = `<!doctype html><html><head><title>Offline fixture</title></head><body>
<form data-testid="ticket-form"><input name="subject"><button>Add</button></form>
<select data-testid="status-filter"><option>All</option></select>
<ul data-testid="ticket-list"></ul><section data-testid="ticket-detail"></section>
<select data-testid="status-update"><option>Open</option><option>Closed</option></select>
<script>const tickets=JSON.parse(localStorage.getItem('offline-tickets')||'[]');
document.querySelector('form').onsubmit=e=>{e.preventDefault();tickets.push({subject:e.target.subject.value});localStorage.setItem('offline-tickets',JSON.stringify(tickets));};</script>
</body></html>`;
const RESULT = { status: 'succeeded', summary: 'Offline fixture only; no model invoked.',
  artifacts: [{ path: 'index.html', title: 'Demo' }, { path: 'README.md', title: 'Instructions' }],
  checks: [{ name: 'fixture', passed: true, details: 'Static offline transport fixture; UI is not accepted.' }] };
let temporary: string;
let hub: TestEnv | undefined;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-codex-worker-test-')); fs.chmodSync(temporary, 0o700); });
afterEach(async () => { await hub?.cleanup(); hub = undefined; fs.rmSync(temporary, { recursive: true, force: true }); });

function envConfig() {
  return {
    HXA_TASK_URL: 'http://127.0.0.1:4801', HXA_TASK_TOKEN_FILE: '/run/credentials/hxa-test/hub-token',
    HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test/pilot',
    HXA_RUNNER_ID: 'pilot-real-worker', HXA_CODEX_STATE_DIR: temporary,
    HXA_CODEX_BIN: '/opt/hxa-codex-worker/codex/bin/codex',
    HXA_CODEX_HOME_DIR: '/var/lib/hxa-codex-worker', CODEX_HOME: '/var/lib/hxa-codex-worker/codex',
    HXA_CODEX_MODEL: 'approved-model-fixture', HXA_CODEX_REASONING_EFFORT: 'medium',
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  hub = await createTestEnv();
  const org = await hub.createOrg();
  const owner = await hub.registerBot(org.org_secret, 'owner');
  const worker = await hub.registerBot(org.org_secret, 'dedicated-worker');
  const config = { ...readCodexConfiguration(envConfig()), url: hub.baseUrl, token: worker.token,
    once: true, heartbeatMs: 30, requestTimeoutMs: 1000, uploadTimeoutMs: 1000,
    pollMs: 10, minFreeBytes: 0, timeoutMs: 5000, maxRetries: 0 };
  async function create() {
    const response = await api(hub!.baseUrl, 'POST', '/api/tasks', { token: owner.token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { title: 'Offline demo fixture', description: 'Test transport; no model.', assigned_bot_id: worker.bot.id } });
    expect(response.status).toBe(201);
    return response.body;
  }
  return { config, org, owner, worker, create };
}

async function successfulFixture({ workspaceDir, config }: any) {
  expect(config).not.toHaveProperty('token');
  expect(config).not.toHaveProperty('tokenFile');
  expect(config).not.toHaveProperty('url');
  fs.writeFileSync(path.join(workspaceDir, 'index.html'), HTML);
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Offline Demo\nOpen index.html in a browser.\n');
  return { result: structuredClone(RESULT), metadata: { exitCode: 0, exitSignal: null, cleanupComplete: true } };
}

describe('real worker configuration and private state', () => {
  it('requires explicit execution, independent paths, a model pin, HTTPS downloads, and a file credential', () => {
    expect(() => parseCodexArguments([])).toThrow('Choose --codex');
    expect(() => parseCodexArguments(['--codex', '--check'])).toThrow();
    expect(parseCodexArguments(['--codex', '--once'])).toEqual({ mode: 'codex', once: true });
    expect(parseCodexArguments(['--report'])).toEqual({ mode: 'report', once: false });
    expect(() => readCodexConfiguration({ ...envConfig(), HXA_TASK_TOKEN: 'do-not-inherit' })).toThrow('TOKEN_FILE');
    expect(() => readCodexConfiguration({ ...envConfig(), HXA_TASK_URL: 'http://10.0.0.1:4801' })).toThrow('HTTPS');
    expect(() => readCodexConfiguration({ ...envConfig(), HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://user:secret@example.test' })).toThrow();
    expect(() => readCodexConfiguration({ ...envConfig(), HXA_CODEX_MODEL: '' })).toThrow('pin');
    expect(() => readCodexConfiguration({ ...envConfig(), CODEX_HOME: '/root/.codex' })).toThrow('dedicated');
    expect(() => readCodexConfiguration({ ...envConfig(), HXA_TASK_TOKEN_FILE: `${temporary}/token` })).toThrow('outside');
    const config = readCodexConfiguration(envConfig());
    expect(config).toMatchObject({ ...LIMITS, maxArtifacts: 19, profile: 'feedback-demo' });
    expect(config).not.toHaveProperty('token');
  });

  it('rejects root and never runs a failed-provenance executable during preflight', async () => {
    const execute = vi.fn();
    const result = await preflight(readCodexConfiguration(envConfig()), { uid: 0, execute });
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({ name: 'linux_non_root_user', passed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a replaceable launcher symlink even when its target is root-managed', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-replaceable-launcher-'));
    try {
      const launcher = path.join(binDir, 'codex');
      fs.symlinkSync('/usr/bin/true', launcher);
      const config = readCodexConfiguration({ ...envConfig(), HXA_CODEX_BIN: launcher });
      const execute = vi.fn();
      const result = await preflight(config, { execute });
      expect(result.checks).toContainEqual({ name: 'trusted_codex_executable', passed: false });
      expect(execute).not.toHaveBeenCalled();
    } finally { fs.rmSync(binDir, { recursive: true, force: true }); }
  });

  it('pins validated executable and PATH targets before any invocation', async () => {
    const config = readCodexConfiguration({ ...envConfig(), HXA_CODEX_BIN: '/bin/true', HXA_CODEX_CHILD_PATH: '/bin:/usr/bin' });
    const execute = vi.fn();
    const report = await preflight(config, { uid: 0, execute });
    expect(report.checks).toContainEqual({ name: 'trusted_codex_executable', passed: true });
    expect(config.codexBin).toBe(fs.realpathSync('/bin/true'));
    expect(config.childPath).toBe([...new Set(['/bin', '/usr/bin'].map(item => fs.realpathSync(item)))].join(':'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads only bounded private ordinary credential files and rejects links and world-readable files', () => {
    const token = path.join(temporary, 'token');
    fs.writeFileSync(token, 'test-bearer\n', { mode: 0o600 });
    expect(readHubToken(token)).toBe('test-bearer');
    fs.chmodSync(token, 0o644);
    expect(() => readHubToken(token)).toThrow();
    fs.chmodSync(token, 0o600);
    fs.symlinkSync(token, path.join(temporary, 'linked'));
    expect(() => readHubToken(path.join(temporary, 'linked'))).toThrow();
    fs.writeFileSync(token, 'bad token');
    expect(() => readHubToken(token)).toThrow('one bearer');
  });

  it('holds one worker lock, keeps unknown stale locks, and gives every run a private unpredictable directory', () => {
    const lock = acquireWorkerLock(temporary);
    expect(() => acquireWorkerLock(temporary)).toThrow('lock exists');
    const first = createRunState(temporary, 'task-1', 'run-1');
    const second = createRunState(temporary, 'task-1', 'run-2');
    expect(first.workspaceDir).not.toBe(second.workspaceDir);
    expect(fs.statSync(first.workspaceDir).mode & 0o777).toBe(0o700);
    expect(() => createRunState(temporary, '../outside', 'run-3')).toThrow('unsafe');
    expect(reportState(temporary).lock_present).toBe(true);
    lock.release();
    expect(reportState(temporary).lock_present).toBe(false);
    const dir = path.join(temporary, 'state', 'worker.lock');
    fs.mkdirSync(dir);
    expect(() => acquireWorkerLock(temporary)).toThrow('lock exists');
  });
});

describe('offline real-adapter integration with a temporary Hub', () => {
  it('publishes, downloads and journals two files plus audit metadata; a second task stays queued and acceptance stays human-owned', async () => {
    const f = await setup();
    const first = await f.create();
    const second = await f.create();
    const started = gate();
    const release = gate();
    const runProcess = vi.fn(async context => { started.resolve(); await release.promise; return successfulFixture(context); });
    const executor = createCodexExecutor(f.config, { runProcess });
    const promise = runWorker(f.config, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, logger: () => {} });
    await started.promise;
    const waiting = await api(hub!.baseUrl, 'GET', `/api/tasks/${second.id}`, { token: f.owner.token });
    expect(waiting.body.task.status).toBe('queued');
    release.resolve();
    const stats = await promise;
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(stats.lastResult.task).toMatchObject({ id: first.id, status: 'reviewing' });
    expect(stats.lastResult.run.artifacts).toHaveLength(3);
    expect(runProcess).toHaveBeenCalledTimes(1);
    const cookie = await hub!.loginAsOrg(f.org.org_secret);
    for (const artifact of stats.lastResult.run.artifacts) {
      expect(artifact.url).toMatch(/^https:\/\/agents\.example\.test\/pilot\/api\/files\//);
      expect(artifact.url).not.toContain(f.worker.token);
      const filePath = new URL(artifact.url).pathname.replace(/^\/pilot/, '');
      const response = await fetch(`${hub!.baseUrl}${filePath}`, { headers: { Cookie: `hxa_session=${cookie}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const content = await response.text();
      expect(content).not.toContain(f.worker.token);
      if (artifact.title === 'Demo') expect(content).toBe(HTML);
      if (artifact.title === 'Run metadata') expect(JSON.parse(content)).toMatchObject({ execution: { exitCode: 0 }, hub_finish: 'not_yet_confirmed_at_upload' });
    }
    const report = reportState(temporary);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ finish_confirmed: true, status: 'succeeded', possible_orphans: [], unknown_upload_paths: [] });
    expect(report.runs[0].known_file_ids).toHaveLength(3);
    const accepted = await api(hub!.baseUrl, 'POST', `/api/tasks/${first.id}/accept`, { token: f.owner.token, body: { expected_revision: stats.lastResult.task.revision } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('completed');
    expect(executor.canReleaseLock()).toBe(true);
  });

  it.each(['CODEX_EXIT_NONZERO', 'CODEX_TRUNCATED_STREAM', 'CODEX_MISSING_RESULT'])(
    'records %s as a failed run without artifacts or replay', async code => {
      const f = await setup();
      const task = await f.create();
      const runProcess = vi.fn(async () => { throw Object.assign(new RunnerError('Offline failure fixture.', { code }), { metadata: { exitCode: 9, cleanupComplete: true } }); });
      const executor = createCodexExecutor(f.config, { runProcess });
      const stats = await runWorker(f.config, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, logger: () => {} });
      expect(stats).toMatchObject({ failed: 1, claimed: 1 });
      expect(stats.lastResult.task).toMatchObject({ id: task.id, status: 'failed' });
      expect(stats.lastResult.run.artifacts).toEqual([]);
      expect(stats.lastResult.run.error).toContain(code);
      expect(runProcess).toHaveBeenCalledTimes(1);
      expect(reportState(temporary).runs[0]).toMatchObject({ finish_confirmed: true, status: 'failed', code });
    },
  );

  it('joins adapter cleanup after Hub cancellation and does not publish a late result', async () => {
    const f = await setup();
    const task = await f.create();
    const started = gate();
    let cleaned = false;
    const runProcess = vi.fn(async ({ signal }: any) => {
      started.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 40));
      cleaned = true;
      throw Object.assign(new RunnerError('Stopped fixture.', { code: 'CODEX_ABORTED' }), { metadata: { exitCode: null, exitSignal: 'SIGTERM', cleanupComplete: true } });
    });
    const executor = createCodexExecutor(f.config, { runProcess });
    const stopped = runWorker(f.config, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, logger: () => {} }).catch(error => error);
    await started.promise;
    const current = await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token });
    const cancel = await api(hub!.baseUrl, 'POST', `/api/tasks/${task.id}/cancel`, { token: f.owner.token, body: { expected_revision: current.body.task.revision } });
    expect(cancel.status).toBe(200);
    expect(await stopped).toMatchObject({ code: 'TASK_CANCELLED' });
    expect(cleaned).toBe(true);
    const record = reportState(temporary).runs[0];
    expect(record).toMatchObject({ phase: 'unconfirmed', finish_confirmed: false, code: 'TASK_CANCELLED', known_file_ids: [] });
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(executor.canReleaseLock()).toBe(false);
  });

  it('retains uploaded file IDs when finish is uncertain and does not run the queued successor', async () => {
    const f = await setup();
    await f.create();
    const next = await f.create();
    const runProcess = vi.fn(successfulFixture);
    const executor = createCodexExecutor(f.config, { runProcess });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/finish')) throw new TypeError('Simulated connection loss');
      return fetch(url, init);
    });
    await expect(runWorker({ ...f.config, once: false }, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, fetchImpl, logger: () => {} })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(runProcess).toHaveBeenCalledTimes(1);
    const report = reportState(temporary).runs[0];
    expect(report.finish_confirmed).toBe(false);
    expect(report.possible_orphans).toHaveLength(3);
    expect(executor.canReleaseLock()).toBe(false);
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${next.id}`, { token: f.owner.token })).body.task.status).toBe('queued');
  });

  it('fails an uncertain upload once, retaining its intent without claiming successful publication', async () => {
    const f = await setup();
    const task = await f.create();
    const uploadFetch = vi.fn(async () => { throw new TypeError('Unknown upload outcome'); });
    const executor = createCodexExecutor(f.config, { runProcess: successfulFixture, fetchImpl: uploadFetch });
    await expect(runWorker(f.config, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, logger: () => {} })).rejects.toMatchObject({ code: 'RUN_SETTLEMENT_FAILED' });
    const detail = await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token });
    expect(detail.body.task.status).toBe('failed');
    expect(detail.body.runs[0].error).toContain('ARTIFACT_UPLOAD_UNKNOWN');
    expect(detail.body.runs[0].artifacts).toEqual([]);
    expect(uploadFetch).toHaveBeenCalledTimes(1);
    expect(reportState(temporary).runs[0].unknown_upload_paths).toEqual(['index.html']);
    expect(executor.canReleaseLock()).toBe(false);
  });

  it.each(['deadline', 'invalid-response'])('keeps the reconciliation interlock for an unknown upload after %s', async mode => {
    const f = await setup();
    const task = await f.create();
    const config = { ...f.config, timeoutMs: mode === 'deadline' ? 1000 : 5000 };
    const uploadFetch = vi.fn(async () => mode === 'deadline' ? new Promise<Response>(() => {})
      : new Response(JSON.stringify({ id: 'not-a-file-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const executor = createCodexExecutor(config, { runProcess: successfulFixture, fetchImpl: uploadFetch });
    await expect(runWorker(config, { executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, logger: () => {} })).rejects.toMatchObject({ code: 'RUN_SETTLEMENT_FAILED' });
    const record = reportState(temporary).runs[0];
    expect(record).toMatchObject({ finish_confirmed: true, status: 'failed', unknown_upload_paths: ['index.html'] });
    expect(record.code).toBe(mode === 'deadline' ? 'TASK_TIMEOUT' : 'ARTIFACT_UPLOAD_RESPONSE');
    expect(executor.canReleaseLock()).toBe(false);
    expect(uploadFetch).toHaveBeenCalledTimes(1);
    expect((await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token })).body.task.status).toBe('failed');
  });

  it('keeps unconfirmed finish evidence when a shutdown races with the finish request', async () => {
    const f = await setup();
    await f.create();
    const controller = new AbortController();
    const executor = createCodexExecutor(f.config, { runProcess: successfulFixture });
    const fetchImpl = async (url: string, init: RequestInit) => {
      if (url.endsWith('/finish')) { controller.abort(); throw new TypeError('Lost during shutdown'); }
      return fetch(url, init);
    };
    const result = await runWorker(f.config, { signal: controller.signal, executeTask: executor.executeTask,
      onRunSettled: executor.onRunSettled, fetchImpl, logger: () => {} });
    expect(result.stopped).toBe(true);
    expect(executor.canReleaseLock()).toBe(false);
    expect(reportState(temporary).runs[0]).toMatchObject({ finish_confirmed: false, possible_orphans: expect.any(Array) });
    expect(reportState(temporary).runs[0].possible_orphans).toHaveLength(3);
  });

  it('CLI retains its lock when SIGTERM arrives after the Hub claims work but before the response reaches the runner', async () => {
    const f = await setup();
    const task = await f.create();
    const stateRoot = path.join(temporary, 'cli-state');
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const tokenFile = path.join(temporary, 'cli-token');
    fs.writeFileSync(tokenFile, `${f.worker.token}\n`, { mode: 0o600 });
    const originalFetch = globalThis.fetch;
    let claims = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith('/api/tasks/claim')) {
        claims++;
        await response.json(); // The temporary Hub has persisted a running lease.
        process.emit('SIGTERM');
        throw new TypeError('Claim response was lost during shutdown');
      }
      return response;
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await main(['--codex', '--once'], { ...envConfig(), HXA_TASK_URL: hub!.baseUrl,
        HXA_CODEX_STATE_DIR: stateRoot, HXA_TASK_TOKEN_FILE: tokenFile },
      { checkEnvironment: async () => ({ ready: true, checks: [] }) });
      expect(result).toBe(143);
      expect(claims).toBe(1);
      expect(reportState(stateRoot)).toEqual({ lock_present: true, runs: [] });
    } finally { spy.mockRestore(); output.mockRestore(); }
    const detail = await api(hub!.baseUrl, 'GET', `/api/tasks/${task.id}`, { token: f.owner.token });
    expect(detail.body.task.status).toBe('running');
    expect(detail.body.runs).toHaveLength(1);
    expect(detail.body.runs[0].status).toBe('running');
  });
});
