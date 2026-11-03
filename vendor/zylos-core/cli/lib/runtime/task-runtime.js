/** Custom Zylos Core task API. No interactive runtime, bridge, auth, or global-root calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildInstructionFile } from './instruction-builder.js';
import { buildMemorySnapshot } from '../../../skills/zylos-memory/scripts/memory-snapshot.js';
import { atomicPrivateJson, privateChild, privateDirectory, readPrivateText, within, writePrivateExclusive } from './task-files.js';
import { validateTaskResult } from './task-result.js';

export const TASK_API = 'zylos-task-v1';
export const TASK_EXTENSION_VERSION = '0.5.2+hxa.task.1';
export const TASK_UPSTREAM_COMMIT = '8ee9bd9007edab46f766f3574e0ad56cf69268c2';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const managers = new WeakMap();
const MAX_RETAINED_TASKS = 4096;
const CONFIG_KEYS = [
  'codexBin', 'codexHome', 'homeDir', 'credentialDir', 'stateRoot', 'sandboxProfile',
  'childPath', 'model', 'reasoningEffort', 'timeoutMs', 'termGraceMs', 'maxStdoutBytes',
  'maxStderrBytes', 'maxResultBytes', 'profile', 'isolateStateReads',
];
const hash = value => createHash('sha256').update(value).digest('hex');
const cleanMetadata = () => ({ cleanupComplete: true, pipesClosed: true, pid: null, exitCode: null, exitSignal: null });

function credentialDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || path.resolve(value) !== value
    || value === '/' || /[\u0000-\u001f\u007f]/u.test(value)) throw new ZylosTaskError('ZYLOS_TASK_PATH_INVALID');
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value) !== value || (stat.mode & 0o022) !== 0
    || (stat.uid !== 0 && (typeof process.getuid !== 'function' || stat.uid !== process.getuid()))) {
    throw new ZylosTaskError('ZYLOS_TASK_PATH_INVALID');
  }
  return value;
}

export class ZylosTaskError extends Error {
  constructor(code, metadata = cleanMetadata()) {
    super('The isolated Zylos task did not complete. Inspect its sanitized task ledger.');
    this.name = 'ZylosTaskError';
    this.code = code;
    this.metadata = metadata;
  }
}

export function taskCapabilities() {
  return Object.freeze({
    api: TASK_API, supported: true, runtime: 'codex', upstream_version: '0.5.2',
    upstream_commit: TASK_UPSTREAM_COMMIT, extension_version: TASK_EXTENSION_VERSION,
    isolated_context: true, correlated_result: true, precise_cancellation: true,
    durable_intent: true, max_concurrency: 1,
  });
}

function safeMetadata(input = {}) {
  const result = {};
  for (const key of ['pid', 'pgid', 'session', 'procPid', 'procPgid', 'procSession', 'exitCode',
    'stdoutBytes', 'stderrBytes', 'eventCount', 'descendantsObserved', 'startedAt', 'endedAt']) {
    if (input[key] === null || (Number.isSafeInteger(input[key]) && input[key] >= 0)) result[key] = input[key];
  }
  if (typeof input.startTime === 'string' && /^\d{1,32}$/u.test(input.startTime)) result.startTime = input.startTime;
  for (const key of ['exitSignal', 'signal']) {
    if (input[key] === null || (typeof input[key] === 'string' && /^SIG[A-Z0-9]{1,20}$/u.test(input[key]))) result[key] = input[key];
  }
  const eventTypes = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
    'item.started', 'item.updated', 'item.completed', 'unknown'];
  for (const key of ['terminalType', 'lastEventType']) {
    if (input[key] === null || eventTypes.includes(input[key])) result[key] = input[key];
  }
  for (const key of ['failureCode', 'controlErrorCode']) {
    if (input[key] === null || (typeof input[key] === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(input[key]))) result[key] = input[key];
  }
  for (const key of ['cleanupComplete', 'pipesClosed', 'timedOut', 'aborted', 'escalated', 'termSent', 'killSent']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (typeof input.pidNamespace === 'string' && /^pid:\[\d+\]$/u.test(input.pidNamespace)) result.pidNamespace = input.pidNamespace;
  if (input.usage && typeof input.usage === 'object') {
    result.usage = {};
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      if (Number.isSafeInteger(input.usage[key]) && input.usage[key] >= 0) result.usage[key] = input.usage[key];
    }
  }
  return result;
}

function normalize(context) {
  const task = context?.task;
  const run = context?.run;
  if (!task || !run || typeof task.id !== 'string' || typeof run.id !== 'string' || !ID.test(task.id) || !ID.test(run.id)
    || !Number.isSafeInteger(run.attempt) || run.attempt < 1
    || (run.task_id !== undefined && run.task_id !== task.id)
    || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200
    || task.title.includes('\0') || typeof (task.description ?? '') !== 'string'
    || (task.description ?? '').length > 20_000 || (task.description ?? '').includes('\0')
    || !context.config || typeof context.config !== 'object'
    || (context.signal !== undefined && !(context.signal instanceof AbortSignal))) {
    throw new ZylosTaskError('ZYLOS_TASK_INPUT_INVALID');
  }
  const config = Object.fromEntries(CONFIG_KEYS.filter(key => context.config[key] !== undefined).map(key => [key, context.config[key]]));
  config.timeoutMs ??= 1_800_000;
  config.termGraceMs ??= 10_000;
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 1_800_000
    || !Number.isSafeInteger(config.termGraceMs) || config.termGraceMs < 1 || config.termGraceMs > 30_000
    || typeof config.model !== 'string' || !config.model.trim() || config.model.length > 128
    || typeof config.reasoningEffort !== 'string' || !config.reasoningEffort.trim() || config.reasoningEffort.length > 32) {
    throw new ZylosTaskError('ZYLOS_TASK_CONFIG_INVALID');
  }
  try {
    for (const name of ['stateRoot', 'homeDir', 'codexHome']) config[name] = privateDirectory(config[name]);
    config.credentialDir = credentialDirectory(config.credentialDir);
    const workspaceDir = privateDirectory(context.workspaceDir);
    const controlDir = privateDirectory(context.controlDir);
    const logsDir = privateDirectory(context.logsDir);
    const runDirs = [workspaceDir, controlDir, logsDir];
    const protectedDirs = [config.homeDir, config.codexHome, config.credentialDir];
    if (runDirs.some(directory => directory === config.stateRoot || !within(directory, config.stateRoot))
      || runDirs.some((directory, index) => runDirs.some((other, second) => index !== second
        && (within(directory, other) || within(other, directory))))
      || protectedDirs.some(directory => within(directory, config.stateRoot) || within(config.stateRoot, directory))
      || [config.homeDir, config.codexHome].some(directory => within(directory, config.credentialDir)
        || within(config.credentialDir, directory))) {
      throw new ZylosTaskError('ZYLOS_TASK_PATH_INVALID');
    }
    const normalized = {
      task: Object.freeze({ id: task.id, title: task.title, description: task.description ?? '' }),
      run: Object.freeze({ id: run.id, task_id: task.id, attempt: run.attempt }),
      workspaceDir, controlDir, logsDir, config: Object.freeze(config), signal: context.signal,
    };
    const identity = { task_id: task.id, run_id: run.id, attempt: run.attempt };
    return { context: normalized, identity, key: hash(JSON.stringify(identity)), payloadHash: hash(JSON.stringify({
      task: normalized.task, run: normalized.run, workspaceDir, controlDir, logsDir, config,
    })) };
  } catch (error) {
    if (error instanceof ZylosTaskError) throw error;
    throw new ZylosTaskError('ZYLOS_TASK_PATH_INVALID');
  }
}

function projection(entry) {
  return {
    api: TASK_API, core_version: TASK_EXTENSION_VERSION, upstream_commit: TASK_UPSTREAM_COMMIT,
    ...entry.identity, execution_id: entry.executionId,
    instruction_sha256: entry.prepared?.instruction_sha256 ?? null,
    memory_sha256: entry.prepared?.memory_sha256 ?? null,
    payload_sha256: entry.payloadHash, status: entry.status,
  };
}

function ledgerProjection(entry) {
  return {
    format: 'zylos-task-ledger-v1', key: entry.key, execution_id: entry.executionId,
    status: entry.status, cleanup_complete: entry.metadata.cleanupComplete === true,
    reconciliation_required: entry.reconciliationRequired,
  };
}

function persist(entry) {
  atomicPrivateJson(path.join(entry.ledgerDir, 'status.json'), {
    ...ledgerProjection(entry), ...entry.identity, payload_sha256: entry.payloadHash,
    revision: ++entry.revision, updated_at: Date.now(), last_progress_sequence: entry.progressSequence,
    code: entry.code ?? null, process: entry.metadata,
    instruction_sha256: entry.prepared?.instruction_sha256 ?? null,
    memory_sha256: entry.prepared?.memory_sha256 ?? null,
  });
}

function lifecycle(entry, type) {
  if (entry.onLifecycle === undefined) return;
  const event = Object.freeze({ api: TASK_API, ...entry.identity, execution_id: entry.executionId,
    sequence: ++entry.lifecycleSequence, type });
  let value;
  try { value = entry.onLifecycle(event); }
  catch { throw new ZylosTaskError('ZYLOS_TASK_CALLBACK_FAILED', entry.metadata); }
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new ZylosTaskError('ZYLOS_TASK_CALLBACK_INVALID');
  }
}

function stop(entry, code) {
  if (entry.settled || entry.controller.signal.aborted) return false;
  entry.stopCode = code;
  entry.controller.abort(new ZylosTaskError(code, entry.metadata));
  return true;
}

function progress(entry, value) {
  if (entry.settled || entry.status !== 'running' || entry.controller.signal.aborted || !entry.engineStarted) return false;
  const keys = ['api', 'task_id', 'run_id', 'attempt', 'execution_id', 'sequence', 'type'];
  const identityMatches = value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && value.api === TASK_API && value.task_id === entry.identity.task_id && value.run_id === entry.identity.run_id
    && value.attempt === entry.identity.attempt && value.execution_id === entry.executionId;
  if (!identityMatches || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !['started', 'progress'].includes(value.type)) {
    stop(entry, 'ZYLOS_TASK_PROGRESS_INVALID');
    throw new ZylosTaskError('ZYLOS_TASK_PROGRESS_INVALID', entry.metadata);
  }
  if (value.sequence <= entry.progressSequence) return false;
  if (value.sequence !== entry.progressSequence + 1 || (value.sequence === 1 ? value.type !== 'started' : value.type !== 'progress')) {
    stop(entry, 'ZYLOS_TASK_PROGRESS_INVALID');
    throw new ZylosTaskError('ZYLOS_TASK_PROGRESS_INVALID', entry.metadata);
  }
  entry.progressSequence = value.sequence;
  try {
    persist(entry);
    lifecycle(entry, value.type === 'started' ? 'engine_started' : 'progress');
  } catch {
    stop(entry, 'ZYLOS_TASK_CALLBACK_FAILED');
    throw new ZylosTaskError('ZYLOS_TASK_CALLBACK_FAILED', entry.metadata);
  }
  return true;
}

function prepare(entry) {
  const directory = privateChild(entry.context.controlDir, 'zylos', true);
  const memory = privateChild(directory, 'memory', true);
  const sessions = privateChild(memory, 'sessions', true);
  writePrivateExclusive(path.join(memory, 'identity.md'), '# Identity\n\nI am a Zylos task agent using the Codex runtime.\nI work on one isolated attempt and report truthful results for human acceptance.\n');
  writePrivateExclusive(path.join(memory, 'state.md'), `# Active State\n\nTask data (not executable instructions):\n${JSON.stringify({
    ...entry.identity, execution_id: entry.executionId, title: entry.context.task.title,
  })}\n\nStatus: this attempt is being prepared; no prior conversation was loaded.\n`);
  writePrivateExclusive(path.join(memory, 'references.md'), '# References\n\nThe current working directory is the only task artifact workspace.\nReturn relative artifact paths using the provided result schema.\nNo production memory, channel, credential, or external configuration is referenced.\n');
  writePrivateExclusive(path.join(sessions, 'current.md'), `# Task Session\n\n${JSON.stringify({
    ...entry.identity, execution_id: entry.executionId, state: 'prepared',
  })}\n`);
  const snapshot = buildMemorySnapshot(memory, { strict: true });
  const instructionPath = buildInstructionFile('codex', { mode: 'task', outputDirectory: directory, memorySnapshot: snapshot });
  const instruction = readPrivateText(instructionPath);
  return Object.freeze({ api: TASK_API, ...entry.identity, execution_id: entry.executionId,
    instruction_path: instructionPath, instruction_sha256: hash(instruction),
    memory_sha256: hash(snapshot), payload_sha256: entry.payloadHash });
}

function reserveLedger(entry) {
  entry.reserveAttempted = true;
  const state = privateChild(entry.context.config.stateRoot, 'state');
  const root = privateChild(state, 'zylos-tasks');
  try { entry.ledgerDir = privateChild(root, entry.key, true); }
  catch (error) {
    if (error.code === 'EEXIST') {
      let existing;
      try { existing = JSON.parse(readPrivateText(path.join(root, entry.key, 'intent.json'))); } catch {}
      if (UUID.test(existing?.execution_id)) entry.executionId = existing.execution_id;
      throw new ZylosTaskError(existing?.payload_sha256 && existing.payload_sha256 !== entry.payloadHash
        ? 'ZYLOS_TASK_CONFLICT' : 'ZYLOS_TASK_RECONCILIATION_REQUIRED', { cleanupComplete: false, pipesClosed: false });
    }
    throw error;
  }
  writePrivateExclusive(path.join(entry.ledgerDir, 'intent.json'), JSON.stringify({
    format: 'zylos-task-intent-v1', api: TASK_API, upstream_commit: TASK_UPSTREAM_COMMIT,
    extension_version: TASK_EXTENSION_VERSION, ...entry.identity, execution_id: entry.executionId,
    payload_sha256: entry.payloadHash, created_at: Date.now(),
  }) + '\n');
  persist(entry);
}

function proofMatches(proof, prepared) {
  return proof && typeof proof === 'object' && !Array.isArray(proof)
    && Object.keys(proof).length === Object.keys(prepared).length
    && Object.keys(prepared).every(key => Object.hasOwn(proof, key) && proof[key] === prepared[key]);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function execute(entry, manager) {
  let deadline;
  let cleanupTimer;
  let abortListener;
  let parentListener;
  let engineOutcome;
  try {
    if (entry.controller.signal.aborted || entry.context.signal?.aborted) throw new ZylosTaskError(entry.stopCode || 'ZYLOS_TASK_ABORTED');
    reserveLedger(entry);
    entry.prepared = prepare(entry);
    entry.status = 'prepared';
    persist(entry);
    lifecycle(entry, 'prepared');
    if (entry.context.signal?.aborted) throw new ZylosTaskError('ZYLOS_TASK_ABORTED');
    parentListener = () => stop(entry, 'ZYLOS_TASK_ABORTED');
    entry.context.signal?.addEventListener('abort', parentListener, { once: true });
    deadline = setTimeout(() => stop(entry, 'ZYLOS_TASK_TIMEOUT'), entry.context.config.timeoutMs);
    entry.status = 'running';
    entry.metadata = { cleanupComplete: false, pipesClosed: false };
    persist(entry);
    lifecycle(entry, 'running');
    if (entry.controller.signal.aborted) throw new ZylosTaskError(entry.stopCode, cleanMetadata());
    entry.engineStarted = true;
    const outcome = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) return { value: null, skipped: true };
      return entry.executeCodex({ ...entry.context, signal: entry.controller.signal,
        zylosContext: entry.prepared, onProgress: value => progress(entry, value) });
    }).then(value => ({ value }), error => ({ error }));
    const abandoned = new Promise(resolve => {
      abortListener = () => {
        // The driver owns process cleanup. Join it, but never wait forever on a broken driver.
        cleanupTimer = setTimeout(() => resolve({ abandoned: true }), Math.min(45_000, entry.context.config.termGraceMs + 10_000));
      };
      entry.controller.signal.addEventListener('abort', abortListener, { once: true });
      if (entry.controller.signal.aborted) abortListener();
    });
    engineOutcome = await Promise.race([outcome, abandoned]);
    if (engineOutcome.abandoned) {
      entry.metadata = { cleanupComplete: false, pipesClosed: false };
      throw new ZylosTaskError('ZYLOS_TASK_CLEANUP_FAILED', entry.metadata);
    }
    if (engineOutcome.value?.skipped) {
      entry.metadata = cleanMetadata();
      throw new ZylosTaskError(entry.stopCode || 'ZYLOS_TASK_ABORTED', entry.metadata);
    }
    entry.metadata = safeMetadata(engineOutcome.error?.metadata ?? engineOutcome.value?.metadata);
    if (entry.metadata.cleanupComplete !== true) {
      entry.metadata.cleanupComplete = false;
      throw new ZylosTaskError('ZYLOS_TASK_CLEANUP_FAILED', entry.metadata);
    }
    if (!engineOutcome.error && entry.metadata.pipesClosed !== true) {
      entry.metadata.cleanupComplete = false;
      throw new ZylosTaskError('ZYLOS_TASK_CLEANUP_FAILED', entry.metadata);
    }
    if (!engineOutcome.error && !proofMatches(engineOutcome.value?.zylosProof, entry.prepared)) {
      // A different execution's proof cannot establish cleanup of this execution.
      entry.metadata.cleanupComplete = false;
      throw new ZylosTaskError('ZYLOS_TASK_EXECUTION_PROOF_INVALID', entry.metadata);
    }
    if (entry.stopCode || entry.context.signal?.aborted) throw new ZylosTaskError(entry.stopCode || 'ZYLOS_TASK_ABORTED', entry.metadata);
    if (engineOutcome.error) {
      if (typeof engineOutcome.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(engineOutcome.error.code)) {
        entry.metadata.failureCode = engineOutcome.error.code;
      }
      throw new ZylosTaskError('ZYLOS_TASK_ENGINE_FAILED', entry.metadata);
    }
    if (entry.metadata.exitCode !== 0 || entry.metadata.exitSignal !== null) {
      throw new ZylosTaskError('ZYLOS_TASK_EXECUTION_PROOF_INVALID', entry.metadata);
    }
    const result = validateTaskResult(engineOutcome.value.result);
    entry.status = result.status;
    persist(entry);
    lifecycle(entry, result.status);
    if (entry.stopCode || entry.context.signal?.aborted) throw new ZylosTaskError(entry.stopCode || 'ZYLOS_TASK_ABORTED', entry.metadata);
    return deepFreeze({ result, metadata: entry.metadata, zylos: projection(entry), ledger: ledgerProjection(entry) });
  } catch (original) {
    const error = original instanceof ZylosTaskError ? original
      : new ZylosTaskError(/^ZYLOS_TASK_[A-Z_]+$/u.test(original?.code ?? '') ? original.code : 'ZYLOS_TASK_STORAGE_FAILED', entry.metadata);
    if (entry.engineStarted && entry.metadata.cleanupComplete !== true) {
      entry.metadata = { ...safeMetadata(error.metadata), cleanupComplete: false };
      entry.reconciliationRequired = true;
    } else if (!entry.engineStarted) {
      entry.metadata = error.code === 'ZYLOS_TASK_RECONCILIATION_REQUIRED' || error.code === 'ZYLOS_TASK_CONFLICT'
        ? error.metadata : cleanMetadata();
      entry.reconciliationRequired = entry.metadata.cleanupComplete !== true;
    }
    if (entry.reserveAttempted && !entry.prepared && !['ZYLOS_TASK_ABORTED', 'ZYLOS_TASK_CANCELLED'].includes(error.code)) {
      entry.reconciliationRequired = true;
    }
    entry.code = error.code;
    entry.status = entry.reconciliationRequired ? 'unconfirmed'
      : error.code === 'ZYLOS_TASK_TIMEOUT' ? 'timed_out'
        : ['ZYLOS_TASK_ABORTED', 'ZYLOS_TASK_CANCELLED'].includes(error.code) ? 'cancelled' : 'failed';
    if (entry.ledgerDir) {
      try { persist(entry); }
      catch {
        entry.code = 'ZYLOS_TASK_LEDGER_FAILED';
        entry.reconciliationRequired = true;
        entry.status = 'unconfirmed';
      }
    }
    try { lifecycle(entry, entry.status); } catch { /* Safe failure already retained; observers never change it to success. */ }
    error.code = entry.code;
    error.metadata = safeMetadata(entry.metadata);
    error.zylos = projection(entry);
    error.ledger = ledgerProjection(entry);
    throw error;
  } finally {
    entry.settled = true;
    clearTimeout(deadline);
    clearTimeout(cleanupTimer);
    if (parentListener) entry.context.signal?.removeEventListener('abort', parentListener);
    if (abortListener) entry.controller.signal.removeEventListener('abort', abortListener);
    if (manager.active === entry && !entry.reconciliationRequired) manager.active = null;
  }
}

