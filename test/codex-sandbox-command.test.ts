import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSandboxCommand } from '../scripts/codex-runner/sandbox-command.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sandbox-command-main.mjs', import.meta.url));
let directory: string;
let sentinels: ChildProcess[];
let base: any;

function nativePid(pid: number) {
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.readlinkSync(`/proc/${name}/ns/pid`) !== namespace) continue;
      const ids = fs.readFileSync(`/proc/${name}/status`, 'utf8').match(/^NSpid:\s+([\d \t]+)$/m)?.[1].trim().split(/\s+/);
      if (Number(ids?.at(-1)) === pid) return Number(name);
    } catch {}
  }
  return null;
}

function live(pid: number) {
  const native = nativePid(pid);
  if (!native) return false;
  try {
    const stat = fs.readFileSync(`/proc/${native}/stat`, 'utf8');
    return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch { return false; }
}

async function until(predicate: () => boolean) {
  const end = performance.now() + 3_000;
  while (!predicate()) {
    if (performance.now() > end) throw new Error('Offline sandbox fixture did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function execute(mode: string, extra: Record<string, unknown> = {}) {
  return runSandboxCommand({ ...base, args: [fixture, mode], ...extra });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-sandbox-command-'));
  sentinels = [];
  base = {
    executable: process.execPath, cwd: directory,
    env: { PATH: '/usr/bin:/bin', HOME: directory, CODEX_HOME: path.join(directory, 'codex'), LANG: 'C.UTF-8' },
    timeoutMs: 2_000, termGraceMs: 60,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of sentinels) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const name of ['ready.json', 'child-ready.json']) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (live(pid)) process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('bounded offline sandbox command', () => {
  it('uses literal args, cwd and only the explicitly supplied environment', async () => {
    const old = process.env.HXA_TEST_PROBE_SECRET;
    process.env.HXA_TEST_PROBE_SECRET = 'parent-only-private-value';
    let response;
    try {
      response = await execute('success', { args: [fixture, 'success', '$(touch escaped)', '`echo literal`'] });
    } finally {
      if (old === undefined) delete process.env.HXA_TEST_PROBE_SECRET;
      else process.env.HXA_TEST_PROBE_SECRET = old;
    }
    expect(response).toMatchObject({ code: null, exitCode: 0, exitSignal: null, cleanupComplete: true, stderr: '' });
    expect(JSON.parse(response.stdout)).toEqual({ args: ['$(touch escaped)', '`echo literal`'], cwd: directory, env: base.env });
    expect(fs.existsSync(path.join(directory, 'escaped'))).toBe(false);
  });

  it('preserves a nonzero OS status without exposing diagnostics in an error message', async () => {
    const result = await execute('nonzero');
    expect(result).toMatchObject({ code: null, exitCode: 7, exitSignal: null, stderr: 'fixture-private-diagnostic', cleanupComplete: true });
    expect(result).not.toHaveProperty('message');
  });

  it('preserves an operating-system termination signal', async () => {
    expect(await execute('signal')).toMatchObject({ code: null, exitCode: null, exitSignal: 'SIGTERM', cleanupComplete: true });
  });

  it('cancels a running command and ignores the abort reason', async () => {
    const controller = new AbortController();
    const pending = execute('wait', { signal: controller.signal });
    await until(() => fs.existsSync(path.join(directory, 'ready.json')));
    controller.abort(new Error('private-abort-reason'));
    const result = await pending;
    expect(result).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', cleanupComplete: true });
    expect(JSON.stringify(result)).not.toContain('private-abort-reason');
  });

  it('does not spawn a pre-aborted command', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await execute('wait', { signal: controller.signal })).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', cleanupComplete: true, exitCode: null });
    expect(fs.existsSync(path.join(directory, 'ready.json'))).toBe(false);
  });

  it.each(['descendant', 'detached-descendant'])('times out and kills an ignored-TERM %s without touching a sentinel', async mode => {
    const sentinelFile = path.join(directory, 'sentinel.json');
    const sentinel = spawn(process.execPath, [fixture, 'child', sentinelFile], { detached: true, stdio: 'ignore' });
    sentinels.push(sentinel);
    await until(() => fs.existsSync(sentinelFile));
    const result = await execute(mode, { timeoutMs: 350 });
    expect(result).toMatchObject({ code: 'SANDBOX_PROBE_TIMEOUT', cleanupComplete: true, exitSignal: 'SIGKILL' });
    const child = JSON.parse(fs.readFileSync(path.join(directory, 'child-ready.json'), 'utf8'));
    expect(live(child.pid)).toBe(false);
    expect(live(sentinel.pid!)).toBe(true);
  });

  it('cleans an observed new-session child even after its leader exits', async () => {
    const result = await execute('exit-with-descendant');
    expect(result).toMatchObject({ code: null, cleanupComplete: true, exitCode: 0 });
    const child = JSON.parse(fs.readFileSync(path.join(directory, 'child-ready.json'), 'utf8'));
    expect(live(child.pid)).toBe(false);
  });

  it('uses the outer NSpid coordinate for a real child in a simulated nested /proc view', async () => {
    const controller = new AbortController();
    const pending = execute('gated-descendant', { signal: controller.signal });
    await until(() => fs.existsSync(path.join(directory, 'ready.json')));
    const parent = JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8'));
    const parentNative = nativePid(parent.pid);
    expect(parentNative).not.toBeNull();
    const readFile = fs.readFileSync.bind(fs);
    const readlink = fs.readlinkSync.bind(fs);
    const kill = process.kill.bind(process);
    const childOfFixture = (filename: unknown) => {
      const match = /^\/proc\/(\d+)\/(?:status|ns\/pid)$/.exec(String(filename));
      if (!match) return false;
      try {
        const text = readFile(`/proc/${match[1]}/stat`, 'utf8');
        return Number(text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[1]) === parentNative;
      } catch { return false; }
    };
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename: any, options: any) => {
      const value = readFile(filename, options);
      if (String(filename).endsWith('/status') && typeof value === 'string' && childOfFixture(filename)) {
        return value.replace(/^(NSpid|NSpgid|NSsid):([0-9 \t]+)$/gm, '$&\t1');
      }
      return value;
    }) as any);
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((filename: any, options: any) => {
      if (childOfFixture(filename)) return 'pid:[999999999]';
      return readlink(filename, options);
    }) as any);
    const signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      // A mapping regression must never send a real signal to PID 1 or to a
      // process that this test did not create, even if the assertion fails.
      let childPid;
      try { childPid = JSON.parse(readFile(path.join(directory, 'child-ready.json'), 'utf8')).pid; } catch {}
      if (![parent.pid, -parent.pid, childPid].includes(pid)) throw new Error('Rejected unsafe fixture signal');
      return kill(pid, signal);
    });
    fs.writeFileSync(path.join(directory, 'spawn-child'), 'start');
    await until(() => fs.existsSync(path.join(directory, 'child-ready.json')));
    await new Promise(resolve => setTimeout(resolve, 80));
    const child = JSON.parse(readFile(path.join(directory, 'child-ready.json'), 'utf8'));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ code: 'SANDBOX_PROBE_ABORTED', cleanupComplete: true });
    expect(signals).toHaveBeenCalledWith(child.pid, 'SIGKILL');
    vi.restoreAllMocks();
    expect(live(child.pid)).toBe(false);
  });

  it('fails closed on a changed process start identity without signalling a reused identity', async () => {
    const controller = new AbortController();
    const pending = execute('wait', { signal: controller.signal });
    await until(() => fs.existsSync(path.join(directory, 'ready.json')));
    const parent = JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8'));
    const parentNative = nativePid(parent.pid);
    const readFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename: any, options: any) => {
      const value = readFile(filename, options);
      if (filename === `/proc/${parentNative}/stat` && typeof value === 'string') {
        const offset = value.lastIndexOf(')') + 2;
        const fields = value.slice(offset).trim().split(/\s+/);
        fields[19] = String(BigInt(fields[19]) + 1n);
        return value.slice(0, offset) + fields.join(' ');
      }
      return value;
    }) as any);
    const signals = vi.spyOn(process, 'kill');
    controller.abort();
    expect(await pending).toMatchObject({ code: 'SANDBOX_PROBE_CLEANUP_FAILED', cleanupComplete: false });
    expect(signals).not.toHaveBeenCalled();
    // The test owns this still-live fixture and afterEach cleans it after the
    // simulated identity view is restored. Production must require reconciliation.
    vi.restoreAllMocks();
    expect(live(parent.pid)).toBe(true);
  });

  it.each(['output', 'stderr-output'])('bounds combined %s bytes and stops the producer', async mode => {
    const result = await execute(mode, { maxOutputBytes: 1_024 });
    expect(result).toMatchObject({ code: 'SANDBOX_PROBE_OUTPUT_LIMIT', cleanupComplete: true });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
    expect(result.code).not.toContain('fixture-private');
  });

  it('rejects invalid UTF-8 output', async () => {
    expect(await execute('invalid-utf8')).toMatchObject({ code: 'SANDBOX_PROBE_OUTPUT_INVALID', cleanupComplete: true, stdout: '' });
  });

  it('returns a static spawn failure with no raw operating-system message', async () => {
    expect(await execute('success', { executable: path.join(directory, 'private-executable-name') })).toEqual({
      code: 'SANDBOX_PROBE_SPAWN_FAILED', cleanupComplete: true,
      exitCode: null, exitSignal: null, stdout: '', stderr: '',
    });
  });

  it('rejects relative executables without starting a command', async () => {
    expect(await execute('wait', { executable: 'node' })).toMatchObject({ code: 'SANDBOX_PROBE_CONFIG_INVALID', cleanupComplete: true });
  });
});
