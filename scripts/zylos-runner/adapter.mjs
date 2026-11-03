import { createHash } from 'node:crypto';
import { createArtifactExecutor } from '../codex-runner/adapter.mjs';
import { runCodexProcess } from '../codex-runner/process.mjs';
import { safeMetadata } from '../codex-runner/state.mjs';
import { RunnerError } from '../task-runner/worker.mjs';
import { loadTaskAdapter, verifyTaskSource } from './provenance.mjs';

const API = 'zylos-task-v1';
const CORE_COMMIT = '8ee9bd9007edab46f766f3574e0ad56cf69268c2';
const EXTENSION_VERSION = '0.5.2+hxa.task.1';
const HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CORE_CODES = new Set([
  'INPUT_INVALID', 'CONFIG_INVALID', 'PATH_INVALID', 'DRIVER_INVALID', 'CONFLICT', 'BUSY',
  'RECONCILIATION_REQUIRED', 'ABORTED', 'CANCELLED', 'TIMEOUT', 'CLEANUP_FAILED', 'ENGINE_FAILED',
  'EXECUTION_PROOF_INVALID', 'RESULT_INVALID', 'PROGRESS_INVALID', 'CALLBACK_FAILED',
  'CALLBACK_INVALID', 'LEDGER_FAILED', 'STORAGE_FAILED', 'STORAGE_LIMIT',
  'MEMORY_INVALID', 'INSTRUCTIONS_INVALID', 'CANCEL_IDENTITY_INVALID',
].map(value => `ZYLOS_TASK_${value}`));

function failure(code, message) { return new RunnerError(message, { code }); }
const sourceFailure = () => failure('ZYLOS_SOURCE_PROVENANCE_INVALID', 'The pinned Zylos task source and capability could not be verified; no fallback execution is allowed.');
const resultFailure = () => failure('ZYLOS_EXECUTION_PROVENANCE_INVALID', 'The Zylos task result is missing verified runtime provenance or does not belong to this run.');

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sourceProjection(value) {
  if (!value || value.api !== API || value.core_version !== '0.5.2' || value.core_commit !== CORE_COMMIT
    || value.extension_id !== 'hxa-m1-zylos-task-v1' || value.extension_version !== EXTENSION_VERSION
    || !HEX.test(value.patch_sha256 ?? '') || !HEX.test(value.source_manifest_sha256 ?? '')
    || !Number.isSafeInteger(value.file_count) || value.file_count < 314 || value.file_count > 1000
    || typeof value.root_managed !== 'boolean') throw sourceFailure();
  return Object.freeze({
    api: API, core_version: '0.5.2', core_commit: CORE_COMMIT,
    extension_id: value.extension_id, extension_version: EXTENSION_VERSION,
    patch_sha256: value.patch_sha256, source_manifest_sha256: value.source_manifest_sha256,
    source_file_count: value.file_count, source_root_managed: value.root_managed,
  });
}

function assertCapability(runtime) {
  if (typeof runtime?.taskCapabilities !== 'function' || typeof runtime?.runTask !== 'function'
    || typeof runtime?.cancelTask !== 'function') throw sourceFailure();
  const capability = runtime.taskCapabilities();
  if (!exactKeys(capability, ['api', 'supported', 'runtime', 'upstream_version', 'upstream_commit',
    'extension_version', 'isolated_context', 'correlated_result', 'precise_cancellation', 'durable_intent', 'max_concurrency'])
    || capability.api !== API || capability.supported !== true || capability.runtime !== 'codex'
    || capability.upstream_version !== '0.5.2' || capability.upstream_commit !== CORE_COMMIT
    || capability.extension_version !== EXTENSION_VERSION || capability.isolated_context !== true
    || capability.correlated_result !== true || capability.precise_cancellation !== true
    || capability.durable_intent !== true || capability.max_concurrency !== 1) throw sourceFailure();
}

function auditProjection(source, executed, context) {
  const native = executed?.zylos;
  const ledger = executed?.ledger;
  const { task, run } = context;
  const key = createHash('sha256').update(JSON.stringify({ task_id: task.id, run_id: run.id, attempt: run.attempt })).digest('hex');
  if (!exactKeys(native, ['api', 'core_version', 'upstream_commit', 'task_id', 'run_id', 'attempt',
    'execution_id', 'instruction_sha256', 'memory_sha256', 'payload_sha256', 'status'])
    || native.api !== API || native.core_version !== EXTENSION_VERSION || native.upstream_commit !== CORE_COMMIT
    || native.task_id !== task.id || native.run_id !== run.id || native.attempt !== run.attempt
    || !Number.isSafeInteger(native.attempt) || native.attempt < 1 || !UUID.test(native.execution_id ?? '')
    || !['succeeded', 'failed'].includes(native.status) || native.status !== executed?.result?.status
    || !['instruction_sha256', 'memory_sha256', 'payload_sha256'].every(name => HEX.test(native[name] ?? ''))
    || !exactKeys(ledger, ['format', 'key', 'execution_id', 'status', 'cleanup_complete', 'reconciliation_required'])
    || ledger.format !== 'zylos-task-ledger-v1' || ledger.key !== key || ledger.execution_id !== native.execution_id
    || ledger.status !== native.status || ledger.cleanup_complete !== true || ledger.reconciliation_required !== false
    || executed?.metadata?.cleanupComplete !== true || executed?.metadata?.pipesClosed !== true
    || executed?.metadata?.exitCode !== 0 || executed?.metadata?.exitSignal !== null) throw resultFailure();
  return {
    format: 'hxa-zylos-run-v1', executor: 'zylos-core-task', backend: 'codex', engine: 'codex-exec',
    codex_version_required: '0.166.0', ...source,
    attempt: native.attempt, execution_id: native.execution_id,
    instruction_sha256: native.instruction_sha256, memory_sha256: native.memory_sha256,
    payload_sha256: native.payload_sha256, ledger_key: ledger.key,
    core_task_api_invoked: true,
  };
}

