import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function createSandboxProfileName() { return `hxa_m1_${randomBytes(12).toString('hex')}`; }
export const SANDBOX_CANARY_NAME = 'hxa_sandbox_probe';
export const SANDBOX_CANARY_VALUE = 'non-secret-hxa-sandbox-canary-v1';

function policyPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value === '/'
    || /[\u0000-\u001f\u007f*?\[\]{}]/u.test(value)) {
    throw new Error('Sandbox policy requires literal, non-root absolute directories.');
  }
  return path.resolve(value);
}

/** The probe and real exec must use the same profile, never a legacy --sandbox override. */
export function sandboxPolicyArguments(config) {
  if (!/^hxa_m1_[0-9a-f]{24}$/u.test(config.sandboxProfile ?? '')) throw new Error('Invalid sandbox profile name.');
  if (config.isolateStateReads !== undefined && typeof config.isolateStateReads !== 'boolean') {
    throw new Error('Task-history isolation must be an explicit boolean.');
  }
  const state = policyPath(config.stateRoot);
  const protectedDirectories = [...new Set([
    policyPath(config.homeDir), policyPath(config.codexHome), policyPath(config.credentialDir),
  ])];
  // The current workspace has a more-specific inherited write rule. Zylos task
  // mode denies access to other state; the original Codex mode remains read-only.
  // Either rule overrides a writable parent such as /tmp.
  const rules = new Map([[state, config.isolateStateReads === true ? 'deny' : 'read'],
    ...protectedDirectories.map(directory => [directory, 'deny'])]);
  const filesystem = [...rules].map(([directory, access]) => `${JSON.stringify(directory)}=${JSON.stringify(access)}`).join(',');
  // Codex merges configuration tables recursively. A fresh name avoids inheriting
  // additional lower-layer rules from an unrelated fixed-name profile.
  return ['-c', `permissions.${config.sandboxProfile}={extends=":workspace",filesystem={${filesystem}},network={enabled=false}}`];
}
