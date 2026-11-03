import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP, Socket, type AddressInfo } from 'node:net';
import type { HubDB } from '../src/db.js';
import { webhookLogger } from '../src/logger.js';
import { validateWebhookUrl, verifyWebhookSignature, WebhookManager } from '../src/webhook.js';

const PUBLIC_V4 = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6 = { address: '2606:4700:4700::1111', family: 6 };

function database() {
  const db = {
    isWebhookDegraded: vi.fn().mockResolvedValue(false),
    recordWebhookSuccess: vi.fn().mockResolvedValue(undefined),
    recordWebhookFailure: vi.fn().mockResolvedValue(undefined),
  };
  return { db, manager: new WebhookManager(db as unknown as HubDB) };
}

type FakeRequest = EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
type Attempt = {
  url: URL;
  options: https.RequestOptions;
  request: FakeRequest;
  body?: string;
  addresses: LookupAddress[];
  response?: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
};
type Outcome = number | Error | 'hang';

/**
 * Simulate only the wire after Node's supplied lookup has completed. No test
 * connects to a public address. The actual lookup policy is never replaced.
 */
function transport(outcomes: Outcome[], settings: { location?: string; singleLookup?: boolean } = {}) {
  const attempts: Attempt[] = [];
  const implementation = (url: URL, options: https.RequestOptions, onResponse: (res: http.IncomingMessage) => void) => {
    const request = new EventEmitter() as FakeRequest;
    const attempt: Attempt = { url, options, request, addresses: [] };
    const outcome = outcomes[Math.min(attempts.length, outcomes.length - 1)];
    attempts.push(attempt);
    let destroyed = false;
    const onAbort = () => request.emit('error', Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }));
    request.destroy = vi.fn(() => {
      destroyed = true;
      options.signal?.removeEventListener('abort', onAbort);
      return request;
    });
    request.end = vi.fn((body: string) => {
      attempt.body = body;
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const connected = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
        if (destroyed) return;
        if (error) { request.emit('error', error); return; }
        attempt.addresses = typeof address === 'string' ? [{ address, family: family! }] : address;
        if (outcome instanceof Error) { request.emit('error', outcome); return; }
        if (outcome === 'hang') return;
        const response = new EventEmitter() as NonNullable<Attempt['response']>;
        response.statusCode = outcome;
        response.headers = settings.location ? { location: settings.location } : {};
        response.destroy = vi.fn(() => response);
        attempt.response = response;
        onResponse(response as unknown as http.IncomingMessage);
      };
      queueMicrotask(() => {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        if (family) connected(null, hostname, family); // native IP-literal bypass
        else options.lookup!(hostname, { all: !settings.singleLookup }, connected);
      });
      return request;
    });
    return request as unknown as http.ClientRequest;
  };
  vi.spyOn(https, 'request').mockImplementation(implementation as typeof https.request);
  vi.spyOn(http, 'request').mockImplementation(implementation as typeof http.request);
  return attempts;
}

