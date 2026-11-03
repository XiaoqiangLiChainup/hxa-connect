import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 1024;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = Object.freeze({
  '.html': 'text/plain', '.htm': 'text/plain', '.md': 'text/plain', '.txt': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
});

const MESSAGES = Object.freeze({
  ARTIFACT_ABORTED: 'Artifact processing was cancelled.',
  ARTIFACT_PLATFORM_UNSUPPORTED: 'Artifact verification requires Linux with accessible procfs.',
  ARTIFACT_INVALID_CONFIG: 'Artifact configuration is invalid.',
  ARTIFACT_INVALID_RESULT: 'The result does not satisfy the artifact result contract.',
  ARTIFACT_FAILED_RESULT: 'An unsuccessful result cannot publish artifacts.',
  ARTIFACT_INVALID_PATH: 'An artifact path or download name is invalid.',
  ARTIFACT_DUPLICATE: 'Artifact paths and download names must be unambiguous.',
  ARTIFACT_LIMIT: 'An artifact count or byte limit was exceeded.',
  ARTIFACT_UNSAFE_FILE: 'An artifact path is not an ordinary, unlinked workspace file.',
  ARTIFACT_FILE_CHANGED: 'An artifact or its directory changed during verification.',
  ARTIFACT_IO_FAILED: 'An artifact could not be read safely.',
  ARTIFACT_UNSUPPORTED_TYPE: 'An artifact file type or content is unsupported.',
  ARTIFACT_DEMO_INVALID: 'The feedback demo does not satisfy the structural acceptance checks.',
  ARTIFACT_INVALID_SNAPSHOT: 'An artifact snapshot is invalid.',
  ARTIFACT_JOURNAL_FAILED: 'The artifact journal could not be updated.',
  ARTIFACT_UPLOAD_UNKNOWN: 'An upload has an uncertain outcome; it must not be retried automatically.',
  ARTIFACT_UPLOAD_REJECTED: 'The Hub rejected an artifact upload.',
  ARTIFACT_UPLOAD_RESPONSE: 'The Hub returned invalid artifact metadata.',
  ARTIFACT_DOWNLOAD_FAILED: 'An uploaded artifact failed authenticated download verification.',
});

/** Errors deliberately contain no original filesystem, HTTP, or credential-bearing error text. */
export class ArtifactError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? 'Artifact processing failed.');
    this.name = 'ArtifactError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'ARTIFACT_IO_FAILED';
    this.uploads = [];
    this.unknownUploads = [];
  }
}

function fail(code) { throw new ArtifactError(code); }
function checkAbort(signal) { if (signal?.aborted) fail('ARTIFACT_ABORTED'); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validText(value, max, allowEmpty = false) {
  return typeof value === 'string' && value.length <= max && (allowEmpty || Boolean(value.trim()))
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function setting(config, key, fallback, maximum) {
  const value = config[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('ARTIFACT_INVALID_CONFIG');
  return value;
}
function limits(config = {}) {
  return {
    maxFileBytes: setting(config, 'maxFileBytes', DEFAULT_FILE_BYTES, 64 * 1024 * 1024),
    maxArtifactBytes: setting(config, 'maxArtifactBytes', DEFAULT_TOTAL_BYTES, 256 * 1024 * 1024),
    maxArtifacts: setting(config, 'maxArtifacts', 19, 19),
  };
}

function artifactPath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
    || path.posix.isAbsolute(value) || /[\\\u0000-\u001f\u007f-\u009f<>:"|?*]/u.test(value)) {
    fail('ARTIFACT_INVALID_PATH');
  }
  const segments = value.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || Buffer.byteLength(part, 'utf8') > 255 || Buffer.from(part).toString('utf8') !== part)) {
    fail('ARTIFACT_INVALID_PATH');
  }
  return value;
}

function descriptions(entries, maximum) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > maximum) fail('ARTIFACT_LIMIT');
  const paths = new Set();
  const names = new Set();
  return entries.map(entry => {
    if (!exactKeys(entry, ['path', 'title']) || !validText(entry.title, 200)) fail('ARTIFACT_INVALID_RESULT');
    const relative = artifactPath(entry.path);
    const name = path.posix.basename(relative);
    // The same downloads must remain distinguishable on case-insensitive client filesystems.
    const pathKey = relative.normalize('NFC').toLowerCase();
    const nameKey = name.normalize('NFC').toLowerCase();
    if (paths.has(pathKey) || names.has(nameKey)) fail('ARTIFACT_DUPLICATE');
    paths.add(pathKey);
    names.add(nameKey);
    const mime = MIME[path.posix.extname(name).toLowerCase()];
    if (!mime) fail('ARTIFACT_UNSUPPORTED_TYPE');
    return { path: relative, name, title: entry.title.trim(), mime };
  });
}

