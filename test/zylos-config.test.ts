import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseZylosArguments, readZylosConfiguration, preflight, assertExecutionWindow, ZYLOS_ENGINE_CHECKS } from '../scripts/zylos-runner/config.mjs';
import { evaluateExecutionWindow } from '../scripts/m1-window-check.mjs';
import { runWorker } from '../scripts/task-runner/worker.mjs';

const expiresAt = '2026-11-04T06:38:16.417Z';
const capability = { api: 'zylos-task-v1', supported: true, runtime: 'codex', upstream_version: '0.5.2',
  upstream_commit: '8ee9bd9007edab46f766f3574e0ad56cf69268c2', extension_version: '0.5.2+hxa.task.1',
  isolated_context: true, correlated_result: true, precise_cancellation: true, durable_intent: true, max_concurrency: 1 };
const engineReport = () => ({ ready: true, codex_version_required: '0.166.0',
  checks: ZYLOS_ENGINE_CHECKS.map(name => ({ name, passed: true })) });
const env = {
  HXA_TASK_URL: 'http://127.0.0.1:4801', HXA_TASK_TOKEN_FILE: '/run/credentials/hxa-fixture/hub-token',
  HXA_ARTIFACT_PUBLIC_BASE_URL: 'https://agents.example.test', HXA_RUNNER_ID: 'zylos-offline-test',
  HXA_CODEX_STATE_DIR: '/data/isolated-fixture', HXA_CODEX_BIN: '/opt/fixture/codex',
  HXA_CODEX_HOME_DIR: '/var/lib/fixture', CODEX_HOME: '/var/lib/fixture/codex',
  HXA_CODEX_MODEL: 'fixture-model', HXA_CODEX_REASONING_EFFORT: 'medium', HXA_ZYLOS_TOKEN_EXPIRES_AT: expiresAt,
};
afterEach(() => vi.restoreAllMocks());

