import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxPolicyError, verifyRuntimeSandboxPolicy } from '../scripts/codex-runner/sandbox-policy-check.mjs';
import { createSandboxProfileName, sandboxPolicyArguments } from '../scripts/codex-runner/sandbox-policy.mjs';

let root: string;
let workspaceDir: string;
let config: any;
const sensitive = 'synthetic-preview-content-must-never-escape';

function requirements(extra: Record<string, unknown> = {}) {
  return { allowedPermissionProfiles: null, defaultPermissions: null, allowedSandboxModes: null, ...extra };
}

function response(policy: unknown = null, extra: Record<string, unknown> = {}) {
  return { code: null, exitCode: 0, exitSignal: null, cleanupComplete: true, stderr: '',
    stdout: JSON.stringify({ appServerVersion: '0.166.0', configRequirements: {
      supportsIndependentSpeedModes: true, requirements: policy,
    } }), ...extra };
}

function verify(result: any = response()) {
  return verifyRuntimeSandboxPolicy(config, { workspaceDir, runCommand: async () => result });
}

async function assertRejected(pending: Promise<unknown>, code: string, cleanupComplete = true) {
  const result = await pending.then(() => null, error => error);
  expect(result).toBeInstanceOf(SandboxPolicyError);
  expect(result).toMatchObject({ code, metadata: { cleanupComplete } });
  expect(Object.keys(result.metadata)).toEqual(['cleanupComplete']);
  expect(result.cause).toBeUndefined();
  expect(`${result.message}\n${result.stack}\n${JSON.stringify(result)}`).not.toContain(sensitive);
  expect(result.message).not.toContain(root);
  return result;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-runtime-policy-'));
  const stateRoot = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(homeDir, 'codex');
  const credentialDir = path.join(root, 'credentials');
  workspaceDir = path.join(stateRoot, 'workspace');
  for (const directory of [stateRoot, homeDir, codexHome, credentialDir, workspaceDir, path.join(workspaceDir, '.tmp')]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  config = { stateRoot, homeDir, codexHome, credentialDir, tokenFile: path.join(credentialDir, 'hub-token'),
    token: sensitive, codexBin: '/usr/bin/true', childPath: '/usr/bin:/bin', sandboxProfile: createSandboxProfileName() };
  fs.writeFileSync(config.tokenFile, sensitive, { mode: 0o600 });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), sensitive, { mode: 0o600 });
});

afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('runtime managed sandbox policy check', () => {
  it('accepts a preview without managed requirements', async () => {
    await expect(verify()).resolves.toEqual({ allowed: true, cleanupComplete: true });
  });

  it('preserves unrelated managed model, network, and login restrictions', async () => {
    await expect(verify(response(requirements({ modelProvider: 'openai',
      allowedLoginMethods: ['chatgpt'], network: { allowedDomains: ['example.invalid'] },
      modelProviders: { internal: { unrelated: sensitive } },
    })))).resolves.toEqual({ allowed: true, cleanupComplete: true });
  });

  it('accepts the explicit current profile and required workspace mode', async () => {
    await expect(verify(response(requirements({ allowedPermissionProfiles: { [config.sandboxProfile]: true },
      defaultPermissions: config.sandboxProfile, allowedSandboxModes: ['read-only', 'workspace-write'],
    })))).resolves.toEqual({ allowed: true, cleanupComplete: true });
  });

  it('uses only the official read-only preview, exact shared policy, cwd, and explicit environment', async () => {
    const read = fs.readFileSync;
    const opened = fs.openSync;
    const protectedPaths = new Set([config.tokenFile, path.join(config.codexHome, 'auth.json')]);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (protectedPaths.has(String(filename))) throw new Error(sensitive);
      return (read as any)(filename, ...args);
    }) as any);
    vi.spyOn(fs, 'openSync').mockImplementation(((filename: any, ...args: any[]) => {
      if (protectedPaths.has(String(filename))) throw new Error(sensitive);
      return (opened as any)(filename, ...args);
    }) as any);
    const previous = process.env.HXA_POLICY_PARENT_SENTINEL;
    process.env.HXA_POLICY_PARENT_SENTINEL = sensitive;
    const runCommand = vi.fn(async (command: any) => {
      expect(command.args).toEqual(['--no-daemon', ...sandboxPolicyArguments(config),
        '-c', `default_permissions=${JSON.stringify(config.sandboxProfile)}`,
        'app-server', '--strict-config', '--print-startup-config', '--startup-client-info',
        JSON.stringify({ name: 'codex_exec', version: '0.166.0' })]);
      expect(command.executable).toBe(config.codexBin);
      expect(command.cwd).toBe(workspaceDir);
      expect(command.env).toEqual({ HOME: config.homeDir, CODEX_HOME: config.codexHome, PATH: config.childPath,
        TMPDIR: path.join(workspaceDir, '.tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' });
      expect(command).toMatchObject({ timeoutMs: 15_000, termGraceMs: 1_000, maxOutputBytes: 65_536 });
      expect(JSON.stringify(command)).not.toContain(sensitive);
      expect(JSON.stringify(command)).not.toContain(config.tokenFile);
      for (const forbidden of ['exec', '--model', '--startup-sign-out', '--listen', '--ignore-user-config', '--sandbox']) {
        expect(command.args).not.toContain(forbidden);
      }
      return response();
    });
    try {
      await expect(verifyRuntimeSandboxPolicy(config, { workspaceDir, runCommand })).resolves.toEqual({ allowed: true, cleanupComplete: true });
    } finally {
      if (previous === undefined) delete process.env.HXA_POLICY_PARENT_SENTINEL;
      else process.env.HXA_POLICY_PARENT_SENTINEL = previous;
    }
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'false', 'wildcard', 'other-profile'])('refuses a %s managed profile permission instead of falling back', async mode => {
    const map = mode === 'missing' ? {} : mode === 'false' ? { [config.sandboxProfile]: false }
      : mode === 'wildcard' ? { '*': true } : { ':workspace': true, ':read-only': true };
    await assertRejected(verify(response(requirements({ allowedPermissionProfiles: map }))), 'CODEX_SANDBOX_POLICY_REJECTED');
  });

  it('refuses a different required default even if the current profile is listed', async () => {
    await assertRejected(verify(response(requirements({ allowedPermissionProfiles: { [config.sandboxProfile]: true, ':workspace': true },
      defaultPermissions: ':workspace',
    }))), 'CODEX_SANDBOX_POLICY_REJECTED');
  });

  it.each([[], ['read-only'], ['danger-full-access']].map(allowedSandboxModes => ({ allowedSandboxModes })))(
    'refuses allowed modes $allowedSandboxModes that cannot retain workspace-write', async ({ allowedSandboxModes }) => {
    await assertRejected(verify(response(requirements({ allowedSandboxModes }))), 'CODEX_SANDBOX_POLICY_REJECTED');
    },
  );

  it.each([
    { allowedPermissionProfiles: [] }, { allowedPermissionProfiles: 'all' }, { allowedPermissionProfiles: { invalid: 'true' } },
    { defaultPermissions: {} }, { defaultPermissions: '' }, { allowedSandboxModes: 'workspace-write' },
    { allowedSandboxModes: ['unknown-mode'] }, { allowedSandboxModes: [true] },
  ])('rejects malformed permission fields %j', async fields => {
    await assertRejected(verify(response(requirements(fields))), 'CODEX_SANDBOX_POLICY_RESPONSE');
  });

  it.each(['allowedPermissionProfiles', 'defaultPermissions', 'allowedSandboxModes'])('requires pinned nullable field %s in a non-null requirements object', async field => {
    const policy: any = requirements();
    delete policy[field];
    await assertRejected(verify(response(policy)), 'CODEX_SANDBOX_POLICY_RESPONSE');
  });

  it.each(['empty', 'truncated', 'prefix', 'suffix', 'wrong-version', 'missing-wrapper', 'missing-requirements',
    'requirements-array', 'requirements-string', 'root-array', 'error-response', 'oversized', 'non-string'])('rejects a %s preview', async mode => {
    const result: any = response();
    const value = JSON.parse(result.stdout);
    if (mode === 'empty') result.stdout = '';
    if (mode === 'truncated') result.stdout = '{';
    if (mode === 'prefix') result.stdout = sensitive + result.stdout;
    if (mode === 'suffix') result.stdout += '\n{}';
    if (mode === 'wrong-version') result.stdout = JSON.stringify({ ...value, appServerVersion: '0.167.0' });
    if (mode === 'missing-wrapper') result.stdout = JSON.stringify({ appServerVersion: '0.166.0' });
    if (mode === 'missing-requirements') result.stdout = JSON.stringify({ ...value, configRequirements: {} });
    if (mode === 'requirements-array') result.stdout = response([]).stdout;
    if (mode === 'requirements-string') result.stdout = response(sensitive).stdout;
    if (mode === 'root-array') result.stdout = '[]';
    if (mode === 'error-response') result.stdout = JSON.stringify({ ...value, error: { message: sensitive } });
    if (mode === 'oversized') result.stdout += ' '.repeat(65_537);
    if (mode === 'non-string') result.stdout = null;
    result.stderr = sensitive;
    await assertRejected(verify(result), 'CODEX_SANDBOX_POLICY_RESPONSE');
  });

  it.each(['timeout', 'nonzero', 'signal', 'controller-code', 'output-limit', 'spawn-failed'])('fails closed on %s without copying raw diagnostics', async mode => {
    const result: any = response(null, { stderr: sensitive, stdout: sensitive });
    if (mode === 'timeout') result.code = 'SANDBOX_PROBE_TIMEOUT';
    if (mode === 'nonzero') result.exitCode = 1;
    if (mode === 'signal') result.exitSignal = 'SIGTERM';
    if (mode === 'controller-code') result.code = sensitive;
    if (mode === 'output-limit') result.code = 'SANDBOX_PROBE_OUTPUT_LIMIT';
    if (mode === 'spawn-failed') result.code = 'SANDBOX_PROBE_SPAWN_FAILED';
    await assertRejected(verify(result), mode === 'timeout' ? 'CODEX_SANDBOX_POLICY_TIMEOUT' : 'CODEX_SANDBOX_POLICY_FAILED');
  });

  it('does not treat a successful payload as success when preview cleanup is unconfirmed', async () => {
    await assertRejected(verify(response(null, { cleanupComplete: false, code: 'SANDBOX_PROBE_TIMEOUT' })), 'CODEX_SANDBOX_POLICY_CLEANUP', false);
  });

  it('keeps uncertain controller failures fail closed', async () => {
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir, runCommand: async () => { throw new Error(sensitive); } }),
      'CODEX_SANDBOX_POLICY_CLEANUP', false);
  });

  it('does not launch an already-cancelled preview or copy the abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error(sensitive));
    const runCommand = vi.fn();
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir, signal: controller.signal, runCommand }), 'CODEX_SANDBOX_POLICY_ABORTED');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('propagates cancellation and rejects even a late successful preview', async () => {
    const controller = new AbortController();
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir, signal: controller.signal, runCommand: async command => {
      expect(command.signal).toBe(controller.signal);
      controller.abort(new Error(sensitive));
      return response();
    } }), 'CODEX_SANDBOX_POLICY_ABORTED');
  });

  it.each(['file', 'directory', 'symlink', 'dangling-symlink'])('refuses an existing user config %s without modifying or reading it', async kind => {
    const filename = path.join(config.codexHome, 'config.toml');
    if (kind === 'file') fs.writeFileSync(filename, sensitive, { mode: 0o600 });
    if (kind === 'directory') fs.mkdirSync(filename);
    if (kind === 'symlink') fs.symlinkSync(config.tokenFile, filename);
    if (kind === 'dangling-symlink') fs.symlinkSync(path.join(root, 'missing'), filename);
    const before = fs.lstatSync(filename);
    const runCommand = vi.fn();
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir, runCommand }), 'CODEX_SANDBOX_POLICY_USER_CONFIG');
    const after = fs.lstatSync(filename);
    expect({ ino: after.ino, size: after.size, mode: after.mode }).toEqual({ ino: before.ino, size: before.size, mode: before.mode });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects user config appearing during preview instead of silently accepting it', async () => {
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir, runCommand: async () => {
      fs.writeFileSync(path.join(config.codexHome, 'config.toml'), sensitive);
      return response();
    } }), 'CODEX_SANDBOX_POLICY_USER_CONFIG');
  });

  it.each(['workspace-link', 'home-link', 'outside-workspace', 'missing-tmp', 'relative-path', 'bad-profile'])('rejects a %s setup before launching', async mode => {
    let cwd = workspaceDir;
    if (mode === 'workspace-link') { cwd = path.join(config.stateRoot, 'link'); fs.symlinkSync(workspaceDir, cwd); }
    if (mode === 'home-link') { const link = path.join(root, 'home-link'); fs.symlinkSync(config.homeDir, link); config.homeDir = link; }
    if (mode === 'outside-workspace') { cwd = path.join(root, 'outside'); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.tmp')); }
    if (mode === 'missing-tmp') fs.rmdirSync(path.join(workspaceDir, '.tmp'));
    if (mode === 'relative-path') config.childPath = './bin';
    if (mode === 'bad-profile') config.sandboxProfile = 'hxa_m1_fixed';
    const runCommand = vi.fn();
    await assertRejected(verifyRuntimeSandboxPolicy(config, { workspaceDir: cwd, runCommand }), 'CODEX_SANDBOX_POLICY_CONFIG');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
