import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZYLOS_ENGINE_CHECKS } from '../scripts/zylos-runner/config.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(repository, 'scripts/zylos-worker.mjs');
let temporary: string;
let current: string;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-zylos-cli-'));
  current = path.join(temporary, 'current # %');
  fs.symlinkSync(repository, current, 'dir');
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

function runNode(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: temporary, env: { PATH: '/usr/bin:/bin', HOME: path.join(temporary, 'empty-home'), ...extra },
    encoding: 'utf8', timeout: 8000, maxBuffer: 1_048_576,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function runNodeAsync(args: string[], extra: NodeJS.ProcessEnv) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: temporary, env: { PATH: '/usr/bin:/bin', HOME: path.join(temporary, 'empty-home'), ...extra },
      encoding: 'utf8', timeout: 8000, maxBuffer: 1_048_576,
    }, (error: any, stdout, stderr) => {
      if (error?.killed || error?.signal || (error && typeof error.code !== 'number')) reject(error);
      else resolve({ status: error?.code ?? 0, stdout, stderr });
    });
  });
}

function fixtureEnvironment(expiresAt = '2099-11-04T06:38:16.417Z', hub = 'http://127.0.0.1:4801') {
  return {
    HXA_TASK_URL: hub,
    HXA_TASK_TOKEN_FILE: path.join(temporary, 'credentials', 'absent-token'),
    HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test', HXA_RUNNER_ID: 'zylos-cli-offline',
    HXA_CODEX_STATE_DIR: path.join(temporary, 'missing-state'),
    HXA_CODEX_BIN: path.join(temporary, 'absent-codex'),
    HXA_CODEX_HOME_DIR: path.join(temporary, 'missing-model-home'),
    CODEX_HOME: path.join(temporary, 'missing-model-home', 'codex'),
    HXA_CODEX_MODEL: 'offline-model-fixture', HXA_CODEX_REASONING_EFFORT: 'medium',
    HXA_ZYLOS_TOKEN_EXPIRES_AT: expiresAt,
  };
}

function cliPath(mode: string) {
  if (mode === 'absolute') return entry;
  if (mode === 'relative') return path.relative(temporary, entry);
  const linked = path.join(current, 'scripts/zylos-worker.mjs');
  if (mode === 'directory_link' || mode === 'preserved_directory_link') return linked;
  if (mode === 'relative_directory_link') return path.relative(temporary, linked);
  const fileLink = path.join(temporary, 'zylos-worker # %.mjs');
  fs.symlinkSync(entry, fileLink);
  return fileLink;
}