describe('explicit Zylos task configuration and admission', () => {
  it('keeps precise UTC milliseconds from the issuance record', () => {
    const result = evaluateExecutionWindow({ expiresAt, taskTimeoutMs: 1_800_000, now: Date.parse(expiresAt) - 2_100_001 });
    expect(result).toMatchObject({ expires_at: expiresAt, window_adequate: true, remaining_ms: 2_100_001, token_auth_verified: false });
    expect(evaluateExecutionWindow({ expiresAt, taskTimeoutMs: 1_800_000, now: Date.parse(expiresAt) - 2_100_000 }).window_adequate).toBe(false);
  });
  it.each(['2026-11-04T06:38:16.4Z', '2026-11-04T06:38:16.4171Z', '2026-02-30T06:38:16.417Z'])('rejects ambiguous or invalid fractional expiry %s', value => {
    expect(() => readZylosConfiguration({ ...env, HXA_ZYLOS_TOKEN_EXPIRES_AT: value })).toThrow('UTC');
  });
  it('selects the task API explicitly and preserves the old entrypoints', () => {
    expect(parseZylosArguments(['--zylos', '--once'])).toEqual({ mode: 'zylos', once: true });
    expect(parseZylosArguments(['--check'])).toEqual({ mode: 'check', once: false });
    expect(parseZylosArguments(['--help'])).toEqual({ help: true });
    for (const args of [[], ['--codex'], ['--mock'], ['--zylos', '--zylos'], ['--check', '--once'], ['--help', '--zylos'], ['--token', 'synthetic-secret']]) {
      expect(() => parseZylosArguments(args)).toThrow();
    }
  });
  it('requires the reported expiry and enforces the thirty-minute ceiling and strict state reads', () => {
    expect(() => readZylosConfiguration({ ...env, HXA_ZYLOS_TOKEN_EXPIRES_AT: undefined })).toThrow('UTC');
    expect(() => readZylosConfiguration({ ...env, HXA_CODEX_TASK_TIMEOUT_MS: '1800001' })).toThrow('30 minutes');
    expect(readZylosConfiguration(env)).toMatchObject({ isolateStateReads: true, tokenExpiresAt: expiresAt, stopReserveMs: 300000, timeoutMs: 1800000 });
  });
  it.each(['ZYLOS_DIR', 'HXA_ZYLOS_CORE_DIR', 'HXA_ZYLOS_RUNTIME', 'CODEX_BYPASS_PERMISSIONS'])('rejects shared/default/bypass override %s', key => {
    expect(() => readZylosConfiguration({ ...env, [key]: 'synthetic-sensitive-path' })).toThrow('unsupported');
  });
  it('rejects a reserve shorter than a separately enlarged finite finish budget', () => {
    expect(() => readZylosConfiguration({ ...env, HXA_TASK_MAX_RETRIES: '10', HXA_TASK_REQUEST_TIMEOUT_MS: '60000', HXA_TASK_RETRY_MAX_MS: '30000' })).toThrow('finish-retry');
  });
  it('does not claim tasks or run an executor when the admission window closes', async () => {
    const fetchImpl = vi.fn(), executeTask = vi.fn();
    const config = readZylosConfiguration(env);
    await expect(runWorker({ ...config, token: 'offline-credential-fixture', once: true }, {
      fetchImpl, executeTask, logger: () => {},
      beforeClaim: () => assertExecutionWindow(config, Date.parse(expiresAt)),
    })).rejects.toThrow('window');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });
  it('checks admission again before a second claim instead of extending the token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const executeTask = vi.fn(), beforeClaim = vi.fn();
    beforeClaim.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('window closed'); });
    await expect(runWorker({ token: 'fixture', runnerId: 'fixture', url: 'http://localhost', pollMs: 1 }, {
      fetchImpl, executeTask, beforeClaim, logger: () => {},
    })).rejects.toThrow('window closed');
    expect(beforeClaim).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
  });
  it('keeps a cancelled admission from reaching the claim endpoint', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn();
    const stats = await runWorker({ token: 'fixture', runnerId: 'fixture', url: 'http://localhost' }, {
      signal: controller.signal, executeTask: vi.fn(), fetchImpl, logger: () => {},
      beforeClaim: () => controller.abort(),
    });
    expect(stats.stopped).toBe(true);
    expect(stats.claimed).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('requires real source, explicit task capability, engine checks and a fresh window separately', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) - 3_600_000);
    const config = readZylosConfiguration(env);
    const checkEngine = vi.fn(async () => engineReport());
    const verifySource = vi.fn(async () => ({ api: 'zylos-task-v1' }));
    const loadAdapter = vi.fn(async () => ({ taskCapabilities: () => capability }));
    const report = await preflight(config, { checkEngine, verifySource, loadAdapter });
    expect(report).toMatchObject({ ready: true, model_invoked: false, hub_contacted: false, existing_zylos_session_accessed: false });
    expect(checkEngine.mock.calls[0][0].isolateStateReads).toBe(true);
    loadAdapter.mockResolvedValue({ taskCapabilities: () => ({ ...capability, supported: false }) });
    expect((await preflight(config, { checkEngine, verifySource, loadAdapter })).ready).toBe(false);
    verifySource.mockRejectedValue(new Error('source mismatch'));
    loadAdapter.mockClear();
    expect((await preflight(config, { checkEngine, verifySource, loadAdapter })).ready).toBe(false);
    expect(loadAdapter).not.toHaveBeenCalled();
  });
  it.each(['empty', 'missing_history', 'duplicate', 'string_boolean', 'contradictory_ready', 'wrong_version'])
    ('cannot report full readiness from %s engine evidence', async mode => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) - 3_600_000);
      const engine: any = engineReport();
      if (mode === 'empty') engine.checks = [];
      if (mode === 'missing_history') engine.checks = engine.checks.filter((item: any) => item.name !== 'sandbox_task_history_reads_denied');
      if (mode === 'duplicate') engine.checks[1] = engine.checks[0];
      if (mode === 'string_boolean') engine.checks[0].passed = 'true';
      if (mode === 'contradictory_ready') engine.ready = false;
      if (mode === 'wrong_version') engine.codex_version_required = '0.165.0';
      const report = await preflight(readZylosConfiguration(env), {
        checkEngine: async () => engine, verifySource: async () => ({ api: 'zylos-task-v1' }),
        loadAdapter: async () => ({ taskCapabilities: () => capability }),
      });
      expect(report.ready).toBe(false);
      expect(report.engine_evidence_valid).toBe(false);
      expect(report.checks).toHaveLength(20);
      expect(report.checks.find((item: any) => item.name === 'sandbox_task_history_reads_denied').passed).toBe(false);
    });
});
