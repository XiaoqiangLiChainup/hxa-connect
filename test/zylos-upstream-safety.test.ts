import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const core = fileURLToPath(new URL('../vendor/zylos-core/', import.meta.url));
const monitorPath = 'skills/activity-monitor/scripts/monitor.js';
const samplerPath = 'skills/activity-monitor/scripts/proc-sampler.js';
const upgradePath = 'skills/upgrade-claude/scripts/upgrade.js';
let forbiddenCalls: ReturnType<typeof vi.fn>[];

beforeEach(() => { forbiddenCalls = []; });
afterEach(() => {
  for (const forbidden of forbiddenCalls) expect(forbidden).not.toHaveBeenCalled();
});

/**
 * These maintenance entrypoints start a monitor or upgrade at module scope.
 * Parse their actual declarations, without imports, initializers, or main(),
 * and evaluate only the selected code with inert process/child-process bindings.
 * This exercises the changed functions, not module startup or OS integration.
 */
function actualDeclarations(relative: string, names: string[], bindings: Record<string, unknown> = {}) {
  const filename = path.join(core, relative);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, string>();
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement.getText(source).replace(/^export\s+/u, ''));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, `const ${declaration.getText(source)};`);
      }
    }
  }
  const selected = names.map(name => {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Missing tested declaration: ${name}`);
    return declaration;
  });
  const forbidden = vi.fn(() => { throw new Error('A maintenance startup, shell, or filesystem operation was attempted.'); });
  forbiddenCalls.push(forbidden);
  const script = new vm.Script(`${selected.join('\n')}\n({ ${names.join(', ')} });`, { filename });
  return script.runInNewContext({
    execSync: forbidden,
    fs: { readFileSync: forbidden, writeFileSync: forbidden, renameSync: forbidden },
    process: Object.freeze({ platform: 'linux' }),
    ...bindings,
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}

function loadMonitor(execFileSync: ReturnType<typeof vi.fn>) {
  return actualDeclarations(monitorPath, ['parseFirstPid', 'getTmuxPanePid', 'getTmuxClaudePid'], { execFileSync });
}

function loadSampler(execFileSync: ReturnType<typeof vi.fn>, sessionName = 'claude-main') {
  const { ProcSampler } = actualDeclarations(samplerPath,
    ['SAMPLE_INTERVAL', 'FROZEN_THRESHOLD', 'parseFirstPid', 'ProcSampler'], { execFileSync });
  return new ProcSampler({ sessionName });
}

function loadUpgrade(execFileSync: ReturnType<typeof vi.fn>, isClaudeRunning = vi.fn()) {
  return actualDeclarations(upgradePath, ['MAX_EXIT_WAIT', 'sleep', 'waitForClaudeExit'], {
    execFileSync, isClaudeRunning, log: vi.fn(), logError: vi.fn(),
  });
}

function expectDirectCalls(execute: ReturnType<typeof vi.fn>) {
  for (const [executable, args, options] of execute.mock.calls) {
    expect(typeof executable).toBe('string');
    expect(Array.isArray(args)).toBe(true);
    expect(args.every((arg: unknown) => typeof arg === 'string')).toBe(true);
    expect(options.shell).toBe(false);
    expect(Number.isFinite(options.timeout) && options.timeout > 0).toBe(true);
  }
}

describe('bundled monitor PID probes without shell evaluation', () => {
  it('passes shell punctuation literally as one tmux target and keeps the first pane', () => {
    const session = 'demo"; $(untrusted-command) #\nother-pane';
    const execute = vi.fn().mockReturnValue('00123\r\n456\n');
    expect(loadMonitor(execute).getTmuxPanePid(session)).toBe(123);
    expect(execute).toHaveBeenCalledExactlyOnceWith('tmux',
      ['list-panes', '-t', session, '-F', '#{pane_pid}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, shell: false });
  });

  it('returns a pane already running Claude without starting pgrep', () => {
    const execute = vi.fn().mockReturnValueOnce('321\n').mockReturnValueOnce('claude\n');
    expect(loadMonitor(execute).getTmuxClaudePid('claude-main')).toBe(321);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]).toEqual(['ps', ['-p', '321', '-o', 'comm='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, shell: false }]);
    expectDirectCalls(execute);
  });

  it.each(['shell-pane', 'failed-ps'])('keeps the first Claude child after %s', mode => {
    const execute = vi.fn().mockReturnValueOnce('321\n').mockImplementationOnce(() => {
      if (mode === 'failed-ps') throw new Error('Synthetic ps failure');
      return 'bash\n';
    }).mockReturnValueOnce('654\n655\n');
    expect(loadMonitor(execute).getTmuxClaudePid('claude-main')).toBe(654);
    expect(execute.mock.calls[2]).toEqual(['pgrep', ['-P', '321', '-f', 'claude'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, shell: false }]);
    expectDirectCalls(execute);
  });

  it('refuses malformed or out-of-range pane IDs before ps or pgrep', () => {
    for (const output of ['', '\n321\n', '0', '-1', '12oops', '42; untrusted-command', '2147483648', '99999999999999999999']) {
      const execute = vi.fn().mockReturnValue(output);
      expect(loadMonitor(execute).getTmuxClaudePid('claude-main')).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a malformed child ID or failed tmux command as unavailable', () => {
    const malformed = vi.fn().mockReturnValueOnce('321\n').mockReturnValueOnce('bash\n').mockReturnValueOnce('654suffix\n');
    expect(loadMonitor(malformed).getTmuxClaudePid('claude-main')).toBe(0);
    const failed = vi.fn(() => { throw new Error('Synthetic tmux failure'); });
    expect(loadMonitor(failed).getTmuxPanePid('claude-main')).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe('bundled ProcSampler direct process discovery and Darwin sampling', () => {
  it('keeps literal session input and selects the first validated pane and child', () => {
    const session = 'runtime"; $(untrusted-command) #';
    const execute = vi.fn().mockReturnValueOnce('321\n322\n').mockReturnValueOnce('654\n655\n');
    expect(loadSampler(execute, session)._findRuntimePid()).toBe(654);
    expect(execute.mock.calls[0].slice(0, 2)).toEqual(['tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}']]);
    expect(execute.mock.calls[1]).toEqual(['pgrep', ['-P', '321'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, shell: false }]);
    expectDirectCalls(execute);
  });

  it('rejects malformed discovery output before issuing another subprocess', () => {
    for (const output of ['123; untrusted-command', '0', '-1', '2147483648', '1e3']) {
      const execute = vi.fn().mockReturnValue(output);
      expect(loadSampler(execute)._findRuntimePid()).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it('returns unknown for a malformed child ID or unavailable command', () => {
    const malformed = vi.fn().mockReturnValueOnce('321\n').mockReturnValueOnce('654suffix\n');
    expect(loadSampler(malformed)._findRuntimePid()).toBeNull();
    const unavailable = vi.fn(() => { throw new Error('Synthetic process discovery failure'); });
    expect(loadSampler(unavailable)._findRuntimePid()).toBeNull();
  });

  it('samples Darwin context switches using a numeric argument and retains last matching row parsing', () => {
    const execute = vi.fn().mockReturnValue('Processes: 1 total\nPID CSW\n 321 70\n 321 81\n');
    const sampler = loadSampler(execute);
    sampler._platform = 'darwin';
    expect(sampler._sampleCtxSwitches(321)).toBe(81);
    expect(execute).toHaveBeenCalledExactlyOnceWith('top',
      ['-l', '1', '-pid', '321', '-stats', 'pid,csw', '-s', '0'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, shell: false });
  });

  it('refuses nonnumeric, fractional, nonpositive, or oversized Darwin PIDs without executing top', () => {
    const execute = vi.fn();
    const sampler = loadSampler(execute);
    for (const pid of ['321; untrusted-command', '321', undefined, NaN, Infinity, 0, -1, 1.5, 2147483648]) {
      expect(sampler._sampleDarwin(pid)).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts the bounded PID endpoints', () => {
    for (const pid of [1, 2147483647]) {
      const execute = vi.fn().mockReturnValue(`${pid} 9\n`);
      expect(loadSampler(execute)._sampleDarwin(pid)).toBe(9);
      expect(execute.mock.calls[0][1]).toContain(String(pid));
    }
  });

  it('returns unknown when top output is unparseable or execution fails', () => {
    expect(loadSampler(vi.fn().mockReturnValue('no matching process'))._sampleDarwin(321)).toBeNull();
    expect(loadSampler(vi.fn(() => { throw new Error('Synthetic top failure'); }))._sampleDarwin(321)).toBeNull();
  });
});

describe('bundled upgrade sleep validation without activating the upgrade script', () => {
  it('passes finite bounded durations as one argument with a bounded timeout', () => {
    const execute = vi.fn();
    const { sleep } = loadUpgrade(execute);
    for (const seconds of [0, 0.25, 2, 120]) {
      sleep(seconds);
      expect(execute).toHaveBeenLastCalledWith('sleep', [String(seconds)],
        { stdio: 'ignore', timeout: Math.ceil(seconds * 1000) + 1000, shell: false });
    }
    expectDirectCalls(execute);
  });

  it('rejects command text and invalid durations before any subprocess', () => {
    const execute = vi.fn();
    const { sleep } = loadUpgrade(execute);
    for (const seconds of ['2; untrusted-command', '2', undefined, NaN, Infinity, -1, 120.1]) {
      expect(() => sleep(seconds)).toThrow('Sleep duration must be between 0 and 120 seconds.');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the existing two-second wait loop using only stubbed subprocess calls', () => {
    const execute = vi.fn();
    const running = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    expect(loadUpgrade(execute, running).waitForClaudeExit()).toBe(true);
    expect(running).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls).toEqual([
      ['sleep', ['2'], { stdio: 'ignore', timeout: 3000, shell: false }],
      ['sleep', ['2'], { stdio: 'ignore', timeout: 3000, shell: false }],
    ]);
  });

  it('propagates sleep execution failure instead of pretending the delay completed', () => {
    const execute = vi.fn(() => { throw new Error('Synthetic sleep failure'); });
    expect(() => loadUpgrade(execute).sleep(2)).toThrow('Synthetic sleep failure');
  });
});
