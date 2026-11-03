import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigurationError, normalizeBaseUrl, readConfiguration } from '../task-runner/config.mjs';

const executeFile = promisify(execFile);
export const CODEX_VERSION = '0.166.0';
export const LIMITS = Object.freeze({
  timeoutMs: 1_800_000, termGraceMs: 10_000, maxStdoutBytes: 8_388_608,
  maxStderrBytes: 2_097_152, maxResultBytes: 65_536, maxFileBytes: 5_242_880,
  maxArtifactBytes: 10_485_760, uploadTimeoutMs: 30_000, minFreeBytes: 1_073_741_824,
});

function setting(env, name, fallback, min, max) {
  if (!env[name]) return fallback;
  if (!/^\d+$/.test(env[name])) throw new ConfigurationError(`${name} must be an integer.`);
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new ConfigurationError(`${name} must be an absolute local path.`);
  }
  const normalized = path.resolve(value);
  if (normalized === '/') throw new ConfigurationError(`${name} cannot be the filesystem root.`);
  return normalized;
}

export function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function parseCodexArguments(args) {
  if (args.some(arg => !['--codex', '--once', '--check', '--report', '--help', '-h'].includes(arg))) {
    throw new ConfigurationError('Unknown Codex worker option. Use --help; credentials are never command arguments.');
  }
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const modes = ['--codex', '--check', '--report'].filter(arg => args.includes(arg));
  if (modes.length !== 1 || (args.includes('--once') && modes[0] !== '--codex')) {
    throw new ConfigurationError('Choose --codex [--once], --check, or --report explicitly.');
  }
  return { mode: modes[0].slice(2), once: args.includes('--once') };
}

export function readStateDirectory(env = process.env) {
  return absolutePath(env.HXA_CODEX_STATE_DIR, 'HXA_CODEX_STATE_DIR');
}

