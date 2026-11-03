import { ConfigurationError } from '../task-runner/config.mjs';
import { preflight as codexPreflight, readCodexConfiguration } from '../codex-runner/config.mjs';
import { evaluateExecutionWindow } from '../m1-window-check.mjs';
import { verifyTaskSource, loadTaskAdapter } from './provenance.mjs';

export const ZYLOS_ENGINE_CHECKS = Object.freeze([
  'linux_non_root_user', 'node_22_or_later', 'private_state_directory', 'dedicated_model_directories',
  'hub_token_file', 'free_disk_budget', 'trusted_codex_executable', 'trusted_child_path',
  'codex_0_166_0', 'dedicated_chatgpt_login_configured',
  'sandbox_command_startup', 'sandbox_workspace_write', 'sandbox_outside_write_denied',
  'sandbox_credential_reads_denied', 'sandbox_network_restricted',
  'sandbox_task_history_reads_denied', 'sandbox_probe_cleanup',
]);

function engineEvidence(report, signal) {
  const list = Array.isArray(report?.checks) ? report.checks : [];
  const valid = report?.codex_version_required === '0.166.0' && typeof report.ready === 'boolean'
    && list.length === ZYLOS_ENGINE_CHECKS.length
    && ZYLOS_ENGINE_CHECKS.every(name => list.filter(item => item?.name === name).length === 1)
    && list.every(item => typeof item?.passed === 'boolean')
    && (report.ready === list.every(item => item.passed) || (signal?.aborted === true && report.ready === false));
  return { valid, ready: valid && report.ready === true,
    checks: ZYLOS_ENGINE_CHECKS.map(name => ({ name,
      passed: valid && list.find(item => item.name === name)?.passed === true })) };
}

export function parseZylosArguments(args) {
  const allowed = new Set(['--zylos', '--once', '--check', '--report', '--help', '-h']);
  if (args.some(item => !allowed.has(item)) || new Set(args).size !== args.length) {
    throw new ConfigurationError('Unknown or repeated Zylos worker option. Use --help; credentials are never arguments.');
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const modes = ['--zylos', '--check', '--report'].filter(item => args.includes(item));
  if (modes.length !== 1 || args.includes('--help') || args.includes('-h') || (args.includes('--once') && modes[0] !== '--zylos')) {
    throw new ConfigurationError('Choose --zylos [--once], --check, or --report explicitly.');
  }
  return { mode: modes[0].slice(2), once: args.includes('--once') };
}

export function executionWindow(config, now = Date.now()) {
  return evaluateExecutionWindow({ expiresAt: config.tokenExpiresAt, taskTimeoutMs: config.timeoutMs, reserveMs: config.stopReserveMs, now });
}

export function assertExecutionWindow(config, now) {
  const window = executionWindow(config, now);
  if (!window.window_adequate) throw new ConfigurationError('The reported Hub-token window cannot cover this task and settlement reserve. Stop; no credential renewal or fallback is permitted.');
  return window;
}

export function readZylosConfiguration(env = process.env) {
  const config = readCodexConfiguration(env);
  if (config.timeoutMs > 1_800_000) throw new ConfigurationError('M1 Zylos tasks are limited to 30 minutes.');
  if (env.ZYLOS_DIR || env.HXA_ZYLOS_CORE_DIR || env.HXA_ZYLOS_RUNTIME || env.CODEX_BYPASS_PERMISSIONS) {
    throw new ConfigurationError('Zylos tasks use the pinned task extension and explicit private context; shared runtime/path/bypass overrides are unsupported.');
  }
  const tokenExpiresAt = env.HXA_ZYLOS_TOKEN_EXPIRES_AT;
  const reserve = env.HXA_ZYLOS_STOP_RESERVE_MS ?? '300000';
  if (!/^\d+$/u.test(reserve)) throw new ConfigurationError('HXA_ZYLOS_STOP_RESERVE_MS must be a bounded millisecond value.');
  const stopReserveMs = Number(reserve);
  try { evaluateExecutionWindow({ expiresAt: tokenExpiresAt, taskTimeoutMs: config.timeoutMs, reserveMs: stopReserveMs }); }
  catch { throw new ConfigurationError('Set the exact recorded UTC HXA_ZYLOS_TOKEN_EXPIRES_AT and a reserve of 5 to 60 minutes.'); }
  // A reserve must cover the configured finite finish-retry budget plus cleanup.
  const retryReserve = (config.maxRetries + 1) * config.requestTimeoutMs
    + config.maxRetries * config.retryMaxMs + config.termGraceMs + 5000;
  if (stopReserveMs < retryReserve) throw new ConfigurationError('The stopping reserve does not cover the configured finish-retry budget.');
  return { ...config, isolateStateReads: true, tokenExpiresAt, stopReserveMs };
}

/** Credential-free source loading, the existing local checks, and a reported time window. */
export async function preflight(config, {
  signal, checkEngine = codexPreflight, verifySource = verifyTaskSource, loadAdapter = loadTaskAdapter,
} = {}) {
  const checks = [];
  let source;
  try { source = await verifySource(config); checks.push({ name: 'zylos_pinned_task_source', passed: true }); }
  catch { checks.push({ name: 'zylos_pinned_task_source', passed: false }); }
  try {
    if (!source) throw new Error();
    const adapter = await loadAdapter(config);
    const capabilities = adapter.taskCapabilities();
    if (capabilities.supported !== true || capabilities.api !== 'zylos-task-v1' || capabilities.runtime !== 'codex'
      || capabilities.upstream_version !== '0.5.2' || capabilities.upstream_commit !== '8ee9bd9007edab46f766f3574e0ad56cf69268c2'
      || capabilities.extension_version !== '0.5.2+hxa.task.1' || capabilities.max_concurrency !== 1
      || ['isolated_context', 'correlated_result', 'precise_cancellation', 'durable_intent'].some(key => capabilities[key] !== true)) throw new Error();
    checks.push({ name: 'zylos_explicit_task_runtime', passed: true });
  } catch { checks.push({ name: 'zylos_explicit_task_runtime', passed: false }); }
  const engine = await checkEngine(config, { signal });
  const evidence = engineEvidence(engine, signal);
  checks.push(...evidence.checks);
  let window;
  try { window = assertExecutionWindow(config); checks.push({ name: 'zylos_execution_window', passed: true }); }
  catch { window = executionWindow(config); checks.push({ name: 'zylos_execution_window', passed: false }); }
  return {
    scope: 'zylos-task-local-prerequisites', ready: !signal?.aborted && evidence.ready && checks.every(item => item.passed),
    executor: 'zylos-core-task', engine: 'codex-exec', api: 'zylos-task-v1', model: config.model,
    codex_version_required: '0.166.0', source, checks, sandbox: engine?.sandbox, execution_window: window,
    engine_evidence_valid: evidence.valid,
    model_invoked: false, hub_contacted: false, existing_zylos_session_accessed: false,
  };
}
