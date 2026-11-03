import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkSandbox, SANDBOX_CHECK_NAMES } from '../scripts/codex-runner/sandbox-preflight.mjs';
import { runSandboxCommand } from '../scripts/codex-runner/sandbox-command.mjs';
import { SANDBOX_CANARY_NAME, SANDBOX_CANARY_VALUE, createSandboxProfileName, sandboxPolicyArguments } from '../scripts/codex-runner/sandbox-policy.mjs';
import { preflight, readCodexConfiguration } from '../scripts/codex-runner/config.mjs';
import { main } from '../scripts/codex-worker.mjs';

let root: string;
let config: any;
const secret = 'offline-auth-content-must-never-be-read-or-printed';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-sandbox-preflight-'));
  const stateRoot = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(root, 'credentials');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir]) fs.mkdirSync(directory, { mode: 0o700 });
  config = { stateRoot, homeDir, codexHome, credentialDir, tokenFile: path.join(credentialDir, 'hub-token'),
    sandboxProfile: createSandboxProfileName(),
    codexBin: '/usr/bin/true', childPath: '/usr/bin:/bin', model: 'offline-model-fixture', minFreeBytes: 0 };
  fs.writeFileSync(config.tokenFile, secret, { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), secret, { mode: 0o600 });
  fs.writeFileSync(path.join(credentialDir, SANDBOX_CANARY_NAME), SANDBOX_CANARY_VALUE, { mode: 0o600 });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function evidence(command: any) {
  const input = JSON.parse(command.args.at(-1));
  for (const filename of ['witness', '.tmp/witness']) fs.writeFileSync(path.join(input.workspace, filename), input.nonce);
  return { input, result: { exitCode: 0, exitSignal: null, code: null, cleanupComplete: true, stderr: '',
    stdout: JSON.stringify({ protocol: 'hxa-sandbox-probe-v1', nonce: input.nonce, workspace_write: true,
      outside_write_denied: true, credential_reads_denied: true, network_restricted: true }) } };
}

function allPassed(report: any) { return report.checks.every((check: any) => check.passed === true); }
function temporaryEntries() {
  return [config.stateRoot, config.homeDir, config.codexHome].flatMap(directory =>
    fs.readdirSync(directory).filter(name => name.startsWith('.sandbox-preflight-') || name.startsWith('.hxa-sandbox-probe-')));
}