function validateResult(result, maximum) {
  if (!exactKeys(result, ['status', 'summary', 'artifacts', 'checks'])
    || !['succeeded', 'failed'].includes(result.status) || !validText(result.summary, 10_000)
    || !Array.isArray(result.checks) || result.checks.length === 0 || result.checks.length > 100
    || result.checks.some(check => !exactKeys(check, ['name', 'passed', 'details'])
      || !validText(check.name, 200) || typeof check.passed !== 'boolean' || !validText(check.details, 10_000, true))) {
    fail('ARTIFACT_INVALID_RESULT');
  }
  if (result.status !== 'succeeded' || result.checks.some(check => !check.passed)) fail('ARTIFACT_FAILED_RESULT');
  return descriptions(result.artifacts, maximum);
}

function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function closeHandles(entries) {
  for (const entry of [...entries].reverse()) await entry.handle.close().catch(() => {});
}

/**
 * Each next component is opened relative to an already-open directory descriptor.
 * O_NOFOLLOW is applied to that single component, including every workspace ancestor.
 * A plain lstat/realpath followed by open(fullPath) would leave a parent-directory race.
 */
async function openWorkspace(workspaceDir, signal) {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    fail('ARTIFACT_PLATFORM_UNSUPPORTED');
  }
  if (typeof workspaceDir !== 'string' || !path.isAbsolute(workspaceDir)
    || workspaceDir.split('/').some(part => part === '.' || part === '..') || workspaceDir.includes('\0')) {
    fail('ARTIFACT_INVALID_CONFIG');
  }
  const workspace = path.resolve(workspaceDir);
  const entries = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const root = await open('/', flags);
    const rootEntry = { handle: root, absolute: '/', stat: null };
    entries.push(rootEntry);
    rootEntry.stat = await root.stat({ bigint: true });
    let absolute = '';
    for (const part of workspace.split('/').filter(Boolean)) {
      checkAbort(signal);
      absolute += `/${part}`;
      const parent = entries.at(-1).handle;
      const handle = await open(`/proc/self/fd/${parent.fd}/${part}`, flags);
      const entry = { handle, absolute, stat: null };
      entries.push(entry);
      entry.stat = await handle.stat({ bigint: true });
      if (!entry.stat.isDirectory()) fail('ARTIFACT_UNSAFE_FILE');
    }
    const anchor = `/proc/self/fd/${entries.at(-1).handle.fd}`;
    if (await realpath(anchor) !== workspace || await realpath(workspace) !== workspace) fail('ARTIFACT_FILE_CHANGED');
    return { workspace, entries, handle: entries.at(-1).handle };
  } catch (error) {
    await closeHandles(entries);
    if (error instanceof ArtifactError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes(error?.code)) fail('ARTIFACT_UNSAFE_FILE');
    fail('ARTIFACT_IO_FAILED');
  }
}

async function verifyDirectories(entries) {
  for (const entry of entries) {
    const current = await lstat(entry.absolute, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, entry.stat)) {
      fail('ARTIFACT_FILE_CHANGED');
    }
  }
}

