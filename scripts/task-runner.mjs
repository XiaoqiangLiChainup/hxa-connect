#!/usr/bin/env node
import { isMainModule } from './cli-entrypoint.mjs';
import { parseArguments, readConfiguration } from './task-runner/config.mjs';
import { createMockExecutor, runWorker, safeErrorMessage, ShutdownError } from './task-runner/worker.mjs';

export { createMockExecutor, runWorker } from './task-runner/worker.mjs';

const HELP = `Usage: node scripts/task-runner.mjs --mock [--once]

--mock   Required for this CLI: explicit simulation, no model invoked.
--once   Claim at most one task; exit also when the queue is empty.
--help   Show this help.

Required environment: HXA_TASK_URL, HXA_TASK_TOKEN.
Optional: HXA_RUNNER_ID, HXA_TASK_POLL_MS (2000),
HXA_TASK_HEARTBEAT_MS (15000), HXA_TASK_REQUEST_TIMEOUT_MS (10000),
HXA_TASK_MAX_RETRIES (3), HXA_TASK_RETRY_BASE_MS (250),
HXA_TASK_RETRY_MAX_MS (2000), HXA_MOCK_DELAY_MS (1000).

Token values are read from the environment, never from command arguments.
An uncertain claim or result stops the worker; work is not automatically repeated.
See docs/task-runner.md for the executeTask adapter contract.`;

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArguments(args);
  if (options.help) { console.log(HELP); return 0; }
  const config = { ...readConfiguration(env), once: options.once };
  const controller = new AbortController();
  let exitCode = 0;
  const onInterrupt = () => { exitCode = 130; controller.abort(new ShutdownError()); };
  const onTerminate = () => { exitCode = 143; controller.abort(new ShutdownError()); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    console.log('模拟执行 / No model invoked.');
    const result = await runWorker(config, {
      executeTask: createMockExecutor({ delayMs: config.mockDelayMs }),
      signal: controller.signal,
    });
    return exitCode || (result.failed > 0 ? 1 : 0);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (isMainModule(import.meta)) {
  try { process.exitCode = await main(); } catch (error) {
    console.error(`Task runner: ${safeErrorMessage(error)}`);
    process.exitCode = 2;
  }
}
