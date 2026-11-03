import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCodexProcess } from '../scripts/codex-runner/process.mjs';
import { createRunState } from '../scripts/codex-runner/state.mjs';
import { createSandboxProfileName } from '../scripts/codex-runner/sandbox-policy.mjs';
import { loadTaskAdapter } from '../scripts/zylos-runner/provenance.mjs';

const fixtureModule = fileURLToPath(new URL('./fixtures/codex-process-main.mjs', import.meta.url));
let root: string;
let context: any;
let runtime: any;
let controllers: AbortController[];
let pending: Promise<unknown>[];
let sentinels: ChildProcess[];

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise.catch(() => {}));
  return promise;
}

async function until(predicate: () => boolean, maximum = 4000) {
  const deadline = performance.now() + maximum;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('The offline native runtime fixture did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function live(pid: number) {
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      if (fs.readlinkSync(`/proc/${entry}/ns/pid`) !== namespace) continue;
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const ids = status.match(/^NSpid:\s+([\d \t]+)$/mu)?.[1].trim().split(/\s+/u);
      if (Number(ids?.at(-1)) !== pid) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch { /* A disappearing fixture process is already stopped. */ }
  }
  return false;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-process-'));
  controllers = []; pending = []; sentinels = [];
  const stateRoot = path.join(root, 'state-root');
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(root, 'credentials');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir]) fs.mkdirSync(directory, { mode: 0o700 });
  const codexBin = path.join(root, 'offline-codex');
  fs.writeFileSync(codexBin, `#!${process.execPath}\nimport ${JSON.stringify(fixtureModule)};\n`, { mode: 0o700 });
  const state = createRunState(stateRoot, 'native-task', 'native-run');
  const controller = new AbortController(); controllers.push(controller);
  context = {
    task: { id: 'native-task', title: 'Offline native Zylos task', description: 'fixture:success' },
    run: { id: 'native-run', task_id: 'native-task', attempt: 1 },
    workspaceDir: state.workspaceDir, controlDir: state.controlDir, logsDir: state.logsDir,
    signal: controller.signal,
    config: {
      stateRoot, homeDir, codexHome, credentialDir, codexBin, isolateStateReads: true,
      childPath: '/usr/local/bin:/usr/bin:/bin', sandboxProfile: createSandboxProfileName(),
      model: 'offline-native-fixture', reasoningEffort: 'medium', profile: 'files', timeoutMs: 5000, termGraceMs: 100,
    },
  };
  runtime = await loadTaskAdapter(context.config, { requireRootOwned: false });
});

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(pending);
  for (const sentinel of sentinels) {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      const closed = new Promise(resolve => sentinel.once('close', resolve));
      sentinel.kill('SIGKILL');
      await closed;
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('genuine patched Zylos Core with an offline process engine', () => {
  it('uses native instructions in actual stdin, records correlated progress, and never invokes the shared runtime', async () => {
    const forbidden = ['launch', 'sendMessage', 'checkAuth', 'getHeartbeatDeps', 'getContextMonitor']
      .filter(name => typeof runtime[name] === 'function')
      .map(name => vi.spyOn(runtime, name).mockImplementation(() => { throw new Error('Shared runtime access is forbidden.'); }));
    const progress: any[] = [];
    const driver = vi.fn((native: any) => {
      expect(native.config).not.toHaveProperty('token');
      expect(native.config).not.toHaveProperty('tokenFile');
      expect(native).not.toHaveProperty('lease_token');
      return runCodexProcess({ ...native, onProgress: (event: any) => { progress.push(event); return native.onProgress(event); } });
    });
    const result = await track(runtime.runTask(context, { executeCodex: driver }));
    const nativeText = fs.readFileSync(path.join(context.controlDir, 'zylos', 'AGENTS.md'), 'utf8');
    const observed = JSON.parse(fs.readFileSync(path.join(context.workspaceDir, 'observed.json'), 'utf8'));
    expect(observed.prompt.startsWith(`ZYLOS NATIVE TASK INSTRUCTIONS\n${nativeText}\nEND ZYLOS NATIVE TASK INSTRUCTIONS`)).toBe(true);
    expect(observed.prompt).toContain('BEGIN UNTRUSTED TASK JSON');
    expect(observed.argv.join(' ')).toContain(`${JSON.stringify(context.config.stateRoot)}="deny"`);
    expect(Object.keys(observed.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']);
    expect(result.metadata).toMatchObject({ cleanupComplete: true, pipesClosed: true, exitCode: 0, exitSignal: null });
    expect(result.zylos).toMatchObject({ api: 'zylos-task-v1', task_id: 'native-task', run_id: 'native-run', attempt: 1,
      instruction_sha256: createHash('sha256').update(nativeText).digest('hex'), status: 'succeeded' });
    expect(result.ledger).toMatchObject({ format: 'zylos-task-ledger-v1', status: 'succeeded', cleanup_complete: true, reconciliation_required: false });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(progress[0]).toMatchObject({ type: 'started', sequence: 1, execution_id: result.zylos.execution_id });
    expect(progress.length).toBeGreaterThan(1);
    progress.forEach((event, index) => {
      expect(Object.keys(event).sort()).toEqual(['api', 'attempt', 'execution_id', 'run_id', 'sequence', 'task_id', 'type']);
      expect(event).toMatchObject({ sequence: index + 1, api: 'zylos-task-v1', task_id: 'native-task', run_id: 'native-run', attempt: 1 });
      expect(['started', 'progress']).toContain(event.type);
    });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it.each(['identity', 'hash', 'symlink', 'hardlink', 'oversize', 'missing', 'state-policy'])(
    'rejects a native instruction/context defect before any engine prompt: %s', async defect => {
      const result = track(runtime.runTask(context, { executeCodex: async (native: any) => {
        const supplied = { ...native, zylosContext: { ...native.zylosContext }, config: { ...native.config } };
        const instruction = supplied.zylosContext.instruction_path;
        if (defect === 'identity') supplied.zylosContext.run_id = 'different-run';
        if (defect === 'hash') fs.appendFileSync(instruction, '\nChanged after native preparation.');
        if (defect === 'symlink') {
          const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'private-outside-fixture');
          fs.unlinkSync(instruction); fs.symlinkSync(outside, instruction);
        }
        if (defect === 'hardlink') fs.linkSync(instruction, path.join(root, 'instruction-alias'));
        if (defect === 'oversize') fs.writeFileSync(instruction, 'x'.repeat(131_073));
        if (defect === 'missing') fs.unlinkSync(instruction);
        if (defect === 'state-policy') supplied.config.isolateStateReads = false;
        return runCodexProcess(supplied);
      } }));
      await expect(result).rejects.toMatchObject({ code: 'ZYLOS_TASK_ENGINE_FAILED', metadata: {
        cleanupComplete: true, failureCode: 'ZYLOS_EXECUTION_CONTEXT_INVALID',
      } });
      expect(fs.existsSync(path.join(context.workspaceDir, 'observed.json'))).toBe(false);
      expect(fs.existsSync(path.join(context.workspaceDir, 'policy-preview-observed.json'))).toBe(false);
    },
  );

  it('does not let task data select a native override or manufacture driver proof', async () => {
    context.task.zylosContext = { instruction_path: '/must-not-open', instruction_sha256: '0'.repeat(64) };
    context.task.executor = 'zylos-core-task';
    const result = await track(runtime.runTask(context, { executeCodex: runCodexProcess }));
    expect(result.zylos.instruction_sha256).not.toBe('0'.repeat(64));
    expect(result.zylos).not.toHaveProperty('instruction_path');
    const observed = JSON.parse(fs.readFileSync(path.join(context.workspaceDir, 'observed.json'), 'utf8'));
    expect(observed.prompt).not.toContain('/must-not-open');
  });

  it.each(['missing', 'wrong-run'])('rejects %s driver proof even after a successful offline process', async defect => {
    const result = track(runtime.runTask(context, { executeCodex: async (native: any) => {
      const completed = await runCodexProcess(native);
      if (defect === 'missing') delete completed.zylosProof;
      else completed.zylosProof = { ...completed.zylosProof, run_id: 'another-run' };
      return completed;
    } }));
    await expect(result).rejects.toMatchObject({ code: 'ZYLOS_TASK_EXECUTION_PROOF_INVALID',
      metadata: { cleanupComplete: false }, ledger: { reconciliation_required: true } });
  });

  it('stops before sending stdin if the native started callback rejects progress', async () => {
    const result = track(runtime.runTask(context, { executeCodex: (native: any) => runCodexProcess({ ...native, onProgress: () => false }) }));
    await expect(result).rejects.toMatchObject({ code: 'ZYLOS_TASK_ENGINE_FAILED', metadata: { cleanupComplete: true, failureCode: 'ZYLOS_PROGRESS_REJECTED' } });
    expect(fs.existsSync(path.join(context.workspaceDir, 'observed.json'))).toBe(false);
  });

  it.each(['nonzero', 'terminal-failed', 'missing-result', 'failed-check', 'extra-field', 'symlink-result'])(
    'does not promote a process/model failure to native success: %s', async mode => {
      context.task.description = `fixture:${mode}`;
      await expect(track(runtime.runTask(context, { executeCodex: runCodexProcess })))
        .rejects.toMatchObject({ code: 'ZYLOS_TASK_ENGINE_FAILED', metadata: { cleanupComplete: true } });
    },
  );

  it('cancels only the exact native execution and waits for its TERM-resistant process to stop', async () => {
    context.task.description = 'fixture:ignore-term';
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
    sentinels.push(sentinel);
    let identity: any;
    const result = track(runtime.runTask(context, { executeCodex: runCodexProcess, onLifecycle: (event: any) => { identity = event; } }));
    const rejected = result.catch((error: any) => error);
    const ready = path.join(context.workspaceDir, 'ready.json');
    await until(() => fs.existsSync(ready));
    const pid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
    const exact = { task_id: identity.task_id, run_id: identity.run_id, attempt: identity.attempt, execution_id: identity.execution_id };
    await expect(runtime.cancelTask({ ...exact, run_id: 'unrelated-run' })).rejects.toMatchObject({ code: 'ZYLOS_TASK_CANCEL_IDENTITY_INVALID' });
    expect(live(pid)).toBe(true);
    const cancelled = await runtime.cancelTask(exact);
    const error = await rejected;
    expect(error).toMatchObject({ code: 'ZYLOS_TASK_CANCELLED', metadata: { cleanupComplete: true, killSent: true } });
    expect(cancelled).toMatchObject({ requested: true, status: 'cancelled', cleanup_complete: true });
    expect(live(pid)).toBe(false);
    expect(live(sentinel.pid!)).toBe(true);
  });

  it('times out a native task, joins escalation cleanup, and ignores later completion', async () => {
    context.task.description = 'fixture:timeout';
    context.config.timeoutMs = 700;
    await expect(track(runtime.runTask(context, { executeCodex: runCodexProcess })))
      .rejects.toMatchObject({ code: 'ZYLOS_TASK_TIMEOUT', metadata: { cleanupComplete: true } });
    const ready = path.join(context.workspaceDir, 'ready.json');
    if (fs.existsSync(ready)) expect(live(JSON.parse(fs.readFileSync(ready, 'utf8')).pid)).toBe(false);
  });
});
