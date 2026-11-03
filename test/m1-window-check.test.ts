import { describe, expect, it, vi, afterEach } from 'vitest';
import { evaluateExecutionWindow, main } from '../scripts/m1-window-check.mjs';

const expiresAt = '2026-11-04T06:38:16Z';
const expiry = Date.parse(expiresAt);
const taskTimeoutMs = 1_800_000;
afterEach(() => vi.restoreAllMocks());

describe('reported M1 credential window, without credentials or requests', () => {
  it('requires more than the full task budget plus reserve, without claiming authentication or task selection', () => {
    expect(evaluateExecutionWindow({ expiresAt, taskTimeoutMs, now: expiry - 2_100_001 })).toMatchObject({
      window_adequate: true, code: null, required_ms: 2_100_000, token_auth_verified: false,
      task_selected: false, renewal_performed: false,
    });
    expect(evaluateExecutionWindow({ expiresAt, taskTimeoutMs, now: expiry - 2_100_000 })).toMatchObject({
      window_adequate: false, code: 'TOKEN_WINDOW_TOO_SHORT',
    });
  });

  it.each([0, 1, 600_000])('stops at or after expiry (%i ms late)', late => {
    expect(evaluateExecutionWindow({ expiresAt, taskTimeoutMs, now: expiry + late })).toMatchObject({
      window_adequate: false, code: 'TOKEN_EXPIRED',
    });
  });

  it.each(['2026-02-30T06:38:16Z', '2026-11-04T06:38:16+00:00', '2026-11-04', 'secret-value'])('rejects invalid or ambiguous expiry %s', value => {
    expect(() => evaluateExecutionWindow({ expiresAt: value, taskTimeoutMs })).toThrow();
  });

  it('rejects missing/unbounded budgets and attempts to remove the stop reserve', () => {
    for (const budget of [undefined, 0, -1, 1.5, 43_200_001, Infinity]) {
      expect(() => evaluateExecutionWindow({ expiresAt, taskTimeoutMs: budget })).toThrow();
    }
    expect(() => evaluateExecutionWindow({ expiresAt, taskTimeoutMs, reserveMs: 299_999 })).toThrow();
  });

  it('uses the current clock and only emits the projected report; no fetch or environment credential inspection', () => {
    vi.spyOn(Date, 'now').mockReturnValue(expiry - 3_600_000);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No request allowed'));
    expect(main(['--expires-at', expiresAt, '--task-timeout-ms', String(taskTimeoutMs)])).toBe(0);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ window_adequate: true, token_auth_verified: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => main(['--expires-at', expiresAt, '--task-timeout-ms', String(taskTimeoutMs), '--now', '0'])).toThrow();
    expect(() => main(['--expires-at', expiresAt, '--expires-at', expiresAt])).toThrow();
    expect(() => main(['--token', 'protected-credential'])).toThrow();
  });
});