beforeEach(() => {
  vi.stubEnv('DEV_MODE', 'false');
  vi.spyOn(webhookLogger, 'warn').mockImplementation(() => {});
  vi.spyOn(webhookLogger, 'error').mockImplementation(() => {});
  // A regression back to fetch cannot contact the network in this suite.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch transport'); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('webhook destination validation', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '[::]', '[::1]', '[fc00::1]', '[fdff::1]', '[fe80::1]', '[fe90::1]', '[febf::1]',
    '[fec0::1]', '[ff02::1]', '[::127.0.0.1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]',
    '[0:0:0:0:0:ffff:a00:1]', '[::ffff:93.184.216.34]', '[64:ff9b::a00:1]',
    '[64:ff9b:1::a00:1]', '[100::1]', '[2001::1]', '[2001:db8::1]',
    '[2002:7f00:1::]', '[3fff::1]', '2130706433', '0x7f000001', '127.1', '0177.0.0.1',
  ])('rejects private/reserved/translated or alternate-format literal %s before DNS or request creation', async hostname => {
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('DNS must not run'));
    const attempts = transport([200]);
    const { manager, db } = database();
    const url = 'https://' + hostname + '/hook';
    expect(await validateWebhookUrl(url)).toEqual(expect.any(String));
    expect(await manager.deliver('bot', url, null, { type: 'test' })).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(0);
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
  });

  it.each(['1.1.1.1', '93.184.216.34', '100.128.0.1', '172.15.0.1', '172.32.0.1',
    '198.20.0.1', '[2606:4700:4700::1111]', '[2001:4860:4860::8888]'])('accepts ordinary public literal %s without DNS', async hostname => {
    const lookup = vi.spyOn(dns, 'lookup');
    expect(await validateWebhookUrl('https://' + hostname + '/hook')).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('applies the same protocol and URL-credential rules at registration and delivery', async () => {
    const attempts = transport([200]);
    const { manager } = database();
    for (const url of ['http://1.1.1.1/hook', 'ftp://1.1.1.1/hook', 'file:///etc/hosts',
      'https://name:password@1.1.1.1/hook', 'not a URL', 'https://[fe80::1%25eth0]/hook']) {
      expect(await validateWebhookUrl(url)).toEqual(expect.any(String));
      expect(await manager.deliver('bot', url, null, {})).toBe(false);
    }
    expect(attempts).toHaveLength(0);
    vi.stubEnv('DEV_MODE', 'true');
    expect(await validateWebhookUrl('http://1.1.1.1/hook')).toBeNull();
    expect(await validateWebhookUrl('http://127.0.0.1/hook')).toEqual(expect.any(String));
  });

  it('checks every A/AAAA answer and fails closed on mixed or malformed DNS answers', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    for (const answers of [
      [PUBLIC_V4, { address: '127.0.0.1', family: 4 }],
      [PUBLIC_V4, { address: 'fe90::1', family: 6 }],
      [PUBLIC_V6, { address: '::ffff:a9fe:a9fe', family: 6 }],
      [{ address: 'not-an-address', family: 4 }],
      [{ address: PUBLIC_V4.address, family: 6 }],
      [],
    ]) {
      lookup.mockResolvedValueOnce(answers as any);
      expect(await validateWebhookUrl('https://webhook.test/hook')).toEqual(expect.any(String));
    }
    lookup.mockResolvedValueOnce([PUBLIC_V4, PUBLIC_V6] as any);
    expect(await validateWebhookUrl('https://webhook.test/hook')).toBeNull();
    expect(lookup).toHaveBeenLastCalledWith('webhook.test', { all: true, verbatim: true });
  });
});

