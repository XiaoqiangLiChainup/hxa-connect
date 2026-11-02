import { TaskError, TASK_STATUSES, type CreateTaskInput, type FinishTaskInput, type TaskStatus } from './types.js';

function invalid(message: string): never { throw new TaskError(400, 'VALIDATION_ERROR', message); }

export function objectBody(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('A JSON object is required');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid('Unexpected request field');
  return body;
}

export function textValue(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    invalid(`${field} must be a ${allowEmpty ? '' : 'non-empty '}string up to ${max} characters`);
  }
  return value;
}

export function createInput(value: unknown): CreateTaskInput {
  const body = objectBody(value, ['title', 'description', 'assigned_bot_id']);
  return {
    title: textValue(body.title, 'title', 200).trim(),
    description: textValue(body.description ?? '', 'description', 20000, true),
    assigned_bot_id: textValue(body.assigned_bot_id, 'assigned_bot_id', 128),
  };
}

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    invalid('Idempotency-Key is required and must contain 1 to 128 visible ASCII characters');
  }
  return value;
}

export function expectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('expected_revision must be a positive safe integer');
  return value;
}

export function listOptions(status: unknown, limit: unknown): { status?: TaskStatus; limit: number } {
  let parsedStatus: TaskStatus | undefined;
  if (status !== undefined) {
    if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) invalid('Invalid task status');
    parsedStatus = status as TaskStatus;
  }
  if (limit !== undefined && (typeof limit !== 'string' || !/^\d+$/.test(limit))) invalid('limit must be an integer from 1 to 100');
  const parsedLimit = limit === undefined ? 50 : Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) invalid('limit must be an integer from 1 to 100');
  return { status: parsedStatus, limit: parsedLimit };
}

export function finishInput(value: unknown): { leaseToken: string; result: FinishTaskInput } {
  const body = objectBody(value, ['lease_token', 'status', 'summary', 'error', 'artifacts']);
  const leaseToken = textValue(body.lease_token, 'lease_token', 256);
  if (body.status !== 'succeeded' && body.status !== 'failed') invalid('status must be succeeded or failed');
  const summary = body.summary == null ? null : textValue(body.summary, 'summary', 10000, true);
  const error = body.error == null ? null : textValue(body.error, 'error', 10000, true);
  if (body.status === 'succeeded' && !summary?.trim()) invalid('A successful run requires a non-empty summary');
  if (body.status === 'failed' && !error?.trim()) invalid('A failed run requires a non-empty error');
  const rawArtifacts = body.artifacts ?? [];
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length > 20) invalid('artifacts must be an array of at most 20 items');
  const artifacts = rawArtifacts.map(value => {
    const artifact = objectBody(value, ['title', 'url']);
    const title = textValue(artifact.title, 'artifact title', 200).trim();
    const urlText = textValue(artifact.url, 'artifact URL', 2048);
    let url: URL;
    try { url = new URL(urlText); } catch { return invalid('artifact URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('artifact URL must use HTTP(S) without credentials');
    if (url.href.length > 2048) invalid('artifact URL is too long');
    return { title, url: url.href };
  });
  return { leaseToken, result: { status: body.status, summary, error, artifacts } };
}
