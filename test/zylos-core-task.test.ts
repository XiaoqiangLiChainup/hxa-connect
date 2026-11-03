import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CodexAdapter } from '../vendor/zylos-core/cli/lib/runtime/codex.js';
import { RuntimeAdapter } from '../vendor/zylos-core/cli/lib/runtime/base.js';
import { inspectTaskLedger } from '../vendor/zylos-core/cli/lib/runtime/task-runtime.js';
import { buildMemorySnapshot } from '../vendor/zylos-core/skills/zylos-memory/scripts/memory-snapshot.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string;
let base: any;
let runtime: any;

function mkdir(parent: string, name: string, mode = 0o700) {
  const directory = path.join(parent, name);
  fs.mkdirSync(directory, { mode });
  return directory;
}

function result(context: any, overrides: Record<string, unknown> = {}) {
  return {
    result: { status: 'succeeded', summary: 'Offline fixture; no model invoked.', artifacts: [],
      checks: [{ name: 'offline check', passed: true, details: 'A fake engine verified the contract.' }] },
    metadata: { cleanupComplete: true, pipesClosed: true, exitCode: 0, exitSignal: null, pid: 12345 },
    zylosProof: { ...context.zylosContext },
    ...overrides,
  };
}

function nextContext(id = 'next', overrides: Record<string, unknown> = {}) {
  const directory = mkdir(base.config.stateRoot, `run-${id}`);
  return { ...base, task: { ...base.task, id: `task-${id}`, title: `Task ${id}` },
    run: { id: `run-${id}`, attempt: 1 }, workspaceDir: mkdir(directory, 'workspace'),
    controlDir: mkdir(directory, 'control'), logsDir: mkdir(directory, 'logs'), ...overrides };
}

async function until(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Offline core fixture did not reach the expected state.');
}

