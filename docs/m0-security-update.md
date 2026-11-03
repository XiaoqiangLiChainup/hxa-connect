# M0 Security Update and Pilot Revalidation

This development update is based on the original M0 deployment commit
`3e91c5b4c7c97d187cce399a925a21ae20c06c28`. Its branch is
`fix/m0-security-hardening`. Verify remote publication before fetching it; a
locally prepared branch name is not evidence that a remote branch exists.

The update addresses the webhook transport and dependency advisories identified
during the independent pilot. It does not implement a real Zylos/Codex runner or
change the database schema. The development package version remains 1.7.5; use
the source commit and image ID to identify the build.

## Webhook changes

- Native Node HTTP/HTTPS requests do not follow redirects. Every 3xx response
  ends delivery; relative and same-host redirects are also rejected. Configure
  the final HTTPS callback URL rather than a redirecting endpoint.
- The actual TCP connection uses a checked DNS lookup. All returned A/AAAA
  addresses must pass the public-address policy, and those same addresses are
  given directly to the connection. An earlier registration check is not reused
  as proof that a later DNS result is safe.
- Every retry opens its own connection and repeats the DNS check. A failed DNS
  lookup cannot fall through to an unchecked fetch. Direct IP literals receive
  the same address policy because Node can connect to them without DNS.
- The policy conservatively excludes private, loopback, link-local, shared,
  reserved, multicast, documentation, and IPv4/IPv6 translation address ranges.
  Native global-unicast IPv6 is supported with special-purpose exclusions.
  Some special-purpose public exceptions are intentionally unsupported.
- HTTPS retains the original hostname, native certificate verification, and SNI.
  URL-embedded credentials are rejected. HMAC signing and the existing bounded
  retry schedule are retained, with a fresh timestamp for each attempt.
- Each delivery attempt has a 10-second request deadline. Responses need only
  their status, so the response stream and request are closed without buffering
  a potentially unbounded response body. Logs omit callback URLs, Location,
  bodies, and secrets.

This public-destination policy is not a substitute for company egress controls.
An allowed public IP is not a declaration that every service behind that address
is trusted. Keep the pilot's internal-only application network and disabled
webhooks while performing this update. A future pull runner does not require
Hub-originated webhooks or direct Hub access to a model provider.

## Dependency changes

Both lockfiles were regenerated with npm, without `audit fix --force`. Existing
Express 4, Multer 2, ws 8, Next 15.5, and Vitest 4 major versions were retained.

| Package | Previous locked version | Updated locked version |
| --- | --- | --- |
| Express | 4.22.1 | 4.22.3 |
| body-parser | 1.20.4 | 1.20.9 |
| proxy-addr | 2.0.7 | 2.0.8 |
| Multer | 2.1.1 | 2.5.0 |
| qs | 6.14.2 | 6.16.2 |
| uuid | 11.1.0 | 11.1.1 |
| ws | 8.19.0 | 8.22.1 |
| Next.js | 15.5.14 | 15.5.28 |
| Web PostCSS | 8.4.31 / 8.5.8 | 8.5.23 |
| Web sharp | 0.34.5 | 0.35.5 |

The web PostCSS override removes a vulnerable version pinned by Next's dependency
tree. The Vite override keeps the test toolchain on the patched 7.3.7 line instead
of introducing Vite 8. Related development and transitive dependencies were also
refreshed. React remained at the existing locked 19.2.4.

Audit results for the updated lockfiles on 2026-11-03:

| Audit scope | Before | After |
| --- | --- | --- |
| Server production dependencies (`--omit=dev`) | 6: 1 critical, 3 high, 2 moderate | 0 |
| Server including development dependencies | 14: 2 critical, 7 high, 4 moderate, 1 low | 0 |
| Web dependencies including build tools | 5: 1 critical, 4 high | 0 |

These are npm advisory results for that date, not a guarantee against unknown
vulnerabilities. Runtime applicability depends on configuration. For example,
the dashboard is exported statically and served by the Hub, so a Next server
advisory is not automatically an exploitable path in this deployment. Update
the dependency tree and rebuild the static output nonetheless.

