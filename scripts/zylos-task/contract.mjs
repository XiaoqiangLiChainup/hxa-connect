import { Buffer } from 'node:buffer';

// Evidence interpretation only. This module never invokes C4 or an executor.
// Reviewed protocol: zylos-core 0.5.2, commit 8ee9bd9007edab46f766f3574e0ad56cf69268c2.
const MAX_RECEIPT_BYTES = 16 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, names) {
  return record(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}

// JSON.parse otherwise silently accepts repeated keys. Scan only after parsing
// valid JSON; strings are whole tokens, including escaped quotes and key names.
function hasUniqueKeys(text) {
  const stack = [];
  for (const token of text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g) || []) {
    if (token === '{' || token === '[') {
      stack.push({ object: token === '{', key: true, names: new Set() });
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else if (token === ',') {
      if (stack.at(-1)?.object) stack.at(-1).key = true;
    } else if (token.startsWith('"') && stack.at(-1)?.object && stack.at(-1).key) {
      const frame = stack.at(-1);
      const name = JSON.parse(token);
      if (frame.names.has(name)) return false;
      frame.names.add(name);
      frame.key = false;
    }
  }
  return true;
}

function decodeReceipt(stdout) {
  if (typeof stdout !== 'string') return { code: 'C4_RECEIPT_INVALID_OUTPUT' };
  if (Buffer.byteLength(stdout, 'utf8') > MAX_RECEIPT_BYTES) return { code: 'C4_RECEIPT_OUTPUT_LIMIT' };
  let body;
  try {
    body = JSON.parse(stdout);
    if (!hasUniqueKeys(stdout)) return { code: 'C4_RECEIPT_AMBIGUOUS_JSON' };
  } catch {
    return { code: 'C4_RECEIPT_INVALID_JSON' };
  }
  if (exactKeys(body, ['ok', 'action', 'id']) && body.ok === true
    && typeof body.action === 'string' && Number.isSafeInteger(body.id) && body.id > 0) {
    return { kind: 'receipt', id: body.id, action: body.action };
  }
  if (exactKeys(body, ['ok', 'error']) && body.ok === false
    && exactKeys(body.error, ['code', 'message'])
    && typeof body.error.code === 'string' && typeof body.error.message === 'string') {
    // Never return the message or an arbitrary upstream error code.
    return { kind: 'error', errorCode: body.error.code };
  }
  return { code: 'C4_RECEIPT_INVALID_SCHEMA' };
}

function receipt(intake, code, c4Id = null, reconciliationRequired = true) {
  return Object.freeze({
    intake,
    c4_id: c4Id,
    execution: 'unverified',
    automatic_retry: false,
    reconciliation_required: reconciliationRequired,
    code,
  });
}

/**
 * Classify an already-collected C4 intake response, never task completion.
 * Even a known queued receipt requires separate execution reconciliation.
 * A valid ID is retained after an uncertain process outcome for that purpose.
 */
export function classifyC4Receipt(input = {}) {
  if (!record(input)) return receipt('unknown', 'C4_RECEIPT_INVALID_INPUT');
  const { exitCode, exitSignal, stdout, timedOut } = input;
  const decoded = decodeReceipt(stdout);
  const c4Id = decoded.kind === 'receipt' ? decoded.id : null;

  if (timedOut === true) return receipt('unknown', 'C4_RECEIPT_PROCESS_TIMEOUT', c4Id);
  if (timedOut !== undefined && timedOut !== false) return receipt('unknown', 'C4_RECEIPT_INVALID_INPUT', c4Id);
  if (exitSignal !== undefined && exitSignal !== null) return receipt('unknown', 'C4_RECEIPT_PROCESS_INTERRUPTED', c4Id);
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    return receipt('unknown', 'C4_RECEIPT_EXIT_UNCONFIRMED', c4Id);
  }
  if (decoded.code) return receipt('unknown', decoded.code);

  // Only the reviewed pre-intake argument rejection has a known no-submission
  // boundary. An internal/notification error may occur after the DB insert.
  if (decoded.kind === 'error') {
    if (exitCode === 1 && decoded.errorCode === 'INVALID_ARGS') {
      return receipt('rejected', 'C4_RECEIPT_INVALID_ARGS', null, false);
    }
    if (decoded.errorCode === 'INTERNAL_ERROR') return receipt('unknown', 'C4_RECEIPT_INTERNAL_ERROR');
    if (decoded.errorCode === 'UNHEALTHY_NOTIFY_FAILED') return receipt('unknown', 'C4_RECEIPT_NOTIFY_FAILED');
    return receipt('unknown', 'C4_RECEIPT_ERROR');
  }
  if (exitCode !== 0) return receipt('unknown', 'C4_RECEIPT_PROCESS_FAILED', c4Id);
  if (decoded.action === 'queued') return receipt('queued', 'C4_RECEIPT_QUEUED', c4Id);
  if (decoded.action === 'delivered') return receipt('handled', 'C4_RECEIPT_HANDLED', c4Id);
  if (decoded.action === 'suppressed') return receipt('handled', 'C4_RECEIPT_SUPPRESSED', c4Id);
  return receipt('unknown', 'C4_RECEIPT_UNKNOWN_ACTION', c4Id);
}

const DELIVERY_CODES = Object.freeze({
  pending: 'C4_TRANSPORT_PENDING',
  running: 'C4_TRANSPORT_RUNNING',
  delivered: 'C4_TRANSPORT_DELIVERED',
  failed: 'C4_TRANSPORT_FAILED',
});

/** C4 DB status is transport evidence, including its "running" and "failed" states. */
export function classifyC4DeliveryStatus(status) {
  const known = typeof status === 'string' && Object.hasOwn(DELIVERY_CODES, status);
  return Object.freeze({
    transport: known ? status : 'unknown',
    execution: 'unverified',
    task_terminal: false,
    automatic_retry: false,
    reconciliation_required: true,
    code: known ? DELIVERY_CODES[status] : 'C4_TRANSPORT_UNKNOWN',
  });
}

export const ZYLOS_M1_MISSING_CAPABILITIES = Object.freeze([
  'task_isolation',
  'correlated_result',
  'precise_cancellation',
  'artifact_ownership',
  'idempotent_submission',
  'lease_fencing',
]);

const SOURCE_REVIEWS = new Set([
  'matches_reviewed_upstream',
  'different_source_requires_review',
  'incomplete_source_evidence',
]);

/**
 * Compatibility evidence cannot enable a missing execution interface. Only a
 * static source-review classification is retained, never arbitrary diagnostics.
 * There is intentionally no override, capability flag, or true return path.
 */
export function assessZylosM1Capability(sourceReview = 'unknown') {
  return Object.freeze({
    ready: false,
    claim_allowed: false,
    code: 'ZYLOS_M1_TASK_INTERFACE_UNSUPPORTED',
    source_review: SOURCE_REVIEWS.has(sourceReview) ? sourceReview : 'unknown',
    missing_capabilities: ZYLOS_M1_MISSING_CAPABILITIES,
  });
}