/**
 * Prepare the genuine patched Core before the first claim. Dependency injection
 * exists only for offline tests; the CLI uses the fixed verified loader/driver.
 * The Hub credential never enters Core, its instruction builder, or the engine.
 */
export async function createZylosExecutor(config, {
  loadAdapter = loadTaskAdapter,
  verifySource = verifyTaskSource,
  runProcess = runCodexProcess,
  prepare,
  upload,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (config?.isolateStateReads !== true) {
    throw failure('ZYLOS_TASK_CONFIG_INVALID', 'Zylos task execution requires isolated state reads.');
  }
  const sourceConfig = Object.freeze(Object.fromEntries(
    ['stateRoot', 'homeDir', 'codexHome'].map(key => [key, config[key]]),
  ));
  let source, runtime;
  try {
    source = sourceProjection(await verifySource(sourceConfig));
    runtime = await loadAdapter(sourceConfig);
    assertCapability(runtime);
  } catch { throw sourceFailure(); }
  const engines = new Set();
  let engineCleanupUncertain = false;
  let nativeReconciliationRequired = false;
  const executeCodex = context => {
    const promise = Promise.resolve().then(() => runProcess(context));
    engines.add(promise);
    // Keep the original rejection attached while independently tracking cleanup.
    promise.then(() => engines.delete(promise), () => engines.delete(promise));
    return promise;
  };
  const shared = createArtifactExecutor(config, {
    prepare, upload, fetchImpl,
    runProcess: async context => {
      try {
        return await runtime.runTask(context, { executeCodex });
      } catch (original) {
        nativeReconciliationRequired ||= original?.ledger?.reconciliation_required === true
          || ['ZYLOS_TASK_RECONCILIATION_REQUIRED', 'ZYLOS_TASK_CONFLICT', 'ZYLOS_TASK_EXECUTION_PROOF_INVALID',
            'ZYLOS_TASK_PROGRESS_INVALID', 'ZYLOS_TASK_CALLBACK_FAILED', 'ZYLOS_TASK_CALLBACK_INVALID',
            'ZYLOS_TASK_LEDGER_FAILED', 'ZYLOS_TASK_STORAGE_FAILED'].includes(original?.code);
        const error = failure(CORE_CODES.has(original?.code) ? original.code : 'ZYLOS_TASK_ENGINE_FAILED',
          'The isolated Zylos task failed; inspect its sanitized native task ledger before retrying.');
        error.metadata = safeMetadata(original?.metadata ?? { cleanupComplete: false, pipesClosed: false });
        throw error;
      }
    },
    auditFields: (executed, context) => {
      try { return auditProjection(source, executed, context); }
      catch (error) { nativeReconciliationRequired = true; throw error; }
    },
    reportedFailure: { code: 'ZYLOS_TASK_REPORTED_FAILURE', message: 'Zylos reported that the task was unsuccessful; inspect the private native task record.' },
  });
  async function joinEngines() {
    if (engines.size === 0) return;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...engines]),
        new Promise(resolve => { timer = setTimeout(resolve, Math.min(45_000, config.termGraceMs + 10_000)); }),
      ]);
      if (engines.size !== 0) {
        engineCleanupUncertain = true;
        throw failure('ZYLOS_TASK_CLEANUP_FAILED', 'The Zylos execution driver has not settled; keep this worker stopped for reconciliation.');
      }
    } finally { clearTimeout(timer); }
  }
  return {
    executeTask(context) {
      if (nativeReconciliationRequired || engineCleanupUncertain) {
        throw failure('ZYLOS_TASK_RECONCILIATION_REQUIRED', 'This Zylos runtime is blocked until its previous execution evidence is reconciled.');
      }
      return shared.executeTask(context);
    },
    async onRunSettled(outcome) {
      try { await shared.onRunSettled(outcome); }
      finally { await joinEngines(); }
      if (nativeReconciliationRequired) {
        throw failure('ZYLOS_TASK_RECONCILIATION_REQUIRED', 'Native Zylos execution evidence requires reconciliation before another claim.');
      }
    },
    async drain() {
      try { await shared.drain(); }
      finally { await joinEngines(); }
    },
    canReleaseLock: () => !engineCleanupUncertain && !nativeReconciliationRequired && engines.size === 0 && shared.canReleaseLock(),
  };
}
