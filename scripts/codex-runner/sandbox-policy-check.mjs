import fs from 'node:fs';
import path from 'node:path';
import { runSandboxCommand } from './sandbox-command.mjs';
import { sandboxPolicyArguments } from './sandbox-policy.mjs';

const CODEX_VERSION = '0.166.0';
const OUTPUT_LIMIT = 65_536;
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const MESSAGES = Object.freeze({
  CODEX_SANDBOX_POLICY_CONFIG: 'The runtime sandbox policy check requires the validated worker configuration and a real run workspace.',
  CODEX_SANDBOX_POLICY_USER_CONFIG: 'The runtime policy preview cannot ignore user config. Keep the worker stopped and review the dedicated Codex config file before retrying; it was not modified.',
  CODEX_SANDBOX_POLICY_ABORTED: 'The runtime sandbox policy check was interrupted before model execution.',
  CODEX_SANDBOX_POLICY_TIMEOUT: 'The runtime sandbox policy preview timed out; model execution was not started.',
  CODEX_SANDBOX_POLICY_CLEANUP: 'Runtime policy preview cleanup could not be confirmed. Keep the worker stopped and inspect its control group before retrying.',
  CODEX_SANDBOX_POLICY_FAILED: 'The runtime sandbox policy preview failed; model execution was not started.',
  CODEX_SANDBOX_POLICY_RESPONSE: 'The pinned Codex runtime did not return a valid sandbox policy preview; model execution was not started.',
  CODEX_SANDBOX_POLICY_REJECTED: 'Managed permissions do not preserve this worker sandbox profile. Keep the worker stopped and review the policy with its administrator; no fallback was used.',
});

/** No subprocess output, configuration values, credentials, or paths escape in errors. */
export class SandboxPolicyError extends Error {
  constructor(code, metadata = { cleanupComplete: true }) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'CODEX_SANDBOX_POLICY_FAILED';
    super(MESSAGES[safeCode]);
    this.name = 'SandboxPolicyError';
    this.code = safeCode;
    this.metadata = { cleanupComplete: metadata?.cleanupComplete === true };
  }
}

function reject(code, cleanupComplete = true) {
  throw new SandboxPolicyError(code, { cleanupComplete });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function realDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === '/'
    || /[\u0000-\u001f\u007f]/u.test(directory)) reject('CODEX_SANDBOX_POLICY_CONFIG');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    reject('CODEX_SANDBOX_POLICY_CONFIG');
  }
}

function requireAbsentUserConfig(codexHome) {
  try { fs.lstatSync(path.join(codexHome, 'config.toml')); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    reject('CODEX_SANDBOX_POLICY_CONFIG');
  }
  reject('CODEX_SANDBOX_POLICY_USER_CONFIG');
}

function requirementsFrom(result) {
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > OUTPUT_LIMIT) {
    reject('CODEX_SANDBOX_POLICY_RESPONSE');
  }
  let preview;
  try { preview = JSON.parse(result.stdout); }
  catch { reject('CODEX_SANDBOX_POLICY_RESPONSE'); }
  if (!object(preview) || Object.hasOwn(preview, 'error') || preview.appServerVersion !== CODEX_VERSION
    || !object(preview.configRequirements) || !Object.hasOwn(preview.configRequirements, 'requirements')) {
    reject('CODEX_SANDBOX_POLICY_RESPONSE');
  }
  const requirements = preview.configRequirements.requirements;
  if (requirements !== null && !object(requirements)) reject('CODEX_SANDBOX_POLICY_RESPONSE');
  return requirements;
}

function verifyRequirements(requirements, sandboxProfile) {
  if (requirements === null) return;
  // These nullable fields are emitted by the pinned version's direct serializer.
  if (['allowedPermissionProfiles', 'defaultPermissions', 'allowedSandboxModes']
    .some(key => !Object.hasOwn(requirements, key))) reject('CODEX_SANDBOX_POLICY_RESPONSE');
  const allowed = requirements.allowedPermissionProfiles;
  if (allowed !== undefined && allowed !== null) {
    if (!object(allowed) || Object.values(allowed).some(value => typeof value !== 'boolean')) {
      reject('CODEX_SANDBOX_POLICY_RESPONSE');
    }
    if (!Object.hasOwn(allowed, sandboxProfile) || allowed[sandboxProfile] !== true) {
      reject('CODEX_SANDBOX_POLICY_REJECTED');
    }
  }
  const requiredDefault = requirements.defaultPermissions;
  if (requiredDefault !== undefined && requiredDefault !== null) {
    if (typeof requiredDefault !== 'string' || !requiredDefault) reject('CODEX_SANDBOX_POLICY_RESPONSE');
    if (requiredDefault !== sandboxProfile) reject('CODEX_SANDBOX_POLICY_REJECTED');
  }
  const modes = requirements.allowedSandboxModes;
  if (modes !== undefined && modes !== null) {
    if (!Array.isArray(modes) || modes.some(value => typeof value !== 'string' || !SANDBOX_MODES.has(value))) {
      reject('CODEX_SANDBOX_POLICY_RESPONSE');
    }
    if (!modes.includes('workspace-write')) reject('CODEX_SANDBOX_POLICY_REJECTED');
  }
}