function handle(context: any) {
  const { task_id, run_id, attempt, execution_id } = context.zylosContext;
  return { task_id, run_id, attempt, execution_id };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-core-'));
  const stateRoot = mkdir(root, 'state-root');
  const homeDir = mkdir(root, 'home');
  const codexHome = mkdir(homeDir, 'codex');
  const credentialDir = mkdir(root, 'credentials', 0o550);
  const directory = mkdir(stateRoot, 'run');
  base = {
    task: { id: 'task-one', title: 'Create an offline demonstration', description: 'Only fixture execution is permitted.' },
    run: { id: 'run-one', task_id: 'task-one', attempt: 1 },
    workspaceDir: mkdir(directory, 'workspace'), controlDir: mkdir(directory, 'control'), logsDir: mkdir(directory, 'logs'),
    config: {
      stateRoot, homeDir, codexHome, credentialDir, codexBin: '/usr/bin/offline-codex',
      childPath: '/usr/bin:/bin', model: 'offline-fixture', reasoningEffort: 'medium',
      timeoutMs: 2000, termGraceMs: 10, profile: 'files', isolateStateReads: true,
    },
  };
  runtime = new CodexAdapter({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.chmodSync(base.config.credentialDir, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom Zylos Core task runtime', () => {
  it('keeps unextended runtime task support disabled and exposes the actual Codex extension', async () => {
    class Unsupported extends RuntimeAdapter {}
    const unsupported = new Unsupported({});
    expect(unsupported.taskCapabilities()).toMatchObject({ api: 'zylos-task-v1', supported: false });
    await expect(unsupported.runTask()).rejects.toMatchObject({ code: 'ZYLOS_TASK_UNSUPPORTED' });
    await expect(unsupported.cancelTask()).rejects.toMatchObject({ code: 'ZYLOS_TASK_UNSUPPORTED' });
    expect(runtime.taskCapabilities()).toEqual({
      api: 'zylos-task-v1', supported: true, runtime: 'codex', upstream_version: '0.5.2',
      upstream_commit: '8ee9bd9007edab46f766f3574e0ad56cf69268c2', extension_version: '0.5.2+hxa.task.1',
      isolated_context: true, correlated_result: true, precise_cancellation: true, durable_intent: true, max_concurrency: 1,
    });
  });

  it('executes the real native instruction and memory path with a durable intent before the engine', async () => {
    const lifecycle: any[] = [];
    const executeCodex = vi.fn(async context => {
      const report = inspectTaskLedger(base.config.stateRoot);
      expect(report.records).toHaveLength(1);
      expect(report.records[0]).toMatchObject({ status: 'running', cleanup_complete: false });
      const instruction = fs.readFileSync(context.zylosContext.instruction_path, 'utf8');
      expect(instruction).toContain('Zylos isolated task mode');
      expect(instruction).toContain('Codex task execution');
      expect(instruction).toContain('=== BOT IDENTITY ===');
      expect(instruction).toContain('=== ACTIVE STATE ===');
      expect(instruction).toContain(base.task.title);
      expect(instruction).not.toContain('dangerously-bypass-approvals');
      expect(instruction).not.toContain('sudo access');
      expect(context.zylosContext.instruction_sha256).toBe(digest(instruction));
      const snapshot = buildMemorySnapshot(path.join(base.controlDir, 'zylos', 'memory'), { strict: true });
      expect(context.zylosContext.memory_sha256).toBe(digest(snapshot));
      expect(fs.statSync(context.zylosContext.instruction_path).mode & 0o777).toBe(0o600);
      expect(Object.isFrozen(context.zylosContext)).toBe(true);
      expect(context.onProgress({ api: 'zylos-task-v1', ...handle(context), sequence: 1, type: 'started' })).toBe(true);
      return result(context);
    });
    const output = await runtime.runTask(base, { executeCodex, onLifecycle: (event: any) => { lifecycle.push(event); } });
    expect(output.zylos).toMatchObject({ task_id: 'task-one', run_id: 'run-one', attempt: 1,
      api: 'zylos-task-v1', core_version: '0.5.2+hxa.task.1', status: 'succeeded' });
    expect(output.ledger).toMatchObject({ status: 'succeeded', cleanup_complete: true, reconciliation_required: false });
    expect(lifecycle.map(event => event.type)).toEqual(['prepared', 'running', 'engine_started', 'succeeded']);
    expect(lifecycle.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(Object.isFrozen(output.result)).toBe(true);
    const report = inspectTaskLedger(base.config.stateRoot);
    expect(report.reconciliation_required).toBe(false);
    expect(JSON.stringify(report)).not.toContain(base.task.title);
    expect(JSON.stringify(report)).not.toContain(base.task.description);
  });

  it('does not use shared lifecycle, global roots, auth, credentials, or mutate the environment', async () => {
    const methods = ['launch', 'sendMessage', 'stop', 'isRunning', 'checkAuth', 'getHeartbeatDeps', 'getContextMonitor'];
    const spies = methods.map(name => vi.spyOn(runtime, name).mockImplementation(() => { throw new Error('Forbidden shared lifecycle'); }));
    const auth = path.join(base.config.codexHome, 'auth.json');
    fs.writeFileSync(auth, 'model-auth-sentinel', { mode: 0o600 });
    fs.chmodSync(base.config.credentialDir, 0o700);
    const token = path.join(base.config.credentialDir, 'token');
    fs.writeFileSync(token, 'hub-token-sentinel', { mode: 0o600 });
    fs.chmodSync(base.config.credentialDir, 0o550);
    const opened: string[] = [];
    const originalOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((filename: any, ...args: any[]) => {
      opened.push(String(filename));
      return (originalOpen as any)(filename, ...args);
    }) as any);
    const environment = { ...process.env };
    let observed: any;
    await runtime.runTask({ ...base, lease_token: 'never-pass', config: { ...base.config, token: 'never-pass', tokenFile: token } }, {
      executeCodex: async (context: any) => { observed = context; return result(context); },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(opened).not.toContain(auth);
    expect(opened).not.toContain(token);
    expect(process.env).toEqual(environment);
    expect(observed.lease_token).toBeUndefined();
    expect(observed.config.token).toBeUndefined();
    expect(observed.config.tokenFile).toBeUndefined();
  });

  it('returns exactly the same work promise for duplicate calls before and after completion', async () => {
    let finish: (value: any) => void = () => {};
    let supplied: any;
    const executeCodex = vi.fn(context => { supplied = context; return new Promise(resolve => { finish = resolve; }); });
    const first = runtime.runTask(base, { executeCodex });
    const second = runtime.runTask({ ...base, task: { ...base.task }, run: { ...base.run } }, { executeCodex });
    expect(second).toBe(first);
    await until(() => Boolean(supplied));
    finish(result(supplied));
    await first;
    expect(runtime.runTask(base, { executeCodex })).toBe(first);
    expect(executeCodex).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed payload and concurrent other task without dispatching either', async () => {
    let finish: (value: any) => void = () => {};
    let supplied: any;
    const executeCodex = vi.fn(context => { supplied = context; return new Promise(resolve => { finish = resolve; }); });
    const first = runtime.runTask(base, { executeCodex });
    await until(() => Boolean(supplied));
    await expect(runtime.runTask({ ...base, task: { ...base.task, description: 'Changed task' } }, { executeCodex }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_CONFLICT' });
    await expect(runtime.runTask(nextContext(), { executeCodex })).rejects.toMatchObject({ code: 'ZYLOS_TASK_BUSY' });
    finish(result(supplied));
    await first;
    expect(executeCodex).toHaveBeenCalledTimes(1);
  });

  it('never re-executes an existing durable identity in a restarted runtime', async () => {
    const engine = vi.fn(async context => result(context));
    await runtime.runTask(base, { executeCodex: engine });
    await expect(new CodexAdapter({}).runTask(base, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_RECONCILIATION_REQUIRED', metadata: { cleanupComplete: false } });
    await expect(new CodexAdapter({}).runTask({ ...base, task: { ...base.task, title: 'Changed' } }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_CONFLICT' });
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('isolates two sequential tasks with different native snapshots and private session files', async () => {
    const seen: any[] = [];
    const engine = async (context: any) => {
      seen.push({ context, instructions: fs.readFileSync(context.zylosContext.instruction_path, 'utf8') });
      return result(context);
    };
    const first = await runtime.runTask(base, { executeCodex: engine });
    const next = nextContext('second');
    const second = await runtime.runTask(next, { executeCodex: engine });
    expect(first.zylos.memory_sha256).not.toBe(second.zylos.memory_sha256);
    expect(seen[1].instructions).not.toContain(base.task.title);
    expect(fs.readFileSync(path.join(next.controlDir, 'zylos/memory/sessions/current.md'), 'utf8')).toContain('task-second');
    expect(seen[0].context.workspaceDir).not.toBe(seen[1].context.workspaceDir);
  });

  it('requires exact cancellation identity and joins cleanup before rejecting late success', async () => {
    let observed: any;
    let finish: (value: any) => void = () => {};
    const taskPromise = runtime.runTask(base, { executeCodex: (context: any) => {
      observed = context;
      return new Promise(resolve => { finish = resolve; });
    } });
    const rejected = taskPromise.catch((error: any) => error);
    await until(() => Boolean(observed));
    await expect(runtime.cancelTask({ ...handle(observed), execution_id: randomUUID() }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_CANCEL_IDENTITY_INVALID' });
    expect(observed.signal.aborted).toBe(false);
    let cancellationSettled = false;
    const cancellation = runtime.cancelTask(handle(observed)).then((value: any) => { cancellationSettled = true; return value; });
    expect(observed.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    finish(result(observed));
    expect(await rejected).toMatchObject({ code: 'ZYLOS_TASK_CANCELLED', metadata: { cleanupComplete: true }, zylos: { status: 'cancelled' } });
    expect(await cancellation).toMatchObject({ requested: true, status: 'cancelled', cleanup_complete: true });
    expect(observed.onProgress({ api: 'zylos-task-v1', ...handle(observed), sequence: 1, type: 'started' })).toBe(false);
  });

  it('propagates parent abort without relying on run lease timestamps', async () => {
    const abort = new AbortController();
    let supplied: any;
    const taskPromise = runtime.runTask({ ...base, run: { ...base.run, lease_expires_at: 1 }, signal: abort.signal }, {
      executeCodex: async (context: any) => {
        supplied = context;
        await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
        return result(context);
      },
    });
    const rejected = taskPromise.catch((error: any) => error);
    await until(() => Boolean(supplied));
    expect(supplied.signal.aborted).toBe(false);
    expect(supplied.run.lease_expires_at).toBeUndefined();
    abort.abort();
    expect(await rejected).toMatchObject({ code: 'ZYLOS_TASK_ABORTED', metadata: { cleanupComplete: true } });
  });

  it('enforces deadline and awaits cooperative cleanup', async () => {
    const output = await runtime.runTask({ ...base, config: { ...base.config, timeoutMs: 10 } }, {
      executeCodex: async (context: any) => {
        await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
        await new Promise(resolve => setTimeout(resolve, 5));
        return result(context);
      },
    }).catch((error: any) => error);
    expect(output).toMatchObject({ code: 'ZYLOS_TASK_TIMEOUT', zylos: { status: 'timed_out' }, metadata: { cleanupComplete: true } });
  });

  it('bounds an uncooperative driver, preserves uncertainty, and blocks another task', async () => {
    vi.useFakeTimers();
    const taskPromise = runtime.runTask({ ...base, config: { ...base.config, timeoutMs: 10 } }, {
      executeCodex: () => new Promise(() => {}),
    });
    const rejected = taskPromise.catch((error: any) => error);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await rejected).toMatchObject({ code: 'ZYLOS_TASK_CLEANUP_FAILED', metadata: { cleanupComplete: false },
      ledger: { status: 'unconfirmed', reconciliation_required: true } });
    await expect(runtime.runTask(nextContext(), { executeCodex: async (context: any) => result(context) }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_RECONCILIATION_REQUIRED' });
  });

  it('rejects pre-aborted work before creating a ledger or invoking a driver', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = vi.fn();
    await expect(runtime.runTask({ ...base, signal: controller.signal }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_ABORTED', metadata: { cleanupComplete: true } });
    expect(engine).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(base.config.stateRoot, 'state'))).toBe(false);
  });

  it('accepts only ordered correlated progress, ignores duplicates and late callbacks', async () => {
    let callback: (value: any) => boolean = () => false;
    let started: any;
    await runtime.runTask(base, { executeCodex: async (context: any) => {
      callback = context.onProgress;
      started = { api: 'zylos-task-v1', ...handle(context), sequence: 1, type: 'started' };
      expect(callback(started)).toBe(true);
      expect(callback(started)).toBe(false);
      expect(callback({ ...started, sequence: 2, type: 'progress' })).toBe(true);
      return result(context);
    } });
    expect(callback({ ...started, sequence: 3, type: 'progress' })).toBe(false);
    expect(inspectTaskLedger(base.config.stateRoot).records[0].status).toBe('succeeded');
  });

  it.each(['wrong_identity', 'skipped_sequence', 'terminal_callback'])('fails closed on %s even if the engine ignores the callback error', async mode => {
    const output = await runtime.runTask(base, { executeCodex: async (context: any) => {
      const event = { api: 'zylos-task-v1', ...handle(context), sequence: 1, type: 'started' };
      if (mode === 'wrong_identity') event.run_id = 'another-run';
      if (mode === 'skipped_sequence') event.sequence = 2;
      if (mode === 'terminal_callback') event.type = 'succeeded';
      try { context.onProgress(event); } catch {}
      return result(context);
    } }).catch((error: any) => error);
    expect(output.code).toBe('ZYLOS_TASK_PROGRESS_INVALID');
    expect(output.zylos.status).toBe('failed');
  });

  it.each(['missing_proof', 'wrong_execution', 'extra_proof', 'bad_cleanup', 'open_pipes', 'nonzero_exit', 'bad_result'])
    ('does not accept %s as a terminal success', async mode => {
      const output = await runtime.runTask(base, { executeCodex: async (context: any) => {
        const value: any = result(context);
        if (mode === 'missing_proof') delete value.zylosProof;
        if (mode === 'wrong_execution') value.zylosProof.execution_id = randomUUID();
        if (mode === 'extra_proof') value.zylosProof.extra = true;
        if (mode === 'bad_cleanup') value.metadata.cleanupComplete = false;
        if (mode === 'open_pipes') value.metadata.pipesClosed = false;
        if (mode === 'nonzero_exit') value.metadata.exitCode = 1;
        if (mode === 'bad_result') value.result.checks[0].passed = false;
        return value;
      } }).catch((error: any) => error);
      expect(output.code).toMatch(/^ZYLOS_TASK_(EXECUTION_PROOF_INVALID|CLEANUP_FAILED|RESULT_INVALID)$/);
      expect(output.zylos.status).not.toBe('succeeded');
    });

  it('retains model-declared failure as a validated failed result with cleanup evidence', async () => {
    const output = await runtime.runTask(base, { executeCodex: async (context: any) => {
      const value = result(context);
      value.result.status = 'failed';
      value.result.summary = 'The fixture could not complete the requested action.';
      value.result.checks[0].passed = false;
      return value;
    } });
    expect(output.result.status).toBe('failed');
    expect(output.ledger).toMatchObject({ status: 'failed', cleanup_complete: true, reconciliation_required: false });
  });

  it('does not persist or expose arbitrary driver diagnostics in a task error or journal', async () => {
    const sentinel = 'raw-auth-or-model-stderr-sentinel';
    const output = await runtime.runTask(base, { executeCodex: async () => {
      const error: any = new Error(sentinel);
      error.code = 'CODEX_FIXTURE_FAILURE';
      error.metadata = { cleanupComplete: true, pipesClosed: true, exitCode: 1, exitSignal: null,
        stderr: sentinel, prompt: sentinel, startTime: sentinel, lastEventType: sentinel, signal: sentinel };
      throw error;
    } }).catch((error: any) => error);
    expect(output.code).toBe('ZYLOS_TASK_ENGINE_FAILED');
    expect(output.message).not.toContain(sentinel);
    expect(JSON.stringify(output)).not.toContain(sentinel);
    const directory = path.join(base.config.stateRoot, 'state', 'zylos-tasks', output.ledger.key);
    expect(fs.readFileSync(path.join(directory, 'status.json'), 'utf8')).not.toContain(sentinel);
  });

  it.each([0, -1, 1.5, '1', undefined])('rejects invalid attempt %s without dispatch', async attempt => {
    const engine = vi.fn();
    await expect(runtime.runTask({ ...base, run: { ...base.run, attempt } }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_INPUT_INVALID' });
    expect(engine).not.toHaveBeenCalled();
  });

  it('rejects mismatched task binding, excessive timeout, and unsafe paths', async () => {
    const engine = vi.fn();
    await expect(runtime.runTask({ ...base, run: { ...base.run, task_id: 'wrong-task' } }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_INPUT_INVALID' });
    await expect(runtime.runTask({ ...base, config: { ...base.config, timeoutMs: 1_800_001 } }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_CONFIG_INVALID' });
    fs.chmodSync(base.workspaceDir, 0o755);
    await expect(runtime.runTask(base, { executeCodex: engine })).rejects.toMatchObject({ code: 'ZYLOS_TASK_PATH_INVALID' });
    fs.chmodSync(base.workspaceDir, 0o700);
    const linked = path.join(path.dirname(base.workspaceDir), 'linked');
    fs.symlinkSync(base.workspaceDir, linked);
    await expect(runtime.runTask({ ...base, workspaceDir: linked }, { executeCodex: engine }))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_PATH_INVALID' });
    expect(engine).not.toHaveBeenCalled();
  });

  it('blocks when exclusive intent cannot be durably flushed, before any engine invocation', async () => {
    const original = fs.fsyncSync;
    let failed = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const filename = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (!failed && filename.endsWith('/intent.json')) { failed = true; throw new Error('private IO failure'); }
      return original(fd);
    });
    const engine = vi.fn();
    const output = await runtime.runTask(base, { executeCodex: engine }).catch((error: any) => error);
    expect(output.code).toBe('ZYLOS_TASK_STORAGE_FAILED');
    expect(output.ledger.reconciliation_required).toBe(true);
    expect(engine).not.toHaveBeenCalled();
  });

  it('reports partial/corrupt ledgers conservatively without reading unrelated files', async () => {
    await runtime.runTask(base, { executeCodex: async (context: any) => result(context) });
    const report = inspectTaskLedger(base.config.stateRoot);
    const directory = path.join(base.config.stateRoot, 'state/zylos-tasks', report.records[0].key);
    fs.writeFileSync(path.join(directory, 'status.json'), '{invalid raw secret', { mode: 0o600 });
    const snapshot = inspectTaskLedger(base.config.stateRoot);
    expect(snapshot).toMatchObject({ reconciliation_required: true, records: [{ status: 'unverified', cleanup_complete: false }] });
    expect(JSON.stringify(snapshot)).not.toContain('raw secret');
    fs.unlinkSync(path.join(directory, 'status.json'));
    fs.symlinkSync(path.join(base.config.codexHome, 'auth.json'), path.join(directory, 'status.json'));
    expect(inspectTaskLedger(base.config.stateRoot).records[0].status).toBe('unverified');
  });

  it('preserves interactive memory formatting while task snapshots reject links and oversized files', () => {
    const memory = mkdir(root, 'memory-fixture');
    fs.writeFileSync(path.join(memory, 'identity.md'), '  identity  \n', { mode: 0o600 });
    fs.writeFileSync(path.join(memory, 'state.md'), ' ', { mode: 0o600 });
    expect(buildMemorySnapshot(memory)).toBe('=== BOT IDENTITY ===\nidentity\n\n=== ACTIVE STATE ===\n(empty)\n\n=== REFERENCES ===\n(missing)\n');
    fs.symlinkSync(path.join(memory, 'identity.md'), path.join(memory, 'references.md'));
    expect(() => buildMemorySnapshot(memory, { strict: true })).toThrow();
    fs.unlinkSync(path.join(memory, 'references.md'));
    fs.writeFileSync(path.join(memory, 'references.md'), 'r'.repeat(2049), { mode: 0o600 });
    expect(() => buildMemorySnapshot(memory, { strict: true })).toThrow();
  });
});
