import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationError } from '../task-runner/config.mjs';
import { assertPrivateDirectory } from './config.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PHASES = new Set(['prepared', 'executing', 'validating', 'uploading', 'ready_to_finish', 'execution_failed', 'execution_stopped', 'finish_confirmed', 'unconfirmed']);
const EVENTS = new Set(['upload_started', 'uploaded', 'download_verified', 'upload_unknown', 'upload_rejected', 'download_failed']);

function privateChild(parent, name) {
  const directory = path.join(parent, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertPrivateDirectory(directory);
}

export function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function processIdentity(pid = process.pid) {
  const procPath = pid === process.pid ? '/proc/self' : `/proc/${pid}`;
  const value = fs.readFileSync(`${procPath}/stat`, 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
  const status = fs.readFileSync(`${procPath}/status`, 'utf8');
  const localId = (name, fallback) => {
    const line = status.split('\n').find(item => item.startsWith(`${name}:`));
    return line ? Number(line.trim().split(/\s+/).at(-1)) : fallback;
  };
  return {
    pid, proc_pid: Number(value.slice(0, value.indexOf(' '))),
    pgid: localId('NSpgid', Number(fields[2])), session: localId('NSsid', Number(fields[3])),
    start_time: fields[19], pid_namespace: fs.readlinkSync(`${procPath}/ns/pid`),
  };
}

/** A crash leaves the lock in place for operator reconciliation. Never steal it by PID alone. */
export function acquireWorkerLock(stateRoot) {
  assertPrivateDirectory(stateRoot);
  const stateDir = privateChild(stateRoot, 'state');
  const lock = path.join(stateDir, 'worker.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new ConfigurationError('Worker lock exists. Inspect systemd, local journals, and Hub runs before explicitly clearing a stale lock.');
    throw error;
  }
  const lockId = randomUUID();
  try {
    atomicJson(path.join(lock, 'owner.json'), {
      lock_id: lockId, ...processIdentity(), created_at: new Date().toISOString(),
      boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    });
  } catch (error) {
    // Keep an incomplete lock closed; operators must inspect an interrupted setup too.
    throw new ConfigurationError('Unable to persist the worker lock; inspect the state directory before starting.');
  }
  let released = false;
  return {
    release() {
      if (released) return;
      const owner = readBoundedJson(path.join(lock, 'owner.json'));
      if (owner.lock_id !== lockId) throw new ConfigurationError('Worker lock ownership changed; it was not removed.');
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
      released = true;
    },
  };
}

export function safeCode(error, fallback = 'EXECUTION_FAILED') {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback;
}

export function safeMetadata(metadata = {}) {
  const value = {};
  for (const key of ['pid', 'pgid', 'session', 'procPid', 'procPgid', 'procSession', 'exitCode', 'stdoutBytes', 'stderrBytes', 'eventCount', 'descendantsObserved', 'startedAt', 'endedAt']) {
    if (metadata[key] === null || Number.isSafeInteger(metadata[key])) value[key] = metadata[key];
  }
  for (const key of ['startTime', 'exitSignal', 'signal', 'terminalType', 'lastEventType', 'failureCode', 'controlErrorCode']) {
    if (metadata[key] === null || (typeof metadata[key] === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(metadata[key]))) value[key] = metadata[key];
  }
  for (const key of ['cleanupComplete', 'timedOut', 'aborted', 'escalated', 'termSent', 'killSent', 'pipesClosed']) {
    if (typeof metadata[key] === 'boolean') value[key] = metadata[key];
  }
  if (typeof metadata.pidNamespace === 'string' && /^pid:\[\d+\]$/.test(metadata.pidNamespace)) value.pidNamespace = metadata.pidNamespace;
  if (metadata.usage && typeof metadata.usage === 'object') {
    value.usage = {};
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      if (Number.isSafeInteger(metadata.usage[key]) && metadata.usage[key] >= 0) value.usage[key] = metadata.usage[key];
    }
  }
  return value;
}

export function createRunState(stateRoot, taskId, runId) {
  if (!ID.test(taskId) || !ID.test(runId)) throw new ConfigurationError('The Hub returned an unsafe task or run identifier.');
  const runsDir = privateChild(stateRoot, 'runs');
  const taskDir = privateChild(runsDir, taskId);
  const runDir = privateChild(taskDir, runId);
  const root = fs.mkdtempSync(path.join(runDir, 'attempt-'));
  fs.chmodSync(root, 0o700);
  const workspaceDir = privateChild(root, 'workspace');
  const controlDir = privateChild(root, 'control');
  const logsDir = privateChild(root, 'logs');
  const stateDir = privateChild(stateRoot, 'state');
  const attemptId = path.basename(root);
  const file = path.join(stateDir, `${taskId}.${runId}.${attemptId}.json`);
  const value = {
    version: 1, task_id: taskId, run_id: runId, attempt_id: attemptId,
    run_directory: path.relative(stateRoot, root), phase: 'prepared',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    finish_confirmed: false, status: null, code: null, executor: {}, uploads: [],
  };
  const save = () => { value.updated_at = new Date().toISOString(); atomicJson(file, value); };
  save();
  return {
    root, workspaceDir, controlDir, logsDir, file,
    snapshot: () => structuredClone(value),
    phase(phase, extra = {}) {
      if (!PHASES.has(phase)) throw new Error('Unknown local run phase.');
      value.phase = phase;
      if (Object.hasOwn(extra, 'code')) value.code = safeCode(extra);
      if (extra.executor) value.executor = safeMetadata(extra.executor);
      if (['succeeded', 'failed'].includes(extra.status)) value.status = extra.status;
      save();
    },
    event(event) {
      if (!EVENTS.has(event.event)) throw new Error('Unknown artifact audit event.');
      if (value.uploads.length >= 120) throw new Error('Artifact audit event limit exceeded.');
      const safe = { event: event.event, at: new Date().toISOString() };
      for (const key of ['path', 'name', 'file_id', 'sha256', 'url', 'code']) {
        if (typeof event[key] === 'string' && event[key].length <= 2048) safe[key] = event[key];
      }
      if (Number.isSafeInteger(event.size)) safe.size = event.size;
      value.uploads.push(safe);
      save();
    },
    settled({ confirmed, status, code }) {
      value.finish_confirmed = confirmed === true;
      value.phase = confirmed ? 'finish_confirmed' : 'unconfirmed';
      value.status = ['succeeded', 'failed'].includes(status) ? status : value.status;
      value.code = code ? safeCode({ code }) : value.code;
      save();
    },
  };
}

function readBoundedJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 262_144) throw new Error('Invalid local journal.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

/** Read-only report. Uploaded-but-unconfirmed IDs remain evidence, never an auto-retry queue. */
export function reportState(stateRoot) {
  assertPrivateDirectory(stateRoot);
  const stateDir = path.join(stateRoot, 'state');
  if (!fs.existsSync(stateDir)) return { lock_present: false, runs: [] };
  assertPrivateDirectory(stateDir);
  const runs = [];
  const entries = fs.readdirSync(stateDir).sort();
  if (entries.length > 10_000) throw new ConfigurationError('Too many state records; archive reviewed journals before reporting.');
  for (const name of entries) {
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) continue;
    const value = readBoundedJson(path.join(stateDir, name));
    const events = Array.isArray(value.uploads) ? value.uploads : [];
    const known = [...new Set(events.filter(item => item.event === 'uploaded' && typeof item.file_id === 'string').map(item => item.file_id))];
    const unresolved = events.filter(item => item.event === 'upload_started').filter(start =>
      !events.some(item => ['uploaded', 'upload_rejected'].includes(item.event) && item.path === start.path));
    runs.push({
      task_id: value.task_id, run_id: value.run_id, attempt_id: value.attempt_id,
      phase: value.phase, status: value.status, code: value.code,
      finish_confirmed: value.finish_confirmed === true,
      known_file_ids: known, unknown_upload_paths: unresolved.map(item => item.path),
      possible_orphans: value.finish_confirmed !== true || value.status !== 'succeeded' ? known : [],
      updated_at: value.updated_at,
    });
  }
  return { lock_present: fs.existsSync(path.join(stateDir, 'worker.lock')), runs };
}
