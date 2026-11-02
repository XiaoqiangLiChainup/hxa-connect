import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../scripts/task-runner.mjs';
import {
  abortableDelay, createMockExecutor, LeaseLostError, runWorker,
} from '../scripts/task-runner/worker.mjs';
import { parseArguments, readConfiguration } from '../scripts/task-runner/config.mjs';

const TOKEN = 'bot-secret-do-not-log';
const LEASE_TOKEN = 'lease-secret-do-not-log';
const task = {
  id: 'task-1', title: 'Preview request', description: 'Build a preview; do not run this test text.',
  assigned_bot_id: 'bot-1', thread_id: 'thread-1', status: 'running', revision: 2,
};
const config = {
  url: 'http://127.0.0.1:4800', token: TOKEN, runnerId: 'test-runner', once: true,
  heartbeatMs: 15, pollMs: 10, requestTimeoutMs: 30,
  maxRetries: 3, retryBaseMs: 5, retryMaxMs: 10,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function fixture(overrides: Record<string, Function> = {}) {
  const calls: Array<{ path: string; body: string; signal: AbortSignal }> = [];
  const logs: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const call = { path, body: String(init.body), signal: init.signal as AbortSignal };
    calls.push(call);
    if (path.endsWith('/claim')) {
      if (overrides.claim) return overrides.claim(call);
      return json({ task, run: { id: 'run-1', lease_expires_at: Date.now() + 60 }, lease_token: LEASE_TOKEN });
    }
    if (path.endsWith('/heartbeat')) {
      if (overrides.heartbeat) return overrides.heartbeat(call);
      return json({ lease_expires_at: Date.now() + 60 });
    }
    if (path.endsWith('/finish')) {
      if (overrides.finish) return overrides.finish(call);
      const body = JSON.parse(call.body);
      return json({ task: { ...task, status: body.status === 'succeeded' ? 'reviewing' : 'failed', revision: 3 }, run: { id: 'run-1', ...body } });
    }
    throw new Error('Unexpected request');
  });
  return { fetchImpl, calls, logs, logger: (entry: unknown) => logs.push(entry) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('task runner', () => {
  it('does not fabricate an executor and requires the explicit CLI mock flag', () => {
    expect(() => parseArguments([])).toThrow('Pass --mock');
    expect(parseArguments(['--help']).help).toBe(true);
    expect(parseArguments(['--mock', '--once'])).toMatchObject({ mock: true, once: true });
    expect(() => readConfiguration({ HXA_TASK_URL: 'https://user:password@example.test', HXA_TASK_TOKEN: TOKEN })).toThrow('without credentials');
  });

  it('exits --once after an empty queue without invoking an adapter', async () => {
    const f = fixture({ claim: () => json({ task: null }) });
    const executeTask = vi.fn();
    const result = await runWorker(config, { ...f, executeTask });
    expect(result).toMatchObject({ claimed: 0, succeeded: 0, failed: 0 });
    expect(executeTask).not.toHaveBeenCalled();
    expect(f.calls.map(call => call.path)).toEqual(['/api/tasks/claim']);
  });

  it('renews the lease, returns explicit mock output, and stops heartbeats after finish', async () => {
    const f = fixture();
    const promise = runWorker(config, { ...f, executeTask: createMockExecutor({ delayMs: 80 }) });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.lastResult.task.status).toBe('reviewing');
    const finish = f.calls.filter(call => call.path.endsWith('/finish'));
    expect(f.calls.filter(call => call.path.endsWith('/heartbeat')).length).toBeGreaterThan(1);
    expect(finish).toHaveLength(1);
    expect(JSON.parse(finish[0].body).summary).toContain('模拟执行 / No model invoked.');
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toHaveLength(count);
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(f.logs)).not.toContain(LEASE_TOKEN);
  });

  it('retries a lost finish response with identical bytes and never executes again', async () => {
    let finishAttempts = 0;
    const f = fixture({ finish: () => {
      if (++finishAttempts === 1) throw new TypeError(`Network response lost ${TOKEN} ${LEASE_TOKEN}`);
      return json({ task: { ...task, status: 'reviewing' }, run: { id: 'run-1', status: 'succeeded' } });
    } });
    const executeTask = vi.fn(createMockExecutor({ delayMs: 1 }));
    const promise = runWorker(config, { ...f, executeTask });
    await vi.advanceTimersByTimeAsync(20);
    expect((await promise).succeeded).toBe(1);
    const finish = f.calls.filter(call => call.path.endsWith('/finish'));
    expect(finish).toHaveLength(2);
    expect(finish[0].body).toBe(finish[1].body);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.path.endsWith('/claim'))).toHaveLength(1);
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(f.logs)).not.toContain(LEASE_TOKEN);
  });

  it('survives temporary heartbeat errors within the lease', async () => {
    let attempts = 0;
    const f = fixture({ heartbeat: () => ++attempts < 3
      ? json({ code: 'TEMPORARY_ERROR' }, 503)
      : json({ lease_expires_at: Date.now() + 60 }) });
    const promise = runWorker(config, { ...f, executeTask: createMockExecutor({ delayMs: 80 }) });
    await vi.advanceTimersByTimeAsync(100);
    expect((await promise).succeeded).toBe(1);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it.each(['TASK_CANCELLED', 'TASK_LEASE_EXPIRED', 'TASK_LEASE_INVALID', 'TASK_RUN_INACTIVE'])(
    'aborts execution and never finishes successfully on %s', async code => {
      const f = fixture({ heartbeat: () => json({ code }, code === 'TASK_LEASE_INVALID' ? 403 : 409) });
      let aborted = false;
      const executeTask = async ({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        await abortableDelay(200, signal);
        return { status: 'succeeded', summary: 'Must not be submitted' };
      };
      const promise = runWorker(config, { ...f, executeTask });
      const rejection = expect(promise).rejects.toMatchObject({ name: 'LeaseLostError', code });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(aborted).toBe(true);
      expect(f.calls.some(call => call.path.endsWith('/finish'))).toBe(false);
    },
  );

  it('does not label unrelated HTTP 409 responses as lease loss', async () => {
    const f = fixture({ heartbeat: () => json({ code: 'UNRELATED_CONFLICT' }, 409) });
    const promise = runWorker(config, { ...f, executeTask: createMockExecutor({ delayMs: 80 }) }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await promise;
    expect(error).not.toBeInstanceOf(LeaseLostError);
    expect(error).toMatchObject({ status: 409, code: 'UNRELATED_CONFLICT' });
    expect(f.calls.some(call => call.path.endsWith('/finish'))).toBe(false);
  });

  it('aborts at the known lease deadline while temporary errors continue', async () => {
    const f = fixture({
      claim: () => json({ task, run: { id: 'run-1', lease_expires_at: Date.now() + 40 }, lease_token: LEASE_TOKEN }),
      heartbeat: () => json({ code: 'TEMPORARY_ERROR' }, 503),
    });
    let aborted = false;
    const executeTask = async ({ signal }: { signal: AbortSignal }) => {
      // Deliberately resolves after cancellation to prove a late success is fenced.
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      aborted = true;
      return { status: 'succeeded', summary: 'Late result must not be sent' };
    };
    const promise = runWorker({ ...config, retryBaseMs: 20, retryMaxMs: 20 }, { ...f, executeTask });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'TASK_LEASE_EXPIRED' });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(aborted).toBe(true);
    expect(f.calls.some(call => call.path.endsWith('/finish'))).toBe(false);
  });

  it('does not retry an uncertain claim or start another claim in resident mode', async () => {
    const f = fixture({ claim: () => { throw new TypeError(`Sensitive transport detail ${TOKEN}`); } });
    const executeTask = vi.fn();
    await expect(runWorker({ ...config, once: false }, { ...f, executeTask })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(f.calls).toHaveLength(1);
    expect(executeTask).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logs)).not.toContain(TOKEN);
  });

  it('does not retry a permanent result rejection', async () => {
    const f = fixture({ finish: () => json({ code: 'AUTH_REQUIRED' }, 401) });
    const promise = runWorker(config, { ...f, executeTask: createMockExecutor({ delayMs: 1 }) });
    const rejection = expect(promise).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(f.calls.filter(call => call.path.endsWith('/finish'))).toHaveLength(1);
  });

  it('reports an adapter failure without logging or submitting credentials', async () => {
    const f = fixture();
    const result = await runWorker(config, { ...f, executeTask: async () => { throw new Error(`Failed ${TOKEN} ${LEASE_TOKEN}`); } });
    expect(result.failed).toBe(1);
    const body = JSON.parse(f.calls.find(call => call.path.endsWith('/finish'))!.body);
    expect(body.error).toBe('Failed [REDACTED] [REDACTED]');
    expect(body.status).toBe('failed');
  });

  it('turns an empty success result into a failed attempt instead of claiming completion', async () => {
    const f = fixture();
    const result = await runWorker(config, { ...f, executeTask: async () => ({ status: 'succeeded' }) });
    expect(result.failed).toBe(1);
    const body = JSON.parse(f.calls.find(call => call.path.endsWith('/finish'))!.body);
    expect(body.status).toBe('failed');
    expect(body.error).toContain('non-empty summary');
  });

  it('cancels the active adapter on shutdown and leaves acceptance to the server', async () => {
    const f = fixture();
    const controller = new AbortController();
    let aborted = false;
    const executeTask = async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await abortableDelay(200, signal);
      return { status: 'succeeded', summary: 'Not sent' };
    };
    const promise = runWorker({ ...config, once: false }, { ...f, executeTask, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5);
    controller.abort();
    const result = await promise;
    expect(result.stopped).toBe(true);
    expect(aborted).toBe(true);
    expect(f.calls.some(call => call.path.endsWith('/finish'))).toBe(false);
  });
});

it('CLI entry refuses an implicit mock before making requests', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  await expect(main(['--once'], { HXA_TASK_TOKEN: TOKEN, HXA_TASK_URL: 'http://127.0.0.1:1' })).rejects.toThrow('Pass --mock');
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
