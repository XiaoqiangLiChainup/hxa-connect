# Browser Acceptance for a Loopback-Only Pilot

Use this optional path when the independent M0 pilot is healthy on the company
server's `127.0.0.1:4801`, but the company HTTPS hostname is not ready. It uses the
operator's existing approved SSH access and a browser on the operator's computer.
It does not provide a shared employee URL or complete company HTTPS acceptance.

Keep the pilot's current Compose overlays, network isolation, data volume, and
credentials. The default repository Compose file does not reproduce additional
company-local ingress or egress restrictions by itself.

## 1. Check the pilot's effective host configuration

The company-side operator should inspect only the relevant non-secret settings:

- The effective `DOMAIN` is empty, `localhost`, or `localhost:14801` for this
  temporary check. A company hostname or leftover example value would reject
  a cookie-authenticated POST from `http://localhost:14801`.
- `HXA_CONNECT_CORS_ORIGINS` can remain empty. The browser UI, API, and WebSocket
  use the same forwarded origin; an allow-all CORS setting is unnecessary.
- The local ingress accepts `Host: localhost:14801` and does not redirect this
  request to a company hostname or an HTTPS origin that is not available. SSH
  forwards TCP; it does not rewrite HTTP Host or redirect destinations.
- When `DOMAIN` is empty, preserve the browser-facing Host and any effective
  `X-Forwarded-Host` so Express observes `localhost`. With an explicit
  `DOMAIN=localhost` or `DOMAIN=localhost:14801`, CSRF uses that configured value
  instead. Do not assume a company-local ingress uses the example proxy headers.
- `DEV_MODE` remains disabled. The session cookie continues to use `Secure`,
  `HttpOnly`, and `SameSite=Strict`; keep the existing CSRF checks enabled.

Record and restore any temporary pilot-only hostname setting after this check.
Apply a configuration change through the existing pilot operations runbook and
all its Compose overlays. Do not restart or reconfigure an unrelated Hub.

## 2. Open the tunnel on the operator's computer

Run this on the computer that will open the browser, using the existing SSH
account, SSH config, key, VPN, and jump-host arrangement approved by the company:

```bash
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -L localhost:14801:127.0.0.1:4801 \
  your-user@your-company-server
```

Replace the account and server placeholder. The SSH destination must be the host
where `127.0.0.1:4801` already reaches this pilot. Keep the terminal running. A
company-side Zylos cannot create this local tunnel on an employee's computer.

The explicit `localhost` bind limits the forwarded listener to that computer.
Use the company's existing host-key verification; no new public application port
or disabled SSH host-key checks are needed. If local port 14801 is occupied,
choose a free local port and use that exact port consistently below. Also update
`DOMAIN` if its temporary value includes a port.

Open a clean browser profile or private window in a current Chrome or Firefox:

```text
http://localhost:14801/
http://localhost:14801/admin/
```

Use the literal hostname `localhost` throughout. Do not alternate it with a
server IP or `127.0.0.1`. Cookies are not isolated by port, so an unrelated local
HXA session is another reason to use a clean browser profile.

## 3. Verify the actual browser session

The application sets a host-only session cookie. Browsers supporting the
localhost exception can retain a Secure cookie at this HTTP origin while the
remote network hop is carried by SSH. MDN documents that Safari does not support
this exception. Browser policy and the effective ingress configuration still
need to be verified on the actual client; the tunnel alone is not proof.

Use the existing pilot accounts through the company's local credential process:

1. Log in, reload the page, and verify `/api/auth/session` reports the expected
   identity. Inspect cookie attributes if necessary, without copying its value.
2. Log in as the pilot Bot Owner and open the completed mock task reported by the
   operator. Check its result, run history, and final status after a refresh.
3. Create a new, clearly labeled mock task and assign the dedicated pilot worker.
   Confirm the browser's POST succeeds without `CSRF_ERROR`.
4. Have the company-side operator run the explicit one-shot mock using the
   existing pilot's complete Compose configuration. Confirm the same task shows
   `No model invoked`, reaches `reviewing`, and becomes `completed` after acceptance.
5. Verify WebSocket connection, page refresh, and logout/session invalidation.

Record the browser/version, source commit, task ID, and each result. Keep cookies,
Bot tokens, and administrator secrets out of screenshots or shared reports.

If the browser will not store the cookie or a refresh loses the session, inspect
the actual browser's localhost support and cookie blocked reason. The current
cookie has no Domain attribute; the application's `DOMAIN` setting does not
control browser cookie storage. If the session exists but a POST returns
`CSRF_ERROR`, inspect effective `DOMAIN`, Host, and `X-Forwarded-Host` instead.
Use a supported browser or a trusted HTTPS entry point; keep cookie security,
browser protections, and CSRF checks enabled, and keep `DEV_MODE` disabled.

## 4. What remains for the company HTTPS entry point

A successful tunnel check establishes browser login and the M0 task UI for that
client. It does not validate a company TLS certificate, reverse proxy, Safari,
an employee access policy, or a real model runner. Keep those outcomes separate.

For regular employee use, provide a company-approved hostname, a certificate
trusted by employee browsers (including an approved internal CA if appropriate),
and the intended internal/VPN access policy. Then repeat browser acceptance at
the actual HTTPS origin, with `DOMAIN`, forwarded Host/protocol, and WebSockets
configured for that origin.

## References

- [OpenSSH local port forwarding](https://man.openbsd.org/ssh#L)
- [MDN HTTP cookies: Secure and the localhost compatibility exception](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#block_access_to_your_cookies)
- [MDN Set-Cookie: Secure and Domain](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- Application: `src/session-middleware.ts`, `src/routes.ts`,
  `web-next/src/lib/api.ts`, and `web-next/src/hooks/useWebSocket.ts`.