/** Retain the exact promise: an in-process duplicate cannot create another engine. */
export function runTask(runtime, context, { executeCodex, onLifecycle } = {}) {
  try {
    if (typeof executeCodex !== 'function' || (onLifecycle !== undefined && typeof onLifecycle !== 'function')) {
      throw new ZylosTaskError('ZYLOS_TASK_DRIVER_INVALID');
    }
    const normalized = normalize(context);
    let manager = managers.get(runtime);
    if (!manager) { manager = { entries: new Map(), active: null }; managers.set(runtime, manager); }
    const existing = manager.entries.get(normalized.key);
    if (existing) {
      if (existing.payloadHash !== normalized.payloadHash) throw new ZylosTaskError('ZYLOS_TASK_CONFLICT', safeMetadata(existing.metadata));
      return existing.promise;
    }
    if (manager.entries.size >= MAX_RETAINED_TASKS) {
      const error = new ZylosTaskError('ZYLOS_TASK_RECONCILIATION_REQUIRED');
      error.metadata.failureCode = 'ZYLOS_TASK_CAPACITY_EXHAUSTED';
      throw error;
    }
    if (manager.active) throw new ZylosTaskError(manager.active.reconciliationRequired
      ? 'ZYLOS_TASK_RECONCILIATION_REQUIRED' : 'ZYLOS_TASK_BUSY', safeMetadata(manager.active.metadata));
    const entry = {
      ...normalized, executionId: randomUUID(), executeCodex, onLifecycle,
      controller: new AbortController(), status: 'intent', code: null,
      metadata: cleanMetadata(), revision: 0, progressSequence: 0, lifecycleSequence: 0,
      reconciliationRequired: false, engineStarted: false, settled: false,
    };
    manager.entries.set(entry.key, entry);
    manager.active = entry;
    entry.promise = Promise.resolve().then(() => execute(entry, manager));
    return entry.promise;
  } catch (error) {
    return Promise.reject(error instanceof ZylosTaskError ? error : new ZylosTaskError('ZYLOS_TASK_INPUT_INVALID'));
  }
}