## Verification of this source update

Validated with Node 22.23.4:

- Full Vitest run: **613 passed, 7 Redis-dependent tests skipped, 0 failed**
  across 22 files (620 tests total).
- Included webhook regression coverage: **73 tests passed**, including a real
  local listener receiving zero connections after a DNS answer changes to loopback,
  and native HTTPS/TLS hostname and certificate-check preservation.
- Server TypeScript compilation and Next 15.5.28 production build/static export
  succeeded. The Node 22 SQLite native binding passed an in-memory query.
- All three npm audit scopes above reported zero known vulnerabilities.
- `git diff --check` passed.

The migration CLI tests now invoke the same TypeScript entry point through
`process.execPath --import tsx`. This keeps their original assertions while
avoiding an unnecessary npx/tsx CLI IPC server in restricted test environments;
the production migration implementation is unchanged.

This validation does not claim that a new Docker image has been executed on the
company server, or that its HTTPS/browser entry point has passed acceptance.

## Apply to an already deployed independent pilot

1. Record the existing source commit, image ID, project, volume, and completed
   mock task. Read the company's local operations document and preserve every
   local overlay, ingress configuration, network policy, and protected `.env`.
2. Confirm the security branch exists in the intended fork and review its diff
   from the deployed commit. Fetch that exact source. A supplied Git patch can
   instead be checked and applied against its documented base commit in a clean
   branch. Stop on an unexpected base or local tracked-file conflict.
3. Build a new image with a distinct commit-based tag. Use the existing pilot's
   complete Compose configuration, including its company-local overlays. Running
   the repository's base Compose file alone can discard local isolation choices
   or ignore its separate ingress service.
4. Take a consistent full-volume backup using the pilot's tested procedure and
   retain the previous image. Preserve the existing project and volume identity.
   Follow the local stop/update/start procedure so two Hub processes never open
   the same SQLite volume concurrently.
5. Verify health, the old completed task and run, and one new explicit mock task.
   Repeat the local network-isolation checks and confirm the existing company
   HXA/Zylos instances are still healthy. Keep the mock worker's Bot token in the
   company environment.
6. Perform real-browser acceptance at the company's trusted HTTPS origin, or use
   the limited [SSH/local-browser path](company-browser-check.md) while that
   origin is pending. Record those two acceptance outcomes separately.

Do not remove the pilot's volume during an application update. If data recovery
is required, restore the verified backup into a new volume and select it through
the local override, rather than overwriting the only current volume.

The source update has not itself changed the company's running containers.
The company-side operator must rebuild, deploy, and revalidate the actual image.
The locally writable root filesystem reported by an operator is a separate
Compose hardening decision; this code patch does not change that setting.

## Reproduce validation

Use Node 22 for both npm and its child processes:

```bash
npm ci
npm run build
npm test
npm audit --omit=dev
npm audit
npm --prefix web-next ci
npm --prefix web-next run build
npm --prefix web-next audit
```

The webhook regression suite uses controlled DNS/native transport doubles and
local negative-connection checks. It does not probe cloud metadata or production
network services. Its checks cover redirects, IP literals, mixed DNS results,
DNS rebinding, retry/deadline behavior, and signing.

## Follow-up: one real worker

After this revalidation, add one dedicated pilot worker that actively calls the
Task claim/heartbeat/finish API and owns an isolated execution workspace. Keep
model access in that worker or its separate Zylos execution instance, using the
company-approved model egress path. The Hub can remain on its internal network.
This is a design for the next stage, not a capability delivered by this patch.

## Selected upstream references

- [proxy-addr IP spoofing advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
- [body-parser compressed-body denial of service](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828)
- [Multer asynchronous file-filter denial of service](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m)
- [ws memory exhaustion advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p)
- [Next.js security advisories](https://github.com/vercel/next.js/security/advisories)
- [PostCSS source-map loading advisory](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp)
- [tsx official Node CLI integration](https://github.com/privatenumber/tsx/blob/master/docs/dev-api/node-cli.md)