/**
 * Runtime-only: the official preview loads the configured account's managed/cloud
 * requirements. It is never part of the credential-free --check probe.
 *
 * Codex 0.166.0's resolve_default_permissions silently falls back when a managed
 * allowlist excludes the selected profile. Refuse that snapshot before exec.
 * The preview and later exec are separate processes, not an atomic policy proof.
 * Sources (pinned):
 * https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/startup_config.rs
 * https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/config/mod.rs
 */
export async function verifyRuntimeSandboxPolicy(config, {
  workspaceDir, signal, runCommand = runSandboxCommand,
} = {}) {
  if (signal?.aborted) reject('CODEX_SANDBOX_POLICY_ABORTED');
  let policy;
  try {
    for (const directory of [config.homeDir, config.codexHome, config.stateRoot, config.credentialDir, workspaceDir,
      path.join(workspaceDir, '.tmp')]) realDirectory(directory);
    if (!workspaceDir.startsWith(config.stateRoot + path.sep)) reject('CODEX_SANDBOX_POLICY_CONFIG');
    if (typeof config.codexBin !== 'string' || !path.isAbsolute(config.codexBin)
      || /[\u0000-\u001f\u007f]/u.test(config.codexBin)
      || typeof config.childPath !== 'string' || config.childPath.split(':').some(directory =>
        !directory || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory))) {
      reject('CODEX_SANDBOX_POLICY_CONFIG');
    }
    policy = sandboxPolicyArguments(config);
    // app-server does not implement exec's --ignore-user-config. Do not read,
    // rename, replace, or delete an existing file to make this check pass.
    requireAbsentUserConfig(config.codexHome);
  } catch (error) {
    if (error instanceof SandboxPolicyError) throw error;
    reject('CODEX_SANDBOX_POLICY_CONFIG');
  }
  if (signal?.aborted) reject('CODEX_SANDBOX_POLICY_ABORTED');
  let result;
  try {
    result = await runCommand({
      executable: config.codexBin,
      args: ['--no-daemon', ...policy, '-c', `default_permissions=${JSON.stringify(config.sandboxProfile)}`,
        'app-server', '--strict-config', '--print-startup-config', '--startup-client-info',
        JSON.stringify({ name: 'codex_exec', version: CODEX_VERSION })],
      cwd: workspaceDir,
      env: { HOME: config.homeDir, CODEX_HOME: config.codexHome, PATH: config.childPath,
        TMPDIR: path.join(workspaceDir, '.tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' },
      signal, timeoutMs: 15_000, termGraceMs: 1_000, maxOutputBytes: OUTPUT_LIMIT,
    });
  } catch {
    // A throwing controller does not establish whether it created a process.
    reject('CODEX_SANDBOX_POLICY_CLEANUP', false);
  }
  if (!object(result) || result.cleanupComplete !== true) reject('CODEX_SANDBOX_POLICY_CLEANUP', false);
  if (signal?.aborted || result.code === 'SANDBOX_PROBE_ABORTED') reject('CODEX_SANDBOX_POLICY_ABORTED');
  if (result.code === 'SANDBOX_PROBE_TIMEOUT') reject('CODEX_SANDBOX_POLICY_TIMEOUT');
  if (result.code || result.exitCode !== 0 || result.exitSignal) reject('CODEX_SANDBOX_POLICY_FAILED');
  // A concurrent change cannot make an observed user config silently acceptable.
  requireAbsentUserConfig(config.codexHome);
  verifyRequirements(requirementsFrom(result), config.sandboxProfile);
  return { allowed: true, cleanupComplete: true };
}
