import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ZYLOS_UPSTREAM, ZYLOS_SOURCE_FILES } from './upstream.mjs';
import { assessZylosM1Capability } from './contract.mjs';

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_PACKAGE_BYTES = 32_768;

export class ZylosInspectionError extends Error {
  constructor() {
    super('Provide an absolute Zylos root and exactly one absolute launcher or package-root path. No installed program is executed.');
    this.code = 'ZYLOS_INSPECTION_ARGUMENTS';
  }
}

function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value)
    || /[\u0000-\u001f\u007f]/u.test(value) || path.resolve(value) === '/') throw new ZylosInspectionError();
  return path.resolve(value);
}

function safeError(error) {
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return 'SOURCE_MISSING';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'SOURCE_UNREADABLE';
  return 'SOURCE_NOT_VERIFIED';
}

/** Bounded source reads only; reject redirects to credentials and changing files. */
function sourceFile(filename, expectedSuffix, expectedSha256, maximum = MAX_SOURCE_BYTES) {
  let fd;
  try {
    const real = fs.realpathSync(filename);
    if (!real.endsWith('/' + expectedSuffix) || /[\u0000-\u001f\u007f]/u.test(real)) throw new Error();
    const entry = fs.lstatSync(real);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 1 || entry.size > maximum) throw new Error();
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== entry.dev || before.ino !== entry.ino
      || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) throw new Error();
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || fs.realpathSync(filename) !== real) throw new Error();
    const current = fs.lstatSync(real);
    if (current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw new Error();
    const bytes = buffer.subarray(0, count);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      evidence: { status: 'read', sha256, matches_upstream: sha256 === expectedSha256,
        canonical_path: real, linked: real !== filename, uid: before.uid,
        mode: (before.mode & 0o777).toString(8).padStart(4, '0'), size_bytes: count },
      bytes,
    };
  } catch (error) {
    return { evidence: { status: safeError(error), matches_upstream: false }, bytes: null };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function packageIdentity(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { name_matches: value?.name === 'zylos', version: typeof value?.version === 'string'
      && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value.version) ? value.version : null };
  } catch { return { name_matches: false, version: null }; }
}

/**
 * Inspect only a fixed list of public program files. Never import foreign code,
 * run zylos/checkAuth/doctor/C4, open a live DB, or inspect auth/config/logs/env.
 * Installed-source matching does not attest which code a running process loaded.
 */
export function inspectZylosSource({ root, launcher, packageRoot } = {}) {
  root = absolute(root);
  if (Boolean(launcher) === Boolean(packageRoot)) throw new ZylosInspectionError();
  let locatedRoot = null, launcherStatus = 'not_supplied';
  if (launcher) {
    launcher = absolute(launcher);
    try {
      const real = fs.realpathSync(launcher);
      if (!real.endsWith('/cli/zylos.js') || /[\u0000-\u001f\u007f]/u.test(real)) throw new Error();
      locatedRoot = path.dirname(path.dirname(real));
      launcherStatus = 'source_path_resolved_without_execution';
    } catch (error) { launcherStatus = safeError(error); }
  } else {
    locatedRoot = absolute(packageRoot);
  }
  const files = [];
  let identity = { name_matches: false, version: null };
  for (const source of ZYLOS_SOURCE_FILES) {
    const deployedBridge = source.relativePath.startsWith('skills/comm-bridge/');
    const label = deployedBridge ? 'installed_bridge' : 'installed_package';
    const filename = deployedBridge
      ? path.join(root, '.claude', source.relativePath)
      : locatedRoot && path.join(locatedRoot, source.relativePath);
    const suffix = deployedBridge ? source.relativePath.slice('skills/'.length) : source.relativePath;
    const result = filename ? sourceFile(filename, suffix, source.sha256,
      source.relativePath === 'package.json' ? MAX_PACKAGE_BYTES : MAX_SOURCE_BYTES)
      : { evidence: { status: 'PACKAGE_ROOT_NOT_RESOLVED', matches_upstream: false }, bytes: null };
    if (source.relativePath === 'package.json' && result.bytes) identity = packageIdentity(result.bytes);
    files.push({ scope: label, source: source.relativePath, expected_sha256: source.sha256, ...result.evidence });
  }
  const inspectionComplete = files.every(file => file.status === 'read') && identity.name_matches && identity.version !== null;
  const sourceReview = inspectionComplete
    ? identity.version === ZYLOS_UPSTREAM.version && files.every(file => file.matches_upstream)
      ? 'matches_reviewed_upstream' : 'different_source_requires_review'
    : 'incomplete_source_evidence';
  return {
    format: 'hxa-zylos-source-evidence-v1', scope: 'static-source-only', captured_at: new Date().toISOString(),
    root, package_root: locatedRoot, launcher_status: launcherStatus, upstream: ZYLOS_UPSTREAM,
    package: identity, source_review: sourceReview, inspection_complete: inspectionComplete,
    files, capability: assessZylosM1Capability(sourceReview),
    runtime_verified: false, auth_inspected: false, c4_dispatched: false, hub_contacted: false,
  };
}