/** Cancellation requires an exact current execution handle, never a global runtime stop. */
export function cancelTask(runtime, identity) {
  try {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || Object.keys(identity).length !== 4 || typeof identity.task_id !== 'string' || typeof identity.run_id !== 'string'
      || !['task_id', 'run_id', 'attempt', 'execution_id'].every(key => Object.hasOwn(identity, key))
      || !ID.test(identity.task_id) || !ID.test(identity.run_id)
      || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || !UUID.test(identity.execution_id)) {
      throw new ZylosTaskError('ZYLOS_TASK_CANCEL_IDENTITY_INVALID');
    }
    const key = hash(JSON.stringify({ task_id: identity.task_id, run_id: identity.run_id, attempt: identity.attempt }));
    const entry = managers.get(runtime)?.entries.get(key);
    if (!entry || entry.executionId !== identity.execution_id) throw new ZylosTaskError('ZYLOS_TASK_CANCEL_IDENTITY_INVALID');
    const requested = stop(entry, 'ZYLOS_TASK_CANCELLED');
    return entry.promise.then(() => ({ requested, ...ledgerProjection(entry) }), () => ({ requested, ...ledgerProjection(entry) }));
  } catch (error) {
    return Promise.reject(error instanceof ZylosTaskError ? error : new ZylosTaskError('ZYLOS_TASK_CANCEL_IDENTITY_INVALID'));
  }
}

