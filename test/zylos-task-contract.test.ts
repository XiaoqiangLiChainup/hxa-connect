import { describe, expect, it } from 'vitest';
import {
  assessZylosM1Capability, classifyC4DeliveryStatus, classifyC4Receipt,
  ZYLOS_M1_MISSING_CAPABILITIES,
} from '../scripts/zylos-task/contract.mjs';

const safeOutputKeys = ['intake', 'c4_id', 'execution', 'automatic_retry', 'reconciliation_required', 'code'];
const success = (action = 'queued', id: unknown = 73) => JSON.stringify({ ok: true, action, id });
const failure = (code: string, message = 'Untrusted upstream diagnostic') => JSON.stringify({ ok: false, error: { code, message } });
const input = (stdout: unknown, overrides = {}) => ({ exitCode: 0, exitSignal: null, timedOut: false, stdout, ...overrides });

function expectUnverified(result: ReturnType<typeof classifyC4Receipt>) {
  expect(Object.keys(result)).toEqual(safeOutputKeys);
  expect(result.execution).toBe('unverified');
  expect(result.automatic_retry).toBe(false);
  expect(result).not.toHaveProperty('success');
  expect(result).not.toHaveProperty('message');
  expect(Object.isFrozen(result)).toBe(true);
}

describe('offline C4 intake evidence', () => {
  it('treats queued and exit 0 as a receipt, never execution success', () => {
    const result = classifyC4Receipt(input(success()));
    expect(result).toEqual({
      intake: 'queued', c4_id: 73, execution: 'unverified', automatic_retry: false,
      reconciliation_required: true, code: 'C4_RECEIPT_QUEUED',
    });
    expectUnverified(result);
  });

  it.each(['delivered', 'suppressed'])('classifies %s only as handled intake', action => {
    const result = classifyC4Receipt(input(success(action)));
    expect(result).toMatchObject({ intake: 'handled', c4_id: 73, reconciliation_required: true });
    expectUnverified(result);
  });

  it.each(['degraded', 'completed', 'succeeded', 'running', '', 'queued\nsecret'])('rejects the unreviewed action %j', action => {
    const result = classifyC4Receipt(input(success(action)));
    expect(result).toMatchObject({ intake: 'unknown', c4_id: 73, code: 'C4_RECEIPT_UNKNOWN_ACTION' });
    expectUnverified(result);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('allows surrounding JSON whitespace without scraping a log or the last JSON line', () => {
    expect(classifyC4Receipt(input(` \n${success()}\n\t `)).intake).toBe('queued');
    for (const stdout of [`[C4-DB] Database initialized\n${success()}`, `${success()}\n${success()}`, `${success()}\nDONE`]) {
      expect(classifyC4Receipt(input(stdout))).toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_INVALID_JSON' });
    }
  });

  it('rejects duplicate keys, including equivalent escaped keys', () => {
    for (const stdout of [
      '{"ok":false,"ok":true,"action":"queued","id":73}',
      '{"ok":true,"action":"delivered","action":"queued","id":73}',
      '{"ok":true,"action":"queued","id":12,"\\u0069d":73}',
      '{"ok":false,"error":{"code":"INTERNAL_ERROR","code":"INVALID_ARGS","message":"x"}}',
    ]) {
      expect(classifyC4Receipt(input(stdout, { exitCode: 1 })))
        .toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_AMBIGUOUS_JSON' });
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '73', null, true, {}, []])('rejects an invalid conversation ID %j', id => {
    const result = classifyC4Receipt(input(success('queued', id)));
    expect(result).toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_INVALID_SCHEMA' });
    expectUnverified(result);
  });

  it('accepts only positive safe integer IDs', () => {
    for (const id of [1, Number.MAX_SAFE_INTEGER]) {
      expect(classifyC4Receipt(input(success('queued', id)))).toMatchObject({ intake: 'queued', c4_id: id });
    }
  });

  it.each([
    null, [], true, 'queued', { ok: 'true', action: 'queued', id: 73 },
    { ok: true, action: 'queued' }, { ok: true, action: 'queued', id: 73, token: 'secret' },
    { ok: false, error: { code: 'INVALID_ARGS' } },
    { ok: false, error: { code: 'INVALID_ARGS', message: 'x', extra: true } },
    { ok: false, error: { code: 'INVALID_ARGS', message: 'x' }, id: 73 },
  ])('rejects a mismatched protocol schema %j', body => {
    const result = classifyC4Receipt(input(JSON.stringify(body), { exitCode: 1 }));
    expect(result).toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_INVALID_SCHEMA' });
    expectUnverified(result);
  });

  it('enforces the 16 KiB limit on UTF-8 bytes, including whitespace', () => {
    const base = success();
    const atLimit = base + ' '.repeat(16 * 1024 - Buffer.byteLength(base));
    expect(classifyC4Receipt(input(atLimit)).intake).toBe('queued');
    expect(classifyC4Receipt(input(atLimit + ' ')).code).toBe('C4_RECEIPT_OUTPUT_LIMIT');
    const multibyte = failure('INVALID_ARGS', '界'.repeat(6000));
    expect(multibyte.length).toBeLessThan(16 * 1024);
    expect(classifyC4Receipt(input(multibyte, { exitCode: 1 })).code).toBe('C4_RECEIPT_OUTPUT_LIMIT');
  });

  it.each([undefined, null, Buffer.from(success()), {}, 7])('does not coerce non-text stdout', stdout => {
    expect(classifyC4Receipt(input(stdout))).toMatchObject({ intake: 'unknown', code: 'C4_RECEIPT_INVALID_OUTPUT' });
  });

  it('recognizes only the normal pre-intake INVALID_ARGS rejection as known rejected', () => {
    const result = classifyC4Receipt(input(failure('INVALID_ARGS'), { exitCode: 1 }));
    expect(result).toMatchObject({ intake: 'rejected', c4_id: null, reconciliation_required: false, code: 'C4_RECEIPT_INVALID_ARGS' });
    expectUnverified(result);
    for (const exitCode of [0, 2, null]) {
      expect(classifyC4Receipt(input(failure('INVALID_ARGS'), { exitCode })).intake).toBe('unknown');
    }
  });

  it.each(['INTERNAL_ERROR', 'UNHEALTHY_NOTIFY_FAILED', 'UNREVIEWED_ERROR', 'secret=do-not-publish'])(
    'does not infer no submission from %s', code => {
      const result = classifyC4Receipt(input(failure(code, 'Bearer private-token; /private/path; task output'), { exitCode: 1 }));
      expect(result).toMatchObject({ intake: 'unknown', c4_id: null, reconciliation_required: true });
      expectUnverified(result);
      for (const sensitive of ['private-token', '/private/path', 'task output', 'secret=', 'UNREVIEWED_ERROR']) {
        expect(JSON.stringify(result)).not.toContain(sensitive);
      }
    },
  );

  it('does not confuse escaped diagnostic text with duplicate JSON keys or copy it out', () => {
    const stdout = failure('INVALID_ARGS', 'Embedded {"code":"secret","code":"other"} and \\"quoted\\"');
    expect(classifyC4Receipt(input(stdout, { exitCode: 1 })).intake).toBe('rejected');
  });

  it.each([
    [{ timedOut: true }, 'C4_RECEIPT_PROCESS_TIMEOUT'],
    [{ exitSignal: 'SIGTERM', exitCode: null }, 'C4_RECEIPT_PROCESS_INTERRUPTED'],
    [{ exitSignal: 'sensitive-signal-value' }, 'C4_RECEIPT_PROCESS_INTERRUPTED'],
    [{ exitCode: 1 }, 'C4_RECEIPT_PROCESS_FAILED'],
    [{ exitCode: null }, 'C4_RECEIPT_EXIT_UNCONFIRMED'],
    [{ exitCode: '0' }, 'C4_RECEIPT_EXIT_UNCONFIRMED'],
    [{ exitCode: -1 }, 'C4_RECEIPT_EXIT_UNCONFIRMED'],
    [{ timedOut: 'false' }, 'C4_RECEIPT_INVALID_INPUT'],
  ])('preserves a known receipt ID after an uncertain process outcome: %j', (overrides, code) => {
    const result = classifyC4Receipt(input(success(), overrides));
    expect(result).toMatchObject({ intake: 'unknown', c4_id: 73, reconciliation_required: true, code });
    expectUnverified(result);
    expect(JSON.stringify(result)).not.toContain('sensitive-signal-value');
  });

  it('gives timeout and signal precedence over a rejection payload', () => {
    expect(classifyC4Receipt(input(failure('INVALID_ARGS'), { exitCode: 1, timedOut: true })).intake).toBe('unknown');
    expect(classifyC4Receipt(input(failure('INVALID_ARGS'), { exitCode: 1, exitSignal: 'SIGKILL' })).intake).toBe('unknown');
  });

  it('does not treat an empty successful process exit as a receipt', () => {
    expect(classifyC4Receipt(input(''))).toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_INVALID_JSON' });
    expect(classifyC4Receipt(null)).toMatchObject({ intake: 'unknown', c4_id: null, code: 'C4_RECEIPT_INVALID_INPUT' });
  });
});

describe('C4 delivery evidence never terminates a task', () => {
  it.each(['pending', 'running', 'delivered', 'failed'])('keeps %s as transport evidence only', status => {
    expect(classifyC4DeliveryStatus(status)).toEqual({
      transport: status, execution: 'unverified', task_terminal: false, automatic_retry: false,
      reconciliation_required: true, code: `C4_TRANSPORT_${status.toUpperCase()}`,
    });
  });

  it.each(['succeeded', 'completed', 'done', 'cancelled', '__proto__', 'secret-status', null, {}, 0])(
    'does not promote an unknown status %j', status => {
      const result = classifyC4DeliveryStatus(status);
      expect(result).toMatchObject({ transport: 'unknown', execution: 'unverified', task_terminal: false, code: 'C4_TRANSPORT_UNKNOWN' });
      expect(JSON.stringify(result)).not.toContain('secret-status');
    },
  );
});

describe('Zylos M1 execution eligibility', () => {
  it.each([undefined, 'unknown', 'v0.5.2', 'matched', true, { ready: true, claim_allowed: true, missing_capabilities: [] }])(
    'does not activate an executor from source evidence or claimed capability %j', sourceReview => {
      const result = assessZylosM1Capability(sourceReview);
      expect(result).toEqual({
        ready: false, claim_allowed: false, code: 'ZYLOS_M1_TASK_INTERFACE_UNSUPPORTED',
        source_review: 'unknown',
        missing_capabilities: [
          'task_isolation', 'correlated_result', 'precise_cancellation',
          'artifact_ownership', 'idempotent_submission', 'lease_fencing',
        ],
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.missing_capabilities).toBe(ZYLOS_M1_MISSING_CAPABILITIES);
    },
  );

  it.each(['matches_reviewed_upstream', 'different_source_requires_review', 'incomplete_source_evidence'])(
    'retains the static source classification %s without enabling claims', sourceReview => {
      expect(assessZylosM1Capability(sourceReview)).toMatchObject({
        source_review: sourceReview, ready: false, claim_allowed: false,
        code: 'ZYLOS_M1_TASK_INTERFACE_UNSUPPORTED',
      });
    },
  );

  it('does not allow mutation of the shared missing-capability evidence', () => {
    expect(Object.isFrozen(ZYLOS_M1_MISSING_CAPABILITIES)).toBe(true);
    expect(() => ZYLOS_M1_MISSING_CAPABILITIES.push('override')).toThrow();
    expect(assessZylosM1Capability('secret-source-detail').source_review).toBe('unknown');
    expect(JSON.stringify(assessZylosM1Capability('secret-source-detail'))).not.toContain('secret-source-detail');
  });
});
