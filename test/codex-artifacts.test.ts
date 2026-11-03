import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, open, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ArtifactError, prepareArtifacts, uploadArtifacts } from '../scripts/codex-runner/artifacts.mjs';

const TOKEN = 'test-only-parent-bearer-not-for-events';
const hub = 'http://127.0.0.1:4800/internal/hxa';
const browser = 'https://browser.example.test/company/hxa';
const configuration = { url: hub, publicBaseUrl: browser, token: TOKEN, profile: 'files', uploadTimeoutMs: 100 };
const fileId = (number = 1) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const demoHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Tickets</title></head><body>
  <form data-testid="ticket-form"><input name="subject"></form>
  <main data-testid="ticket-list"></main><select data-testid="status-filter"></select>
  <aside data-testid="ticket-detail"><button data-testid="status-update">Update</button></aside>
  <script>const tickets = JSON.parse(localStorage.getItem('tickets') || '[]');</script>
</body></html>`;
const demoReadme = '# Feedback demo\n\nOpen index.html in your browser. Create a ticket, filter by status and update its status.\n';

function result(paths: string[] = ['notes.txt'], extra: Record<string, unknown> = {}) {
  return {
    status: 'succeeded', summary: 'Created the requested artifacts.',
    artifacts: paths.map(relative => ({ path: relative, title: path.posix.basename(relative) })),
    checks: [{ name: 'requested files', passed: true, details: 'Local artifact files were checked.' }],
    ...extra,
  };
}

function prepared(relative = 'notes.txt', content = 'artifact bytes', mime = 'text/plain') {
  const bytes = Buffer.from(content);
  return { path: relative, name: path.posix.basename(relative), title: relative, mime, bytes, size: bytes.length, sha256: sha256(bytes) };
}

function uploadResponse(artifact: ReturnType<typeof prepared>, number = 1, extra: Record<string, unknown> = {}) {
  return json({ id: fileId(number), name: artifact.name, mime_type: artifact.mime, size: artifact.size,
    url: `/api/files/${fileId(number)}`, created_at: 1, ...extra });
}

function downloadResponse(artifact: ReturnType<typeof prepared>, extraHeaders: Record<string, string> = {}, bytes = artifact.bytes) {
  return new Response(new Uint8Array(bytes), { headers: {
    'Content-Type': artifact.mime, 'Content-Length': String(artifact.size), 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${artifact.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    ...extraHeaders,
  } });
}

function successfulFetch(artifacts: ReturnType<typeof prepared>[]) {
  let uploaded = 0;
  return vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') return uploadResponse(artifacts[uploaded], ++uploaded);
    const number = Number(url.slice(-12));
    return downloadResponse(artifacts[number - 1]);
  });
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'hxa-codex-artifacts-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in artifact tests'); }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function put(relative: string, content: string | Buffer) {
  await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await writeFile(path.join(directory, relative), content);
}
const prepare = (value = result(), config: Record<string, unknown> = {}) => prepareArtifacts({
  workspaceDir: directory, result: value, config: { profile: 'files', ...config },
});

describe('Codex artifact preparation', () => {
  it('snapshots ordinary UTF-8 files without uploading and keeps a stable digest after later file edits', async () => {
    await put('sub/说明.md', '# Local instructions\nOpen the file.');
    const [artifact] = await prepare(result(['sub/说明.md']));
    expect(artifact).toMatchObject({ path: 'sub/说明.md', name: '说明.md', mime: 'text/plain', title: '说明.md' });
    expect(artifact.sha256).toBe(sha256(artifact.bytes));
    expect(artifact.size).toBe(artifact.bytes.length);
    await put('sub/说明.md', 'changed after preparation');
    expect(artifact.bytes.toString()).toContain('# Local instructions');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['../outside.txt', '/tmp/outside.txt', 'sub//file.txt', './file.txt', 'sub/../file.txt',
    'sub\\file.txt', 'C:secret.txt', 'file\u0000.txt', 'sub/file.txt ', 'sub./file.txt', `${'x'.repeat(256)}.txt`])(
    'rejects an unsafe declaration before reading files: %j', async relative => {
      await expect(prepare(result([relative], { artifacts: [{ path: relative, title: 'Artifact' }] })))
        .rejects.toMatchObject({ code: 'ARTIFACT_INVALID_PATH' });
    },
  );

  it('rejects excessively long paths and duplicate basenames across directories and case variants', async () => {
    await expect(prepare(result([`${'a/'.repeat(520)}x.txt`]))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_PATH' });
    for (const paths of [['a/x.txt', 'b/x.txt'], ['a.txt', 'a.txt'], ['a/README.md', 'b/readme.md'], ['é.txt', 'e\u0301.txt']]) {
      await expect(prepare(result(paths))).rejects.toMatchObject({ code: 'ARTIFACT_DUPLICATE' });
    }
  });

  it('rejects symlinks at the file, nested directory, workspace and workspace ancestor', async () => {
    await put('actual/notes.txt', 'safe content');
    await symlink('actual/notes.txt', path.join(directory, 'notes.txt'));
    await expect(prepare()).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    await symlink('actual', path.join(directory, 'alias'));
    await expect(prepare(result(['alias/notes.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    await expect(prepareArtifacts({ workspaceDir: path.join(directory, 'alias'), result: result(), config: {} }))
      .rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    await put('actual/child/notes.txt', 'safe child');
    await expect(prepareArtifacts({ workspaceDir: path.join(directory, 'alias/child'), result: result(), config: {} }))
      .rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
  });

  it('rejects hard links, directories and FIFO files without opening a blocking stream', async () => {
    await put('original.txt', 'safe content');
    await link(path.join(directory, 'original.txt'), path.join(directory, 'notes.txt'));
    await expect(prepare()).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    await mkdir(path.join(directory, 'directory.txt'));
    await expect(prepare(result(['directory.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    execFileSync('mkfifo', [path.join(directory, 'pipe.txt')]);
    await expect(prepare(result(['pipe.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
  });

  it('does not turn an outside symlink target into a snapshot', async () => {
    await put('outside/secret.txt', 'outside-content-never-published');
    await mkdir(path.join(directory, 'workspace'));
    await symlink('../outside', path.join(directory, 'workspace/escape'));
    await expect(prepareArtifacts({ workspaceDir: path.join(directory, 'workspace'),
      result: result(['escape/secret.txt']), config: {} })).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['file', 'parent'])('rejects a real %s replacement while an open descriptor is being read', async replacement => {
    await put('sub/notes.txt', 'original content');
    const probe = await open(path.join(directory, 'sub/notes.txt'), 'r');
    const prototype = Object.getPrototypeOf(probe);
    const originalRead = prototype.read;
    await probe.close();
    let replaced = false;
    vi.spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const chunk = await originalRead.apply(this, args);
      if (!replaced) {
        replaced = true;
        if (replacement === 'file') {
          await rename(path.join(directory, 'sub/notes.txt'), path.join(directory, 'sub/moved.txt'));
          await writeFile(path.join(directory, 'sub/notes.txt'), 'modified content');
        } else {
          await rename(path.join(directory, 'sub'), path.join(directory, 'moved'));
          await symlink('moved', path.join(directory, 'sub'));
        }
      }
      return chunk;
    });
    await expect(prepare(result(['sub/notes.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_FILE_CHANGED' });
    expect(replaced).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('enforces per-file, total-size and count caps', async () => {
    await put('one.txt', '1234');
    await put('two.txt', '5678');
    await expect(prepare(result(['one.txt']), { maxFileBytes: 3 })).rejects.toMatchObject({ code: 'ARTIFACT_LIMIT' });
    await expect(prepare(result(['one.txt', 'two.txt']), { maxArtifactBytes: 7 })).rejects.toMatchObject({ code: 'ARTIFACT_LIMIT' });
    await expect(prepare(result(Array.from({ length: 20 }, (_, i) => `${i}.txt`))))
      .rejects.toMatchObject({ code: 'ARTIFACT_LIMIT' });
    await expect(prepare(result(['one.txt']), { maxArtifacts: 20 })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_CONFIG' });
  });

  it.each([
    { status: 'failed' }, { checks: [{ name: 'test', passed: false, details: 'failed' }] },
  ])('cannot publish a failed status or failed check', async extra => {
    await put('notes.txt', 'exists');
    await expect(prepare(result(['notes.txt'], extra))).rejects.toMatchObject({ code: 'ARTIFACT_FAILED_RESULT' });
  });

  it.each([
    { unexpected: true }, { checks: [] }, { summary: '' },
    { artifacts: [{ path: 'notes.txt', title: 'Notes', extra: true }] },
    { artifacts: [{ path: 'notes.txt', title: 'x'.repeat(201) }] },
    { checks: [{ name: 'test', passed: true }] },
    { checks: [{ name: 'test', passed: 'true', details: '' }] },
  ])('requires the exact result/check/declaration schema', async extra => {
    await expect(prepare(result(['notes.txt'], extra))).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_RESULT' });
  });

  it('checks JSON, UTF-8, MIME signatures and unsupported extensions', async () => {
    await put('data.json', '{broken');
    await expect(prepare(result(['data.json']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSUPPORTED_TYPE' });
    await put('data.json', '{"valid":true}');
    expect((await prepare(result(['data.json'])))[0].mime).toBe('application/json');
    await put('bad.txt', Buffer.from([255, 254]));
    await expect(prepare(result(['bad.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSUPPORTED_TYPE' });
    await put('bad.png', 'not an image');
    await expect(prepare(result(['bad.png']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSUPPORTED_TYPE' });
    await put('script.js', 'alert(1)');
    await expect(prepare(result(['script.js']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSUPPORTED_TYPE' });
    await put('svg.txt', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(prepare(result(['svg.txt']))).rejects.toMatchObject({ code: 'ARTIFACT_UNSUPPORTED_TYPE' });
  });

  it('supports CSV and PNG/JPEG/PDF signatures while preserving original filenames', async () => {
    await put('data.csv', 'name,count\nx,1\n');
    await put('image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRLsAAAAASUVORK5CYII=', 'base64'));
    await put('photo.jpeg', Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]));
    await put('report.pdf', '%PDF-1.4\n%%EOF');
    expect((await prepare(result(['data.csv', 'image.png', 'photo.jpeg', 'report.pdf']))).map(item => item.mime))
      .toEqual(['text/csv', 'image/png', 'image/jpeg', 'application/pdf']);
  });

  it('requires the demo HTML selectors, embedded script, persistence marker and run instructions', async () => {
    await put('index.html', demoHtml);
    await put('README.md', demoReadme);
    const artifacts = await prepare(result(['index.html', 'README.md']), { profile: 'feedback-demo' });
    expect(artifacts.map(item => item.mime)).toEqual(['text/plain', 'text/plain']);
    for (const html of [demoHtml.replace('ticket-detail', 'missing'), demoHtml.replace('localStorage', 'memory'),
      demoHtml.replace(/<script>[\s\S]*?<\/script>/, ''), '<p>not a document</p>']) {
      await put('index.html', html);
      await expect(prepare(result(['index.html', 'README.md']), { profile: 'feedback-demo' }))
        .rejects.toMatchObject({ code: 'ARTIFACT_DEMO_INVALID' });
    }
    await put('index.html', demoHtml);
    await put('README.md', 'Done.');
    await expect(prepare(result(['index.html', 'README.md']), { profile: 'feedback-demo' }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DEMO_INVALID' });
    await expect(prepare(result(['index.html']), { profile: 'feedback-demo' }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DEMO_INVALID' });
  });

  it.each([
    '<script src="https://cdn.example.test/library.js"></script>',
    '<script>fetch("https://api.example.test")</script>',
    '<link rel="stylesheet" href="https://cdn.example.test/app.css">',
    '<img src="https://tracker.example.test/pixel">',
    '<iframe src="https://example.test"></iframe>',
    '<style>body { background: url(https://example.test/image.png); }</style>',
  ])('rejects declared external demo runtime dependencies: %s', async dependency => {
    await put('index.html', demoHtml.replace('</body>', `${dependency}</body>`));
    await put('README.md', demoReadme);
    await expect(prepare(result(['index.html', 'README.md']), { profile: 'feedback-demo' }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DEMO_INVALID' });
  });

  it('does not count HTML comments or script strings as required DOM selectors', async () => {
    await put('index.html', demoHtml.replace('<aside data-testid="ticket-detail">', '<aside>')
      .replace('</body>', '<!-- <aside data-testid="ticket-detail"></aside> --></body>'));
    await put('README.md', demoReadme);
    await expect(prepare(result(['index.html', 'README.md']), { profile: 'feedback-demo' }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DEMO_INVALID' });
  });

  it('stops before filesystem work when already cancelled and does not expose arbitrary abort reasons', async () => {
    const controller = new AbortController();
    controller.abort(new Error(TOKEN));
    await expect(prepareArtifacts({ workspaceDir: directory, result: result(), config: {}, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ARTIFACT_ABORTED' });
  });
});

describe('Codex artifact upload and authenticated verification', () => {
  it('posts multipart bytes, downloads through the internal Hub, and publishes only the configured HTTPS browser prefix', async () => {
    const artifacts = [prepared('pages/说明.html', demoHtml), prepared('README.md', demoReadme)];
    const fetchImpl = successfulFetch(artifacts);
    const events: any[] = [];
    const output = await uploadArtifacts({ artifacts, config: configuration, fetchImpl, onEvent: async event => { events.push(event); } });
    expect(output.artifacts).toEqual(artifacts.map((artifact, i) => ({ title: artifact.title, url: `${browser}/api/files/${fileId(i + 1)}` })));
    expect(output.uploads).toHaveLength(2);
    expect(events.map(event => event.event)).toEqual(['upload_started', 'uploaded', 'download_verified', 'upload_started', 'uploaded', 'download_verified']);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url.startsWith(`${hub}/api/files/`)).toBe(true);
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
    const form = fetchImpl.mock.calls[0][1].body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('说明.html');
    expect(file.type).toBe('text/plain');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(artifacts[0].bytes);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('awaits intent persistence before POST and known-ID persistence before GET', async () => {
    const artifact = prepared();
    const fetchImpl = successfulFetch([artifact]);
    const events: any[] = [];
    let releaseIntent!: () => void;
    let releaseId!: () => void;
    const intentGate = new Promise<void>(resolve => { releaseIntent = resolve; });
    const idGate = new Promise<void>(resolve => { releaseId = resolve; });
    const promise = uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async event => {
      events.push(event);
      if (event.event === 'upload_started') await intentGate;
      if (event.event === 'uploaded') await idGate;
    } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(fetchImpl).not.toHaveBeenCalled();
    releaseIntent();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseId();
    await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('validates every snapshot and all totals before the first POST, including parent metadata', async () => {
    const fetchImpl = vi.fn();
    const onEvent = vi.fn();
    const good = prepared();
    const invalid = { ...prepared('later.txt'), sha256: 'wrong' };
    await expect(uploadArtifacts({ artifacts: [good, invalid], config: configuration, fetchImpl, onEvent }))
      .rejects.toMatchObject({ code: 'ARTIFACT_INVALID_SNAPSHOT' });
    const metadata = prepared('run-metadata.json', '{"status":"ok"}', 'application/json');
    await expect(uploadArtifacts({ artifacts: [good, metadata], config: { ...configuration, maxArtifactBytes: good.size }, fetchImpl, onEvent }))
      .rejects.toMatchObject({ code: 'ARTIFACT_LIMIT' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('allows 19 prepared user artifacts plus the parent metadata as the twentieth upload', async () => {
    const artifacts = [...Array.from({ length: 19 }, (_, i) => prepared(`${i}.txt`, String(i))),
      prepared('run-metadata.json', '{"validated":true}', 'application/json')];
    const output = await uploadArtifacts({ artifacts, config: configuration, fetchImpl: successfulFetch(artifacts), onEvent: async () => {} });
    expect(output.uploads).toHaveLength(20);
    await expect(uploadArtifacts({ artifacts: [...artifacts, prepared('extra.txt')], config: configuration, onEvent: async () => {} }))
      .rejects.toMatchObject({ code: 'ARTIFACT_LIMIT' });
  });

  it('copies all upload buffers before asynchronous journal code can change caller-owned bytes', async () => {
    const artifacts = [prepared('first.txt'), prepared('second.txt', 'stable second')];
    const expected = artifacts.map(item => ({ ...item, bytes: Buffer.from(item.bytes) }));
    const fetchImpl = successfulFetch(expected);
    await uploadArtifacts({ artifacts, config: configuration, fetchImpl, onEvent: async event => {
      if (event.event === 'upload_started') artifacts[1].bytes.fill(120);
    } });
    const second = (fetchImpl.mock.calls[2][1].body as FormData).get('file') as File;
    expect(await second.text()).toBe('stable second');
  });

  it.each(['http://browser.example.test', 'http://127.0.0.1:4801', 'https://user:pass@browser.example.test',
    'https://browser.example.test?token=secret', 'https://browser.example.test/#fragment'])('rejects an unsafe browser base before upload: %s', async publicBaseUrl => {
    const fetchImpl = vi.fn();
    await expect(uploadArtifacts({ artifacts: [prepared()], config: { ...configuration, publicBaseUrl }, fetchImpl, onEvent: async () => {} }))
      .rejects.toMatchObject({ code: 'ARTIFACT_INVALID_CONFIG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send a POST when journaling the intent fails', async () => {
    const fetchImpl = vi.fn();
    await expect(uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl,
      onEvent: async () => { throw new Error(TOKEN); } })).rejects.toMatchObject({ code: 'ARTIFACT_JOURNAL_FAILED', uploads: [], unknownUploads: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retains a known ID even if journaling that ID fails, without making a second POST or GET', async () => {
    const artifact = prepared();
    const fetchImpl = successfulFetch([artifact]);
    await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async event => {
      if (event.event === 'uploaded') throw new Error(TOKEN);
    } })).rejects.toMatchObject({ code: 'ARTIFACT_JOURNAL_FAILED', uploads: [{ file_id: fileId() }], unknownUploads: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records an uncertain POST without retrying or leaking transport errors', async () => {
    const events: any[] = [];
    const fetchImpl = vi.fn(async () => { throw new Error(`Request failed with ${TOKEN} https://attacker.example.test`); });
    let caught: any;
    try {
      await uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl, onEvent: async event => { events.push(event); } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ArtifactError);
    expect(caught).toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN', uploads: [], unknownUploads: [{ path: 'notes.txt' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.event)).toEqual(['upload_started', 'upload_unknown']);
    expect(`${caught.message} ${JSON.stringify(events)}`).not.toContain(TOKEN);
    expect(`${caught.message} ${JSON.stringify(events)}`).not.toContain('attacker.example.test');
  });

  it('preserves verified earlier uploads and the unresolved next intent on partial failure', async () => {
    const artifacts = [prepared('first.txt'), prepared('second.txt')];
    const events: any[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(uploadResponse(artifacts[0]))
      .mockResolvedValueOnce(downloadResponse(artifacts[0]))
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(uploadArtifacts({ artifacts, config: configuration, fetchImpl, onEvent: async event => { events.push(event); } }))
      .rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN', uploads: [{ file_id: fileId(), path: 'first.txt' }],
        unknownUploads: [{ path: 'second.txt' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events.map(event => event.event)).toEqual(['upload_started', 'uploaded', 'download_verified', 'upload_started', 'upload_unknown']);
  });

  it.each(['https://attacker.example.test/leak', `/api/files/${fileId()}?redirect=bad`, `/api/files/../${fileId()}`])(
    'journals the known file ID but refuses an arbitrary returned download URL: %s', async url => {
      const artifact = prepared();
      const events: any[] = [];
      const fetchImpl = vi.fn(async () => uploadResponse(artifact, 1, { url }));
      await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async event => { events.push(event); } }))
        .rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_RESPONSE', uploads: [{ file_id: fileId() }], unknownUploads: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(events.map(event => event.event)).toEqual(['upload_started', 'uploaded', 'download_failed']);
      expect(JSON.stringify(events)).not.toContain('attacker.example.test');
    },
  );

  it('rejects malformed IDs and bounded oversized JSON without following a URL or retrying', async () => {
    for (const response of [uploadResponse(prepared(), 1, { id: '../secret' }), json({ padding: 'x'.repeat(65 * 1024), id: fileId() })]) {
      const fetchImpl = vi.fn(async () => response);
      await expect(uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl, onEvent: async () => {} }))
        .rejects.toBeInstanceOf(ArtifactError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects redirect responses without requesting the Location destination', async () => {
    const events: any[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example.test' } }));
    await expect(uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl, onEvent: async event => { events.push(event); } }))
      .rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(events.at(-1)).toMatchObject({ event: 'upload_unknown', http_status: 302 });
  });

  it('separates a definite Hub rejection from an unknown upload outcome', async () => {
    const events: any[] = [];
    const fetchImpl = vi.fn(async () => json({ error: `Do not expose ${TOKEN}` }, 413));
    await expect(uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl, onEvent: async event => { events.push(event); } }))
      .rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_REJECTED', uploads: [], unknownUploads: [] });
    expect(events.at(-1)).toMatchObject({ event: 'upload_rejected', http_status: 413, reason: 'http_rejected' });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it.each([
    { 'Content-Type': 'text/html' }, { 'X-Content-Type-Options': 'unsafe' },
    { 'Content-Disposition': "inline; filename*=UTF-8''notes.txt" },
    { 'Content-Disposition': "attachment; filename*=UTF-8''wrong.txt" },
    { 'Content-Length': '999' },
  ])('requires a matching safe download type, original name and size: %j', async headers => {
    const artifact = prepared();
    const events: any[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(uploadResponse(artifact)).mockResolvedValueOnce(downloadResponse(artifact, headers));
    await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async event => { events.push(event); } }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED', uploads: [{ file_id: fileId() }] });
    expect(events.at(-1).event).toBe('download_failed');
  });

  it('rejects download redirects and matching-length tampering while retaining the uploaded ID', async () => {
    const artifact = prepared();
    for (const response of [new Response(null, { status: 302, headers: { Location: 'https://attacker.example.test' } }),
      downloadResponse(artifact, {}, Buffer.alloc(artifact.size, 120))]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(uploadResponse(artifact)).mockResolvedValueOnce(response);
      await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async () => {} }))
        .rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED', uploads: [{ file_id: fileId() }] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('bounds download reads and cancels an oversized stream', async () => {
    const artifact = prepared();
    const cancel = vi.fn();
    const response = downloadResponse(artifact);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1000)); }, cancel });
    const fetchImpl = vi.fn().mockResolvedValueOnce(uploadResponse(artifact))
      .mockResolvedValueOnce(new Response(stream, { headers: response.headers }));
    await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async () => {} }))
      .rejects.toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('permits safe inline image downloads', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const artifact = { ...prepared('image.png', '', 'image/png'), bytes, size: bytes.length, sha256: sha256(bytes) };
    const output = await uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl: successfulFetch([artifact]), onEvent: async () => {} });
    expect(output.artifacts).toHaveLength(1);
  });

  it('records a known ID before honoring cancellation that occurs immediately after the POST response', async () => {
    const artifact = prepared();
    const controller = new AbortController();
    const events: any[] = [];
    const fetchImpl = vi.fn(() => {
      const response = Promise.resolve(uploadResponse(artifact));
      controller.abort(new Error(TOKEN));
      return response;
    });
    await expect(uploadArtifacts({ artifacts: [artifact], config: configuration, signal: controller.signal, fetchImpl,
      onEvent: async event => { events.push(event); } })).rejects.toMatchObject({ code: 'ARTIFACT_ABORTED', uploads: [{ file_id: fileId() }], unknownUploads: [] });
    expect(events.map(event => event.event)).toEqual(['upload_started', 'uploaded', 'download_failed']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out an uncertain POST once and clears the request timer', async () => {
    vi.useFakeTimers();
    const events: any[] = [];
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, init) => {
      requestSignal = init.signal;
      return new Promise<Response>(() => {});
    });
    const caught = uploadArtifacts({ artifacts: [prepared()], config: configuration, fetchImpl,
      onEvent: async event => { events.push(event); } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await caught).toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN', unknownUploads: [{ path: 'notes.txt' }] });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.at(-1).event).toBe('upload_unknown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a download, cancels its body and preserves the known upload ID', async () => {
    vi.useFakeTimers();
    const artifact = prepared();
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const fetchImpl = vi.fn().mockResolvedValueOnce(uploadResponse(artifact))
      .mockResolvedValueOnce(new Response(stream, { headers: downloadResponse(artifact).headers }));
    const caught = uploadArtifacts({ artifacts: [artifact], config: configuration, fetchImpl, onEvent: async () => {} }).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await caught).toMatchObject({ code: 'ARTIFACT_DOWNLOAD_FAILED', uploads: [{ file_id: fileId() }] });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
