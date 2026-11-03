import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { URL } from 'node:url';
import type { HubDB } from './db.js';
import { webhookLogger } from './logger.js';

function computeHmacSignature(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const REQUEST_TIMEOUT_MS = 10_000;

class WebhookPolicyError extends Error {
  readonly code = 'WEBHOOK_DESTINATION_BLOCKED';
}

// Conservative public-destination policy, using Node's binary CIDR matcher.
// Sources: IANA IPv4/IPv6 Special-Purpose Address Registries. These exclusions
// intentionally include special-purpose ranges with globally reachable exceptions.
const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedIPv4.addSubnet(address, prefix, 'ipv4');

const publicIPv6 = new BlockList();
publicIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blockedIPv6.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, 'ipv4');
  // Only native global-unicast IPv6 is supported. This also rejects unspecified,
  // loopback, ULA, link/site-local, multicast, mapped/compatible IPv4, NAT64,
  // discard-only and other reserved space, rather than trusting an embedded IP.
  if (family === 6) return publicIPv6.check(address, 'ipv6') && !blockedIPv6.check(address, 'ipv6');
  return false;
}

function parseWebhookUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new WebhookPolicyError('webhook_url is not a valid URL');
  }
  if (parsed.protocol === 'http:' && process.env.DEV_MODE !== 'true') {
    throw new WebhookPolicyError('webhook_url must use https (http allowed only when DEV_MODE=true)');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new WebhookPolicyError('webhook_url must use http or https scheme');
  }
  if (parsed.username || parsed.password) {
    throw new WebhookPolicyError('webhook_url must not contain credentials');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  // Node bypasses custom DNS lookup for IP literals, so check them here too.
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new WebhookPolicyError('webhook_url must use a public IP address');
  }
  return parsed;
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw Object.assign(new Error('Empty DNS answer'), { code: 'ENOTFOUND' });
  // Fail closed on mixed public/private results, not just the first DNS answer.
  if (addresses.some(result => !isPublicAddress(result.address) || isIP(result.address) !== result.family)) {
    throw new WebhookPolicyError('webhook_url must not resolve to a private, reserved or unsupported IP address');
  }
  return addresses;
}

// This is the resolver used by the actual TCP connection. The validated answers
// are passed directly to Node; there is no second unchecked DNS lookup between
// validation and connection. Support both native single and dual-stack lookup.
const checkedLookup: LookupFunction = (hostname, options, callback) => {
  void resolvePublicAddresses(hostname).then(addresses => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
    const eligible = family ? addresses.filter(result => result.family === family) : addresses;
    if (!eligible.length) {
      callback(Object.assign(new Error('No address for requested family'), { code: 'ENOTFOUND' }), '');
    } else if (options.all) callback(null, eligible);
    else callback(null, eligible[0].address, eligible[0].family);
  }, error => callback(error instanceof Error ? error : new Error('DNS lookup failed'), ''));
};

async function postWebhook(url: URL, headers: Record<string, string>, body: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let request: http.ClientRequest | undefined;
  try {
    return await new Promise<number>((resolve, reject) => {
      const options: https.RequestOptions = {
        method: 'POST', headers, agent: false, lookup: checkedLookup,
        signal: controller.signal,
        // Keep the original URL hostname for Host, TLS certificate verification
        // and SNI. Only DNS answers are pinned; TLS verification is never disabled.
        rejectUnauthorized: true,
      };
      const send = url.protocol === 'https:' ? https.request : http.request;
      request = send(url, options, response => {
        const status = response.statusCode ?? 0;
        // No response body is needed. Bound resources even for an infinite body.
        response.on('error', () => {});
        response.destroy();
        resolve(status);
      });
      request.once('error', reject);
      request.end(body);
    });
  } finally {
    clearTimeout(timer);
    request?.destroy();
  }
}

