import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigurationError } from '../task-runner/config.mjs';

export const ZYLOS_CORE_COMMIT = '8ee9bd9007edab46f766f3574e0ad56cf69268c2';
export const ZYLOS_TASK_API = 'zylos-task-v1';
export const ZYLOS_TASK_VERSION = '0.5.2+hxa.task.1';
export const ZYLOS_SOURCE_ROOT = fileURLToPath(new URL('../../vendor/zylos-core/', import.meta.url));
const MANIFEST = fileURLToPath(new URL('./source-manifest.json', import.meta.url));
const PATCH = fileURLToPath(new URL('../../patches/zylos-core-0.5.2-task-runtime.patch', import.meta.url));
const UPSTREAM = fileURLToPath(new URL('../../third_party/zylos-core-upstream.json', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new ConfigurationError('Zylos Task source provenance failed; restore the complete immutable release. No fallback runtime is permitted.'); };

function rootManaged(value) {
  for (const spelling of new Set([path.resolve(value), fs.realpathSync(value)])) {
    for (let current = spelling; ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022))) fail();
      if (current === path.dirname(current)) break;
    }
  }
}

function readFile(filename, maximum, requireRootOwned) {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum
    || fs.realpathSync(filename) !== path.resolve(filename)) fail();
  if (requireRootOwned) rootManaged(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) fail();
    const bytes = Buffer.alloc(Math.min(maximum + 1, opened.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(filename);
    if (offset !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev
      || current.isSymbolicLink() || current.nlink !== 1 || fs.realpathSync(filename) !== path.resolve(filename)) fail();
    return { bytes: bytes.subarray(0, offset), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function treeFiles(root, prefix = '') {
  const result = [];
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...treeFiles(root, relative));
    else if (item.isFile()) result.push(relative);
    else fail();
    if (result.length > 1000) fail();
  }
  return result.sort();
}

/** Fixed repository paths only. The options are test injection, never CLI/env switches. */
export function verifyTaskSource(config = {}, { requireRootOwned = true } = {}) {
  try {
    const bytes = readFile(MANIFEST, 262_144, requireRootOwned).bytes;
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (manifest.format !== 'hxa-zylos-task-source-v1' || manifest.api !== ZYLOS_TASK_API
      || manifest.core_commit !== ZYLOS_CORE_COMMIT || manifest.core_version !== '0.5.2'
      || manifest.extension_version !== ZYLOS_TASK_VERSION || manifest.extension_id !== 'hxa-m1-zylos-task-v1'
      || !Array.isArray(manifest.files) || manifest.files.length < 314 || manifest.files.length > 1000) fail();
    const root = path.resolve(ZYLOS_SOURCE_ROOT);
    if (fs.realpathSync(root) !== root) fail();
    for (const protectedRoot of [config.stateRoot, config.homeDir, config.codexHome]) {
      if (typeof protectedRoot === 'string' && (root === path.resolve(protectedRoot) || root.startsWith(path.resolve(protectedRoot) + '/'))) fail();
    }
    const expected = manifest.files.map(entry => {
      if (!entry || typeof entry.path !== 'string' || !/^[A-Za-z0-9_.@/+\-]+$/u.test(entry.path)
        || entry.path.split('/').some(part => !part || part === '.' || part === '..')
        || !/^[a-f0-9]{64}$/u.test(entry.sha256) || ![0o644, 0o755].includes(entry.mode)) fail();
      const actual = readFile(path.join(root, entry.path), 4_194_304, requireRootOwned);
      if (sha(actual.bytes) !== entry.sha256 || actual.mode !== entry.mode) fail();
      return entry.path;
    });
    if (new Set(expected).size !== expected.length || JSON.stringify([...expected].sort()) !== JSON.stringify(treeFiles(root))) fail();
    if (sha(readFile(PATCH, 2_097_152, requireRootOwned).bytes) !== manifest.patch_sha256
      || sha(readFile(UPSTREAM, 262_144, requireRootOwned).bytes) !== manifest.upstream_manifest_sha256) fail();
    const pkg = JSON.parse(readFile(path.join(root, 'package.json'), 32_768, requireRootOwned).bytes);
    if (pkg.name !== 'zylos' || pkg.version !== ZYLOS_TASK_VERSION || pkg.license !== 'MIT') fail();
    return Object.freeze({
      api: ZYLOS_TASK_API, core_version: '0.5.2', core_commit: ZYLOS_CORE_COMMIT,
      extension_id: 'hxa-m1-zylos-task-v1', extension_version: ZYLOS_TASK_VERSION,
      patch_sha256: manifest.patch_sha256, source_manifest_sha256: sha(bytes),
      file_count: expected.length, root_managed: requireRootOwned,
    });
  } catch { fail(); }
}

/** Load only the explicitly selected, verified task-capable Core adapter. */
export async function loadTaskAdapter(config, options) {
  const source = verifyTaskSource(config, options);
  const module = await import(pathToFileURL(path.join(ZYLOS_SOURCE_ROOT, 'cli/lib/runtime/codex.js')).href);
  const adapter = new module.CodexAdapter({ taskMode: true });
  const capability = adapter.taskCapabilities?.();
  if (capability?.api !== source.api || capability?.supported !== true || capability?.runtime !== 'codex'
    || capability?.upstream_commit !== source.core_commit || capability?.extension_version !== source.extension_version
    || capability?.max_concurrency !== 1 || typeof adapter.runTask !== 'function' || typeof adapter.cancelTask !== 'function') fail();
  return adapter;
}

/** A report loads verified source but performs no readiness/authentication checks. */
export async function readTaskLedgerReport(stateRoot, options) {
  verifyTaskSource({ stateRoot }, options);
  const module = await import(pathToFileURL(path.join(ZYLOS_SOURCE_ROOT, 'cli/lib/runtime/task-runtime.js')).href);
  if (typeof module.inspectTaskLedger !== 'function') fail();
  return module.inspectTaskLedger(stateRoot);
}
