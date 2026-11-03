#!/usr/bin/env node
import { isMainModule } from './cli-entrypoint.mjs';

const MIN_RESERVE_MS = 300_000;
const HELP = `Usage: node scripts/m1-window-check.mjs --expires-at <YYYY-MM-DDTHH:mm:ssZ> --task-timeout-ms <milliseconds> [--reserve-ms <milliseconds>]

Check the reported token lifetime against the host clock, task budget, and at least five minutes of reserve.
This reads no token, makes no Hub/model request, and starts no task. It cannot prove token validity or select a task.
Exit 0 means the reported time window is adequate; exit 2 means stop. Inspect the JSON, then recheck immediately before the one-shot.
No renewal, credential replacement, clock override, or bypass option exists.`;

export class ExecutionWindowError extends Error {
  constructor() { super('Use an exact UTC expiry, a task budget of 1 second to 12 hours, and a reserve of 5 to 60 minutes.'); }
}

export function evaluateExecutionWindow({ expiresAt, taskTimeoutMs, reserveMs = MIN_RESERVE_MS, now = Date.now() } = {}) {
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(expiresAt)) throw new ExecutionWindowError();
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt.replace('Z', '.000Z')
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(taskTimeoutMs)
    || taskTimeoutMs < 1000 || taskTimeoutMs > 43_200_000 || !Number.isSafeInteger(reserveMs)
    || reserveMs < MIN_RESERVE_MS || reserveMs > 3_600_000) throw new ExecutionWindowError();
  const remainingMs = expiry - now;
  const requiredMs = taskTimeoutMs + reserveMs;
  const adequate = remainingMs > requiredMs;
  return {
    format: 'hxa-m1-execution-window-v1', scope: 'reported-token-window-only',
    checked_at: new Date(now).toISOString(), expires_at: expiresAt,
    task_timeout_ms: taskTimeoutMs, reserve_ms: reserveMs, remaining_ms: remainingMs,
    required_ms: requiredMs, window_adequate: adequate,
    code: adequate ? null : remainingMs <= 0 ? 'TOKEN_EXPIRED' : 'TOKEN_WINDOW_TOO_SHORT',
    token_auth_verified: false, task_selected: false, renewal_performed: false,
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(HELP); return 0; }
  const values = {};
  const names = { '--expires-at': 'expiresAt', '--task-timeout-ms': 'taskTimeoutMs', '--reserve-ms': 'reserveMs' };
  for (let index = 0; index < args.length; index += 2) {
    if (!Object.hasOwn(names, args[index])) throw new ExecutionWindowError();
    const key = names[args[index]];
    const value = args[index + 1];
    if (!key || values[key] !== undefined || typeof value !== 'string') throw new ExecutionWindowError();
    if (key !== 'expiresAt' && !/^\d+$/u.test(value)) throw new ExecutionWindowError();
    values[key] = key === 'expiresAt' ? value : Number(value);
  }
  const report = evaluateExecutionWindow(values);
  console.log(JSON.stringify(report, null, 2));
  return report.window_adequate ? 0 : 2;
}

if (isMainModule(import.meta)) {
  try { process.exitCode = main(); }
  catch {
    console.error('M1 execution window: invalid input; no task started. Use --help.');
    process.exitCode = 2;
  }
}
