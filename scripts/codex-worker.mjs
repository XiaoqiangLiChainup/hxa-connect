#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ConfigurationError } from './task-runner/config.mjs';
import { runWorker, RunnerError, safeErrorMessage, ShutdownError } from './task-runner/worker.mjs';
import { parseCodexArguments, preflight, readCodexConfiguration, readHubToken, readStateDirectory } from './codex-runner/config.mjs';
import { acquireWorkerLock, reportState } from './codex-runner/state.mjs';
import { createCodexExecutor } from './codex-runner/adapter.mjs';

const HELP = `Usage: node scripts/codex-worker.mjs --check | --report | --codex [--once]

--check  Local version, identity, permissions, and login-status checks; no inference or Hub mutation.
--report Read-only local run/upload evidence. Needs only HXA_CODEX_STATE_DIR.
--codex  Explicit real execution. Requires a dedicated approved identity and pinned model.
--once   Claim at most one task; an empty queue also exits successfully.

The original scripts/task-runner.mjs --mock remains unchanged.
Configure HXA_TASK_URL, HXA_TASK_TOKEN_FILE, HXA_RUNNER_ID,
HXA_ARTIFACT_PUBLIC_BASE_URL, HXA_CODEX_STATE_DIR, HXA_CODEX_BIN,
HXA_CODEX_HOME_DIR, CODEX_HOME, HXA_CODEX_MODEL, HXA_CODEX_REASONING_EFFORT.
Linux, a non-root dedicated user, Node 22+, and Codex CLI 0.166.0 are required.
No default model, inherited API key, shared session, or automatic work replay.
See docs/m1-codex-worker.md and deploy/systemd/codex-worker.env.example.`;

// The optional dependency is for model-free lifecycle tests; the CLI always uses real preflight.
export async function main(args = process.argv.slice(2), env = process.env, { checkEnvironment = preflight } = {}) {
  const options = parseCodexArguments(args);
  if (options.help) { console.log(HELP); return 0; }
  if (options.mode === 'report') { console.log(JSON.stringify(reportState(readStateDirectory(env)), null, 2)); return 0; }
  const config = { ...readCodexConfiguration(env), once: options.once };
  const readiness = await checkEnvironment(config);
  if (options.mode === 'check') { console.log(JSON.stringify(readiness, null, 2)); return readiness.ready ? 0 : 2; }
  if (!readiness.ready) {
    throw new ConfigurationError(`Worker preflight failed: ${readiness.checks.filter(check => !check.passed).map(check => check.name).join(', ')}. Run --check after provisioning the dedicated environment.`);
  }
  process.umask(0o077);
  const lock = acquireWorkerLock(config.stateRoot);
  let executor;
  let safeToRelease = false;
  const controller = new AbortController();
  let exitCode = 0;
  const onInterrupt = () => { exitCode = 130; controller.abort(new ShutdownError()); };
  const onTerminate = () => { exitCode = 143; controller.abort(new ShutdownError()); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const token = readHubToken(config.tokenFile);
    executor = createCodexExecutor({ ...config, token });
    console.log(JSON.stringify({ event: 'codex_worker_ready', runner_id: config.runnerId, model: config.model, concurrency: 1 }));
    const stats = await runWorker({ ...config, token }, {
      executeTask: executor.executeTask, onRunSettled: executor.onRunSettled, signal: controller.signal,
    });
    safeToRelease = !stats.stopped && !controller.signal.aborted && executor.canReleaseLock();
    return exitCode || (stats.failed > 0 ? 1 : 0);
  } catch (error) {
    // Any transport/claim/finish uncertainty leaves a durable interlock, even with a clean process.
    throw error;
  } finally {
    await executor?.drain();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (safeToRelease && executor?.canReleaseLock()) lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); } catch (error) {
    console.error(`Codex worker: ${error instanceof ConfigurationError || error instanceof RunnerError ? safeErrorMessage(error) : 'Worker stopped; inspect local state before restarting.'}`);
    process.exitCode = 2;
  }
}