/** Parse only operator configuration. Task content never selects a path or executable. */
export function readCodexConfiguration(env = process.env) {
  if (env.HXA_TASK_TOKEN) {
    throw new ConfigurationError('The real worker requires HXA_TASK_TOKEN_FILE; remove HXA_TASK_TOKEN from its environment.');
  }
  const url = normalizeBaseUrl(env.HXA_TASK_URL);
  const hub = new URL(url);
  if (hub.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(hub.hostname)) {
    throw new ConfigurationError('HXA_TASK_URL requires HTTPS except for a loopback Hub.');
  }
  let publicBaseUrl;
  try { publicBaseUrl = normalizeBaseUrl(env.HXA_ARTIFACT_PUBLIC_BASE_URL); } catch {
    throw new ConfigurationError('HXA_ARTIFACT_PUBLIC_BASE_URL must be an absolute HTTPS base without credentials, query, or fragment.');
  }
  if (new URL(publicBaseUrl).protocol !== 'https:' || publicBaseUrl.length > 1500) {
    throw new ConfigurationError('HXA_ARTIFACT_PUBLIC_BASE_URL must use HTTPS and fit within artifact URL limits.');
  }
  const stateRoot = readStateDirectory(env);
  const codexBin = absolutePath(env.HXA_CODEX_BIN, 'HXA_CODEX_BIN');
  const homeDir = absolutePath(env.HXA_CODEX_HOME_DIR, 'HXA_CODEX_HOME_DIR');
  const codexHome = absolutePath(env.CODEX_HOME, 'CODEX_HOME');
  const tokenFile = absolutePath(env.HXA_TASK_TOKEN_FILE, 'HXA_TASK_TOKEN_FILE');
  if (codexHome === homeDir || !isInside(homeDir, codexHome)) {
    throw new ConfigurationError('CODEX_HOME must be a separate directory inside the dedicated HXA_CODEX_HOME_DIR.');
  }
  if (isInside(stateRoot, homeDir) || isInside(homeDir, stateRoot)) {
    throw new ConfigurationError('Worker state and dedicated model HOME must be separate directories.');
  }
  for (const protectedPath of [tokenFile, codexBin]) {
    if (isInside(stateRoot, protectedPath) || isInside(homeDir, protectedPath)) {
      throw new ConfigurationError('The token file and executable must be outside writable worker state and model HOME.');
    }
  }
  const model = env.HXA_CODEX_MODEL;
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) {
    throw new ConfigurationError('HXA_CODEX_MODEL must explicitly pin an approved model identifier.');
  }
  const reasoningEffort = env.HXA_CODEX_REASONING_EFFORT;
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
    throw new ConfigurationError('HXA_CODEX_REASONING_EFFORT must explicitly select minimal, low, medium, high, or xhigh.');
  }
  const childPath = env.HXA_CODEX_CHILD_PATH || '/usr/local/bin:/usr/bin:/bin';
  if (childPath.split(':').some(value => !value || !path.isAbsolute(value) || /[\r\n\0]/.test(value))) {
    throw new ConfigurationError('HXA_CODEX_CHILD_PATH must contain only explicit absolute executable directories.');
  }
  const profile = env.HXA_CODEX_PROFILE || 'feedback-demo';
  if (!['feedback-demo', 'files'].includes(profile)) throw new ConfigurationError('HXA_CODEX_PROFILE must be feedback-demo or files.');
  const runner = readConfiguration({ ...env, HXA_TASK_TOKEN: 'configuration-only', HXA_TASK_URL: url });
  delete runner.token;
  const config = {
    ...runner, url, publicBaseUrl, stateRoot, codexBin, codexHome, homeDir, tokenFile,
    model, reasoningEffort, childPath, profile, maxArtifacts: 19,
    requiredArtifacts: profile === 'feedback-demo' ? ['index.html', 'README.md'] : [],
    timeoutMs: setting(env, 'HXA_CODEX_TASK_TIMEOUT_MS', LIMITS.timeoutMs, 1000, 43_200_000),
    termGraceMs: setting(env, 'HXA_CODEX_TERM_GRACE_MS', LIMITS.termGraceMs, 100, 10_000),
    maxStdoutBytes: setting(env, 'HXA_CODEX_MAX_STDOUT_BYTES', LIMITS.maxStdoutBytes, 1024, 16_777_216),
    maxStderrBytes: setting(env, 'HXA_CODEX_MAX_STDERR_BYTES', LIMITS.maxStderrBytes, 1024, 8_388_608),
    maxResultBytes: setting(env, 'HXA_CODEX_MAX_RESULT_BYTES', LIMITS.maxResultBytes, 1024, 262_144),
    maxFileBytes: setting(env, 'HXA_CODEX_MAX_FILE_BYTES', LIMITS.maxFileBytes, 65_536, 26_214_400),
    maxArtifactBytes: setting(env, 'HXA_CODEX_MAX_ARTIFACT_BYTES', LIMITS.maxArtifactBytes, 131_072, 52_428_800),
    uploadTimeoutMs: setting(env, 'HXA_CODEX_UPLOAD_TIMEOUT_MS', LIMITS.uploadTimeoutMs, 100, 60_000),
    minFreeBytes: setting(env, 'HXA_CODEX_MIN_FREE_BYTES', LIMITS.minFreeBytes, 268_435_456, 1_099_511_627_776),
  };
  if (config.maxFileBytes > config.maxArtifactBytes) throw new ConfigurationError('The file limit cannot exceed the total artifact limit.');
  return config;
}

/** No directory component may be a symlink. Do not repair ownership automatically. */
export function assertPrivateDirectory(directory, uid = process.getuid?.()) {
  const resolved = absolutePath(directory, 'Worker directory');
  let current = path.parse(resolved).root;
  for (const component of resolved.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ConfigurationError('A worker directory is missing, linked, or not a directory.');
  }
  const st = fs.statSync(resolved);
  if (st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new ConfigurationError('Worker state, model HOME, and CODEX_HOME must be owned by the service user with mode 0700.');
  }
  return resolved;
}

