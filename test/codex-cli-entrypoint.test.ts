import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../scripts/cli-entrypoint.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const scripts = ['codex-worker.mjs', 'task-runner.mjs', 'demo-tasks.mjs'];
let temporary: string;
let current: string;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-cli-entrypoint-'));
  // Exercise URL escaping as well as the deployed whole-release directory link.
  current = path.join(temporary, 'current # %');
  fs.symlinkSync(repository, current, 'dir');
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

function runNode(args: string[], cwd = temporary, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8',
    timeout: 5000, maxBuffer: 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function cliPath(script: string, mode: string) {
  const real = path.join(repository, 'scripts', script);
  const linked = path.join(current, 'scripts', script);
  if (mode === 'absolute') return real;
  if (mode === 'relative') return path.relative(temporary, real);
  if (mode === 'directory link') return linked;
  if (mode === 'relative directory link') return path.relative(temporary, linked);
  if (mode === 'preserved directory link') return linked;
  const fileLink = path.join(temporary, `linked # % ${script}`);
  fs.symlinkSync(real, fileLink);
  return fileLink;
}

describe('real CLI subprocess entrypoints, without credentials or model calls', () => {
  it.each(['absolute', 'relative', 'directory link', 'relative directory link', 'file link', 'preserved directory link'])(
    'executes Codex help and rejects an unconfigured check via %s', mode => {
      const entry = cliPath('codex-worker.mjs', mode);
      const flags = mode === 'preserved directory link' ? ['--preserve-symlinks-main'] : [];
      const help = runNode([...flags, entry, '--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: node scripts/codex-worker.mjs --check');
      expect(help.stderr).toBe('');
      const check = runNode([...flags, entry, '--check']);
      expect(check.status).toBe(2);
      expect(check.stderr).toContain('Codex worker:');
      expect(check.stderr).toContain('HXA_TASK_URL');
      expect(check.stdout).toBe('');
    },
  );

  it.each(['task-runner.mjs', 'demo-tasks.mjs'])('also executes %s help through the release symlink', script => {
    const result = runNode([cliPath(script, 'relative directory link'), '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Usage: node scripts/${script}`);
    expect(result.stderr).toBe('');
  });

  it('actually emits failed readiness JSON through current, without a token or executable', () => {
    const state = path.join(temporary, 'state');
    const home = path.join(temporary, 'home');
    const codexHome = path.join(home, 'codex');
    for (const directory of [state, home, codexHome]) fs.mkdirSync(directory, { mode: 0o700 });
    const result = runNode([cliPath('codex-worker.mjs', 'directory link'), '--check'], temporary, {
      HXA_TASK_URL: 'http://127.0.0.1:4801',
      HXA_TASK_TOKEN_FILE: path.join(temporary, 'absent-token'),
      HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test',
      HXA_RUNNER_ID: 'offline-entrypoint-test', HXA_CODEX_STATE_DIR: state,
      HXA_CODEX_BIN: path.join(temporary, 'absent-codex'),
      HXA_CODEX_HOME_DIR: home, CODEX_HOME: codexHome,
      HXA_CODEX_MODEL: 'offline-model-fixture', HXA_CODEX_REASONING_EFFORT: 'medium',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    const readiness = JSON.parse(result.stdout);
    expect(readiness).toMatchObject({ ready: false, codex_version_required: '0.166.0', model: 'offline-model-fixture' });
    expect(readiness.checks).toHaveLength(10);
    for (const name of ['hub_token_file', 'trusted_codex_executable', 'codex_0_166_0', 'dedicated_chatgpt_login_configured']) {
      expect(readiness.checks).toContainEqual({ name, passed: false });
    }
    expect(fs.existsSync(path.join(temporary, 'absent-token'))).toBe(false);
    expect(fs.readdirSync(state)).toEqual([]);
    expect(fs.readdirSync(codexHome)).toEqual([]);
  });

  it.each(scripts)('does not execute imported %s in a wrapper, eval, or a distinct URL', script => {
    const entry = path.join(repository, 'scripts', script);
    const url = pathToFileURL(entry).href;
    const wrapper = path.join(temporary, 'wrapper.mjs');
    fs.writeFileSync(wrapper, `await import(${JSON.stringify(url)}); console.log('import-only');\n`);
    const commands = [
      [wrapper, '--help'],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)}); console.log('import-only');`],
      // argv[1] matches the module here; it is still imported, not the CLI entrypoint.
      ['--input-type=module', '--eval', `await import(${JSON.stringify(url)}); console.log('import-only');`, entry, '--help'],
      ['--input-type=module', '--eval', `await import(${JSON.stringify(`${url}?imported=1#test`)}); console.log('import-only');`, entry, '--help'],
    ];
    for (const args of commands) {
      const result = runNode(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('import-only\n');
      expect(result.stderr).toBe('');
    }
  });
});

describe('entrypoint compatibility for Node without import.meta.main', () => {
  function fallback(url: string, entry?: string, execArgv: string[] = []) {
    return isMainModule({ url }, { argv: entry ? [process.execPath, entry] : [process.execPath], execArgv });
  }

  it('resolves both sides of directory/file symlinks and encoded file URLs', () => {
    const real = path.join(temporary, 'entry # %.mjs');
    const link = path.join(temporary, 'link.mjs');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, link);
    expect(fallback(pathToFileURL(real).href, link)).toBe(true);
    expect(fallback(pathToFileURL(link).href, real)).toBe(true);
    expect(fallback(pathToFileURL(path.join(repository, 'scripts/codex-worker.mjs')).href,
      path.join(current, 'scripts/codex-worker.mjs'))).toBe(true);
    expect(fallback(pathToFileURL(real).href, path.relative(process.cwd(), link))).toBe(true);
  });

  it('honors native false even if argv names the same imported module', () => {
    const entry = path.join(repository, 'scripts/codex-worker.mjs');
    expect(isMainModule({ url: pathToFileURL(entry).href, main: false }, { argv: [process.execPath, entry] })).toBe(false);
  });

  it('rejects eval, print, stdin and distinct import URLs instead of starting a worker', () => {
    const entry = path.join(repository, 'scripts/codex-worker.mjs');
    const url = pathToFileURL(entry).href;
    for (const execArgv of [['-e', ''], ['--eval='], ['-p', ''], ['--print='], ['--input-type=module']]) {
      expect(fallback(url, entry, execArgv)).toBe(false);
    }
    for (const suffix of ['?imported', '#imported']) expect(fallback(url + suffix, entry)).toBe(false);
    expect(fallback(url, '-')).toBe(false);
    expect(fallback(url)).toBe(false);
  });

  it('returns false for another module, a missing path, or an invalid/non-file URL', () => {
    const entry = path.join(repository, 'scripts/codex-worker.mjs');
    expect(fallback(pathToFileURL(path.join(repository, 'scripts/task-runner.mjs')).href, entry)).toBe(false);
    expect(fallback(pathToFileURL(entry).href, path.join(temporary, 'absent'))).toBe(false);
    expect(fallback(pathToFileURL(path.join(temporary, 'absent')).href, entry)).toBe(false);
    for (const url of ['not a URL', 'https://example.test/entry.mjs', 'data:text/javascript,']) {
      expect(fallback(url, entry)).toBe(false);
    }
  });
});
