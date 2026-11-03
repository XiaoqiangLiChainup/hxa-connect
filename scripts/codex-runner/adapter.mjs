import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RunnerError } from '../task-runner/worker.mjs';
import { runCodexProcess, CodexExecutionError } from './process.mjs';
import { prepareArtifacts, uploadArtifacts, ArtifactError } from './artifacts.mjs';
import { atomicJson, createRunState, safeCode, safeMetadata } from './state.mjs';

function processConfiguration(config) {
  // Deliberately enumerate fields: the Hub bearer and token-file path never cross this boundary.
  return Object.fromEntries([
    'codexBin', 'codexHome', 'homeDir', 'credentialDir', 'stateRoot', 'sandboxProfile', 'childPath', 'model', 'reasoningEffort',
    'timeoutMs', 'termGraceMs', 'maxStdoutBytes', 'maxStderrBytes', 'maxResultBytes', 'profile',
  ].map(key => [key, config[key]]));
}

function auditArtifact(context, state, metadata, result, prepared, config) {
  const audit = {
    format: 'hxa-codex-run-v1', task_id: context.task.id, run_id: context.run.id,
    executor: 'codex-exec', codex_version_required: '0.166.0', model: config.model,
    reasoning_effort: config.reasoningEffort, profile: config.profile,
    execution: safeMetadata(metadata), controller_status: result.status,
    checks: result.checks,
    artifact_checks: 'bounded snapshots, path/type/size checks; functional acceptance remains human-owned',
    files: prepared.map(({ path: artifactPath, name, size, sha256 }) => ({ path: artifactPath, name, size, sha256 })),
    hub_finish: 'not_yet_confirmed_at_upload', created_at: new Date().toISOString(),
  };
  // A trusted credential must never appear in an uploaded audit, including model-authored check text.
  const sanitized = JSON.parse(JSON.stringify(audit).split(config.token).join('[REDACTED]'));
  const bytes = Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`);
  if (bytes.length > 65_536) throw new RunnerError('Run metadata exceeds its limit.', { code: 'AUDIT_TOO_LARGE' });
  atomicJson(path.join(state.controlDir, 'run-metadata.json'), sanitized);
  return { path: 'run-metadata.json', name: 'run-metadata.json', title: 'Run metadata', mime: 'application/json', bytes,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** One dedicated subprocess at a time. Lifecycle hooks join cleanup before another claim. */
export function createCodexExecutor(config, {
  runProcess = runCodexProcess,
  prepare = prepareArtifacts,
  upload = uploadArtifacts,
  fetchImpl = globalThis.fetch,
} = {}) {
  const entries = new Map();
  let cleanupSafe = true;
  let reconciliationRequired = false;
  const keyOf = ({ task, run }) => `${task.id}/${run.id}`;

  function executeTask(context) {
    if (entries.size > 0) throw new RunnerError('The dedicated executor already has a run.', { code: 'EXECUTOR_BUSY' });
    if (context.signal.aborted) throw context.signal.reason;
    const state = createRunState(config.stateRoot, context.task.id, context.run.id);
    const entry = { state, promise: null, requiresReconciliation: false };
    entries.set(keyOf(context), entry);
    entry.promise = (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new RunnerError('The real task exceeded its time budget.', { code: 'TASK_TIMEOUT' })), config.timeoutMs);
      const signal = AbortSignal.any([context.signal, deadline.signal]);
      let metadata = {};
      let started = false;
      try {
        const disk = fs.statfsSync(config.stateRoot, { bigint: true });
        if (disk.bavail * disk.bsize < BigInt(config.minFreeBytes)) {
          throw new RunnerError('Insufficient free space for another isolated run.', { code: 'WORKER_DISK_BUDGET' });
        }
        signal.throwIfAborted();
        state.phase('executing');
        started = true;
        cleanupSafe = false;
        const executed = await runProcess({
          ...context, signal, config: processConfiguration(config),
          workspaceDir: state.workspaceDir, controlDir: state.controlDir, logsDir: state.logsDir,
        });
        metadata = safeMetadata(executed.metadata);
        cleanupSafe = metadata.cleanupComplete === true;
        if (!cleanupSafe) throw new RunnerError('Executor cleanup could not be confirmed.', { code: 'EXECUTOR_CLEANUP_FAILED' });
        signal.throwIfAborted();
        const { result } = executed;
        state.phase('validating', { executor: metadata });
        if (result.status !== 'succeeded') {
          throw new RunnerError('Codex reported that the task was unsuccessful; inspect the private run record.', { code: 'CODEX_REPORTED_FAILURE' });
        }
        const prepared = await prepare({ workspaceDir: state.workspaceDir, result, config, signal });
        if (prepared.some(item => item.name.toLowerCase() === 'run-metadata.json')) {
          throw new RunnerError('The run-metadata.json filename is reserved for the controller.', { code: 'RESERVED_ARTIFACT_NAME' });
        }
        if (prepared.some(item => item.bytes.includes(Buffer.from(config.token)))) {
          throw new RunnerError('An artifact contains a protected credential and was not published.', { code: 'PROTECTED_ARTIFACT_CONTENT' });
        }
        const audit = auditArtifact(context, state, metadata, result, prepared, config);
        const allArtifacts = [...prepared, audit];
        if (allArtifacts.reduce((total, item) => total + item.size, 0) > config.maxArtifactBytes) {
          throw new RunnerError('Artifacts and run metadata exceed the configured total.', { code: 'ARTIFACT_TOTAL_LIMIT' });
        }
        signal.throwIfAborted();
        state.phase('uploading');
        const published = await upload({
          artifacts: allArtifacts, config, signal, fetchImpl,
          onEvent: async event => state.event(event),
        });
        signal.throwIfAborted();
        state.phase('ready_to_finish', { status: 'succeeded' });
        return { status: 'succeeded', summary: result.summary.split(config.token).join('[REDACTED]'), artifacts: published.artifacts };
      } catch (original) {
        if (original?.metadata) {
          metadata = safeMetadata(original.metadata);
          cleanupSafe = metadata.cleanupComplete === true;
        } else if (!started) cleanupSafe = true;
        const error = deadline.signal.aborted && !context.signal.aborted ? deadline.signal.reason : original;
        const code = safeCode(error);
        // Presentation may say TASK_TIMEOUT, but the original POST can still have committed.
        const events = state.snapshot().uploads;
        const unresolvedIntent = events.some(start => start.event === 'upload_started'
          && !events.some(event => ['uploaded', 'upload_rejected'].includes(event.event) && event.path === start.path));
        if (original?.unknownUploads?.length || unresolvedIntent
          || ['ARTIFACT_UPLOAD_UNKNOWN', 'ARTIFACT_JOURNAL_FAILED'].includes(safeCode(original))) {
          entry.requiresReconciliation = true;
          reconciliationRequired = true;
        }
        state.phase(context.signal.aborted ? 'execution_stopped' : 'execution_failed', { code, executor: metadata, status: 'failed' });
        if (context.signal.aborted) throw context.signal.reason;
        const message = error instanceof RunnerError || error instanceof CodexExecutionError || error instanceof ArtifactError
          ? error.message : 'The real executor failed; inspect its private run journal.';
        return { status: 'failed', error: `${code}: ${message}`.split(config.token).join('[REDACTED]').slice(0, 4000), artifacts: [] };
      } finally { clearTimeout(timer); }
    })();
    return entry.promise;
  }

  async function onRunSettled(outcome) {
    const key = keyOf(outcome);
    const entry = entries.get(key);
    if (!entry) return;
    // runWorker fences immediately on lost lease; this join waits for the targeted process cleanup.
    await Promise.allSettled([entry.promise]);
    reconciliationRequired ||= !outcome.confirmed || entry.requiresReconciliation || !cleanupSafe;
    try { entry.state.settled(outcome); } catch (error) { reconciliationRequired = true; throw error; }
    entries.delete(key);
    if (!cleanupSafe) throw new RunnerError('Executor cleanup remains uncertain; stop and inspect the service cgroup.', { code: 'EXECUTOR_CLEANUP_FAILED' });
    if (entry.requiresReconciliation) throw new RunnerError('An upload outcome requires reconciliation before another claim.', { code: 'ARTIFACT_RECONCILIATION_REQUIRED' });
  }

  return {
    executeTask, onRunSettled,
    async drain() { await Promise.allSettled([...entries.values()].map(entry => entry.promise)); },
    canReleaseLock: () => cleanupSafe && !reconciliationRequired && entries.size === 0,
  };
}
