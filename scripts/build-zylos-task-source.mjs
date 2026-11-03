#!/usr/bin/env node
/** Reproducible source packaging only. No npm lifecycle, daemon, network or model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './cli-entrypoint.mjs';
import { verifyTaskSource, ZYLOS_CORE_COMMIT, ZYLOS_SOURCE_ROOT, ZYLOS_TASK_API, ZYLOS_TASK_VERSION } from './zylos-runner/provenance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const patchFile = path.join(root, 'patches/zylos-core-0.5.2-task-runtime.patch');
const upstreamFile = path.join(root, 'third_party/zylos-core-upstream.json');
const manifestFile = path.join(root, 'scripts/zylos-runner/source-manifest.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
function git(directory, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', directory, ...args],
    { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4_194_304, timeout: 30_000 });
}
function listFiles(directory, prefix = '') {
  const names = [];
  for (const item of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (!prefix && item.name === '.git') continue;
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) names.push(...listFiles(directory, relative));
    else if (item.isFile()) names.push(relative);
    else throw new Error('Source trees must not contain links or special files.');
  }
  return names.sort();
}
function describe(directory, names = listFiles(directory)) {
  return names.map(name => {
    const file = path.join(directory, name), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || fs.realpathSync(file) !== path.resolve(file)) throw new Error('Invalid source file.');
    return { path: name, mode: info.mode & 0o777, sha256: hash(fs.readFileSync(file)) };
  });
}
function copyFiles(source, destination, names) {
  for (const name of names) {
    const file = path.join(source, name), target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(file, target);
    fs.chmodSync(target, fs.statSync(file).mode & 0o777);
  }
}
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function save(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o644 });
}

function writePackage(upstream) {
  if (!path.isAbsolute(upstream) || fs.realpathSync(upstream) !== upstream
    || git(upstream, ['rev-parse', 'HEAD']).toString().trim() !== ZYLOS_CORE_COMMIT
    || git(upstream, ['status', '--porcelain', '--untracked-files=no']).length) throw new Error('A pristine exact upstream checkout is required.');
  const names = git(upstream, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean).sort();
  const original = describe(upstream, names);
  const current = describe(ZYLOS_SOURCE_ROOT);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-source-package-'));
  let patch;
  try {
    copyFiles(upstream, temporary, names);
    git(temporary, ['init', '-q']);
    git(temporary, ['add', '--force', '--all']);
    git(temporary, ['-c', 'user.name=HXA source packaging', '-c', 'user.email=source-package@example.invalid',
      'commit', '--quiet', '-m', 'Pinned upstream source']);
    for (const file of names) if (!fs.existsSync(path.join(ZYLOS_SOURCE_ROOT, file))) fs.unlinkSync(path.join(temporary, file));
    copyFiles(ZYLOS_SOURCE_ROOT, temporary, current.map(item => item.path));
    git(temporary, ['add', '--force', '--all']);
    patch = git(temporary, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--']);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const upstreamBytes = jsonBytes({ format: 'hxa-zylos-upstream-v1', repository: 'https://github.com/zylos-ai/zylos-core',
    tag: 'v0.5.2', core_commit: ZYLOS_CORE_COMMIT, version: '0.5.2', license: 'MIT', files: original });
  save(patchFile, patch);
  save(upstreamFile, upstreamBytes);
  save(manifestFile, jsonBytes({ format: 'hxa-zylos-task-source-v1', api: ZYLOS_TASK_API,
    core_commit: ZYLOS_CORE_COMMIT, core_version: '0.5.2', extension_id: 'hxa-m1-zylos-task-v1',
    extension_version: ZYLOS_TASK_VERSION, patch_sha256: hash(patch), upstream_manifest_sha256: hash(upstreamBytes), files: current }));
}

export function checkSourcePackage() {
  const report = verifyTaskSource({}, { requireRootOwned: false });
  const original = JSON.parse(fs.readFileSync(upstreamFile, 'utf8'));
  if (original.core_commit !== ZYLOS_CORE_COMMIT || original.version !== '0.5.2' || !Array.isArray(original.files)) throw new Error('Invalid upstream manifest.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-source-reverse-'));
  try {
    copyFiles(ZYLOS_SOURCE_ROOT, temporary, listFiles(ZYLOS_SOURCE_ROOT));
    git(temporary, ['apply', '--reverse', '--check', patchFile]);
    git(temporary, ['apply', '--reverse', patchFile]);
    if (JSON.stringify(describe(temporary)) !== JSON.stringify(original.files)) throw new Error('Reversed source does not match the original fixed tree.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { scope: 'offline-source-package', verified: true, ...report, reversible_patch_verified: true,
    upstream_file_count: original.files.length, model_invoked: false, daemon_started: false };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/build-zylos-task-source.mjs --check\n       node scripts/build-zylos-task-source.mjs --write --upstream <absolute-pristine-checkout>\nOffline source verification/regeneration only. No install, host policy, model, or runtime action.');
    return 0;
  }
  if (args.length === 3 && args[0] === '--write' && args[1] === '--upstream') writePackage(args[2]);
  else if (args.length !== 1 || args[0] !== '--check') throw new Error('Invalid packaging arguments.');
  console.log(JSON.stringify(checkSourcePackage(), null, 2));
  return 0;
}

if (isMainModule(import.meta)) {
  try { process.exitCode = main(); }
  catch { console.error('Zylos source package verification failed. Use an intact fixed release; no installation or execution was attempted.'); process.exitCode = 2; }
}
