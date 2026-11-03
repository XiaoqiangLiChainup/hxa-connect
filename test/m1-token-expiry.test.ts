import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortableDelay, runWorker } from '../scripts/task-runner/worker.mjs';

// Offline HTTP/adapter fixtures only; these are not live Hub or model credentials.
const TOKEN = 'offline-bot-token-do-not-log';
const LEASE_TOKEN = 'offline-lease-token-do-not-log';
const config = {
  url: 'https://hub.invalid', token: TOKEN, runnerId: 'expiry-fixture', once: false,
  heartbeatMs: 10, pollMs: 10, requestTimeoutMs: 50,
  maxRetries: 3, retryBaseMs: 5, retryMaxMs: 10,
};
const task = { id: 'task-expiry', title: 'Offline fixture', status: 'running' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const denied = () => json({ code: 'AUTH_REQUIRED', message: `Sensitive response ${TOKEN} ${LEASE_TOKEN}` }, 401);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Ambient network access is forbidden in this fixture.'); }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('M1 token expiry stops the existing worker without model execution', () => {
  it('never executes, retries, or claims again after claim HTTP 401 in resident mode', async () => {
    const paths: string[] = [];
    const logs: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      paths.push(new URL(url).pathname);
      return denied();
    });
    const executeTask = vi.fn();
    const onRunSettled = vi.fn();
    const error = await runWorker(config, { fetchImpl, executeTask, onRunSettled, logger: (entry: unknown) => logs.push(entry) })
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ status: 401, code: 'AUTH_REQUIRED', retryable: false });
    expect(paths).toEqual(['/api/tasks/claim']);
    expect(executeTask).not.toHaveBeenCalled();
    expect(onRunSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(paths).toEqual(['/api/tasks/claim']);
    expect(vi.getTimerCount()).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const secret of [TOKEN, LEASE_TOKEN, 'Sensitive response']) {
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([false, true])(
    'aborts on heartbeat HTTP 401, awaits cleanup, and never publishes a late success (settlement failure: %s)',
    async settlementFails => {
      const paths: string[] = [];
      const logs: unknown[] = [];
      const observations: unknown[] = [];
      let aborted = false;
      let cleaned = false;
      let workerSettled = false;
      let markCleaned!: () => void;
      const cleanup = new Promise<void>(resolve => { markCleaned = resolve; });
      const fetchImpl = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        paths.push(path);
        if (path.endsWith('/claim')) {
          return json({ task, run: { id: 'run-expiry', lease_expires_at: Date.now() + 60_000 }, lease_token: LEASE_TOKEN });
        }
        if (path.endsWith('/heartbeat')) return denied();
        throw new Error('The stopped run must not submit any result.');
      });
      const executeTask = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        try {
          await abortableDelay(10_000, signal);
        } catch {
          aborted = signal.aborted;
          // Simulate a cooperative adapter whose teardown outlives cancellation.
          await abortableDelay(25);
          cleaned = true;
          markCleaned();
        }
        return { status: 'succeeded', summary: 'Late fixture output must never be submitted.' };
      });
      const onRunSettled = vi.fn(async (outcome: unknown) => {
        observations.push(outcome);
        await cleanup;
        if (settlementFails) throw new Error(`Sensitive cleanup failure ${TOKEN} ${LEASE_TOKEN}`);
      });
      const completion = runWorker(config, {
        fetchImpl, executeTask, onRunSettled, logger: (entry: unknown) => logs.push(entry),
      }).then(
        (result: unknown) => { workerSettled = true; return result; },
        (error: unknown) => { workerSettled = true; return error; },
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(aborted).toBe(true);
      expect(cleaned).toBe(false);
      expect(workerSettled).toBe(false);
      expect(onRunSettled).toHaveBeenCalledTimes(1);
      expect(observations[0]).toMatchObject({ confirmed: false, code: 'AUTH_REQUIRED' });

      await vi.advanceTimersByTimeAsync(25);
      const error = await completion;
      expect(cleaned).toBe(true);
      expect(workerSettled).toBe(true);
      expect(error).toMatchObject(settlementFails
        ? { code: 'RUN_SETTLEMENT_FAILED', retryable: false }
        : { status: 401, code: 'AUTH_REQUIRED', retryable: false });
      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(paths).toEqual(['/api/tasks/claim', '/api/tasks/task-expiry/runs/run-expiry/heartbeat']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(paths).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      for (const secret of [TOKEN, LEASE_TOKEN, 'Sensitive response', 'Sensitive cleanup failure']) {
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(JSON.stringify(observations)).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
      }
    },
  );
});
