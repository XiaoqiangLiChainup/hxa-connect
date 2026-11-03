import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyTaskSource, loadTaskAdapter, readTaskLedgerReport } from '../scripts/zylos-runner/provenance.mjs';
import { checkSourcePackage } from '../scripts/build-zylos-task-source.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let temporary: string;
let markers: string[];

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-provenance-'));
  markers = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const marker of markers) delete (globalThis as any)[marker];
  fs.rmSync(temporary, { recursive: true, force: true });
});

function copyFile(relative: string, release: string) {
  const source = path.join(repository, relative);
  const target = path.join(release, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

async function sourceCopy() {
  const release = path.join(temporary, 'release');
  fs.mkdirSync(release, { mode: 0o755 });
  fs.cpSync(path.join(repository, 'vendor/zylos-core'), path.join(release, 'vendor/zylos-core'), {
    recursive: true, preserveTimestamps: true,
  });
  for (const relative of [
    'package.json', 'scripts/zylos-runner/provenance.mjs', 'scripts/zylos-runner/source-manifest.json',
    'scripts/task-runner/config.mjs', 'patches/zylos-core-0.5.2-task-runtime.patch', 'third_party/zylos-core-upstream.json',
  ]) copyFile(relative, release);
  const module = await import(/* @vite-ignore */ pathToFileURL(path.join(release, 'scripts/zylos-runner/provenance.mjs')).href);
  return { release, module, core: path.join(release, 'vendor/zylos-core'),
    manifest: path.join(release, 'scripts/zylos-runner/source-manifest.json') };
}

function rewriteManifest(copy: any, change: (value: any) => void) {
  const manifest = JSON.parse(fs.readFileSync(copy.manifest, 'utf8'));
  change(manifest);
  fs.writeFileSync(copy.manifest, JSON.stringify(manifest, null, 2) + '\n');
}

function rehash(copy: any, relative: string) {
  rewriteManifest(copy, manifest => {
    manifest.files.find((entry: any) => entry.path === relative).sha256 = sha(fs.readFileSync(path.join(copy.core, relative)));
  });
}

function importMarker(copy: any, includeInManifest = true) {
  const marker = `zylos_test_import_${randomUUID().replaceAll('-', '')}`;
  markers.push(marker);
  const relative = 'cli/lib/runtime/codex.js';
  const filename = path.join(copy.core, relative);
  fs.writeFileSync(filename, `globalThis[${JSON.stringify(marker)}] = true;\n${fs.readFileSync(filename, 'utf8')}`);
  if (includeInManifest) rehash(copy, relative);
  return marker;
}

describe('complete pinned Zylos source provenance', () => {
  it('verifies the actual full source and loads the actual patched Core without execution', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'scripts/zylos-runner/source-manifest.json'), 'utf8'));
    const report = verifyTaskSource({}, { requireRootOwned: false });
    expect(report).toMatchObject({ api: 'zylos-task-v1', core_version: '0.5.2',
      core_commit: '8ee9bd9007edab46f766f3574e0ad56cf69268c2', extension_version: '0.5.2+hxa.task.1',
      extension_id: 'hxa-m1-zylos-task-v1', file_count: 320, root_managed: false });
    expect(report.patch_sha256).toBe(sha(fs.readFileSync(path.join(repository, 'patches/zylos-core-0.5.2-task-runtime.patch'))));
    expect(report.source_manifest_sha256).toBe(sha(fs.readFileSync(path.join(repository, 'scripts/zylos-runner/source-manifest.json'))));
    expect(manifest.files).toHaveLength(320);
    const adapter = await loadTaskAdapter({}, { requireRootOwned: false });
    expect(adapter.taskCapabilities()).toMatchObject({ supported: true, api: 'zylos-task-v1',
      extension_version: '0.5.2+hxa.task.1', correlated_result: true, durable_intent: true });
    expect(typeof adapter.runTask).toBe('function');
    expect(typeof adapter.cancelTask).toBe('function');
  });

  it('reverse-applies the actual complete patch into temporary source and reproduces all 314 upstream files', () => {
    const report = checkSourcePackage();
    expect(report).toMatchObject({ scope: 'offline-source-package', verified: true,
      reversible_patch_verified: true, upstream_file_count: 314, file_count: 320,
      model_invoked: false, daemon_started: false, root_managed: false });
  });

  it('verifies an isolated byte-for-byte source copy before corruption', async () => {
    const copy = await sourceCopy();
    expect(copy.module.verifyTaskSource({}, { requireRootOwned: false }).file_count).toBe(320);
    const adapter = await copy.module.loadTaskAdapter({}, { requireRootOwned: false });
    expect(adapter.taskCapabilities().extension_version).toBe('0.5.2+hxa.task.1');
    expect(fs.existsSync(path.join(temporary, 'zylos'))).toBe(false);
  });

  it.each(['changed_code', 'missing_file', 'source_link', 'extra_file', 'wrong_version', 'wrong_mode',
    'patch_corruption', 'upstream_corruption', 'duplicate_manifest', 'manifest_traversal'])
    ('rejects %s in an isolated source copy before importing its marker code', async defect => {
      const copy = await sourceCopy();
      // For independent corruption cases, the marker is declared in this TEST
      // manifest. Only the separate defect should stop verification before import.
      const marker = importMarker(copy, defect !== 'changed_code');
      const readme = path.join(copy.core, 'README.md');
      let forbiddenTarget: string | undefined;
      if (defect === 'missing_file') fs.unlinkSync(readme);
      if (defect === 'source_link') {
        forbiddenTarget = path.join(temporary, 'synthetic-sensitive-file');
        fs.writeFileSync(forbiddenTarget, 'not-a-real-credential', { mode: 0o600 });
        fs.unlinkSync(readme);
        fs.symlinkSync(forbiddenTarget, readme);
      }
      if (defect === 'extra_file') fs.writeFileSync(path.join(copy.core, 'unexpected-runtime.js'), 'export const extra = true;\n');
      if (defect === 'wrong_version') {
        const filename = path.join(copy.core, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
        pkg.version = '0.5.2';
        fs.writeFileSync(filename, JSON.stringify(pkg, null, 2) + '\n');
        rehash(copy, 'package.json');
      }
      if (defect === 'wrong_mode') fs.chmodSync(readme, 0o600);
      if (defect === 'patch_corruption') fs.appendFileSync(path.join(copy.release, 'patches/zylos-core-0.5.2-task-runtime.patch'), '\ncorrupt\n');
      if (defect === 'upstream_corruption') fs.appendFileSync(path.join(copy.release, 'third_party/zylos-core-upstream.json'), '\ncorrupt\n');
      if (defect === 'duplicate_manifest') rewriteManifest(copy, manifest => { manifest.files[1] = { ...manifest.files[0] }; });
      if (defect === 'manifest_traversal') rewriteManifest(copy, manifest => { manifest.files[0].path = '../../synthetic-sensitive-file'; });
      const opened: string[] = [];
      const originalOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation(((filename: any, ...args: any[]) => {
        opened.push(String(filename));
        return (originalOpen as any)(filename, ...args);
      }) as any);
      expect(() => copy.module.verifyTaskSource({}, { requireRootOwned: false })).toThrow('provenance failed');
      await expect(copy.module.loadTaskAdapter({}, { requireRootOwned: false })).rejects.toThrow('provenance failed');
      expect((globalThis as any)[marker]).toBeUndefined();
      if (forbiddenTarget) {
        expect(opened).not.toContain(forbiddenTarget);
        expect(opened).not.toContain(readme);
      }
    });

  it('rejects a world-writable ancestor under real strict source trust', async () => {
    const copy = await sourceCopy();
    fs.chmodSync(temporary, 0o777);
    // Exact bytes pass offline inspection; a real worker must still reject the location.
    expect(copy.module.verifyTaskSource({}, { requireRootOwned: false }).file_count).toBe(320);
    expect(() => copy.module.verifyTaskSource()).toThrow('provenance failed');
    await expect(copy.module.loadTaskAdapter({})).rejects.toThrow('provenance failed');
  });

  it.each(['stateRoot', 'homeDir', 'codexHome'])('rejects source stored beneath the writable %s', async name => {
    const copy = await sourceCopy();
    expect(() => copy.module.verifyTaskSource({ [name]: copy.release }, { requireRootOwned: false })).toThrow('provenance failed');
  });

  it('projects an existing native task ledger read-only without credentials, lifecycle calls, or raw diagnostics', async () => {
    const stateRoot = path.join(temporary, 'state-root');
    const identity = { task_id: 'task-readonly', run_id: 'run-readonly', attempt: 2 };
    const executionId = randomUUID();
    const key = sha(JSON.stringify(identity));
    const directory = path.join(stateRoot, 'state', 'zylos-tasks', key);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const intent = { format: 'zylos-task-intent-v1', api: 'zylos-task-v1', ...identity,
      execution_id: executionId, payload_sha256: sha('fixture payload'), created_at: 1 };
    const status = { format: 'zylos-task-ledger-v1', ...identity, key, execution_id: executionId,
      payload_sha256: intent.payload_sha256, instruction_sha256: sha('instructions'), memory_sha256: sha('memory'),
      status: 'running', cleanup_complete: false, reconciliation_required: false, updated_at: 2, revision: 2,
      raw_error: 'synthetic-diagnostic-sentinel', raw_requirements: 'synthetic-task-sentinel' };
    for (const [name, value] of [['intent.json', intent], ['status.json', status]] as const) {
      fs.writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
    }
    const before = ['intent.json', 'status.json'].map(name => fs.readFileSync(path.join(directory, name), 'utf8'));
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('Read-only report attempted a write'); });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Read-only report attempted a rename'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Read-only report attempted a network request'); });
    const report = await readTaskLedgerReport(stateRoot, { requireRootOwned: false });
    expect(report).toMatchObject({ format: 'zylos-task-ledger-report-v1', reconciliation_required: true,
      records: [{ ...identity, key, execution_id: executionId, status: 'running', cleanup_complete: false, reconciliation_required: true }] });
    expect(JSON.stringify(report)).not.toContain('synthetic-diagnostic-sentinel');
    expect(JSON.stringify(report)).not.toContain('synthetic-task-sentinel');
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(['intent.json', 'status.json'].map(name => fs.readFileSync(path.join(directory, name), 'utf8'))).toEqual(before);
  });

  it('loads the read-only report in a real Node process without HOME, CODEX_HOME, or ZYLOS_DIR', () => {
    const stateRoot = path.join(temporary, 'empty-state-root');
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const moduleUrl = pathToFileURL(path.join(repository, 'scripts/zylos-runner/provenance.mjs')).href;
    const code = `const { readTaskLedgerReport } = await import(${JSON.stringify(moduleUrl)});\n`
      + `console.log(JSON.stringify(await readTaskLedgerReport(${JSON.stringify(stateRoot)}, { requireRootOwned: false })));\n`;
    const output = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: temporary, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 8000, maxBuffer: 262_144,
    });
    expect(output.error).toBeUndefined();
    expect(output.signal).toBeNull();
    expect(output.status, output.stderr).toBe(0);
    expect(output.stderr).toBe('');
    expect(JSON.parse(output.stdout)).toEqual({ format: 'zylos-task-ledger-report-v1', records: [], reconciliation_required: false });
    expect(fs.readdirSync(stateRoot)).toEqual([]);
  });
});