/**
 * Validate a webhook URL at registration. Delivery uses the same policy inside
 * the actual connection's DNS lookup, since an earlier check cannot pin DNS.
 */
export async function validateWebhookUrl(url: string): Promise<string | null> {
  try {
    const parsed = parseWebhookUrl(url);
    await resolvePublicAddresses(parsed.hostname.replace(/^\[|\]$/g, ''));
    return null;
  } catch (error) {
    if (error instanceof WebhookPolicyError) return error.message;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOTFOUND') {
      return 'webhook_url hostname could not be resolved';
    }
    return 'webhook_url hostname DNS lookup failed temporarily — please try again';
  }
}

export class WebhookManager {
  constructor(private db: HubDB) {}

  /**
   * Deliver a webhook payload with bounded retries and HMAC signing.
   * Returns true on success, false on failure or if bot is degraded.
   *
   * When webhook_secret is set, the request includes:
   * - Authorization: Bearer <secret> (legacy, for backward compat)
   * - X-Hub-Signature-256: sha256=<hex> (HMAC-SHA256 of "timestamp.body")
   * - X-Hub-Timestamp: <unix_ms> (request timestamp for replay protection)
   */
  async deliver(
    botId: string,
    webhookUrl: string,
    webhookSecret: string | null,
    payload: unknown,
  ): Promise<boolean> {
    if (await this.db.isWebhookDegraded(botId)) return false;

    const body = JSON.stringify(payload);
    // Retain the existing bounded delivery schedule. Each attempt gets its own
    // connection, checked DNS resolution and 10-second total request deadline.
    const delays = [0, 1000, 5000, 30000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delays[attempt]));

      try {
        const parsed = parseWebhookUrl(webhookUrl);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (webhookSecret) {
          headers['Authorization'] = 'Bearer ' + webhookSecret;
          const timestamp = String(Date.now());
          const signature = computeHmacSignature(webhookSecret, timestamp + '.' + body);
          headers['X-Hub-Signature-256'] = 'sha256=' + signature;
          headers['X-Hub-Timestamp'] = timestamp;
        }

        const status = await postWebhook(parsed, headers, body);
        if (status >= 200 && status < 300) {
          await this.db.recordWebhookSuccess(botId);
          return true;
        }

        webhookLogger.warn({ botId, attempt: attempt + 1, status }, 'Webhook delivery attempt failed');
        // Native http(s).request never follows Location. Every redirect is a
        // permanent refusal, including same-host and scheme-relative targets.
        if (status >= 300 && status < 400) break;
      } catch (error) {
        // Do not log the URL, Location, response body, request body, or secrets.
        const code = (error as NodeJS.ErrnoException)?.code;
        webhookLogger.warn({ botId, attempt: attempt + 1,
          code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'WEBHOOK_REQUEST_ERROR',
        }, 'Webhook delivery attempt error');
        if (error instanceof WebhookPolicyError) break;
      }
    }

    await this.db.recordWebhookFailure(botId);
    webhookLogger.error({ botId }, 'Webhook delivery failed');
    return false;
  }
}

/**
 * Verify a webhook signature. For use by bot endpoints receiving webhooks.
 *
 * @param secret - The webhook secret shared between Hub and bot
 * @param signature - Value of X-Hub-Signature-256 header (e.g. "sha256=abc123...")
 * @param timestamp - Value of X-Hub-Timestamp header
 * @param body - Raw request body string
 * @param maxAgeMs - Maximum age of the timestamp (default 5 minutes, for replay protection)
 * @returns true if signature is valid and timestamp is fresh
 */
export function verifyWebhookSignature(
  secret: string,
  signature: string,
  timestamp: string,
  body: string,
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  // Check timestamp freshness (replay protection)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > maxAgeMs) {
    return false;
  }

  // Verify HMAC
  const expected = computeHmacSignature(secret, `${timestamp}.${body}`);
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  // Validate hex format explicitly — SHA-256 digest is always 64 hex chars
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
