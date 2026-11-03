import { DEFAULTS, ConfigurationError, normalizeBaseUrl } from './config.mjs';

const LEASE_CODES = new Set([
  'TASK_LEASE_EXPIRED', 'TASK_LEASE_INVALID', 'TASK_CANCELLED', 'TASK_RUN_INACTIVE',
]);

export class RunnerError extends Error {
  constructor(message, { code = 'RUNNER_ERROR', status, retryable = false } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class LeaseLostError extends RunnerError {
  constructor(code = 'TASK_LEASE_EXPIRED', status) {
    super('The execution lease is no longer usable; execution was stopped.', { code, status });
    this.name = 'LeaseLostError';
  }
}

export class ShutdownError extends RunnerError {
  constructor() {
    super('Runner shutdown requested.', { code: 'RUNNER_STOPPED' });
    this.name = 'ShutdownError';
  }
}

export function safeErrorMessage(error) {
  if (error instanceof ConfigurationError || error instanceof RunnerError) return error.message;
  return 'Unexpected runner error. No further task was claimed.';
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new ShutdownError();
}

export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(abortReason(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    // Attaching both handlers also prevents a late adapter rejection becoming unhandled.
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function redact(value, secrets) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text;
}

function makeLogger(logger, secrets) {
  return (event, fields = {}) => {
    try {
      const safe = JSON.parse(JSON.stringify({ event, ...fields }, (_key, value) => typeof value === 'string' ? redact(value, secrets) : value));
      logger(safe);
    } catch { /* Logging must never alter task execution. */ }
  };
}

function publicCode(body) {
  const code = body?.code ?? body?.error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'HTTP_REJECTED';
}

function leaseTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new RunnerError('The Hub returned an invalid lease expiry.', { code: 'INVALID_LEASE_RESPONSE' });
  }
  return timestamp;
}

class LeaseGuard {
  controller = new AbortController();
  timer = null;

  constructor(expiresAt, parentSignal, now) {
    this.now = now;
    this.parentSignal = parentSignal;
    this.onParentAbort = () => this.abort(new ShutdownError());
    parentSignal?.addEventListener('abort', this.onParentAbort, { once: true });
    this.renew(expiresAt);
    if (parentSignal?.aborted) this.onParentAbort();
  }

  get signal() { return this.controller.signal; }

  renew(value) {
    if (this.signal.aborted) throw abortReason(this.signal);
    this.expiresAt = leaseTimestamp(value);
    clearTimeout(this.timer);
    const remaining = this.expiresAt - this.now();
    if (remaining <= 0) {
      this.abort(new LeaseLostError());
      return;
    }
    this.timer = setTimeout(() => this.abort(new LeaseLostError()), Math.min(remaining, 2_147_483_647));
  }

  assertActive() {
    if (!this.signal.aborted && this.now() >= this.expiresAt) this.abort(new LeaseLostError());
    if (this.signal.aborted) throw abortReason(this.signal);
  }

  abort(error) {
    if (!this.signal.aborted) this.controller.abort(error);
    clearTimeout(this.timer);
  }

  close() {
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener('abort', this.onParentAbort);
  }
}

/** Small HTTP client. Only lease-bound heartbeat/finish operations may retry. */
class TaskClient {
  constructor(config, { fetchImpl, now, log }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
  }

