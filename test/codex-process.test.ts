import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCodexProcess, CodexExecutionError } from '../scripts/codex-runner/process.mjs';
import { validateCodexResult, RESULT_SCHEMA } from '../scripts/codex-runner/schema.mjs';

const fixtureModule = fileURLToPath(new URL('./fixtures/codex-process-main.mjs', import.meta.url));
const childModule = fileURLToPath(new URL('./fixtures/codex-process-child.mjs', import.meta.url));
const fixtureSecret = 'raw-model-output-credential-sentinel';
const task = { id: 'task-fixture', title: 'Offline process verification', description: 'fixture:success' };
const run = { id: 'run-fixture' };
let root: string;
let base: any;
let sentinels: ChildProcess[];

function live(pid: number) {
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.readlinkSync(`/proc/${name}/ns/pid`) !== namespace) continue;
      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const ids = status.match(/^NSpid:\s+([\d \t]+)$/m)?.[1].trim().split(/\s+/);
      if (Number(ids?.at(-1)) !== pid) continue;
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch {}
  }
  return false;
}

async function until(predicate: () => boolean, maximum = 3_000) {
  const deadline = performance.now() + maximum;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Offline fixture did not reach its expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function execute(mode = 'success', overrides: Record<string, unknown> = {}) {
  return runCodexProcess({ ...base, task: { ...task, description: `fixture:${mode}` }, ...overrides });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-codex-process-'));
  const dirs: Record<string, string> = {};
  for (const name of ['workspace', 'control', 'logs', 'home', 'codex-home', 'bin']) {
    dirs[name] = path.join(root, name);
    fs.mkdirSync(dirs[name], { mode: 0o700 });
  }
  const codexBin = path.join(dirs.bin, 'offline-codex');
  fs.writeFileSync(codexBin, `#!${process.execPath}\nimport ${JSON.stringify(fixtureModule)};\n`, { mode: 0o700 });
  base = {
    task, run, workspaceDir: dirs.workspace, controlDir: dirs.control, logsDir: dirs.logs,
    config: {
      codexBin, codexHome: dirs['codex-home'], homeDir: dirs.home,
      childPath: '/usr/local/bin:/usr/bin:/bin', model: 'pinned-offline-fixture', reasoningEffort: 'medium',
      profile: 'feedback-demo', timeoutMs: 3_000, termGraceMs: 100,
    },
  };
  sentinels = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const sentinel of sentinels) {
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill('SIGKILL');
  }
  // Failing assertions must not leave only our own offline fixture children alive.
  for (const filename of ['ready.json', 'child-ready.json']) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(base.workspaceDir, filename), 'utf8'));
      if (live(pid)) process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('offline Codex process controller', () => {
  it('uses an argument array, stdin, dedicated cwd, fixed model, strict environment and external schema', async () => {
    const keys = ['HXA_TASK_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'HTTPS_PROXY'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) process.env[key] = key === 'NODE_OPTIONS' ? '--throw-deprecation' : 'credential-sentinel';
    let response;
    try {
      response = await execute('success', { task: { ...task, title: '$(touch should-not-exist) `echo literal`' } });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
    expect(response.result.status).toBe('succeeded');
    expect(response.metadata).toMatchObject({ exitCode: 0, exitSignal: null, cleanupComplete: true, pipesClosed: true });
    const observed = JSON.parse(fs.readFileSync(path.join(base.workspaceDir, 'observed.json'), 'utf8'));
    expect(observed.argv).toEqual([
      '--no-daemon', '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
      '-C', base.workspaceDir, '--model', base.config.model, '-c', 'model_reasoning_effort="medium"',
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '--output-schema', path.join(base.controlDir, 'schema.json'),
      '--output-last-message', path.join(base.controlDir, 'result.json'), '-',
    ]);
    expect(observed.cwd).toBe(base.workspaceDir);
    expect(Object.keys(observed.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']);
    expect(observed.env).toMatchObject({ HOME: base.config.homeDir, CODEX_HOME: base.config.codexHome, TMPDIR: path.join(base.workspaceDir, '.tmp') });
    expect(observed.prompt).toContain('$(touch should-not-exist) `echo literal`');
    expect(fs.existsSync(path.join(base.workspaceDir, 'should-not-exist'))).toBe(false);
    expect(observed.prompt).toContain('ticket-form, ticket-list, status-filter, ticket-detail, status-update');
    expect(observed.schema).toEqual(RESULT_SCHEMA);
    const journal = JSON.parse(fs.readFileSync(path.join(base.controlDir, 'process.json'), 'utf8'));
    expect(journal).toMatchObject({ task_id: task.id, run_id: run.id, state: 'closed', cleanupComplete: true, exitCode: 0 });
    expect(journal.pid).toBe(journal.pgid);
    expect(journal.session).toBe(journal.pid);
    expect(journal.startTime).toMatch(/^\d+$/);
    expect(journal.pidNamespace).toBe(fs.readlinkSync('/proc/self/ns/pid'));
    expect(journal.procPid).toBeGreaterThan(0);
    expect(journal.procPgid).toBe(journal.procPid);
    expect(journal.procSession).toBe(journal.procPid);
  });

  it('does not log raw messages, tool output, arbitrary event type strings or stderr', async () => {
    const { metadata } = await execute('sensitive-output');
    const logs = fs.readdirSync(base.logsDir).map((name: string) => fs.readFileSync(path.join(base.logsDir, name), 'utf8')).join('\n');
    expect(logs).not.toContain(fixtureSecret);
    expect(JSON.stringify(metadata)).not.toContain(fixtureSecret);
    expect(logs).toContain('unknown');
    expect(logs).toContain('rawContentStored');
    expect(metadata.stderrBytes).toBeGreaterThan(0);
  });

  it('returns a declared failed result without inventing model success', async () => {
    const { result, metadata } = await execute('declared-failure');
    expect(result.status).toBe('failed');
    expect(result.checks[0].passed).toBe(false);
    expect(metadata.exitCode).toBe(0);
  });

  it('persists process identity before completion and cancels the verified process group', async () => {
    const controller = new AbortController();
    const execution = execute('wait', { signal: controller.signal });
    const rejection = expect(execution).rejects.toMatchObject({ code: 'CODEX_ABORTED', metadata: { cleanupComplete: true, termSent: true } });
    await until(() => fs.existsSync(path.join(base.workspaceDir, 'ready.json')));
    const journal = JSON.parse(fs.readFileSync(path.join(base.controlDir, 'process.json'), 'utf8'));
    expect(journal.state).toBe('running');
    controller.abort(new Error('parent-secret-must-not-leak'));
    await rejection;
    expect(live(journal.pid)).toBe(false);
    expect(fs.readFileSync(path.join(base.controlDir, 'process.json'), 'utf8')).not.toContain('parent-secret');
  });

  it('terminates its real child if the initial process identity journal cannot be persisted', async () => {
    const original = fs.renameSync;
    let rejected = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!rejected && to === path.join(base.controlDir, 'process.json')) {
        rejected = true;
        throw Object.assign(new Error('private filesystem detail'), { code: 'ENOSPC' });
      }
      return original(from, to);
    });
    await expect(execute('wait')).rejects.toMatchObject({
      code: 'CODEX_JOURNAL_FAILED', metadata: { cleanupComplete: true, pipesClosed: true, termSent: true },
    });
    const journal = JSON.parse(fs.readFileSync(path.join(base.controlDir, 'process.json'), 'utf8'));
    expect(journal.state).toBe('closed');
    expect(live(journal.pid)).toBe(false);
    expect(JSON.stringify(journal)).not.toContain('private filesystem detail');
  });

  it('escalates an ignored TERM without touching an unrelated process', async () => {
    const ready = path.join(root, 'sentinel-ready.json');
    const sentinel = spawn(process.execPath, [childModule, ready], { detached: true, stdio: 'ignore' });
    sentinels.push(sentinel);
    await until(() => fs.existsSync(ready));
    const controller = new AbortController();
    const execution = execute('ignore-term', { signal: controller.signal });
    const rejection = expect(execution).rejects.toMatchObject({
      code: 'CODEX_ABORTED', metadata: { exitCode: null, exitSignal: 'SIGKILL', cleanupComplete: true, termSent: true, killSent: true },
    });
    await until(() => fs.existsSync(path.join(base.workspaceDir, 'ready.json')));
    controller.abort();
    await rejection;
    expect(live(sentinel.pid!)).toBe(true);
  });

  it('times out and drains an uncooperative process', async () => {
    await expect(execute('timeout', { config: { ...base.config, timeoutMs: 200, termGraceMs: 50 } }))
      .rejects.toMatchObject({ code: 'CODEX_TIMEOUT', metadata: { cleanupComplete: true, killSent: true, pipesClosed: true } });
  });

  it('reaps same-group descendants after the leader exits successfully', async () => {
    const { result, metadata } = await execute('descendant');
    const descendant = JSON.parse(fs.readFileSync(path.join(base.workspaceDir, 'child-ready.json'), 'utf8'));
    expect(result.status).toBe('succeeded');
    expect(metadata).toMatchObject({ exitCode: 0, cleanupComplete: true, pipesClosed: true, termSent: true, killSent: true });
    expect(metadata.descendantsObserved).toBeGreaterThan(0);
    expect(live(descendant.pid)).toBe(false);
  });

  it.each([
    ['malformed-jsonl', 'CODEX_STREAM_INVALID'],
    ['truncated-jsonl', 'CODEX_STREAM_INVALID'],
    ['invalid-utf8', 'CODEX_STREAM_INVALID'],
    ['truncated-utf8', 'CODEX_STREAM_INVALID'],
    ['terminal-failed', 'CODEX_TURN_FAILED'],
    ['terminal-tail', 'CODEX_TERMINAL_INVALID'],
    ['no-terminal', 'CODEX_TERMINAL_INVALID'],
    ['invalid-result', 'CODEX_RESULT_INVALID'],
    ['invalid-result-utf8', 'CODEX_RESULT_INVALID'],
    ['extra-field', 'CODEX_RESULT_INVALID'],
    ['failed-check', 'CODEX_RESULT_INVALID'],
    ['no-checks', 'CODEX_RESULT_INVALID'],
    ['blank-summary', 'CODEX_RESULT_INVALID'],
    ['symlink-result', 'CODEX_RESULT_FILE_UNSAFE'],
    ['hardlink-result', 'CODEX_RESULT_FILE_UNSAFE'],
    ['result-cap', 'CODEX_RESULT_LIMIT'],
    ['missing-result', 'CODEX_RESULT_MISSING'],
  ])('rejects %s without accepting the result', async (mode, code) => {
    await expect(execute(mode)).rejects.toMatchObject({ code, metadata: { cleanupComplete: true, pipesClosed: true } });
  });

  it.each([
    ['stdout-cap', 'maxStdoutBytes', 'CODEX_STDOUT_LIMIT'],
    ['stderr-cap', 'maxStderrBytes', 'CODEX_STDERR_LIMIT'],
  ])('bounds %s and safely records only counts', async (mode, key, code) => {
    await expect(execute(mode, { config: { ...base.config, [key]: 200 } }))
      .rejects.toMatchObject({ code, metadata: { cleanupComplete: true } });
    const logs = fs.readdirSync(base.logsDir).map((name: string) => fs.readFileSync(path.join(base.logsDir, name), 'utf8')).join('\n');
    expect(logs).not.toContain(fixtureSecret);
  });

  it('preserves a nonzero OS exit code even with a completed JSON event', async () => {
    await expect(execute('nonzero')).rejects.toMatchObject({
      code: 'CODEX_EXIT_NONZERO', metadata: { exitCode: 7, exitSignal: null, cleanupComplete: true },
    });
  });

  it('preserves an OS termination signal', async () => {
    await expect(execute('signal')).rejects.toMatchObject({
      code: 'CODEX_EXIT_SIGNAL', metadata: { exitCode: null, exitSignal: 'SIGTERM', cleanupComplete: true },
    });
  });

  it('rejects pre-aborted execution without starting a process', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute('success', { signal: controller.signal })).rejects.toMatchObject({ code: 'CODEX_ABORTED', metadata: { pid: null } });
    expect(fs.existsSync(path.join(base.workspaceDir, 'observed.json'))).toBe(false);
  });

  it('reports spawn failures through a safe error', async () => {
    await expect(execute('success', { config: { ...base.config, codexBin: path.join(root, 'missing') } }))
      .rejects.toBeInstanceOf(CodexExecutionError);
  });
});

describe('strict Codex result schema', () => {
  const valid = () => ({ status: 'succeeded', summary: 'Completed', artifacts: [], checks: [{ name: 'test', passed: true, details: '' }] });
  it('bounds item counts, strings and exact nested fields', () => {
    expect(() => validateCodexResult({ ...valid(), artifacts: Array.from({ length: 20 }, (_, i) => ({ path: `a${i}`, title: 'a' })) })).toThrow();
    expect(() => validateCodexResult({ ...valid(), summary: 'x'.repeat(8_001) })).toThrow();
    expect(() => validateCodexResult({ ...valid(), checks: [{ name: 'a', passed: true, details: '', extra: 1 }] })).toThrow();
    expect(() => validateCodexResult({ ...valid(), artifacts: [{ path: '../outside', title: 'a' }] })).toThrow();
    expect(() => validateCodexResult({ ...valid(), artifacts: [{ path: '.tmp/secret', title: 'a' }] })).toThrow();
  });
});