describe('credential-free sandbox preflight', () => {
  it('uses the pinned direct sandbox CLI and shared policy, checks real-directory canaries, and cleans up', async () => {
    const open = fs.openSync;
    const protectedFiles = new Set([config.tokenFile, path.join(config.codexHome, 'auth.json')]);
    const opened: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (protectedFiles.has(String(filename))) throw new Error('Probe attempted a real credential read');
      opened.push(String(filename));
      return (open as any)(filename, ...args);
    }) as any);
    const runCommand = vi.fn(async command => {
      const { input, result } = evidence(command);
      expect(command.args.slice(0, 8)).toEqual(['--no-daemon', ...sandboxPolicyArguments(config),
        'sandbox', '--permission-profile', config.sandboxProfile, '--cd', input.workspace]);
      for (const forbidden of ['linux', 'exec', '--include-managed-config', '--ignore-user-config', '--sandbox', '--model']) {
        expect(command.args).not.toContain(forbidden);
      }
      expect(command.env.HOME).not.toBe(config.homeDir);
      expect(command.env.CODEX_HOME).not.toBe(config.codexHome);
      expect(fs.readdirSync(command.env.CODEX_HOME)).toEqual([]);
      expect(Object.keys(command.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR']);
      expect(input.canaries).toHaveLength(3);
      expect(input.canaries[0]).toBe(path.join(config.credentialDir, SANDBOX_CANARY_NAME));
      expect(input.canaries.slice(1).every((value: string) => value.startsWith(config.homeDir + '/'))).toBe(true);
      expect(input.aliases.every((alias: string, i: number) => fs.readlinkSync(alias) === input.canaries[i])).toBe(true);
      expect(JSON.stringify(command)).not.toContain(secret);
      return result;
    });
    const report = await checkSandbox(config, { runCommand });
    expect(allPassed(report)).toBe(true);
    expect(report.checks.map((check: any) => check.name)).toEqual(SANDBOX_CHECK_NAMES);
    expect(report.sandbox).toMatchObject({ ran: true, code: null, temporary_evidence_retained: false });
    expect(opened).not.toContain(config.tokenFile);
    expect(opened).not.toContain(path.join(config.codexHome, 'auth.json'));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(temporaryEntries()).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'wrong-content', 'symlink', 'token-name'])('rejects a %s non-secret credential canary before starting anything', async mode => {
    const filename = path.join(config.credentialDir, SANDBOX_CANARY_NAME);
    if (mode === 'missing') fs.unlinkSync(filename);
    if (mode === 'wrong-content') fs.writeFileSync(filename, 'wrong');
    if (mode === 'symlink') { fs.unlinkSync(filename); fs.symlinkSync(config.tokenFile, filename); }
    if (mode === 'token-name') config.tokenFile = filename;
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { runCommand });
    expect(report.sandbox).toMatchObject({ ran: false, code: 'SANDBOX_CANARY_INVALID' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(allPassed(report)).toBe(false);
    expect(temporaryEntries()).toEqual([]);
  });

  it('refuses existing dedicated user config by metadata without reading it or starting a command', async () => {
    const filename = path.join(config.codexHome, 'config.toml');
    fs.writeFileSync(filename, secret, { mode: 0o600 });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((candidate: any, ...args: any[]) => {
      if (String(candidate) === filename) throw new Error('User config must not be read');
      return (open as any)(candidate, ...args);
    }) as any);
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { runCommand });
    expect(report.sandbox).toMatchObject({ ran: false, code: 'SANDBOX_USER_CONFIG_PRESENT' });
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.lstatSync(filename).isFile()).toBe(true);
    expect(temporaryEntries()).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it.each(['empty', 'truncated', 'wrong-nonce', 'string-boolean', 'extra-data', 'nonzero', 'signal', 'timeout', 'output-limit'])(
    'cannot accept %s output as sandbox readiness', async mode => {
      const report = await checkSandbox(config, { runCommand: async command => {
        const { result } = evidence(command);
        if (mode === 'empty') result.stdout = '';
        if (mode === 'truncated') result.stdout = '{"protocol":';
        if (mode === 'wrong-nonce') result.stdout = result.stdout.replace(JSON.parse(result.stdout).nonce, 'wrong');
        if (mode === 'string-boolean') result.stdout = result.stdout.replace('true', '"true"');
        if (mode === 'extra-data') result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), leaked: secret });
        if (mode === 'nonzero') result.exitCode = 7;
        if (mode === 'signal') result.exitSignal = 'SIGTERM' as any;
        if (mode === 'timeout') result.code = 'SANDBOX_PROBE_TIMEOUT' as any;
        if (mode === 'output-limit') result.code = 'SANDBOX_PROBE_OUTPUT_LIMIT' as any;
        return result;
      } });
      expect(allPassed(report)).toBe(false);
      expect(report.sandbox.code).toMatch(/^SANDBOX_/);
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(temporaryEntries()).toEqual([]);
    },
  );

  it.each(['workspace', 'tmp', 'outside', 'canary', 'readable-credential', 'network'])('rejects a broken %s boundary despite exit 0 and a valid nonce', async mode => {
    const report = await checkSandbox(config, { runCommand: async command => {
      const { input, result } = evidence(command);
      if (mode === 'workspace') fs.unlinkSync(path.join(input.workspace, 'witness'));
      if (mode === 'tmp') fs.unlinkSync(path.join(input.workspace, '.tmp/witness'));
      if (mode === 'outside') fs.appendFileSync(input.outside, 'modified');
      if (mode === 'canary') fs.writeFileSync(input.canaries[1], 'modified');
      if (mode === 'readable-credential') result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), credential_reads_denied: false });
      if (mode === 'network') result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), network_restricted: false });
      return result;
    } });
    expect(allPassed(report)).toBe(false);
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(temporaryEntries()).toEqual([]);
  });

  it('detects missing isolation with the actual probe program in an ordinary local Node subprocess', async () => {
    const report = await checkSandbox(config, { runCommand: command => {
      const separator = command.args.indexOf('--');
      return runSandboxCommand({ ...command, executable: command.args[separator + 1], args: command.args.slice(separator + 2) });
    } });
    expect(report.checks).toContainEqual({ name: 'sandbox_workspace_write', passed: true });
    for (const name of ['sandbox_outside_write_denied', 'sandbox_credential_reads_denied', 'sandbox_network_restricted']) {
      expect(report.checks).toContainEqual({ name, passed: false });
    }
    expect(report.sandbox.code).toBe('SANDBOX_BOUNDARY_FAILED');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(temporaryEntries()).toEqual([]);
  });

  it('projects a static host-prerequisite diagnosis without copying raw stderr or credentials', async () => {
    const report = await checkSandbox(config, { runCommand: async () => ({ exitCode: 1, exitSignal: null, code: null,
      cleanupComplete: true, stdout: secret, stderr: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n${secret}` }) });
    expect(report.sandbox.code).toBe('SANDBOX_HOST_PREREQUISITE');
    expect(report.sandbox.guidance).toContain('AppArmor');
    expect(report.sandbox.guidance).toContain('separate approval');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(allPassed(report)).toBe(false);
  });

  it.each(['unconfirmed-cleanup', 'controller-threw'])('retains temporary evidence and fails closed when %s', async mode => {
    const report = await checkSandbox(config, { runCommand: async command => {
      if (mode === 'controller-threw') throw new Error(secret);
      return { ...evidence(command).result, cleanupComplete: false };
    } });
    expect(report.sandbox).toMatchObject({ code: 'SANDBOX_PROBE_CLEANUP_FAILED', temporary_evidence_retained: true });
    expect(report.checks).toContainEqual({ name: 'sandbox_probe_cleanup', passed: false });
    expect(temporaryEntries()).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('does not start an already-cancelled probe', async () => {
    const controller = new AbortController();
    controller.abort();
    const runCommand = vi.fn();
    const report = await checkSandbox(config, { runCommand, signal: controller.signal });
    expect(report.sandbox.code).toBe('SANDBOX_PROBE_ABORTED');
    expect(runCommand).not.toHaveBeenCalled();
    expect(temporaryEntries()).toEqual([]);
  });
});

describe('sandbox readiness integration', () => {
  function environment() {
    return { HXA_TASK_URL: 'http://127.0.0.1:4801', HXA_TASK_TOKEN_FILE: config.tokenFile,
      HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test', HXA_RUNNER_ID: 'offline-sandbox-fixture',
      HXA_CODEX_STATE_DIR: config.stateRoot, HXA_CODEX_BIN: '/usr/bin/true', HXA_CODEX_HOME_DIR: config.homeDir,
      CODEX_HOME: config.codexHome, HXA_CODEX_MODEL: 'offline-model-fixture', HXA_CODEX_REASONING_EFFORT: 'medium',
      HXA_CODEX_CHILD_PATH: '/usr/bin:/bin' };
  }

  it('keeps all original ten checks but blocks ready when the real-shaped bwrap failure occurs', async () => {
    const uid = process.getuid!() === 0 ? 1000 : process.getuid!();
    // Some rootless CI namespaces map only UID 0. Model non-root ownership in
    // this fixture instead of changing any filesystem ownership or host users.
    if (process.getuid!() === 0) {
      const stat = fs.statSync;
      const privateDirectories = new Set([config.stateRoot, config.homeDir, config.codexHome]);
      vi.spyOn(fs, 'statSync').mockImplementation(((filename: any, ...args: any[]) => {
        const info = (stat as any)(filename, ...args);
        if (privateDirectories.has(String(filename))) info.uid = uid;
        return info;
      }) as any);
    }
    const execute = vi.fn(async (_file, args) => ({ stdout: args[0] === '--version' ? 'codex-cli 0.166.0' : 'Logged in using ChatGPT', stderr: '' }));
    const sandboxProbe = vi.fn((checked, options) => checkSandbox(checked, { ...options, runCommand: async () => ({
      exitCode: 1, exitSignal: null, code: null, cleanupComplete: true, stdout: '',
      stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    }) }));
    const report = await preflight({ ...readCodexConfiguration(environment()), minFreeBytes: 0 }, { uid, execute, sandboxProbe });
    expect(report.checks).toHaveLength(16);
    expect(report.checks.slice(0, 10).every((check: any) => check.passed)).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.sandbox.code).toBe('SANDBOX_HOST_PREREQUISITE');
    expect(sandboxProbe).toHaveBeenCalledTimes(1);
  });

  it('does not run a sandbox when provenance or platform prerequisites failed', async () => {
    const sandboxProbe = vi.fn();
    const report = await preflight(readCodexConfiguration(environment()), { uid: 0, execute: vi.fn(), sandboxProbe });
    expect(report.ready).toBe(false);
    expect(report.checks).toHaveLength(16);
    expect(report.sandbox.code).toBe('SANDBOX_PREREQUISITES_NOT_MET');
    expect(sandboxProbe).not.toHaveBeenCalled();
  });

  it('rejects a credential parent containing the state and reserved canary token filenames', () => {
    expect(() => readCodexConfiguration({ ...environment(), HXA_TASK_TOKEN_FILE: path.join(root, 'token') })).toThrow('separate');
    expect(() => readCodexConfiguration({ ...environment(), HXA_TASK_TOKEN_FILE: path.join(config.credentialDir, SANDBOX_CANARY_NAME) })).toThrow('reserved');
    expect(() => sandboxPolicyArguments({ ...config, credentialDir: '/tmp/credentials*' })).toThrow('literal');
  });

  it('propagates SIGTERM during --check, emits failure, and never reaches a Hub request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No Hub request is allowed'); });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    let cleanup = false;
    const exit = await main(['--check'], environment(), { checkEnvironment: async (_config, { signal }) => {
      expect(signal.aborted).toBe(false);
      process.emit('SIGTERM');
      expect(signal.aborted).toBe(true);
      cleanup = true;
      return { ready: false, checks: [{ name: 'sandbox_command_startup', passed: false }] };
    } });
    expect(exit).toBe(143);
    expect(cleanup).toBe(true);
    expect(JSON.parse(output.mock.calls[0][0]).ready).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(config.stateRoot)).toEqual([]);
  });
});
