import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkSandbox, sandboxNotRun, SANDBOX_CHECK_NAMES } from '../scripts/codex-runner/sandbox-preflight.mjs';
import { runSandboxCommand } from '../scripts/codex-runner/sandbox-command.mjs';
import { SANDBOX_CANARY_NAME, SANDBOX_CANARY_VALUE, createSandboxProfileName, sandboxPolicyArguments } from '../scripts/codex-runner/sandbox-policy.mjs';
import { preflight, readCodexConfiguration } from '../scripts/codex-runner/config.mjs';

const historyCheck = 'sandbox_task_history_reads_denied';
const protectedContent = 'fixture-history-or-auth-content-must-not-be-read-or-reported';
let temporary: string;
let config: any;
let historicalFile: string;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-sandbox-'));
  const stateRoot = path.join(temporary, 'state');
  const homeDir = path.join(temporary, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(temporary, 'credentials');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir]) fs.mkdirSync(directory, { mode: 0o700 });
  config = { stateRoot, homeDir, codexHome, credentialDir,
    tokenFile: path.join(credentialDir, 'hub-token'), isolateStateReads: true,
    sandboxProfile: createSandboxProfileName(), codexBin: '/usr/bin/true',
    childPath: '/usr/bin:/bin', model: 'offline-model-fixture', minFreeBytes: 0 };
  historicalFile = path.join(stateRoot, 'runs/prior-run/control/private.txt');
  fs.mkdirSync(path.dirname(historicalFile), { recursive: true, mode: 0o700 });
  for (const filename of [historicalFile, config.tokenFile, path.join(codexHome, 'auth.json')]) {
    fs.writeFileSync(filename, protectedContent, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(credentialDir, SANDBOX_CANARY_NAME), SANDBOX_CANARY_VALUE, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function syntheticEvidence(command: any, overrides: Record<string, unknown> = {}) {
  const input = JSON.parse(command.args.at(-1));
  for (const filename of ['witness', '.tmp/witness']) fs.writeFileSync(path.join(input.workspace, filename), input.nonce);
  const evidence: Record<string, unknown> = {
    protocol: 'hxa-sandbox-probe-v1', nonce: input.nonce, workspace_write: true,
    outside_write_denied: true, credential_reads_denied: true, network_restricted: true,
    ...(input.taskHistory ? { task_history_reads_denied: true } : {}), ...overrides,
  };
  return { input, evidence, result: { exitCode: 0, exitSignal: null, code: null,
    cleanupComplete: true, stderr: '', stdout: JSON.stringify(evidence) } };
}

function temporaryEntries() {
  return [config.stateRoot, config.homeDir, config.codexHome].flatMap(directory =>
    fs.readdirSync(directory).filter(name => name.startsWith('.sandbox-preflight-') || name.startsWith('.hxa-sandbox-probe-')));
}

function hasHistoryResult(report: any, passed: boolean) {
  expect(report.checks).toContainEqual({ name: historyCheck, passed });
}

function ordinaryNodeCommand(command: any, setup = '') {
  const separator = command.args.indexOf('--');
  const args = command.args.slice(separator + 2);
  if (setup) args[args.indexOf('-e') + 1] = `${setup}\n${args[args.indexOf('-e') + 1]}`;
  return runSandboxCommand({ ...command, executable: command.args[separator + 1], args });
}

describe('Zylos task-history policy and readiness contract', () => {
  it('denies other state only in strict mode while keeping the shared profile and legacy policy unchanged', () => {
    const strict = Object.freeze({ ...config });
    const original = sandboxPolicyArguments({ ...config, isolateStateReads: undefined });
    expect(original).toEqual(sandboxPolicyArguments({ ...config, isolateStateReads: false }));
    expect(original[1]).toContain(`${JSON.stringify(config.stateRoot)}="read"`);
    const policy = sandboxPolicyArguments(strict);
    expect(policy[0]).toBe('-c');
    expect(policy[1]).toBe(original[1].replace(`${JSON.stringify(config.stateRoot)}="read"`,
      `${JSON.stringify(config.stateRoot)}="deny"`));
    expect(policy[1]).toContain(`permissions.${config.sandboxProfile}={extends=":workspace"`);
    expect(policy[1]).toContain('network={enabled=false}');
    for (const directory of [config.homeDir, config.codexHome, config.credentialDir]) {
      expect(policy[1]).toContain(`${JSON.stringify(directory)}="deny"`);
    }
    expect(() => sandboxPolicyArguments({ ...config, isolateStateReads: 'true' })).toThrow('boolean');
  });

  it('includes the history check even when strict probing cannot start and preserves the original check list otherwise', () => {
    const legacy = sandboxNotRun(undefined, { ...config, isolateStateReads: false });
    expect(legacy.checks.map((check: any) => check.name)).toEqual(SANDBOX_CHECK_NAMES);
    const strict = sandboxNotRun(undefined, config);
    expect(strict.checks.map((check: any) => check.name)).toEqual([
      ...SANDBOX_CHECK_NAMES.slice(0, -1), historyCheck, 'sandbox_probe_cleanup',
    ]);
    expect(strict.checks.every((check: any) => check.passed === false)).toBe(true);
    expect(strict.sandbox.ran).toBe(false);
  });

  it('passes the same strict policy to the bounded command and verifies only new synthetic history markers', async () => {
    const originalOpen = fs.openSync;
    const protectedFiles = new Set([historicalFile, config.tokenFile, path.join(config.codexHome, 'auth.json')]);
    const opened: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (protectedFiles.has(String(filename))) throw new Error('Probe attempted to open real historical or credential content');
      opened.push(String(filename));
      return (originalOpen as any)(filename, ...args);
    }) as any);
    let marker = '', alias = '';
    const runCommand = vi.fn(async command => {
      const { input, result } = syntheticEvidence(command);
      marker = input.taskHistory.canary;
      alias = input.taskHistory.alias;
      expect(path.dirname(marker)).toBe(path.dirname(input.workspace));
      expect(marker.startsWith(config.stateRoot + path.sep)).toBe(true);
      expect(marker.startsWith(input.workspace + path.sep)).toBe(false);
      expect(path.dirname(alias)).toBe(input.workspace);
      expect(fs.readlinkSync(alias)).toBe(marker);
      expect(fs.readFileSync(marker, 'utf8')).toBe(input.nonce);
      expect(command.args.slice(0, 8)).toEqual(['--no-daemon', ...sandboxPolicyArguments(config),
        'sandbox', '--permission-profile', config.sandboxProfile, '--cd', input.workspace]);
      expect(command).toMatchObject({ timeoutMs: 10_000, termGraceMs: 1_000, maxOutputBytes: 32_768 });
      expect(command.env.HOME).not.toBe(config.homeDir);
      expect(command.env.CODEX_HOME).not.toBe(config.codexHome);
      expect(fs.readdirSync(command.env.CODEX_HOME)).toEqual([]);
      for (const flag of ['linux', 'exec', '--include-managed-config', '--sandbox', '--model']) {
        expect(command.args).not.toContain(flag);
      }
      expect(JSON.stringify(command)).not.toContain(protectedContent);
      return result;
    });
    const report = await checkSandbox(config, { runCommand });
    hasHistoryResult(report, true);
    expect(report.checks).toHaveLength(7);
    expect(report.checks.every((check: any) => check.passed)).toBe(true);
    expect(report.sandbox).toMatchObject({ ran: true, code: null, temporary_evidence_retained: false });
    expect(opened).not.toContain(historicalFile);
    expect(opened).not.toContain(config.tokenFile);
    expect(opened).not.toContain(path.join(config.codexHome, 'auth.json'));
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(alias)).toBe(false);
    expect(temporaryEntries()).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(protectedContent);
    vi.restoreAllMocks();
    expect(fs.readFileSync(historicalFile, 'utf8')).toBe(protectedContent);
  });

  it.each(['missing', 'string-boolean'])('rejects %s history evidence instead of accepting the old six checks', async mode => {
    const report = await checkSandbox(config, { runCommand: async command => {
      const { result, evidence } = syntheticEvidence(command);
      if (mode === 'missing') delete evidence.task_history_reads_denied;
      else evidence.task_history_reads_denied = 'true';
      return { ...result, stdout: JSON.stringify(evidence) };
    } });
    hasHistoryResult(report, false);
    expect(report.sandbox.code).toBe('SANDBOX_PROBE_FAILED');
    expect(temporaryEntries()).toEqual([]);
  });

  it.each(['marker', 'alias'])('rejects changed history %s even when the child reports denial', async mode => {
    const report = await checkSandbox(config, { runCommand: async command => {
      const { input, result } = syntheticEvidence(command);
      if (mode === 'marker') fs.writeFileSync(input.taskHistory.canary, 'modified');
      else {
        fs.unlinkSync(input.taskHistory.alias);
        fs.symlinkSync(path.join(input.workspace, 'missing-target'), input.taskHistory.alias);
      }
      return result;
    } });
    hasHistoryResult(report, false);
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(temporaryEntries()).toEqual([]);
  });

  it('fails the strict history boundary with the actual probe program in an unsandboxed Node negative control', async () => {
    const report = await checkSandbox(config, { runCommand: command => ordinaryNodeCommand(command) });
    expect(report.checks).toContainEqual({ name: 'sandbox_command_startup', passed: true });
    expect(report.checks).toContainEqual({ name: 'sandbox_workspace_write', passed: true });
    hasHistoryResult(report, false);
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(temporaryEntries()).toEqual([]);
    expect(fs.readFileSync(historicalFile, 'utf8')).toBe(protectedContent);
    expect(JSON.stringify(report)).not.toContain(protectedContent);
  });

  it.each(['direct-only', 'alias-only', 'both'])('requires both history read paths in a real Node %s denial fixture', async mode => {
    const report = await checkSandbox(config, { runCommand: command => {
      const input = JSON.parse(command.args.at(-1));
      const denied = mode === 'direct-only' ? [input.taskHistory.canary]
        : mode === 'alias-only' ? [input.taskHistory.alias] : [input.taskHistory.canary, input.taskHistory.alias];
      // Emulate read-denial responses for the trusted program in a child process.
      // This is not a real sandbox pass: other unconfined boundaries still fail.
      const setup = `{ const probeFs = require('node:fs'); const originalRead = probeFs.readFileSync;
        const deniedPaths = ${JSON.stringify(denied)};
        probeFs.readFileSync = function(filename, ...args) {
          if (deniedPaths.includes(String(filename))) throw Object.assign(new Error('fixture-denied'), { code: 'EACCES' });
          return originalRead.call(this, filename, ...args);
        }; }`;
      return ordinaryNodeCommand(command, setup);
    } });
    hasHistoryResult(report, mode === 'both');
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(temporaryEntries()).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(protectedContent);
  });

  it('keeps history readiness false after a bounded timeout and removes only the synthetic probe resources', async () => {
    let marker = '';
    const report = await checkSandbox(config, { runCommand: async command => {
      const { input, result } = syntheticEvidence(command);
      marker = input.taskHistory.canary;
      expect(command.timeoutMs).toBe(10_000);
      return { ...result, code: 'SANDBOX_PROBE_TIMEOUT' };
    } });
    hasHistoryResult(report, false);
    expect(report.sandbox.code).toBe('SANDBOX_PROBE_TIMEOUT');
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: true });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(historicalFile, 'utf8')).toBe(protectedContent);
    expect(temporaryEntries()).toEqual([]);
  });

  it('retains the synthetic history evidence when subprocess cleanup is uncertain', async () => {
    let marker = '';
    const report = await checkSandbox(config, { runCommand: async command => {
      const { input, result } = syntheticEvidence(command);
      marker = input.taskHistory.canary;
      return { ...result, cleanupComplete: false };
    } });
    hasHistoryResult(report, false);
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_CLEANUP_FAILED', temporary_evidence_retained: true });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: false });
    expect(fs.existsSync(marker)).toBe(true);
    expect(temporaryEntries()).toHaveLength(3);
  });

  it('blocks combined readiness when the original sixteen pass but task-history denial fails', async () => {
    const uid = process.getuid!() === 0 ? 1000 : process.getuid!();
    if (process.getuid!() === 0) {
      const stat = fs.statSync;
      const privateDirectories = new Set([config.stateRoot, config.homeDir, config.codexHome]);
      vi.spyOn(fs, 'statSync').mockImplementation(((filename: any, ...args: any[]) => {
        const info = (stat as any)(filename, ...args);
        if (privateDirectories.has(String(filename))) info.uid = uid;
        return info;
      }) as any);
    }
    const validated = readCodexConfiguration({
      HXA_TASK_URL: 'http://127.0.0.1:4801', HXA_TASK_TOKEN_FILE: config.tokenFile,
      HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test', HXA_RUNNER_ID: 'offline-zylos-sandbox',
      HXA_CODEX_STATE_DIR: config.stateRoot, HXA_CODEX_BIN: '/usr/bin/true', HXA_CODEX_HOME_DIR: config.homeDir,
      CODEX_HOME: config.codexHome, HXA_CODEX_MODEL: 'offline-model-fixture', HXA_CODEX_REASONING_EFFORT: 'medium',
      HXA_CODEX_CHILD_PATH: '/usr/bin:/bin',
    });
    const execute = vi.fn(async (_file, args) => ({ stdout: args[0] === '--version'
      ? 'codex-cli 0.166.0' : 'Logged in using ChatGPT', stderr: '' }));
    const report = await preflight({ ...validated, isolateStateReads: true, minFreeBytes: 0 }, {
      uid, execute, sandboxProbe: (checked, options) => checkSandbox(checked, {
        ...options, runCommand: async command => syntheticEvidence(command, { task_history_reads_denied: false }).result,
      }),
    });
    expect(report.checks).toHaveLength(17);
    expect(report.checks.filter((check: any) => check.name !== historyCheck).every((check: any) => check.passed)).toBe(true);
    hasHistoryResult(report, false);
    expect(report.ready).toBe(false);
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(temporaryEntries()).toEqual([]);
  });
});