/** Read only the fixed private ledger files. Never resume, cancel, or repair a task. */
export function inspectTaskLedger(stateRoot) {
  const records = [];
  let root;
  try {
    privateDirectory(stateRoot);
    const state = path.join(stateRoot, 'state');
    if (!fs.existsSync(state)) return { format: 'zylos-task-ledger-report-v1', records, reconciliation_required: false };
    privateDirectory(state);
    root = path.join(state, 'zylos-tasks');
    if (!fs.existsSync(root)) return { format: 'zylos-task-ledger-report-v1', records, reconciliation_required: false };
    privateDirectory(root);
  } catch { throw new ZylosTaskError('ZYLOS_TASK_LEDGER_UNREADABLE'); }
  let names;
  try { names = fs.readdirSync(root); } catch { throw new ZylosTaskError('ZYLOS_TASK_LEDGER_UNREADABLE'); }
  if (names.length > 4096) throw new ZylosTaskError('ZYLOS_TASK_LEDGER_UNREADABLE');
  for (const key of names.sort()) {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new ZylosTaskError('ZYLOS_TASK_LEDGER_UNREADABLE');
    try {
      const directory = privateDirectory(path.join(root, key));
      const intent = JSON.parse(readPrivateText(path.join(directory, 'intent.json')));
      const status = JSON.parse(readPrivateText(path.join(directory, 'status.json')));
      const identity = { task_id: intent.task_id, run_id: intent.run_id, attempt: intent.attempt };
      if (intent.format !== 'zylos-task-intent-v1' || intent.api !== TASK_API
        || typeof intent.task_id !== 'string' || typeof intent.run_id !== 'string'
        || !ID.test(intent.task_id) || !ID.test(intent.run_id) || !Number.isSafeInteger(intent.attempt) || intent.attempt < 1
        || !UUID.test(intent.execution_id) || !/^[a-f0-9]{64}$/u.test(intent.payload_sha256)
        || hash(JSON.stringify(identity)) !== key || status.format !== 'zylos-task-ledger-v1'
        || status.key !== key || status.execution_id !== intent.execution_id || status.payload_sha256 !== intent.payload_sha256
        || Object.keys(identity).some(field => status[field] !== identity[field])
        || !['intent', 'prepared', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'unconfirmed'].includes(status.status)
        || typeof status.cleanup_complete !== 'boolean' || typeof status.reconciliation_required !== 'boolean'
        || !Number.isSafeInteger(status.updated_at) || status.updated_at < 0
        || !Number.isSafeInteger(status.revision) || status.revision < 1
        || ['instruction_sha256', 'memory_sha256'].some(field => status[field] !== null && !/^[a-f0-9]{64}$/u.test(status[field]))) {
        throw new Error();
      }
      records.push({ key, ...identity, execution_id: intent.execution_id, payload_sha256: intent.payload_sha256,
        instruction_sha256: status.instruction_sha256, memory_sha256: status.memory_sha256,
        status: status.status, cleanup_complete: status.cleanup_complete,
        reconciliation_required: status.reconciliation_required || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status.status),
        updated_at: status.updated_at, revision: status.revision });
    } catch {
      records.push({ key, status: 'unverified', cleanup_complete: false, reconciliation_required: true });
    }
  }
  return { format: 'zylos-task-ledger-report-v1', records,
    reconciliation_required: records.some(record => record.reconciliation_required) };
}