describe('webhook delivery security and retries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(dns, 'lookup').mockResolvedValue([PUBLIC_V4, PUBLIC_V6] as any);
  });

  it.each([301, 302, 303, 307, 308])('rejects redirect %s without requesting its private Location or retrying', async status => {
    const attempts = transport([status], { location: 'http://169.254.169.254/latest/meta-data?secret=location-value' });
    const { manager, db } = database();
    expect(await manager.deliver('bot', 'https://webhook.test/path?secret=url-value', 'webhook-secret', { secret: 'payload-value' })).toBe(false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url.hostname).toBe('webhook.test');
    expect(attempts[0].request.destroy).toHaveBeenCalled();
    expect(attempts[0].response!.destroy).toHaveBeenCalled();
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const logs = JSON.stringify([vi.mocked(webhookLogger.warn).mock.calls, vi.mocked(webhookLogger.error).mock.calls]);
    for (const value of ['location-value', 'url-value', 'webhook-secret', 'payload-value']) expect(logs).not.toContain(value);
  });

  it.each(['/elsewhere', '//127.0.0.1/admin', 'https://webhook.test/elsewhere'])('also refuses relative/same-host redirect %s', async location => {
    const attempts = transport([302], { location });
    expect(await database().manager.deliver('bot', 'https://webhook.test/hook', null, {})).toBe(false);
    expect(attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pins the one checked DNS answer set while keeping the original HTTPS hostname and native TLS verification', async () => {
    vi.mocked(dns.lookup).mockReset().mockResolvedValueOnce([PUBLIC_V4, PUBLIC_V6] as any)
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    const attempts = transport([204]);
    const { manager, db } = database();
    expect(await manager.deliver('bot', 'https://webhook.test:8443/hook', null, {})).toBe(true);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(attempts[0].addresses).toEqual([PUBLIC_V4, PUBLIC_V6]);
    expect(attempts[0].url.hostname).toBe('webhook.test');
    expect(attempts[0].url.port).toBe('8443');
    expect(attempts[0].options).toMatchObject({ agent: false, rejectUnauthorized: true });
    expect(attempts[0].options.hostname).toBeUndefined();
    expect(attempts[0].options.host).toBeUndefined();
    expect(attempts[0].options.servername).toBeUndefined(); // https derives SNI from the original URL
    expect(attempts[0].options.checkServerIdentity).toBeUndefined(); // native certificate hostname check
    expect(db.recordWebhookSuccess).toHaveBeenCalledExactlyOnceWith('bot');
    expect(db.recordWebhookFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports native single-address lookup without performing a second resolution', async () => {
    const attempts = transport([200], { singleLookup: true });
    expect(await database().manager.deliver('bot', 'https://webhook.test/hook', null, {})).toBe(true);
    expect(attempts[0].addresses).toEqual([PUBLIC_V4]);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });

  it('passes the original SNI/host to native TLS and does not bypass certificate identity failures', async () => {
    const connections: Array<{ options: tls.ConnectionOptions; socket: tls.TLSSocket }> = [];
    vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => {
      // Exercise https.request's actual Agent/TLS option construction, but never
      // connect the socket. A certificate rejection is surfaced as a real error.
      const socket = new tls.TLSSocket(new Socket());
      connections.push({ options, socket });
      queueMicrotask(() => socket.destroy(Object.assign(new Error('Certificate identity mismatch'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      })));
      return socket;
    }) as typeof tls.connect);
    const { manager, db } = database();
    const delivered = manager.deliver('bot', 'https://webhook.test:8443/hook', null, {});
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(false);
    expect(connections).toHaveLength(4);
    for (const { options, socket } of connections) {
      expect(options.host).toBe('webhook.test');
      expect(options.servername).toBe('webhook.test');
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.checkServerIdentity).toBeUndefined();
      expect(tls.checkServerIdentity(options.servername!, {
        subjectaltname: 'DNS:attacker.test', subject: { CN: 'attacker.test' },
      } as tls.PeerCertificate)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
      expect(socket.destroyed).toBe(true);
    }
    expect(db.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks rebinding on a retry and never hands a private address to the connection', async () => {
    vi.mocked(dns.lookup).mockReset().mockResolvedValueOnce([PUBLIC_V4] as any)
      .mockResolvedValue([{ address: '10.0.0.2', family: 4 }] as any);
    const attempts = transport([503, 200]);
    const { manager, db } = database();
    const delivered = manager.deliver('bot', 'https://webhook.test/hook', null, {});
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(false);
    expect(attempts).toHaveLength(2);
    expect(attempts.map(attempt => attempt.addresses)).toEqual([[PUBLIC_V4], []]);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(attempts.every(attempt => attempt.request.destroy.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed on DNS errors, exhausts only four attempts, and leaves no timers or open requests', async () => {
    vi.mocked(dns.lookup).mockRejectedValue(Object.assign(new Error('private-detail'), { code: 'EAI_AGAIN' }));
    const attempts = transport([200]);
    const { manager, db } = database();
    const delivered = manager.deliver('bot', 'https://webhook.test/hook', null, {});
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(false);
    expect(attempts).toHaveLength(4);
    expect(attempts.every(attempt => attempt.addresses.length === 0)).toBe(true);
    expect(attempts.every(attempt => attempt.request.destroy.mock.calls.length > 0)).toBe(true);
    expect(dns.lookup).toHaveBeenCalledTimes(4);
    expect(db.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds each hung attempt to ten seconds and destroys it before the next retry', async () => {
    const attempts = transport(['hang']);
    const { manager, db } = database();
    const start = Date.now();
    const delivered = manager.deliver('bot', 'https://webhook.test/hook', null, {});
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(false);
    expect(attempts).toHaveLength(4);
    expect(Date.now() - start).toBe(76_000); // 4 deadlines plus 1s, 5s, 30s delays
    expect(attempts.every(attempt => attempt.options.signal!.aborted)).toBe(true);
    expect(attempts.every(attempt => attempt.request.destroy.mock.calls.length > 0)).toBe(true);
    expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled DNS lookup with the same connection deadline and ignores late answers', async () => {
    let resolveLookup!: (addresses: any) => void;
    vi.mocked(dns.lookup).mockImplementation(() => new Promise(resolve => { resolveLookup = resolve; }));
    const attempts = transport(['hang']);
    const delivered = database().manager.deliver('bot', 'https://webhook.test/hook', null, {});
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(false);
    expect(attempts).toHaveLength(4);
    resolveLookup([PUBLIC_V4]);
    await Promise.resolve();
    expect(attempts.every(attempt => attempt.addresses.length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains payload/HMAC signing, refreshes timestamps per retry, and records one success', async () => {
    const attempts = transport([503, 502, 200]);
    const { manager, db } = database();
    const delivered = manager.deliver('bot', 'https://webhook.test/hook', 'test-secret', { text: 'hello' });
    await vi.runAllTimersAsync();
    expect(await delivered).toBe(true);
    expect(attempts).toHaveLength(3);
    const timestamps = attempts.map(attempt => {
      const headers = attempt.options.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-secret');
      expect(attempt.body).toBe('{"text":"hello"}');
      expect(verifyWebhookSignature('test-secret', headers['X-Hub-Signature-256'], headers['X-Hub-Timestamp'], attempt.body!)).toBe(true);
      return Number(headers['X-Hub-Timestamp']);
    });
    expect(timestamps[1] - timestamps[0]).toBe(1000);
    expect(timestamps[2] - timestamps[1]).toBe(5000);
    expect(db.recordWebhookSuccess).toHaveBeenCalledExactlyOnceWith('bot');
    expect(db.recordWebhookFailure).not.toHaveBeenCalled();
    expect(attempts.every(attempt => attempt.response!.destroy.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips degraded bots without resolving DNS, creating requests or changing health', async () => {
    const attempts = transport([200]);
    const { manager, db } = database();
    db.isWebhookDegraded.mockResolvedValue(true);
    expect(await manager.deliver('bot', 'https://webhook.test/hook', null, {})).toBe(false);
    expect(attempts).toHaveLength(0);
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(db.recordWebhookSuccess).not.toHaveBeenCalled();
    expect(db.recordWebhookFailure).not.toHaveBeenCalled();
  });
});

describe('native socket rejection', () => {
  it('blocks a public-at-registration hostname rebound to loopback before any real local connection', async () => {
    vi.stubEnv('DEV_MODE', 'true');
    let connections = 0;
    let requests = 0;
    const server = http.createServer((_req, response) => { requests++; response.end('internal service'); });
    server.on('connection', () => { connections++; });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([PUBLIC_V4] as any)
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
      const url = 'http://webhook.test:' + port + '/internal';
      expect(await validateWebhookUrl(url)).toBeNull();
      const { manager, db } = database();
      expect(await manager.deliver('bot', url, 'test-secret', { value: 'must not arrive' })).toBe(false);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(connections).toBe(0);
      expect(requests).toBe(0);
      expect(db.recordWebhookFailure).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
