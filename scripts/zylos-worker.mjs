#!/usr/bin/env node
import { isMainModule } from './cli-entrypoint.mjs';
import { ConfigurationError } from './task-runner/config.mjs';
import { runWorker, RunnerError, safeErrorMessage, ShutdownError } from './task-runner/worker.mjs';
import { readHubToken, readStateDirectory } from './codex-runner/config.mjs';
import { acquireWorkerLock, reportState } from './codex-runner/state.mjs';
import { parseZylosArguments, readZylosConfiguration, preflight, assertExecutionWindow } from './zylos-runner/config.mjs';
import { createZylosExecutor } from './zylos-runner/adapter.mjs';
import { readTaskLedgerReport } from './zylos-runner/provenance.mjs';

const HELP = `Usage: node scripts/zylos-worker.mjs --check | --report | --zylos [--once]

--check   Verify the pinned custom Zylos Core task extension and local sandbox boundaries; no model or Hub request.
--report  Read-only local execution/upload evidence. Needs only HXA_CODEX_STATE_DIR.
--zylos   Explicit Zylos Core task-mode execution, with Codex as its bounded engine.
--once    At most one Hub claim. It does not select a task ID or prove business success.

Requires the existing dedicated non-root identity, CODEX_HOME login, approved model,
HXA_TASK_TOKEN_FILE and HXA_ZYLOS_TOKEN_EXPIRES_AT (exact UTC issuance record).
Uses the complete root-managed vendored Zylos 0.5.2+hxa.task.1 source; no global CLI,
production Zylos session, C4, default runtime, installation, or fallback is invoked.
Maximum task duration is 30 minutes, concurrency is 1; uncertain work is not replayed.
The normal Codex and Mock entrypoints remain separate. See docs/m1-zylos-task-runtime.md.`;

export async function main(args = process.argv.slice(2), env = process.env, {
  checkEnvironment = preflight, createExecutor = createZylosExecutor,
} = {}) {
  const options = parseZylosArguments(args);
  if (options.help) { console.log(HELP); return 0; }
  if (options.mode === 'report') {
    const stateRoot = readStateDirectory(env);
    console.log(JSON.stringify({ ...reportState(stateRoot), zylos_tasks: await readTaskLedgerReport(stateRoot) }, null, 2));
    return 0;
  }
  const config = { ...readZylosConfiguration(env), once: options.once };
  const controller = new AbortController();
  let lock, executor, safeToRelease = false, exitCode = 0;
  const onInterrupt = () => { exitCode = 130; controller.abort(new ShutdownError()); };
  const onTerminate = () => { exitCode = 143; controller.abort(new ShutdownError()); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const readiness = await checkEnvironment(config, { signal: controller.signal });
    if (controller.signal.aborted) readiness.ready = false;
    if (options.mode === 'check') {
      console.log(JSON.stringify(readiness, null, 2));
      return exitCode || (readiness.ready ? 0 : 2);
    }
    if (controller.signal.aborted) return exitCode;
    if (!readiness.ready) throw new ConfigurationError(`Zylos Task preflight failed: ${readiness.checks.filter(item => !item.passed).map(item => item.name).join(', ')}. Inspect this invocation's --check JSON.`);
    assertExecutionWindow(config);
    process.umask(0o077);
    lock = acquireWorkerLock(config.stateRoot);
    const token = readHubToken(config.tokenFile);
    executor = await createExecutor({ ...config, token });
    console.log(JSON.stringify({ event: 'zylos_task_worker_ready', runner_id: config.runnerId,
      executor: 'zylos-core-task', engine: 'codex-exec', api: 'zylos-task-v1', model: config.model, concurrency: 1 }));
    const stats = await runWorker({ ...config, token }, {
      executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, signal: controller.signal,
      beforeClaim: () => { controller.signal.throwIfAborted(); assertExecutionWindow(config); },
    });
    safeToRelease = !stats.stopped && !controller.signal.aborted && executor.canReleaseLock();
    return exitCode || (stats.failed > 0 ? 1 : 0);
  } finally {
    try { await executor?.drain(); }
    finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
    if (safeToRelease && executor?.canReleaseLock()) lock?.release();
  }
}

if (isMainModule(import.meta)) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(`Zylos Task worker: ${error instanceof ConfigurationError || error instanceof RunnerError
      ? safeErrorMessage(error) : 'Execution stopped; inspect the private task journals before restarting.'}`);
    process.exitCode = 2;
  }
}