  async request(path, serializedBody, { signal, lease, retry = false, operation }) {
    for (let attempt = 0; ; attempt++) {
      lease?.assertActive();
      if (signal?.aborted) throw abortReason(signal);
      const remaining = lease ? lease.expiresAt - this.now() : Infinity;
      const timeoutMs = Math.max(1, Math.min(this.config.requestTimeoutMs, remaining));
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const signals = [timeout.signal, signal, lease?.signal].filter(Boolean);
      const requestSignal = AbortSignal.any(signals);
      let failure;
      try {
        const response = await this.fetchImpl(`${this.config.url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
          body: serializedBody,
          signal: requestSignal,
          redirect: 'error',
        });
        let body;
        try { body = await response.json(); } catch {
          if (response.ok) throw new RunnerError('The Hub returned invalid JSON.', { code: 'INVALID_RESPONSE' });
        }
        lease?.assertActive();
        if (response.ok) return body;
        const code = publicCode(body);
        if ([403, 409].includes(response.status) && LEASE_CODES.has(code)) {
          throw new LeaseLostError(code, response.status);
        }
        throw new RunnerError(`Hub rejected ${operation} (HTTP ${response.status}, ${code}).`, {
          status: response.status,
          code,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        lease?.assertActive();
        failure = error instanceof RunnerError ? error : new RunnerError(`Network request failed during ${operation}.`, {
          code: timeout.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!retry || !failure.retryable || attempt >= this.config.maxRetries) throw failure;
      const delay = Math.min(this.config.retryBaseMs * 2 ** attempt, this.config.retryMaxMs);
      if (lease && this.now() + delay >= lease.expiresAt) {
        // Wait only until the known deadline. Never extend a lease based on hope.
        await abortableDelay(Math.max(1, lease.expiresAt - this.now()), lease.signal);
        lease.assertActive();
      }
      this.log('request_retry', { operation, attempt: attempt + 1, delay_ms: delay });
      await abortableDelay(delay, signal && lease ? AbortSignal.any([signal, lease.signal]) : signal || lease?.signal);
    }
  }

  claim(runnerId, signal) {
    // Retrying this POST after a lost response could acquire another task.
    return this.request('/api/tasks/claim', JSON.stringify({ runner_id: runnerId }), { signal, operation: 'claim' });
  }
}

function resultPayload(result, leaseToken, secrets) {
  if (!result || typeof result !== 'object' || !['succeeded', 'failed'].includes(result.status)) {
    throw new RunnerError('The execution adapter must return an explicit succeeded or failed result.', { code: 'INVALID_ADAPTER_RESULT' });
  }
  const payload = { lease_token: leaseToken, status: result.status };
  if (result.summary !== undefined) {
    if (typeof result.summary !== 'string') throw new RunnerError('Adapter summary must be text.', { code: 'INVALID_ADAPTER_RESULT' });
    payload.summary = redact(result.summary, secrets);
  }
  if (result.error !== undefined) {
    if (typeof result.error !== 'string') throw new RunnerError('Adapter error must be text.', { code: 'INVALID_ADAPTER_RESULT' });
    payload.error = redact(result.error, secrets);
  }
  if (payload.status === 'succeeded' && !payload.summary?.trim()) {
    throw new RunnerError('A successful adapter result requires a non-empty summary.', { code: 'INVALID_ADAPTER_RESULT' });
  }
  if (payload.status === 'failed' && !payload.error?.trim()) {
    throw new RunnerError('A failed adapter result requires a non-empty error.', { code: 'INVALID_ADAPTER_RESULT' });
  }
  if (result.artifacts !== undefined) {
    if (!Array.isArray(result.artifacts) || result.artifacts.some(item => !item || typeof item.title !== 'string' || typeof item.url !== 'string')) {
      throw new RunnerError('Adapter artifacts must be title/URL objects.', { code: 'INVALID_ADAPTER_RESULT' });
    }
    // Links are metadata only; the runner never opens them.
    payload.artifacts = result.artifacts.map(({ title, url }) => ({ title: redact(title, secrets), url: redact(url, secrets) }));
  }
  return payload;
}

async function executeClaim(claim, config, dependencies) {
  const { task, run, lease_token: leaseToken } = claim;
  if (!task || typeof task.id !== 'string' || !run || typeof run.id !== 'string' || typeof leaseToken !== 'string' || !leaseToken) {
    throw new RunnerError('Claim response is incomplete; no task was executed.', { code: 'INVALID_CLAIM_RESPONSE' });
  }
  const { client, signal, executeTask, onRunSettled, log, secrets, now } = dependencies;
  secrets.add(leaseToken);
  const lease = new LeaseGuard(run.lease_expires_at, signal, now);
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([heartbeatStop.signal, lease.signal]);
  const runPath = `/api/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`;
  const heartbeatBody = JSON.stringify({ lease_token: leaseToken });
  const heartbeat = (async () => {
    try {
      while (!heartbeatSignal.aborted) {
        await abortableDelay(config.heartbeatMs, heartbeatSignal);
        lease.assertActive();
        const response = await client.request(`${runPath}/heartbeat`, heartbeatBody, {
          signal: heartbeatSignal, lease, retry: true, operation: 'heartbeat',
        });
        lease.renew(response?.lease_expires_at);
        log('task_heartbeat', { task_id: task.id, run_id: run.id });
      }
    } catch (error) {
      if (!heartbeatStop.signal.aborted && !lease.signal.aborted) lease.abort(error);
    }
  })();

  let confirmedResult;
  let stoppedCode;
  try {
    lease.assertActive();
    log('task_started', { task_id: task.id, run_id: run.id });
    let result;
    try {
      result = await raceAbort(Promise.resolve().then(() => executeTask({ task, run, signal: lease.signal })), lease.signal);
    } catch (error) {
      lease.assertActive();
      result = {
        status: 'failed',
        error: redact(error instanceof Error ? error.message : 'Execution adapter failed.', secrets).slice(0, 4000),
      };
    }

    // No heartbeat can race a successful finish and misclassify its final run as lost.
    heartbeatStop.abort();
    await heartbeat;
    lease.assertActive();
    let payload;
    try { payload = resultPayload(result, leaseToken, secrets); } catch (error) {
      payload = { lease_token: leaseToken, status: 'failed', error: safeErrorMessage(error) };
    }
    const serializedPayload = JSON.stringify(payload); // Identical bytes and token on every retry.
    const response = await client.request(`${runPath}/finish`, serializedPayload, {
      signal: lease.signal, lease, retry: true, operation: 'finish',
    });
    if (response?.task?.id !== task.id || response?.run?.id !== run.id || response.run.status !== payload.status) {
      throw new RunnerError('Finish response is incomplete; inspect the task before retrying work.', { code: 'INVALID_FINISH_RESPONSE' });
    }
    confirmedResult = { task: response.task, run: response.run, status: payload.status };
    log('task_finished', { task_id: task.id, run_id: run.id, status: payload.status });
    return confirmedResult;
  } catch (error) {
    lease.abort(error);
    stoppedCode = error instanceof RunnerError ? error.code : 'RUNNER_ERROR';
    log('task_stopped', { task_id: task.id, run_id: run.id, code: error instanceof RunnerError ? error.code : 'RUNNER_ERROR' });
    throw error;
  } finally {
    heartbeatStop.abort();
    await heartbeat;
    lease.close();
    secrets.delete(leaseToken);
    if (onRunSettled) {
      try {
        // No credential or lease token is exposed to lifecycle observers.
        // Real adapters use this hook to await cleanup and persist finish evidence.
        await onRunSettled({
          task, run, confirmed: Boolean(confirmedResult),
          status: confirmedResult?.status, code: stoppedCode,
        });
      } catch {
        throw new RunnerError('Unable to record run completion or confirm executor cleanup; inspect before restarting.', { code: 'RUN_SETTLEMENT_FAILED' });
      }
    }
  }
}

/**
 * Run one task (--once), or sequentially poll until stopped.
 * executeTask({task, run, signal}) must honor signal and return an explicit result.
 * No execution adapter, model, shell, or remote URL is implicitly selected here.
 */
export async function runWorker(configuration, {
  executeTask,
  onRunSettled,
  beforeClaim,
  signal,
  fetchImpl = globalThis.fetch,
  logger = entry => console.log(JSON.stringify(entry)),
  now = Date.now,
} = {}) {
  if (typeof executeTask !== 'function') throw new ConfigurationError('An explicit executeTask adapter is required.');
  if (onRunSettled !== undefined && typeof onRunSettled !== 'function') throw new ConfigurationError('onRunSettled must be a function when provided.');
  if (beforeClaim !== undefined && typeof beforeClaim !== 'function') throw new ConfigurationError('beforeClaim must be a function when provided.');
  if (!configuration?.token || !configuration?.runnerId) throw new ConfigurationError('A bot token and runner ID are required.');
  const config = { ...DEFAULTS, ...configuration, url: normalizeBaseUrl(configuration.url) };
  const secrets = new Set([config.token]);
  const log = makeLogger(logger, secrets);
  const client = new TaskClient(config, { fetchImpl, now, log });
  const stats = { claimed: 0, succeeded: 0, failed: 0, stopped: false, lastResult: null };
  log('runner_started', { runner_id: config.runnerId, once: Boolean(config.once) });
  try {
    while (!signal?.aborted) {
      // Optional local admission checks run before any claim side effect. No
      // bearer/lease token or Task data is exposed, and the default is unchanged.
      if (beforeClaim) await beforeClaim({ signal });
      if (signal?.aborted) break;
      const claim = await client.claim(config.runnerId, signal);
      if (!claim || !Object.hasOwn(claim, 'task')) {
        throw new RunnerError('Claim response has no task field; no task was executed.', { code: 'INVALID_CLAIM_RESPONSE' });
      }
      if (claim.task !== null) {
        stats.claimed++;
        const result = await executeClaim(claim, config, { client, signal, executeTask, onRunSettled, log, secrets, now });
        stats[result.status]++;
        stats.lastResult = result;
      } else {
        log('runner_idle');
      }
      if (config.once) return stats;
      await abortableDelay(config.pollMs, signal);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  stats.stopped = true;
  log('runner_stopped', { runner_id: config.runnerId });
  return stats;
}

/** Explicit simulation: no model, shell commands, files, or user URLs are executed. */
export function createMockExecutor({ delayMs = DEFAULTS.mockDelayMs } = {}) {
  return async function executeMockTask({ task, signal }) {
    await abortableDelay(delayMs, signal);
    return {
      status: 'succeeded',
      summary: [
        '模拟执行 / No model invoked.',
        `任务：${String(task.title || '').slice(0, 300)}`,
        `需求摘要：${String(task.description || '').slice(0, 1200)}`,
        '已验证任务领取、执行等待和结果回传。此模拟结果不表示业务需求已实现；没有运行用户命令或访问用户链接。',
      ].join('\n'),
      artifacts: [],
    };
  };
}
