import { hostname } from 'node:os';

export const DEFAULTS = Object.freeze({
  pollMs: 2000,
  heartbeatMs: 15_000,
  requestTimeoutMs: 10_000,
  maxRetries: 3,
  retryBaseMs: 250,
  retryMaxMs: 2000,
  mockDelayMs: 1000,
});

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function numberSetting(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new ConfigurationError('HXA_TASK_URL must be an absolute HTTP(S) Hub URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError('HXA_TASK_URL must use HTTP(S), without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function readConfiguration(env = process.env) {
  if (!env.HXA_TASK_URL) throw new ConfigurationError('Set HXA_TASK_URL to the Hub base URL.');
  if (!env.HXA_TASK_TOKEN?.trim()) throw new ConfigurationError('Set HXA_TASK_TOKEN to the assigned bot bearer token.');
  const runnerId = env.HXA_RUNNER_ID || `runner-${hostname()}-${process.pid}`;
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(runnerId)) {
    throw new ConfigurationError('HXA_RUNNER_ID must contain 1–128 letters, digits, underscores, dots, colons, or hyphens.');
  }
  return {
    url: normalizeBaseUrl(env.HXA_TASK_URL),
    token: env.HXA_TASK_TOKEN,
    runnerId,
    pollMs: numberSetting(env, 'HXA_TASK_POLL_MS', DEFAULTS.pollMs, 100, 300_000),
    heartbeatMs: numberSetting(env, 'HXA_TASK_HEARTBEAT_MS', DEFAULTS.heartbeatMs, 100, 30_000),
    requestTimeoutMs: numberSetting(env, 'HXA_TASK_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 100, 60_000),
    maxRetries: numberSetting(env, 'HXA_TASK_MAX_RETRIES', DEFAULTS.maxRetries, 0, 10),
    retryBaseMs: numberSetting(env, 'HXA_TASK_RETRY_BASE_MS', DEFAULTS.retryBaseMs, 10, 10_000),
    retryMaxMs: numberSetting(env, 'HXA_TASK_RETRY_MAX_MS', DEFAULTS.retryMaxMs, 10, 30_000),
    mockDelayMs: numberSetting(env, 'HXA_MOCK_DELAY_MS', DEFAULTS.mockDelayMs, 0, 300_000),
  };
}

export function parseArguments(args) {
  const allowed = new Set(['--mock', '--once', '--help', '-h']);
  if (args.some(arg => !allowed.has(arg))) {
    throw new ConfigurationError('Unknown runner option. Use --help. Credentials are accepted through environment variables only.');
  }
  const help = args.includes('--help') || args.includes('-h');
  if (!help && !args.includes('--mock')) {
    throw new ConfigurationError('No execution adapter selected. Pass --mock for simulation; no model is invoked by this runner.');
  }
  return { help, mock: args.includes('--mock'), once: args.includes('--once') };
}