describe('actual Zylos task CLI without auth, model, or Hub operations', () => {
  it.each(['absolute', 'relative', 'directory_link', 'relative_directory_link', 'file_link', 'preserved_directory_link'])
    ('prints actual nonempty help via %s and rejects absent configuration', mode => {
      const filename = cliPath(mode);
      const flags = mode === 'preserved_directory_link' ? ['--preserve-symlinks-main'] : [];
      const help = runNode([...flags, filename, '--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: node scripts/zylos-worker.mjs --check | --report | --zylos [--once]');
      expect(help.stdout).toContain('0.5.2+hxa.task.1');
      expect(help.stderr).toBe('');
      const check = runNode([...flags, filename, '--check']);
      expect(check.status).toBe(2);
      expect(check.stdout).toBe('');
      expect(check.stderr).toContain('Zylos Task worker:');
      expect(check.stderr).toContain('HXA_TASK_URL');
    });

  it('imports quietly through wrapper, eval, and a distinct URL even when argv names the CLI', () => {
    const url = pathToFileURL(entry).href;
    const wrapper = path.join(temporary, 'wrapper.mjs');
    fs.writeFileSync(wrapper, `await import(${JSON.stringify(url)});\n`);
    for (const args of [
      [wrapper, '--help'],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)});`],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)});`, entry, '--help'],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(`${url}?import-only=1#quiet`)});`, entry, '--zylos'],
    ]) {
      const outcome = runNode(args);
      expect(outcome.status).toBe(0);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toBe('');
    }
  });

  it.each(['2099-11-04T06:38:16.417Z', '2020-11-04T06:38:16.417Z'])
    ('emits all 20 actual failed-readiness checks and preserves precise expiry %s', expiresAt => {
      const output = runNode([path.join(current, 'scripts/zylos-worker.mjs'), '--check'], fixtureEnvironment(expiresAt));
      expect(output.status).toBe(2);
      expect(output.stderr).toBe('');
      const report = JSON.parse(output.stdout);
      expect(report).toMatchObject({ scope: 'zylos-task-local-prerequisites', ready: false,
        executor: 'zylos-core-task', engine: 'codex-exec', api: 'zylos-task-v1',
        codex_version_required: '0.166.0', model: 'offline-model-fixture',
        model_invoked: false, hub_contacted: false, existing_zylos_session_accessed: false });
      expect(report.checks).toHaveLength(20);
      expect(new Set(report.checks.map((item: any) => item.name)).size).toBe(20);
      expect(report.checks.map((item: any) => item.name)).toEqual([
        'zylos_pinned_task_source', 'zylos_explicit_task_runtime', ...ZYLOS_ENGINE_CHECKS, 'zylos_execution_window',
      ]);
      expect(report.checks.every((item: any) => typeof item.passed === 'boolean')).toBe(true);
      for (const name of ['private_state_directory', 'dedicated_model_directories', 'hub_token_file',
        'trusted_codex_executable', 'codex_0_166_0', 'dedicated_chatgpt_login_configured', 'sandbox_task_history_reads_denied']) {
        expect(report.checks).toContainEqual({ name, passed: false });
      }
      expect(report.execution_window).toMatchObject({ expires_at: expiresAt,
        token_auth_verified: false, task_selected: false, renewal_performed: false,
        window_adequate: expiresAt.startsWith('2099') });
      if (expiresAt.startsWith('2020')) expect(report.execution_window.code).toBe('TOKEN_EXPIRED');
      expect(fs.existsSync(path.join(temporary, 'missing-state'))).toBe(false);
      expect(fs.existsSync(path.join(temporary, 'missing-model-home'))).toBe(false);
      expect(fs.existsSync(path.join(temporary, 'credentials'))).toBe(false);
    });

  it('performs no HTTP or model-binary invocation during failed real CLI readiness', async () => {
    let contacts = 0;
    const server = http.createServer((_request, response) => { contacts++; response.writeHead(500); response.end(); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as { port: number };
    const marker = path.join(temporary, 'forbidden-executable-called');
    const binary = path.join(temporary, 'codex-sentinel');
    fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'invoked');\nprocess.exit(91);\n`, { mode: 0o700 });
    try {
      const output = await runNodeAsync([entry, '--check'], {
        ...fixtureEnvironment('2099-11-04T06:38:16.417Z', `http://127.0.0.1:${address.port}`), HXA_CODEX_BIN: binary,
      });
      expect(output.status).toBe(2);
      expect(JSON.parse(output.stdout).ready).toBe(false);
      expect(contacts).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['argument', 'inline_token', 'url_credential', 'expiry', 'bypass'])('does not echo synthetic credentials from %s errors', mode => {
    const sentinel = 'synthetic-secret-never-echo-61729';
    const env: NodeJS.ProcessEnv = fixtureEnvironment();
    let args = [entry, '--check'];
    if (mode === 'argument') args = [entry, '--token', sentinel];
    if (mode === 'inline_token') env.HXA_TASK_TOKEN = sentinel;
    if (mode === 'url_credential') env.HXA_TASK_URL = `https://${sentinel}@agents.example.test`;
    if (mode === 'expiry') env.HXA_ZYLOS_TOKEN_EXPIRES_AT = sentinel;
    if (mode === 'bypass') env.CODEX_BYPASS_PERMISSIONS = sentinel;
    const output = runNode(args, env);
    expect(output.status).toBe(2);
    expect(output.stdout + output.stderr).not.toContain(sentinel);
    expect(output.stderr).toContain('Zylos Task worker:');
  });

  it.each(['--force', '--accept-risk', '--require-root-owned=false', '--codex', '--mock'])
    ('has no CLI fallback or provenance override %s', option => {
      const output = runNode([entry, option], fixtureEnvironment());
      expect(output.status).toBe(2);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain('Unknown or repeated Zylos worker option');
    });
});