function inspectTokenFile(tokenFile) {
  const fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 16_384 || (st.mode & 0o037) !== 0) {
      throw new ConfigurationError('The Hub token must be a bounded ordinary file, owner-readable and at most group-readable.');
    }
    return { fd, st };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function readHubToken(tokenFile) {
  const { fd } = inspectTokenFile(tokenFile);
  try {
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!token || /\s|[\x00-\x1f\x7f]/.test(token)) throw new ConfigurationError('The Hub token file must contain one bearer token.');
    return token;
  } finally { fs.closeSync(fd); }
}

function assertRootManagedPath(value) {
  // Check both spellings: a trusted target behind a replaceable symlink is not a trusted launcher.
  for (const candidate of new Set([path.resolve(value), fs.realpathSync(value)])) {
    for (let current = candidate; ; current = path.dirname(current)) {
      const st = fs.lstatSync(current);
      if (st.uid !== 0 || (!st.isSymbolicLink() && (st.mode & 0o022) !== 0)) throw new Error('Untrusted executable path');
      if (current === path.dirname(current)) break;
    }
  }
}

/** Local checks only; --version and login status do not submit an inference task. */
export async function preflight(config, { execute = executeFile, uid = process.getuid?.(), platform = process.platform } = {}) {
  const checks = [];
  const check = async (name, action) => {
    try { await action(); checks.push({ name, passed: true }); }
    catch { checks.push({ name, passed: false }); }
  };
  await check('linux_non_root_user', () => { if (platform !== 'linux' || !Number.isInteger(uid) || uid === 0) throw new Error(); });
  await check('node_22_or_later', () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(); });
  await check('private_state_directory', () => assertPrivateDirectory(config.stateRoot, uid));
  await check('dedicated_model_directories', () => {
    assertPrivateDirectory(config.homeDir, uid);
    assertPrivateDirectory(config.codexHome, uid);
  });
  await check('hub_token_file', () => { const { fd } = inspectTokenFile(config.tokenFile); fs.closeSync(fd); });
  await check('free_disk_budget', () => {
    const st = fs.statfsSync(config.stateRoot, { bigint: true });
    if (st.bavail * st.bsize < BigInt(config.minFreeBytes)) throw new Error();
  });
  await check('trusted_codex_executable', () => {
    const real = fs.realpathSync(config.codexBin);
    if (isInside(config.stateRoot, real) || isInside(config.homeDir, real)) throw new Error();
    fs.accessSync(real, fs.constants.X_OK);
    if (!fs.statSync(real).isFile()) throw new Error();
    assertRootManagedPath(config.codexBin);
    // Subsequent version checks and task spawns use the verified target, not a
    // possibly multi-hop symlink spelling whose intermediate nodes could change.
    config.codexBin = real;
  });
  await check('trusted_child_path', () => {
    const canonical = [];
    for (const directory of config.childPath.split(':')) {
      if (!fs.statSync(directory).isDirectory()) throw new Error();
      assertRootManagedPath(directory);
      canonical.push(fs.realpathSync(directory));
    }
    config.childPath = [...new Set(canonical)].join(':');
  });
  // Never invoke an executable that failed provenance checks or use another user's HOME.
  const ready = ['linux_non_root_user', 'dedicated_model_directories', 'trusted_codex_executable', 'trusted_child_path']
    .every(name => checks.find(value => value.name === name)?.passed);
  const childEnv = { HOME: config.homeDir, CODEX_HOME: config.codexHome, PATH: config.childPath, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  await check('codex_0_166_0', async () => {
    if (!ready) throw new Error();
    const result = await execute(config.codexBin, ['--version'], { env: childEnv, timeout: 5000, maxBuffer: 8192 });
    if (result.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error();
  });
  await check('dedicated_chatgpt_login_configured', async () => {
    if (!ready || !checks.find(value => value.name === 'codex_0_166_0')?.passed) throw new Error();
    const result = await execute(config.codexBin, ['login', 'status'], { env: childEnv, timeout: 5000, maxBuffer: 8192 });
    if (!/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error();
  });
  return { ready: checks.every(value => value.passed), codex_version_required: CODEX_VERSION, model: config.model, checks };
}