async function snapshotFile(root, description, maximum, signal) {
  const entries = [];
  let file;
  try {
    const segments = description.path.split('/');
    let parent = root.handle;
    let absolute = root.workspace;
    for (const part of segments.slice(0, -1)) {
      checkAbort(signal);
      absolute = path.join(absolute, part);
      const handle = await open(`/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const entry = { handle, absolute, stat: null };
      entries.push(entry);
      entry.stat = await handle.stat({ bigint: true });
      if (!entry.stat.isDirectory()) fail('ARTIFACT_UNSAFE_FILE');
      parent = handle;
    }
    const anchored = `/proc/self/fd/${parent.fd}/${segments.at(-1)}`;
    const beforePath = await lstat(anchored, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) fail('ARTIFACT_UNSAFE_FILE');
    if (beforePath.size > BigInt(maximum)) fail('ARTIFACT_LIMIT');
    file = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameFile(before, beforePath)) fail('ARTIFACT_FILE_CHANGED');
    const expectedPath = path.join(root.workspace, ...segments);
    const resolved = await realpath(`/proc/self/fd/${file.fd}`);
    if (resolved !== expectedPath || !resolved.startsWith(`${root.workspace}${path.sep}`)) fail('ARTIFACT_FILE_CHANGED');
    await verifyDirectories([...root.entries, ...entries]);

    const size = Number(before.size);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      checkAbort(signal);
      const { bytesRead } = await file.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const afterPath = await lstat(anchored, { bigint: true });
    if (offset !== size || !sameFile(before, after) || !sameFile(before, afterPath)
      || !afterPath.isFile() || afterPath.isSymbolicLink()
      || await realpath(`/proc/self/fd/${file.fd}`) !== expectedPath) fail('ARTIFACT_FILE_CHANGED');
    await verifyDirectories([...root.entries, ...entries]);
    checkAbort(signal);
    return Buffer.from(buffer.subarray(0, size));
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes(error?.code)) fail('ARTIFACT_UNSAFE_FILE');
    fail('ARTIFACT_IO_FAILED');
  } finally {
    if (file) await file.close().catch(() => {});
    await closeHandles(entries);
  }
}

function textContent(bytes) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0') || /^\s*(<\?xml|<svg\b|<!doctype\s+svg\b)/i.test(content)) fail('ARTIFACT_UNSUPPORTED_TYPE');
    return content;
  } catch { fail('ARTIFACT_UNSUPPORTED_TYPE'); }
}

function validateContent(artifact) {
  const { bytes, mime } = artifact;
  if (mime.startsWith('text/') || mime === 'application/json') {
    const content = textContent(bytes);
    if (mime === 'application/json') {
      try { JSON.parse(content); } catch { fail('ARTIFACT_UNSUPPORTED_TYPE'); }
    }
    return content;
  }
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'application/pdf' && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  // These are format signatures, not complete image/document decoders or malware checks.
  if (!valid) fail('ARTIFACT_UNSUPPORTED_TYPE');
  return null;
}

function demoChecks(artifacts) {
  const html = textContent(artifacts.find(item => item.path === 'index.html').bytes).replace(/<!--[\s\S]*?-->/g, '');
  const readme = textContent(artifacts.find(item => item.path === 'README.md').bytes);
  if (!/^\s*<!doctype\s+html\b[^>]*>/i.test(html) || !/<html\b/i.test(html) || !/<\/html\s*>/i.test(html)
    || !/<body\b/i.test(html) || !/<\/body\s*>/i.test(html)) fail('ARTIFACT_DEMO_INVALID');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (!scripts.some(item => item[2].trim() && /\blocalStorage\b/.test(item[2]))
    || scripts.some(item => /\bsrc\s*=/i.test(item[1]))) fail('ARTIFACT_DEMO_INVALID');
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const selectors = new Set([...markup.matchAll(/<[a-z][^>]*\bdata-testid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi)]
    .map(item => item[1] ?? item[2] ?? item[3]));
  if (['ticket-form', 'ticket-list', 'status-filter', 'ticket-detail', 'status-update'].some(name => !selectors.has(name))) {
    fail('ARTIFACT_DEMO_INVALID');
  }
  // A structural gate for the self-contained demo, not a JavaScript sandbox or a browser test.
  if (/<(?:iframe|frame|object|embed|base)\b/i.test(markup) || /<link\b[^>]*\bhref\s*=/i.test(markup)
    || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(markup)
    || /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(scripts.map(item => item[2]).join('\n'))
    || /\bimport\s*(?:\(|[{'"*])/.test(scripts.map(item => item[2]).join('\n'))
    || /@import\b/i.test(html)) fail('ARTIFACT_DEMO_INVALID');
  for (const item of markup.matchAll(/<(?:img|source|video|audio|input)\b[^>]*\b(?:src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    if (!/^data:/i.test(item[1] ?? item[2] ?? item[3])) fail('ARTIFACT_DEMO_INVALID');
  }
  for (const item of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!/^(data:|#)/i.test(item[2].trim())) fail('ARTIFACT_DEMO_INVALID');
  }
  if (!readme.trim() || !/index\.html/i.test(readme)
    || !/\b(open|run|launch|usage|instructions?|serve|start)\b|打开|运行|启动|使用|操作|预览/i.test(readme)) {
    fail('ARTIFACT_DEMO_INVALID');
  }
}

/** Validate every declaration and create immutable-by-convention, bounded byte snapshots before any upload. */
export async function prepareArtifacts({ workspaceDir, result, config = {}, signal }) {
  checkAbort(signal);
  if (!record(config)) fail('ARTIFACT_INVALID_CONFIG');
  const bounds = limits(config);
  const declared = validateResult(result, bounds.maxArtifacts);
  const profile = config.profile ?? 'files';
  if (!['files', 'feedback-demo'].includes(profile)) fail('ARTIFACT_INVALID_CONFIG');
  const required = config.requiredArtifacts ?? [];
  if (!Array.isArray(required)) fail('ARTIFACT_INVALID_CONFIG');
  const requiredPaths = new Set([...required, ...(profile === 'feedback-demo' ? ['index.html', 'README.md'] : [])].map(artifactPath));
  if ([...requiredPaths].some(relative => !declared.some(item => item.path === relative))) fail('ARTIFACT_DEMO_INVALID');
  const root = await openWorkspace(workspaceDir, signal);
  try {
    const prepared = [];
    let total = 0;
    for (const declaration of declared) {
      const bytes = await snapshotFile(root, declaration, bounds.maxFileBytes, signal);
      total += bytes.length;
      if (total > bounds.maxArtifactBytes) fail('ARTIFACT_LIMIT');
      const artifact = { ...declaration, bytes, sha256: hash(bytes), size: bytes.length };
      validateContent(artifact);
      prepared.push(artifact);
    }
    if (profile === 'feedback-demo') demoChecks(prepared);
    checkAbort(signal);
    return prepared;
  } finally { await closeHandles(root.entries); }
}

function baseUrl(value, publicUrl = false) {
  let url;
  try { url = new URL(value); } catch { fail('ARTIFACT_INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || (publicUrl && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash || url.href.length > 1900) fail('ARTIFACT_INVALID_CONFIG');
  return url.href.replace(/\/+$/, '');
}

function uploadSnapshots(artifacts, config) {
  const bounds = limits(config);
  if (!Array.isArray(artifacts)) fail('ARTIFACT_INVALID_SNAPSHOT');
  const declared = descriptions(artifacts.map(item => ({ path: item?.path, title: item?.title })), bounds.maxArtifacts + 1);
  let total = 0;
  return artifacts.map((item, index) => {
    const description = declared[index];
    if (!Buffer.isBuffer(item.bytes) || item.name !== description.name || item.mime !== description.mime
      || item.size !== item.bytes.length || item.sha256 !== hash(item.bytes)) fail('ARTIFACT_INVALID_SNAPSHOT');
    if (item.size > bounds.maxFileBytes || (total += item.size) > bounds.maxArtifactBytes) fail('ARTIFACT_LIMIT');
    // The caller cannot change a later upload by mutating its Buffer while this function awaits I/O.
    const snapshot = { ...description, size: item.size, sha256: item.sha256, bytes: Buffer.from(item.bytes) };
    validateContent(snapshot);
    return snapshot;
  });
}

/** Prefer an already-settled operation to a late cancellation so an available file ID can be journaled. */
function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, new ArtifactError('ARTIFACT_ABORTED'));
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) queueMicrotask(abort);
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function deadline(signal, timeout, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try { return await operation(controller.signal); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function readResponse(response, maximum, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let done = false;
  try {
    for (let reads = 0; reads < maximum + 2; reads += 1) {
      const part = await withSignal(reader.read(), signal);
      if (part.done) { done = true; return Buffer.concat(chunks, length); }
      length += part.value.byteLength;
      if (length > maximum) throw new Error('bounded_response');
      chunks.push(Buffer.from(part.value));
    }
    throw new Error('bounded_response');
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function downloadHeaders(response, artifact) {
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const disposition = response.headers.get('content-disposition');
  const match = disposition?.match(/^(attachment|inline);\s*filename\*=UTF-8''([^\r\n]*)$/i);
  let name;
  try { name = match ? decodeURIComponent(match[2]) : null; } catch { return false; }
  const length = response.headers.get('content-length');
  return response.status === 200 && mime === artifact.mime && name === artifact.name
    && (artifact.mime.startsWith('image/') || match?.[1].toLowerCase() === 'attachment')
    && response.headers.get('x-content-type-options')?.trim().toLowerCase() === 'nosniff'
    && (length === null || /^\d+$/.test(length) && Number(length) === artifact.size);
}

/**
 * Uploads are intentionally not retried: a lost response can still mean the POST committed.
 * onEvent is awaited before POST and after learning an ID, allowing the parent to durably journal both.
 */
export async function uploadArtifacts({ artifacts, config, signal, onEvent, fetchImpl = globalThis.fetch }) {
  checkAbort(signal);
  if (!record(config) || typeof config.token !== 'string' || !config.token.trim()
    || /[\r\n]/.test(config.token) || typeof onEvent !== 'function' || typeof fetchImpl !== 'function') {
    fail('ARTIFACT_INVALID_CONFIG');
  }
  const hub = baseUrl(config.url);
  const browser = baseUrl(config.publicBaseUrl, true);
  const timeout = setting(config, 'uploadTimeoutMs', 30_000, 300_000);
  const snapshots = uploadSnapshots(artifacts, config);
  const uploads = [];
  const unknownUploads = [];
  const published = [];
  const emit = async (event, fields) => {
    try { await onEvent({ event, ...fields }); } catch { fail('ARTIFACT_JOURNAL_FAILED'); }
  };
  try {
    for (const artifact of snapshots) {
      checkAbort(signal);
      const intent = { path: artifact.path, name: artifact.name, size: artifact.size, sha256: artifact.sha256 };
      await emit('upload_started', intent);
      checkAbort(signal);
      unknownUploads.push(intent);
      const form = new FormData();
      form.append('file', new Blob([artifact.bytes], { type: artifact.mime }), artifact.name);
      let response;
      let payload;
      try {
        ({ response, payload } = await deadline(signal, timeout, async requestSignal => {
          const response = await withSignal(fetchImpl(`${hub}/api/files/upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
            body: form, signal: requestSignal, redirect: 'error',
          }), requestSignal);
          let payload = null;
          if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json') {
            const bytes = await readResponse(response, MAX_JSON_RESPONSE_BYTES, requestSignal);
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          } else await response.body?.cancel();
          return { response, payload };
        }));
      } catch {
        await emit('upload_unknown', { ...intent, reason: 'response_unavailable' });
        fail('ARTIFACT_UPLOAD_UNKNOWN');
      }

      const knownId = typeof payload?.id === 'string' && FILE_ID.test(payload.id) ? payload.id : null;
      let upload;
      if (knownId) {
        const url = `${browser}/api/files/${knownId}`;
        if (url.length > 2048) fail('ARTIFACT_INVALID_CONFIG');
        upload = { file_id: knownId, ...intent, url };
        uploads.push(upload);
        unknownUploads.pop();
        // Never check cancellation between obtaining an ID and recording it.
        await emit('uploaded', upload);
      }
      if (response.status < 200 || response.status >= 300) {
        const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status) && !knownId;
        if (rejected) unknownUploads.pop();
        await emit(rejected ? 'upload_rejected' : knownId ? 'download_failed' : 'upload_unknown', {
          ...(upload ?? intent), reason: rejected ? 'http_rejected' : 'unexpected_http_status', http_status: response.status,
        });
        fail(rejected ? 'ARTIFACT_UPLOAD_REJECTED' : 'ARTIFACT_UPLOAD_UNKNOWN');
      }
      if (!knownId || payload.url !== `/api/files/${knownId}` || payload.name !== artifact.name
        || payload.size !== artifact.size || payload.mime_type !== artifact.mime) {
        await emit(knownId ? 'download_failed' : 'upload_unknown', {
          ...(upload ?? intent), reason: 'invalid_upload_metadata',
        });
        fail('ARTIFACT_UPLOAD_RESPONSE');
      }
      try {
        checkAbort(signal);
        await deadline(signal, timeout, async requestSignal => {
          const response = await withSignal(fetchImpl(`${hub}/api/files/${knownId}`, {
            method: 'GET', headers: { Authorization: `Bearer ${config.token}`, Accept: artifact.mime },
            signal: requestSignal, redirect: 'error',
          }), requestSignal);
          if (!downloadHeaders(response, artifact)) {
            await response.body?.cancel();
            fail('ARTIFACT_DOWNLOAD_FAILED');
          }
          const bytes = await readResponse(response, artifact.size + 1, requestSignal);
          if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) fail('ARTIFACT_DOWNLOAD_FAILED');
        });
      } catch {
        await emit('download_failed', { ...upload, reason: signal?.aborted ? 'cancelled' : 'verification_failed' });
        fail(signal?.aborted ? 'ARTIFACT_ABORTED' : 'ARTIFACT_DOWNLOAD_FAILED');
      }
      await emit('download_verified', upload);
      published.push({ title: artifact.title, url: upload.url });
    }
    checkAbort(signal);
    return { artifacts: published, uploads };
  } catch (error) {
    const safe = error instanceof ArtifactError ? error : new ArtifactError('ARTIFACT_UPLOAD_UNKNOWN');
    safe.uploads = uploads.map(item => ({ ...item }));
    safe.unknownUploads = unknownUploads.map(item => ({ ...item }));
    throw safe;
  }
}
